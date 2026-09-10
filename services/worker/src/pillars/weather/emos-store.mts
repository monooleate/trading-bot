// services/worker/src/pillars/weather/emos-store.mts
//
// Per-station EMOS residual store + fit cache (B49 #6). The data clock for the
// weather calibration: log the forecast (ensMean, ensStd) at scan time, fill the
// realised daily-max from METAR once the date has passed, and refit EMOS params
// from the resolved residuals. Like the prediction-ledger, the point-in-time
// forecast/obs pairs CANNOT be reconstructed later — logging must start now
// regardless of when the calibration is switched on. Crucially the obs-fill is
// METAR-based (every scanned station+date), NOT trade-based, so the residual set
// is UNBIASED (not limited to markets the bot took). Best-effort, non-throwing.
//
// The pure fit math lives in @core/emos.mts; this is the I/O + rolling storage.

import { getStore } from "@netlify/blobs";
import { fitEmos, type EmosFit, type EmosSample } from "@core/emos.mts";
import { fetchStationDailyMax } from "./station-obs.mts";

const STORE = "weather-emos";
const CAP = 400;            // residual records per station (rolling)
const MIN_SAMPLES = 20;     // min resolved residuals before a fit is used
const VAR_FLOOR = 0.25;     // σ² floor (0.5°C) — matches the bucket-matcher floor

export interface EmosResidual {
  date: string;             // market target date (station-local) — the upsert key
  ensMean: number;          // forecast daily-max °C used at entry
  ensStd: number;           // forecast σ (ensemble stddev or heuristic)
  obs: number | null;       // realised daily-max °C (filled from METAR after the date)
  ts: string;
  seed?: boolean;           // B50 #5: historical-backfill residual (down-weighted; ages out)
}

interface StationEmos {
  residuals: EmosResidual[];
  params?: EmosFit;
  fittedAt?: string;
}

const keyFor = (station: string) => `v1:${station}`;

async function load(station: string): Promise<StationEmos> {
  try {
    const raw = await getStore(STORE).get(keyFor(station));
    if (!raw) return { residuals: [] };
    const p = JSON.parse(raw as string);
    return { residuals: Array.isArray(p?.residuals) ? p.residuals : [], params: p?.params, fittedAt: p?.fittedAt };
  } catch {
    return { residuals: [] };
  }
}

async function save(station: string, s: StationEmos): Promise<void> {
  try { await getStore(STORE).set(keyFor(station), JSON.stringify(s)); } catch { /* best-effort */ }
}

/**
 * Audit P0-2 — seed down-weighting.
 *
 * The `EmosResidual.seed` comment has claimed since B50 #5 that seeded rows are
 * "down-weighted"; they never were. Every live station is fitted on ~181 seeded
 * residuals (ERA5 observations vs inter-model spread) and 0-5 forward ones
 * (METAR observations vs GEFS σ) — different distributions, measured seed bias
 * −0.03 °C vs forward bias +0.50 °C — so the seeded mean correction does not
 * transfer and outvotes the live data ~40:1.
 *
 * Leave-one-out over the 35 forward residuals (refit excluding the held-out
 * point, so this is out-of-sample):
 *
 *   seed weight 1.0 (today)  CRPS 1.0767   log-score 3.5778   var-ratio 5.96
 *   seed weight 0.1          CRPS 0.9681   log-score 3.1933   var-ratio 4.90
 *   seed weight 0.03         CRPS 0.8623   log-score 2.9527   var-ratio 4.35
 *
 * Default 1.0 ⇒ every weight is 1 ⇒ the fit is bit-identical to before.
 *
 * ⚠ Pairs with `weatherSigmaInflation` (P0-1): a better-fitted EMOS needs LESS
 * post-hoc inflation. Measured optima — seed 1.0 → λ 2.25-2.5; seed 0.1 → λ
 * 1.75-2.25; seed 0.03 → λ 1.5-2.0. Do not tune one without re-measuring the
 * other. Recommended pair: seed 0.1 + λ 2.0.
 *
 * ⚠ At seed 0.03 the effective sample size collapses to ~10 per station, so the
 * measured gain is real but high-variance. 0.1 is the conservative setting.
 */
async function loadSeedWeight(): Promise<number> {
  try {
    const mod: any = await import("@api/routes/trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    const w = ov?.weatherEmosSeedWeight;
    if (typeof w === "number" && Number.isFinite(w) && w > 0 && w <= 1) return w;
  } catch { /* fall through to the env default */ }
  const env = parseFloat(process.env.WEATHER_EMOS_SEED_WEIGHT || "1");
  return Number.isFinite(env) && env > 0 && env <= 1 ? env : 1;
}

function refit(s: StationEmos, seedWeight = 1): void {
  const samples: EmosSample[] = s.residuals
    .filter((r) => r.obs !== null)
    .map((r) => ({
      ensMean: r.ensMean,
      ensStd: r.ensStd,
      obs: r.obs as number,
      // Only attach a weight when it actually differs from 1, so the default
      // path hands fitEmos the exact same objects it always did.
      ...(r.seed && seedWeight !== 1 ? { weight: seedWeight } : {}),
    }));
  s.params = fitEmos(samples, { minSamples: MIN_SAMPLES, varFloor: VAR_FLOOR });
  s.fittedAt = new Date().toISOString();
}

/** Log (upsert by date) the forecast used for a station on a given date. Keeps any
 *  obs already filled. Best-effort. */
export async function logForecast(station: string, date: string, ensMean: number, ensStd: number): Promise<void> {
  if (!station || !date || !Number.isFinite(ensMean) || !Number.isFinite(ensStd)) return;
  try {
    const s = await load(station);
    const prev = s.residuals.find((r) => r.date === date);
    if (prev) {
      prev.ensMean = ensMean; prev.ensStd = ensStd; prev.ts = new Date().toISOString();
    } else {
      s.residuals.push({ date, ensMean, ensStd, obs: null, ts: new Date().toISOString() });
    }
    if (s.residuals.length > CAP) {
      s.residuals = s.residuals.sort((a, b) => a.date.localeCompare(b.date)).slice(-CAP);
    }
    await save(station, s);
  } catch { /* swallow */ }
}

/**
 * Fill realised daily-max from the station's settlement source (METAR, or the HKO
 * daily report for Hong Kong — B71) for pending residuals (obs=null, date < today)
 * and refit. UNBIASED: fills every logged station+date, not just traded markets.
 * Budgeted per call to respect the function timeout. Best-effort, non-throwing.
 */
export async function reconcileEmosObs(station: string, tz: string, budget = 6): Promise<{ filled: number }> {
  let filled = 0;
  try {
    const s = await load(station);
    const today = new Date().toISOString().slice(0, 10);
    const pending = s.residuals.filter((r) => r.obs === null && r.date < today);
    if (pending.length === 0) return { filled: 0 };
    for (const rec of pending.slice(0, budget)) {
      const metar = await fetchStationDailyMax(station, rec.date, tz).catch(() => null);
      if (metar && Number.isFinite(metar.dailyMaxC)) {
        rec.obs = metar.dailyMaxC;
        filled++;
      }
    }
    if (filled > 0) { refit(s, await loadSeedWeight()); await save(station, s); }
  } catch { /* swallow */ }
  return { filled };
}

/**
 * B50 #5: inject historical seed residuals (obs already filled) for a station and
 * refit. Only adds dates NOT already present — never overwrites a forward-logged
 * (production-matched) residual. Seeds are tagged + land on old dates, so they age
 * out of the rolling window as forward pairs accumulate. Best-effort, non-throwing.
 */
export async function injectSeedResiduals(
  station: string,
  samples: Array<{ date: string; ensMean: number; ensStd: number; obs: number }>,
): Promise<{ added: number; total: number; fitted: boolean }> {
  try {
    const s = await load(station);
    const have = new Set(s.residuals.map((r) => r.date));
    const now = new Date().toISOString();
    let added = 0;
    for (const smp of samples ?? []) {
      if (!smp?.date || have.has(smp.date)) continue;
      if (!Number.isFinite(smp.ensMean) || !Number.isFinite(smp.ensStd) || smp.ensStd < 0 || !Number.isFinite(smp.obs)) continue;
      s.residuals.push({ date: smp.date, ensMean: smp.ensMean, ensStd: smp.ensStd, obs: smp.obs, ts: now, seed: true });
      have.add(smp.date);
      added++;
    }
    if (s.residuals.length > CAP) {
      s.residuals = s.residuals.sort((a, b) => a.date.localeCompare(b.date)).slice(-CAP);
    }
    if (added > 0) refit(s, await loadSeedWeight());
    await save(station, s);
    return { added, total: s.residuals.length, fitted: !!s.params?.fitted };
  } catch {
    return { added: 0, total: 0, fitted: false };
  }
}

/**
 * Resolved (date → observed daily max °C) pairs for a station. Exported for the
 * B52 multi-model recorder so it can label its snapshots WITHOUT issuing a
 * second round of METAR fetches — `reconcileEmosObs` already did that work.
 * Best-effort: returns {} on any read error.
 */
export async function loadResolvedObs(station: string): Promise<Record<string, number>> {
  try {
    const s = await load(station);
    const out: Record<string, number> = {};
    for (const r of s.residuals) {
      if (typeof r.obs === "number" && Number.isFinite(r.obs)) out[r.date] = r.obs;
    }
    return out;
  } catch {
    return {};
  }
}

/** Load the fitted EMOS params for a station, or null if none/insufficient data. */
export async function loadStationEmosParams(station: string): Promise<EmosFit | null> {
  try {
    const s = await load(station);
    return s.params?.fitted ? s.params : null;
  } catch {
    return null;
  }
}
