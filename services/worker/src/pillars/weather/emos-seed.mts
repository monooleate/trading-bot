// services/worker/src/pillars/weather/emos-seed.mts
//
// Offline EMOS seed orchestrator — model-discovery-training §3.C / #5 (B50).
// Fetches per-station HISTORICAL forecast + realised daily-max from Open-Meteo
// (keyless), builds (ensMean, ensStd, obs) triples, and injects them into the
// per-station weather-emos store so `weatherUseEmos` has a fitted calibrator from
// day one instead of waiting weeks for forward residuals. One-time backfill
// (run via scripts/seed-emos.ts); the pure parsers live in @core/emos-seed.mts.
//
// Data (both keyless, ~2 calls/station):
//  • forecast: historical-forecast-api.open-meteo.com — multiple deterministic
//    models → inter-model mean+std = a legitimate ensemble-spread proxy from
//    history (the production ensemble spread is NOT archived retroactively).
//  • realised: archive-api.open-meteo.com — ERA5 daily max at the station cell.
// Both are a SEED (down-weighted, ages out) — the forward pipeline's
// production-matched, METAR-obs residuals replace it. See @core/emos-seed.mts.

import { parseDailySeries, buildSeedSamples, seedDateWindow } from "@core/emos-seed.mts";
import { injectSeedResiduals } from "./emos-store.mts";
import { SETTLEMENT_STATIONS } from "./station-config.mts";

// Deterministic models with deep Open-Meteo historical-forecast coverage.
const MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless", "gem_seamless"];
const HIST_FC = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "EdgeCalc-EmosSeed/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface SeedStationResult {
  station: string;
  added: number;
  total: number;
  fitted: boolean;
  error?: string;
}

/**
 * Seed one station's EMOS store from `months` of history. Best-effort: returns an
 * `error` string rather than throwing so a batch run continues past a bad station.
 */
export async function seedStationEmos(
  icao: string, lat: number, lon: number, tz: string, months = 6,
): Promise<SeedStationResult> {
  const { start, end } = seedDateWindow(months);
  const q = `latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&daily=temperature_2m_max&timezone=${encodeURIComponent(tz)}`;

  const fc = await fetchJson(`${HIST_FC}?${q}&models=${MODELS.join(",")}`);
  if (!fc?.daily) return { station: icao, added: 0, total: 0, fitted: false, error: "no historical forecast" };
  const ar = await fetchJson(`${ARCHIVE}?${q}`);
  if (!ar?.daily) return { station: icao, added: 0, total: 0, fitted: false, error: "no ERA5 archive" };

  const modelSeries = MODELS.map((m) => parseDailySeries(fc.daily, `temperature_2m_max_${m}`));
  const realized = parseDailySeries(ar.daily, "temperature_2m_max");
  const samples = buildSeedSamples(modelSeries, realized, 2);
  if (samples.length === 0) return { station: icao, added: 0, total: 0, fitted: false, error: "no matched pairs" };

  const r = await injectSeedResiduals(icao, samples);
  return { station: icao, ...r };
}

/** Seed every settlement station. Sequential (polite to Open-Meteo's free tier). */
export async function seedAllStations(months = 6): Promise<SeedStationResult[]> {
  const out: SeedStationResult[] = [];
  const seen = new Set<string>();
  for (const cfg of Object.values(SETTLEMENT_STATIONS)) {
    if (seen.has(cfg.icao)) continue;   // several city keys can map to one ICAO
    seen.add(cfg.icao);
    out.push(await seedStationEmos(cfg.icao, cfg.lat, cfg.lon, cfg.tz, months));
  }
  return out;
}
