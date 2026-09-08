#!/usr/bin/env bun
// B52 #1 — read-out for the weather multi-model log-forward.
//
// Scores what the recorder collected: the single-family GEFS ensemble the bot
// uses today vs the 4-system pooled mixture (and each system on its own),
// against the realised daily max. This is the evidence the `weatherUseMultiModel`
// flip waits on — do NOT flip on the 2026-09-08 spot-check alone.
//
// Run ON THE BOX (needs DATABASE_URL so the store reads hit Postgres):
//   docker compose exec workers bun scripts/eval-multimodel.ts [maxLeadHours]
//   (maxLeadHours default 48 — the bot trades T+0/T+1; pass 0 for no filter)
//
// Read-only: touches no session, opens no position, writes nothing.
//
// Reading the table: CRPS is the decision column (proper score for a Gaussian
// forecast), var-ratio is the diagnosis. ratio > 1 means σ is too narrow, which
// is what oversizes Kelly — the documented weather pathology. A variant with a
// slightly worse MAE but an honest σ is still the better one to ship.

import { pool } from "@core/db.ts";
import { setBlobsDb } from "@core/blobs-compat.ts";
import { scoreForecasts, crpsSkill, dispersionVerdict, type ScoredSample } from "@core/multi-model-eval.mts";
import { SETTLEMENT_STATIONS } from "@worker/pillars/weather/station-config.mts";
import { loadSnapshots, type MultiModelSnapshot } from "@worker/pillars/weather/multi-model-store.mts";

const maxLead = Number(process.argv[2] ?? 48);

setBlobsDb(await pool());

const icaos = [...new Set(Object.values(SETTLEMENT_STATIONS).map((s) => s.icao))].sort();
const all: MultiModelSnapshot[] = [];
const perStation = new Map<string, MultiModelSnapshot[]>();

for (const icao of icaos) {
  const snaps = (await loadSnapshots(icao).catch(() => []))
    .filter((s) => s.obs !== null && (maxLead <= 0 || s.leadHours <= maxLead));
  if (snaps.length > 0) perStation.set(icao, snaps);
  all.push(...snaps);
}

if (all.length === 0) {
  console.log("[eval-multimodel] No labelled snapshots yet.");
  console.log("  The recorder writes on its ~3h cadence and `obs` only lands once the target");
  console.log("  date has passed AND the EMOS reconciler has pulled that day's METAR.");
  console.log("  Expect the first scorable rows ~2 days after deploy; a usable sample in 2-3 weeks.");
  process.exit(0);
}

// Every distinct model tag seen in the log (Open-Meteo's internal domain names).
const tags = [...new Set(all.flatMap((s) => s.perModel.map((m) => m.model)))].sort();

function variantSamples(snaps: MultiModelSnapshot[], variant: string): ScoredSample[] {
  const out: ScoredSample[] = [];
  for (const s of snaps) {
    if (s.obs === null) continue;
    if (variant === "GEFS-only (live)") {
      if (s.baseMean === null || s.baseSd === null) continue;
      out.push({ mean: s.baseMean, sd: s.baseSd, obs: s.obs });
    } else if (variant === "POOLED (4 systems)") {
      out.push({ mean: s.pooledMean, sd: s.pooledSd, obs: s.obs });
    } else {
      const m = s.perModel.find((p) => p.model === variant);
      if (m) out.push({ mean: m.mean, sd: m.sd, obs: s.obs });
    }
  }
  return out;
}

const VARIANTS = ["GEFS-only (live)", "POOLED (4 systems)", ...tags];

function table(snaps: MultiModelSnapshot[], title: string) {
  console.log(`\n── ${title} ──`);
  console.log(
    `${"variant".padEnd(32)}${"n".padStart(5)}${"bias".padStart(8)}${"MAE".padStart(8)}` +
    `${"RMSE".padStart(8)}${"CRPS".padStart(9)}${"σ̄".padStart(7)}${"var-ratio".padStart(11)}` +
    `${"±1σ".padStart(7)}${"skill".padStart(8)}  dispersion`,
  );
  const base = scoreForecasts(variantSamples(snaps, "GEFS-only (live)"));
  for (const v of VARIANTS) {
    const sc = scoreForecasts(variantSamples(snaps, v));
    if (!sc) { console.log(`${v.padEnd(32)}${"—".padStart(5)}`); continue; }
    const sk = v === "GEFS-only (live)" ? null : crpsSkill(sc, base);
    console.log(
      `${v.padEnd(32)}${String(sc.n).padStart(5)}${sc.bias.toFixed(2).padStart(8)}` +
      `${sc.mae.toFixed(2).padStart(8)}${sc.rmse.toFixed(2).padStart(8)}${sc.crps.toFixed(3).padStart(9)}` +
      `${sc.meanSd.toFixed(2).padStart(7)}${sc.varianceRatio.toFixed(2).padStart(11)}` +
      `${(sc.cover1Sd * 100).toFixed(0).padStart(6)}%` +
      `${(sk === null ? "—" : `${(sk * 100).toFixed(1)}%`).padStart(8)}  ${dispersionVerdict(sc)}`,
    );
  }
  return base;
}

console.log(`[eval-multimodel] ${all.length} labelled snapshots across ${perStation.size} stations` +
            `${maxLead > 0 ? `, lead ≤ ${maxLead}h` : ", all lead times"}`);

const base = table(all, "ALL STATIONS");
for (const [icao, snaps] of [...perStation].sort()) {
  if (snaps.length >= 10) table(snaps, `${icao} (${snaps.length})`);
}

// ─── Verdict ──────────────────────────────────────────────────────────────
const pooled = scoreForecasts(variantSamples(all, "POOLED (4 systems)"));
const skill = crpsSkill(pooled, base);
console.log("\n── verdict ──");
if (!pooled || !base || skill === null) {
  console.log("  Not enough paired data to compare yet.");
} else if (pooled.n < 30) {
  console.log(`  n=${pooled.n} — too thin to act on. Target ≥30 labelled snapshots per decision.`);
} else if (skill > 0) {
  console.log(`  POOLED beats GEFS-only by ${(skill * 100).toFixed(1)}% CRPS ` +
              `(dispersion: GEFS ${dispersionVerdict(base)} ${base.varianceRatio.toFixed(2)} → ` +
              `pooled ${dispersionVerdict(pooled)} ${pooled.varianceRatio.toFixed(2)}).`);
  console.log("  → Flipping `weatherUseMultiModel` is justified. Expect FEWER trades: the wider σ");
  console.log("    lowers confidence (1 − σ/4), so `weatherConfidenceMin` blocks more markets.");
} else {
  console.log(`  POOLED does NOT beat GEFS-only (${(skill * 100).toFixed(1)}% CRPS skill). Keep the flip OFF.`);
}
console.log("  Reminder: this scores the FORECAST, not PnL — that is the point (B50 #1 doctrine).");

process.exit(0);
