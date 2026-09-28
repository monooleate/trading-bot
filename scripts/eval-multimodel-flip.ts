#!/usr/bin/env bun
// B69/B52 flip read-out — scores the LIVE σ pipeline on the forward multi-model
// log, so the `weatherUseMultiModel` flip and its paired σ-knob can be decided
// on the same evidence.
//
// Unlike scripts/eval-multimodel.ts (which scores raw μ/σ), this replays what
// the weather runner actually hands the bucket matcher:
//     μ = correctForecast(mean)            (METAR rounding, as live)
//     σ = max(0.5, sd)                      (the live floor)
//     → EMOS(params) if weatherUseEmos and the station is fitted
//     → × weatherSigmaInflation
//
// Sampling fixes the three known flaws of the older script (B69 felderítés):
// one sample per (station, target date, lead-day) — the LAST snapshot in the
// bucket, so correlated re-snapshots of the same forecast are not counted
// twice; negative leads are dropped; labels name the real system count.
//
// Run ON THE BOX:  docker exec edgecalc-workers bun scripts/eval-multimodel-flip.ts
// Read-only: writes nothing.

import { pool } from "@core/db.ts";
import { setBlobsDb, getStore } from "@core/blobs-compat.ts";
import { gaussianCrps, emosApply, fitEmos } from "@core/emos.mts";
import { inflateSigma } from "@core/weather-dispersion.mts";
import { SETTLEMENT_STATIONS } from "@worker/pillars/weather/station-config.mts";
import { loadSnapshots, type MultiModelSnapshot } from "@worker/pillars/weather/multi-model-store.mts";
import { loadStationEmosParams } from "@worker/pillars/weather/emos-store.mts";
import { correctForecast } from "@worker/pillars/weather/metar-simulator.mts";
import { fitPooledEmos, applyPooledEmos, type PooledCalibrationInput } from "@core/pooled-emos.mts";

setBlobsDb(await pool());

const LIVE_INFLATION = Number(process.argv[2] ?? 2.25);
const LAMBDAS = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.75, 2.0, 2.25];

interface Row { station: string; key: string; lead: number; snap: MultiModelSnapshot; emos: any | null }

const icaos = [...new Set(Object.values(SETTLEMENT_STATIONS).map((s) => s.icao))].sort();
const rows: Row[] = [];
let rawSnaps = 0;
for (const icao of icaos) {
  const snaps = (await loadSnapshots(icao).catch(() => [])).filter(
    (s) => s.obs !== null && s.leadHours >= 0 && s.leadHours <= 48 && s.baseMean !== null && s.baseSd !== null,
  );
  rawSnaps += snaps.length;
  const last = new Map<string, MultiModelSnapshot>();
  for (const s of snaps) {
    const k = `${s.date}|${Math.floor(s.leadHours / 24)}`;
    const prev = last.get(k);
    if (!prev || s.ts > prev.ts) last.set(k, s);
  }
  const params = await loadStationEmosParams(icao).catch(() => null);
  for (const [k, s] of last) {
    rows.push({ station: icao, key: `${icao}|${k}`, lead: s.leadHours, snap: s, emos: params?.fitted ? params : null });
  }
}

type Pred = { mu: number; sigma: number };
function pipeline(mean: number, sd: number, emos: any | null, useEmos: boolean, lambda: number): Pred {
  let mu = correctForecast(mean, 0);
  let sigma = Math.max(0.5, sd);
  if (useEmos && emos) {
    const cal = emosApply(emos, mu, sigma, emos.varFloor);
    mu = cal.mu;
    sigma = cal.sigma;
  }
  return { mu, sigma: inflateSigma(sigma, lambda) };
}

function score(fn: (r: Row) => Pred) {
  const crps: number[] = [];
  let e2 = 0, s2 = 0, bias = 0, in1 = 0;
  for (const r of rows) {
    const p = fn(r);
    const y = r.snap.obs as number;
    crps.push(gaussianCrps(p.mu, p.sigma, y));
    const e = y - p.mu;
    e2 += e * e; s2 += p.sigma * p.sigma; bias += e;
    if (Math.abs(e) <= p.sigma) in1++;
  }
  const n = rows.length;
  return { crps, mean: crps.reduce((a, b) => a + b, 0) / n, varRatio: e2 / s2, bias: bias / n, cov1: in1 / n };
}

// Paired bootstrap CI of the CRPS skill of `b` against `a` (by station-day).
function skillCI(a: number[], b: number[], iters = 2000) {
  const n = a.length;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sa = 0, sb = 0;
    for (let j = 0; j < n; j++) { const k = Math.floor(rnd() * n); sa += a[k]; sb += b[k]; }
    out.push(1 - sb / sa);
  }
  out.sort((x, y) => x - y);
  return [out[Math.floor(iters * 0.05)], out[Math.floor(iters * 0.95)]];
}

const nStations = new Set(rows.map((r) => r.station)).size;
const nDays = new Set(rows.map((r) => r.key.split("|").slice(0, 2).join("|"))).size;
const dates = rows.map((r) => r.snap.date).sort();
console.log(`samples=${rows.length} (from ${rawSnaps} labelled snapshots) · stations=${nStations} · station-days=${nDays} · ${dates[0]} → ${dates.at(-1)}`);
console.log(`systems per snapshot: ${[...new Set(rows.map((r) => r.snap.perModel.length))].sort().join("/")} · EMOS fitted on ${rows.filter((r) => r.emos).length}/${rows.length} samples`);

const live = score((r) => pipeline(r.snap.baseMean!, r.snap.baseSd!, r.emos, true, LIVE_INFLATION));
const fmt = (name: string, s: ReturnType<typeof score>, ci?: number[]) =>
  console.log(
    `${name.padEnd(34)} CRPS ${s.mean.toFixed(3)}  skill ${((1 - s.mean / live.mean) * 100).toFixed(1).padStart(6)}%` +
    (ci ? ` [${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]` : "            ") +
    `  var-ratio ${s.varRatio.toFixed(2)}  bias ${s.bias >= 0 ? "+" : ""}${s.bias.toFixed(2)}  ±1σ ${(s.cov1 * 100).toFixed(0)}%`,
  );

console.log(`\nbaseline = LIVE today: GEFS μ/σ → EMOS → ×${LIVE_INFLATION}`);
fmt(`LIVE (GEFS, EMOS, ×${LIVE_INFLATION})`, live);
fmt("GEFS raw (no EMOS, ×1)", score((r) => pipeline(r.snap.baseMean!, r.snap.baseSd!, r.emos, false, 1)));

// The fair comparison is best-GEFS vs best-POOLED: part of any gain may come
// from the inflation knob alone, which the GEFS path can also retune.
for (const src of ["GEFS", "POOLED"] as const) {
  for (const useEmos of [false, true]) {
    console.log(`\n${src} μ/σ, EMOS ${useEmos ? "ON" : "OFF"}:`);
    for (const l of LAMBDAS) {
      const s = score((r) =>
        src === "GEFS"
          ? pipeline(r.snap.baseMean!, r.snap.baseSd!, r.emos, useEmos, l)
          : pipeline(r.snap.pooledMean, r.snap.pooledSd, r.emos, useEmos, l),
      );
      fmt(`  ×${l}`, s, skillCI(live.crps, s.crps));
    }
  }
}

// Out-of-sample guard: the EMOS params were refit on residuals that include
// these same days, which flatters every EMOS-ON row. Split by date: the first
// half vs the second half should tell the same story if the ranking is real.
const mid = dates[Math.floor(dates.length / 2)];
for (const [name, keep] of [["first half", (r: Row) => r.snap.date < mid], ["second half", (r: Row) => r.snap.date >= mid]] as const) {
  const sub = rows.filter(keep);
  const mean = (fn: (r: Row) => Pred) =>
    sub.reduce((acc, r) => { const p = fn(r); return acc + gaussianCrps(p.mu, p.sigma, r.snap.obs as number); }, 0) / sub.length;
  const l = mean((r) => pipeline(r.snap.baseMean!, r.snap.baseSd!, r.emos, true, LIVE_INFLATION));
  const g = mean((r) => pipeline(r.snap.baseMean!, r.snap.baseSd!, r.emos, true, 1.2));
  const p = mean((r) => pipeline(r.snap.pooledMean, r.snap.pooledSd, r.emos, true, 1.2));
  console.log(`\n${name} (n=${sub.length}): LIVE ${l.toFixed(3)} · GEFS+EMOS×1.2 ${g.toFixed(3)} · POOLED+EMOS×1.2 ${p.toFixed(3)}`);
}
// Fair out-of-sample head-to-head: give EACH source its OWN EMOS, fitted on one
// half of the forward data and scored on the other (both directions). The live
// EMOS params are GEFS-fitted and partly in-sample, so the rows above cannot
// tell whether the pool would win once it has a calibration of its own. Per
// station there are only ~12 samples, so the fit is global plus a shrunk
// per-station bias (k = 5 pseudo-samples toward the global fit).
function crossFit(fitRows: Row[], testRows: Row[], src: "GEFS" | "POOLED", lambdas: number[]) {
  const mS = (r: Row) => (src === "GEFS" ? r.snap.baseMean! : r.snap.pooledMean);
  const sS = (r: Row) => Math.max(0.5, src === "GEFS" ? r.snap.baseSd! : r.snap.pooledSd);
  const fit = fitEmos(
    fitRows.map((r) => ({ ensMean: correctForecast(mS(r), 0), ensStd: sS(r), obs: r.snap.obs as number })),
    { minSamples: 20 },
  );
  const resid = new Map<string, number[]>();
  for (const r of fitRows) {
    const mu = emosApply(fit, correctForecast(mS(r), 0), sS(r), fit.varFloor).mu;
    const arr = resid.get(r.station) ?? [];
    arr.push((r.snap.obs as number) - mu);
    resid.set(r.station, arr);
  }
  const K = 5;
  const bias = (st: string) => { const a = resid.get(st) ?? []; return a.reduce((x, y) => x + y, 0) / (a.length + K); };
  return lambdas.map((l) => {
    const c = testRows.map((r) => {
      const cal = emosApply(fit, correctForecast(mS(r), 0), sS(r), fit.varFloor);
      return gaussianCrps(cal.mu + bias(r.station), inflateSigma(cal.sigma, l), r.snap.obs as number);
    });
    return { l, crps: c.reduce((a, b) => a + b, 0) / c.length };
  });
}
const A = rows.filter((r) => r.snap.date < mid), B = rows.filter((r) => r.snap.date >= mid);
console.log("\nOUT-OF-SAMPLE, own EMOS per source (fit → test), CRPS by σ-factor:");
for (const [fitSet, testSet, label] of [[A, B, "fit 1st → test 2nd"], [B, A, "fit 2nd → test 1st"]] as const) {
  for (const src of ["GEFS", "POOLED"] as const) {
    const res = crossFit(fitSet, testSet, src, [1.0, 1.2, 1.4, 1.6]);
    console.log(`  ${label}  ${src.padEnd(6)} ` + res.map((x) => `×${x.l}: ${x.crps.toFixed(3)}`).join("  "));
  }
}
// ── The shipped calibration, scored the way it will run live ────────────────
// Expanding window: every target date d is scored with a pooled EMOS fitted
// ONLY on station-days before d (the hourly refit only ever sees the past).
// Baseline = the NEW live GEFS setting (station EMOS × 1.25). Its per-station
// EMOS was partly fitted on these same days, so this comparison is biased in
// the GEFS path's favour — a pool win here is a conservative result.
{
  const inputs: PooledCalibrationInput[] = [];
  for (const icao of icaos) {
    for (const s of await loadSnapshots(icao).catch(() => [])) {
      inputs.push({ station: icao, ts: s.ts, date: s.date, leadHours: s.leadHours, mean: s.pooledMean, sd: s.pooledSd, obs: s.obs });
    }
  }
  const tf = (m: number) => correctForecast(m, 0);
  const days = [...new Set(rows.map((r) => r.snap.date))].sort();
  const lambdas = [1.0, 1.25, 1.5];
  const pool: Record<number, number[]> = Object.fromEntries(lambdas.map((l) => [l, []]));
  const base: number[] = [];
  let scored = 0, unfitted = 0;
  const scoredKeys: string[] = [];
  for (const d of days) {
    const model = fitPooledEmos(inputs.filter((x) => x.date < d), { transformMean: tf });
    for (const r of rows.filter((x) => x.snap.date === d)) {
      if (!model.fit.fitted) { unfitted++; continue; }
      const y = r.snap.obs as number;
      const b = pipeline(r.snap.baseMean!, r.snap.baseSd!, r.emos, true, 1.25);
      base.push(gaussianCrps(b.mu, b.sigma, y));
      scoredKeys.push(r.key);
      const cal = applyPooledEmos(model, r.station, tf(r.snap.pooledMean), Math.max(0.5, r.snap.pooledSd));
      for (const l of lambdas) pool[l].push(gaussianCrps(cal.mu, inflateSigma(cal.sigma, l), y));
      scored++;
    }
  }
  // Fair GEFS baseline: refit each station's EMOS the way the live store does
  // (seed rows at weatherEmosSeedWeight 0.1, forward rows at 1) but using ONLY
  // forward residuals dated before d — so both sides are truly out-of-sample.
  const emosRaw = new Map<string, any[]>();
  for (const icao of icaos) {
    try {
      const raw = await getStore("weather-emos").get(`v1:${icao}`);
      emosRaw.set(icao, raw ? (JSON.parse(raw as string).residuals ?? []) : []);
    } catch { emosRaw.set(icao, []); }
  }
  const gefsOos: number[] = [];  // filled after the loop below, in scoredKeys order
  const gefsOosFor = new Map<string, number>();
  for (const d of days) {
    for (const r of rows.filter((x) => x.snap.date === d)) {
      const res = (emosRaw.get(r.station) ?? []).filter((x: any) => x.obs !== null && (x.seed || x.date < d));
      const fit = fitEmos(
        res.map((x: any) => ({ ensMean: x.ensMean, ensStd: x.ensStd, obs: x.obs, ...(x.seed ? { weight: 0.1 } : {}) })),
        { minSamples: 20, varFloor: 0.25 },
      );
      const mu0 = correctForecast(r.snap.baseMean!, 0), s0 = Math.max(0.5, r.snap.baseSd!);
      const cal = fit.fitted ? emosApply(fit, mu0, s0, fit.varFloor) : { mu: mu0, sigma: s0 };
      gefsOosFor.set(r.key, gaussianCrps(cal.mu, inflateSigma(cal.sigma, 1.25), r.snap.obs as number));
    }
  }

  for (const k of scoredKeys) gefsOos.push(gefsOosFor.get(k)!);
  const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`\nEXPANDING-WINDOW OOS with the shipped fitPooledEmos (scored ${scored}, skipped ${unfitted} before the first fit):`);
  console.log(`  NEW LIVE  GEFS + station EMOS × 1.25   CRPS ${m(base).toFixed(3)}`);
  console.log(`  GEFS OOS  station EMOS refit < d × 1.25 CRPS ${m(gefsOos).toFixed(3)}   ← the fair baseline`);
  for (const l of lambdas) {
    const ci = skillCI(gefsOos, pool[l]);
    console.log(`  POOLED × ${l} vs GEFS OOS`.padEnd(40) + `skill ${((1 - m(pool[l]) / m(gefsOos)) * 100).toFixed(1)}% [${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]`);
  }
  for (const l of lambdas) {
    const ci = skillCI(base, pool[l]);
    console.log(`  POOLED + pooled EMOS × ${l}`.padEnd(40) + `CRPS ${m(pool[l]).toFixed(3)}  skill ${((1 - m(pool[l]) / m(base)) * 100).toFixed(1)}% [${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]`);
  }
}
process.exit(0);
