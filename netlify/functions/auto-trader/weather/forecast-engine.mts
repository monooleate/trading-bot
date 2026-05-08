import type { StationConfig } from "./station-config.mts";
import { getSeason } from "./station-config.mts";
import { correctForecast } from "./metar-simulator.mts";
import {
  fetchEnsemble,
  ensembleEnabled,
  type EnsembleResult,
} from "./ensemble-forecast.mts";
import { getDebWeights, type DebWeights } from "./deb.mts";

const TIMEOUT = 8000;

// ─── Types ────────────────────────────────────────────────

export interface ForecastResult {
  city: string;
  date: string;
  predictedMaxC: number;       // after station offset + METAR rounding
  rawGfsMaxC: number | null;
  rawEcmwfMaxC: number | null;
  rawNoaaMaxC: number | null;
  ensembleMaxC: number;        // weighted average before corrections
  cloudCoverPct: number;       // average cloud cover %
  confidence: number;          // 0–1
  modelUsed: string;
  fetchedAt: string;
  // ─ Additive fields (all optional for backwards compat) ──────────────────
  // 31-member GFS ensemble distribution, only populated when USE_ENSEMBLE=true
  // and the Open-Meteo ensemble API responded successfully.
  ensembleDetail?: EnsembleResult | null;
  // Model weights used for this forecast (either fixed defaults or DEB-adjusted).
  modelWeightsUsed?: DebWeights;
}

// ─── Open-Meteo fetch ─────────────────────────────────────

interface HourlyData {
  time: string[];
  temperature_2m: number[];
  cloudcover?: number[];
}

async function fetchOpenMeteo(
  station: StationConfig,
  model: "gfs_seamless" | "ecmwf_ifs025",
  targetDate: string,            // YYYY-MM-DD in station.tz
  forecastDays: number = 2,
): Promise<{ maxTemp: number; cloudCover: number } | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${station.lat}&longitude=${station.lon}` +
    `&hourly=temperature_2m,cloudcover` +
    `&models=${model}` +
    `&timezone=${encodeURIComponent(station.tz)}` +
    `&forecast_days=${forecastDays}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return null;
    const data = await res.json();
    const hourly: HourlyData = data.hourly;
    if (!hourly?.temperature_2m?.length || !Array.isArray(hourly.time)) return null;

    // Bug fix B: filter to the target date (in station tz) instead of taking
    // the global max across the whole multi-day window. Open-Meteo returns
    // local-time strings prefixed with YYYY-MM-DDT...
    const prefix = targetDate + "T";
    const idxs: number[] = [];
    for (let i = 0; i < hourly.time.length; i++) {
      if (typeof hourly.time[i] === "string" && hourly.time[i].startsWith(prefix)) {
        idxs.push(i);
      }
    }

    // If the target date isn't in the response (e.g. forecastDays too short
    // or date is past), fall back to global max so we don't silently 0-out.
    const tempIdxs = idxs.length > 0 ? idxs : hourly.temperature_2m.map((_, i) => i);

    let maxTemp = -Infinity;
    for (const i of tempIdxs) {
      const v = hourly.temperature_2m[i];
      if (typeof v === "number" && !isNaN(v) && v > maxTemp) maxTemp = v;
    }
    if (maxTemp === -Infinity) return null;

    const cloudVals = hourly.cloudcover
      ? tempIdxs.map(i => hourly.cloudcover![i]).filter(v => typeof v === "number" && !isNaN(v))
      : [];
    const cloudCover = cloudVals.length > 0
      ? cloudVals.reduce((a, b) => a + b, 0) / cloudVals.length
      : 50;

    return { maxTemp, cloudCover };
  } catch {
    return null;
  }
}

// ─── NOAA fetch (US cities only) ──────────────────────────

async function fetchNOAA(
  station: StationConfig,
  targetDate: string,            // YYYY-MM-DD in station.tz
): Promise<number | null> {
  // NOAA only works for US stations (Canada uses Environment Canada, not NOAA).
  const usTimezones = [
    "America/New_York", "America/Chicago", "America/Los_Angeles",
    "America/Denver",   "America/Phoenix",
  ];
  if (!usTimezones.includes(station.tz)) return null;

  try {
    // Step 1: get grid point
    const pointUrl = `https://api.weather.gov/points/${station.lat},${station.lon}`;
    const pointRes = await fetch(pointUrl, {
      headers: { "User-Agent": "EdgeCalc-AutoTrader/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!pointRes.ok) return null;
    const pointData = await pointRes.json();
    const forecastUrl = pointData.properties?.forecastHourly;
    if (!forecastUrl) return null;

    // Step 2: get hourly forecast
    const fcRes = await fetch(forecastUrl, {
      headers: { "User-Agent": "EdgeCalc-AutoTrader/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!fcRes.ok) return null;
    const fcData = await fcRes.json();
    const periods = fcData.properties?.periods;
    if (!Array.isArray(periods) || periods.length === 0) return null;

    // Filter periods to the target date in the station's local timezone.
    // NOAA's `startTime` is an ISO string with offset (e.g. "2026-05-09T13:00:00-04:00")
    // — comparing the date portion in local time gives us the right day.
    const targetDay = targetDate;
    const targetPeriods = periods.filter((p: any) => {
      if (typeof p.startTime !== "string") return false;
      const localDay = p.startTime.slice(0, 10); // ISO date portion
      return localDay === targetDay;
    });
    const usePeriods = targetPeriods.length > 0 ? targetPeriods : periods.slice(0, 48);

    let maxF = -Infinity;
    for (const p of usePeriods) {
      const temp = p.temperature;
      if (typeof temp === "number" && temp > maxF) maxF = temp;
    }

    if (maxF === -Infinity) return null;
    // Convert °F to °C
    return Math.round(((maxF - 32) * 5) / 9 * 10) / 10;
  } catch {
    return null;
  }
}

// ─── Ensemble logic ───────────────────────────────────────

function computeEnsemble(
  gfs: number | null,
  ecmwf: number | null,
  noaa: number | null,
  cloudCoverPct: number,
  debWeights: DebWeights,
): { ensemble: number; confidence: number; modelUsed: string } {
  const models: { name: string; value: number; weight: number }[] = [];

  // Base weight comes from DEB (Dynamic Error Balancing).
  // If DEB is bootstrapping (< threshold trades), getDebWeights() returns
  // the original fixed defaults, so this code path is unchanged for new
  // installs.
  // Cloud cover still modulates relative model weights slightly, since
  // ECMWF is historically stronger in cloudy/humid regimes.
  const isCloudy = cloudCoverPct > 60;
  const cloudBoostEcmwf = isCloudy ? 1.3 : 1.0;
  const cloudBoostGfs   = isCloudy ? 0.8 : 1.0;

  if (gfs   !== null) models.push({ name: "GFS",   value: gfs,   weight: debWeights.gfs   * cloudBoostGfs  });
  if (ecmwf !== null) models.push({ name: "ECMWF", value: ecmwf, weight: debWeights.ecmwf * cloudBoostEcmwf });
  if (noaa  !== null) models.push({ name: "NOAA",  value: noaa,  weight: debWeights.noaa });

  if (models.length === 0) {
    return { ensemble: 20, confidence: 0, modelUsed: "none" };
  }

  // Normalize weights
  const totalWeight = models.reduce((s, m) => s + m.weight, 0);
  const ensemble = models.reduce((s, m) => s + (m.value * m.weight) / totalWeight, 0);

  // Confidence based on model agreement
  const spread = models.length > 1
    ? Math.max(...models.map((m) => m.value)) - Math.min(...models.map((m) => m.value))
    : 2.0; // single model = lower confidence

  // spread < 1°C → high confidence, > 3°C → low confidence
  const confidence = Math.max(0.3, Math.min(0.95, 1.0 - spread / 5.0));

  const modelUsed = models.map((m) => m.name).join("+");

  return {
    ensemble: Math.round(ensemble * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    modelUsed,
  };
}

// ─── Main forecast function ───────────────────────────────

export interface ForecastOptions {
  // When true, applies the configured city_offset to the raw forecast.
  // Default false: Open-Meteo is queried at airport coordinates, so the
  // returned value is already station-relative — adding the offset on top
  // double-corrects and biases the prediction.
  applyCityOffset?: boolean;
  // Override forecast_days (1–7). Default: auto-computed from targetDate.
  forecastDays?: number;
  // Override the USE_ENSEMBLE env flag.
  useEnsemble?: boolean;
}

function autoForecastDays(targetDate: string): number {
  const ms = new Date(targetDate + "T12:00:00Z").getTime() - Date.now();
  const days = Math.ceil(ms / 86_400_000) + 1;
  return Math.max(2, Math.min(7, days));
}

export async function getForecast(
  city: string,
  station: StationConfig,
  targetDate: string, // YYYY-MM-DD
  opts: ForecastOptions = {},
): Promise<ForecastResult> {
  // Load DEB weights (per-city if available). Falls back to fixed defaults
  // when the city has < MIN_TRADES_FOR_DEB closed trades.
  const debWeights = await getDebWeights(city);

  const fcDays   = opts.forecastDays ?? autoForecastDays(targetDate);
  const wantEns  = opts.useEnsemble ?? ensembleEnabled();

  // Parallel fetch: GFS + ECMWF + NOAA always; ensemble only if enabled.
  const [gfsResult, ecmwfResult, noaaResult, ensembleResult] = await Promise.all([
    fetchOpenMeteo(station, "gfs_seamless", targetDate, fcDays),
    fetchOpenMeteo(station, "ecmwf_ifs025", targetDate, fcDays),
    fetchNOAA(station, targetDate),
    wantEns ? fetchEnsemble(station, targetDate) : Promise.resolve(null),
  ]);

  const gfsMax     = gfsResult?.maxTemp ?? null;
  const ecmwfMax   = ecmwfResult?.maxTemp ?? null;
  const cloudCover = gfsResult?.cloudCover ?? ecmwfResult?.cloudCover ?? 50;

  // Base ensemble (original GFS+ECMWF+NOAA path) — always computed so we
  // have a fallback and can log raw per-model outputs.
  const base = computeEnsemble(gfsMax, ecmwfMax, noaaResult, cloudCover, debWeights);

  let ensembleMaxC = base.ensemble;
  let confidence   = base.confidence;
  let modelUsed    = base.modelUsed;

  // If the 31-member GFS ensemble is available, prefer its distribution
  // (higher signal-to-noise than the fixed 2- or 3-model blend).
  if (ensembleResult && ensembleResult.memberCount >= 5) {
    ensembleMaxC = ensembleResult.dailyMaxMean;
    // Unanimity proxy: tighter stddev → higher confidence
    // stddev <= 0.5°C → 0.95 ; stddev >= 3°C → 0.30
    const sd = ensembleResult.dailyMaxStdDev;
    confidence = Math.max(0.30, Math.min(0.95, 1.0 - sd / 4.0));
    modelUsed = `GFS-ENS31(${ensembleResult.memberCount})+${base.modelUsed}`;
  }

  // Bug fix A: city_offset is only applied when explicitly requested.
  // Open-Meteo is queried at the station's airport coordinates, so the
  // returned forecast already represents station temp; adding the offset
  // double-corrects. METAR rounding (°C → °F → integer → °C) is always
  // applied because that *is* how Polymarket settles.
  const offsetToApply = opts.applyCityOffset ? station.city_offset : 0;
  const predictedMax = correctForecast(ensembleMaxC, offsetToApply);

  return {
    city,
    date: targetDate,
    predictedMaxC: predictedMax,
    rawGfsMaxC: gfsMax,
    rawEcmwfMaxC: ecmwfMax,
    rawNoaaMaxC: noaaResult,
    ensembleMaxC: parseFloat(ensembleMaxC.toFixed(2)),
    cloudCoverPct: Math.round(cloudCover),
    confidence,
    modelUsed,
    fetchedAt: new Date().toISOString(),
    ensembleDetail: ensembleResult,
    modelWeightsUsed: debWeights,
  };
}
