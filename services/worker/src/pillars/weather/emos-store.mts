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
import { fetchMetarDailyMax } from "./metar-fetcher.mts";

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

function refit(s: StationEmos): void {
  const samples: EmosSample[] = s.residuals
    .filter((r) => r.obs !== null)
    .map((r) => ({ ensMean: r.ensMean, ensStd: r.ensStd, obs: r.obs as number }));
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
 * Fill realised daily-max from METAR for pending residuals (obs=null, date < today)
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
      const metar = await fetchMetarDailyMax(station, rec.date, tz).catch(() => null);
      if (metar && Number.isFinite(metar.dailyMaxC)) {
        rec.obs = metar.dailyMaxC;
        filled++;
      }
    }
    if (filled > 0) { refit(s); await save(station, s); }
  } catch { /* swallow */ }
  return { filled };
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
