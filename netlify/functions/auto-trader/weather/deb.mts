// netlify/functions/auto-trader/weather/deb.mts
// Dynamic Error Balancing (DEB) for weather forecast model weights.
//
// Reference: yangyuan-zhen/PolyWeather.
// Idea: after each resolved trade, compute per-model error (|predicted - settled|)
// and shift weights toward the model that has been more accurate recently.
//
// Storage: Netlify Blobs (`weather-deb-v1`), keyed per city. Each city has
// its own rolling error buffer so weights specialise — ECMWF might dominate
// in London while GFS dominates in Chicago.
//
// Bootstrapping: until we have MIN_TRADES_FOR_DEB resolved trades for a
// city, getDebWeights() returns the original fixed defaults. This satisfies
// the "< 10 trade → use fixed weights" guardrail.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "weather-deb-v1";
const MIN_TRADES_FOR_DEB = 10;
const ROLLING_WINDOW     = 30;

export interface DebWeights {
  gfs:   number;
  ecmwf: number;
  noaa:  number;
  source: "default" | "deb";
  citySampleSize?: number;
}

export interface DebSample {
  date:        string;      // target date (YYYY-MM-DD)
  actualMaxC:  number;      // settled actual temperature
  gfsPred:     number | null;
  ecmwfPred:   number | null;
  noaaPred:    number | null;
  closedAt:    string;
}

export interface CityDebState {
  city:         string;
  samples:      DebSample[];   // rolling window, newest first
  lastUpdated:  string;
}

// ─── Fixed defaults (match the pre-DEB behaviour) ─────────────────────────
const DEFAULT_WEIGHTS: DebWeights = {
  gfs:   0.6,
  ecmwf: 0.4,
  noaa:  0.5,
  source: "default",
};

// ─── Storage ──────────────────────────────────────────────────────────────
async function loadCityState(city: string): Promise<CityDebState | null> {
  try {
    const store = getStore(STORE_NAME);
    const raw = await store.get(`city:${city.toLowerCase()}`);
    if (!raw) return null;
    return JSON.parse(raw) as CityDebState;
  } catch {
    return null;
  }
}

async function saveCityState(state: CityDebState): Promise<void> {
  try {
    const store = getStore(STORE_NAME);
    await store.set(`city:${state.city.toLowerCase()}`, JSON.stringify(state));
  } catch {
    // Non-fatal — weights will be recomputed on next trade
  }
}

// ─── Weight computation from historical samples ───────────────────────────
function weightsFromSamples(samples: DebSample[]): DebWeights {
  if (samples.length < MIN_TRADES_FOR_DEB) {
    return { ...DEFAULT_WEIGHTS, citySampleSize: samples.length };
  }

  // Compute mean absolute error per model.
  // Smaller error ↔ bigger weight. Weight = 1 / (error + epsilon).
  let gfsErrSum = 0, gfsN = 0;
  let ecmErrSum = 0, ecmN = 0;
  let noaaErrSum = 0, noaaN = 0;

  for (const s of samples) {
    if (s.gfsPred   != null) { gfsErrSum += Math.abs(s.gfsPred   - s.actualMaxC); gfsN++;  }
    if (s.ecmwfPred != null) { ecmErrSum += Math.abs(s.ecmwfPred - s.actualMaxC); ecmN++;  }
    if (s.noaaPred  != null) { noaaErrSum += Math.abs(s.noaaPred - s.actualMaxC); noaaN++; }
  }

  const gfsMae  = gfsN  > 0 ? gfsErrSum  / gfsN  : 10;
  const ecmMae  = ecmN  > 0 ? ecmErrSum  / ecmN  : 10;
  const noaaMae = noaaN > 0 ? noaaErrSum / noaaN : 10;

  const eps = 0.2;
  const gfsW  = 1 / (gfsMae + eps);
  const ecmW  = 1 / (ecmMae + eps);
  const noaaW = 1 / (noaaMae + eps);

  // Blend DEB-derived weights with defaults 60/40 so we never fully lose
  // the prior — protects against over-fitting to a small sample window.
  const blend = (deb: number, def: number) => 0.6 * deb + 0.4 * def;
  const total = gfsW + ecmW + noaaW;

  return {
    gfs:   parseFloat(blend(gfsW  / total, DEFAULT_WEIGHTS.gfs  ).toFixed(3)),
    ecmwf: parseFloat(blend(ecmW  / total, DEFAULT_WEIGHTS.ecmwf).toFixed(3)),
    noaa:  parseFloat(blend(noaaW / total, DEFAULT_WEIGHTS.noaa ).toFixed(3)),
    source: "deb",
    citySampleSize: samples.length,
  };
}

// ─── Public: read current weights (callers of forecast-engine) ────────────
export async function getDebWeights(city: string): Promise<DebWeights> {
  const state = await loadCityState(city);
  if (!state) return { ...DEFAULT_WEIGHTS, citySampleSize: 0 };
  return weightsFromSamples(state.samples);
}

// ─── Public: record an observed outcome (caller after trade resolves) ─────
export async function recordDebSample(
  city:       string,
  targetDate: string,
  actualMaxC: number,
  preds:      { gfs?: number | null; ecmwf?: number | null; noaa?: number | null },
): Promise<void> {
  const state = (await loadCityState(city)) || {
    city:        city.toLowerCase(),
    samples:     [],
    lastUpdated: new Date().toISOString(),
  };

  const sample: DebSample = {
    date:       targetDate,
    actualMaxC,
    gfsPred:    preds.gfs   ?? null,
    ecmwfPred:  preds.ecmwf ?? null,
    noaaPred:   preds.noaa  ?? null,
    closedAt:   new Date().toISOString(),
  };

  // Newest first, cap the rolling window
  state.samples = [sample, ...state.samples].slice(0, ROLLING_WINDOW);
  state.lastUpdated = new Date().toISOString();
  await saveCityState(state);
}

// ─── Diagnostic helper ───────────────────────────────────────────────────
export async function getDebDiagnostics(city: string): Promise<{
  city:         string;
  sampleCount:  number;
  bootstrapping: boolean;
  weights:      DebWeights;
  recentSamples: DebSample[];
} | null> {
  const state = await loadCityState(city);
  if (!state) return null;
  const weights = weightsFromSamples(state.samples);
  return {
    city:          state.city,
    sampleCount:   state.samples.length,
    bootstrapping: state.samples.length < MIN_TRADES_FOR_DEB,
    weights,
    recentSamples: state.samples.slice(0, 5),
  };
}

export { MIN_TRADES_FOR_DEB, ROLLING_WINDOW, DEFAULT_WEIGHTS };
