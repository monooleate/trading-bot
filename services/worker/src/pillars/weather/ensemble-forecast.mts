// netlify/functions/auto-trader/weather/ensemble-forecast.mts
// 31-member GFS ensemble fetch via Open-Meteo's dedicated ensemble API.
//
// Reference: suislanchez/polymarket-kalshi-weather-bot
// The ensemble endpoint returns `temperature_2m_member01` … `_member30` as
// separate hourly series — we compute each member's daily max and vote.
//
// Opt-in via USE_ENSEMBLE=true. On any fetch failure the caller falls back
// to the original GFS+ECMWF combination — this module never throws.

import type { StationConfig } from "./station-config.mts";
import {
  modelStatsForDate,
  parseModelList,
  DEFAULT_ENSEMBLE_MODELS,
  type MultiModelStats,
} from "@core/multi-model-ensemble.mts";

const TIMEOUT  = 9000;
const MAX_MEMBERS = 31;

// ─── Types ────────────────────────────────────────────────────────────────
export interface EnsembleMemberResult {
  memberIndex: number;
  dailyMaxC:   number;
}

export interface EnsembleResult {
  dailyMaxMean:   number;        // °C, mean across members
  dailyMaxStdDev: number;        // °C, sample stddev
  members:        EnsembleMemberResult[];
  memberCount:    number;        // how many members returned (usually 31)
  // Confidence when bucket threshold is specified:
  // |membersAbove/total - 0.5| × 2  → 1.0 unanimous, 0.0 coin-flip
  // Not pre-computed — call ensembleConfidence() on demand.
  rawDailyMaxMembers: number[];  // convenience: plain array of daily maxes
  source:         "open-meteo-ensemble" | "open-meteo-multi-model";
  fetchedAt:      string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/**
 * Given an ensemble result and a threshold bucket bound, return the voting
 * confidence: fraction of members above threshold.
 */
export function ensembleProbAbove(ens: EnsembleResult, thresholdC: number): number {
  const above = ens.rawDailyMaxMembers.filter(v => v >= thresholdC).length;
  return ens.memberCount > 0 ? above / ens.memberCount : 0.5;
}

/**
 * Unanimity-based confidence: 1.0 when all members agree on side,
 * 0.0 when 50/50 split.
 */
export function ensembleConfidence(ens: EnsembleResult, thresholdC: number): number {
  const p = ensembleProbAbove(ens, thresholdC);
  return Math.abs(p - 0.5) * 2;
}

/**
 * Fetch a 31-member GFS ensemble for the given station and extract daily
 * max temperatures for the target date.
 *
 * Returns null on any failure (network error, shape mismatch, empty members).
 * Never throws.
 */
export async function fetchEnsemble(
  station:   StationConfig,
  targetDate: string,  // YYYY-MM-DD in station.tz
): Promise<EnsembleResult | null> {
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble` +
    `?latitude=${station.lat}&longitude=${station.lon}` +
    `&hourly=temperature_2m` +
    `&models=gfs_seamless` +
    `&timezone=${encodeURIComponent(station.tz)}` +
    `&forecast_days=7`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const hourly = data?.hourly;
    if (!hourly || !Array.isArray(hourly.time)) return null;

    // Locate member column keys (temperature_2m_member01 … member30),
    // plus the base temperature_2m (the control run = member 0).
    const memberKeys: string[] = Object.keys(hourly).filter(k =>
      /^temperature_2m(_member\d+)?$/.test(k),
    );
    if (memberKeys.length === 0) return null;

    // Filter hourly rows to the target date in the station's tz
    const targetPrefix = targetDate + "T";
    const rowIndexes: number[] = [];
    for (let i = 0; i < hourly.time.length; i++) {
      if (typeof hourly.time[i] === "string" && hourly.time[i].startsWith(targetPrefix)) {
        rowIndexes.push(i);
      }
    }
    if (rowIndexes.length === 0) return null;

    const members: EnsembleMemberResult[] = [];
    for (const key of memberKeys.slice(0, MAX_MEMBERS)) {
      const series = hourly[key];
      if (!Array.isArray(series)) continue;
      let maxT = -Infinity;
      for (const idx of rowIndexes) {
        const v = series[idx];
        if (typeof v === "number" && !isNaN(v) && v > maxT) maxT = v;
      }
      if (maxT === -Infinity) continue;
      // Member index: 0 for control run, 1..30 for perturbed
      const m = key.match(/_member(\d+)$/);
      const memberIndex = m ? parseInt(m[1], 10) : 0;
      members.push({ memberIndex, dailyMaxC: parseFloat(maxT.toFixed(2)) });
    }

    if (members.length === 0) return null;

    const values = members.map(m => m.dailyMaxC);
    const mean   = values.reduce((s, v) => s + v, 0) / values.length;
    const sd     = stddev(values);

    return {
      dailyMaxMean:     parseFloat(mean.toFixed(2)),
      dailyMaxStdDev:   parseFloat(sd.toFixed(2)),
      members,
      memberCount:      members.length,
      rawDailyMaxMembers: values,
      source:           "open-meteo-ensemble",
      fetchedAt:        new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ─── Config helper ────────────────────────────────────────────────────────
export function ensembleEnabled(): boolean {
  return (process.env.USE_ENSEMBLE || "").toLowerCase() === "true";
}

// ─── B52 #1: multi-model ensemble ─────────────────────────────────────────
//
// Same endpoint, same key-free access — Open-Meteo serves several independent
// ensemble systems and accepts them comma-separated in ONE request (measured
// 2026-09-08: 197 members, ~30 KB, ~0.2 s). The bot has always asked for a
// single family (`gfs_seamless`), which measurably under-states σ by 2–3× at
// the T+0/T+1 lead times it trades. See @core/multi-model-ensemble.mts for the
// pooling rationale and packages/core/src/multi-model-ensemble.test.mts for the
// pinned maths.
//
// Uses `daily=temperature_2m_max` rather than deriving the max from `hourly`:
// verified numerically identical on all four models (Open-Meteo aggregates the
// same interpolated hourly series), at a fraction of the payload.

export interface MultiModelEnsembleResult extends EnsembleResult {
  /** Per-system breakdown — the whole point of the record. */
  perModel: MultiModelStats["perModel"];
  /** Population stddev of the per-model means: the uncertainty a single family cannot see. */
  interModelSpread: number;
  /** Model ids as REQUESTED (the response tags are Open-Meteo's internal domain names). */
  requested: string[];
}

/** Model list for the multi-model fetch: `WEATHER_ENSEMBLE_MODELS` or the four verified systems. */
export function multiModelList(): string[] {
  return parseModelList(process.env.WEATHER_ENSEMBLE_MODELS, DEFAULT_ENSEMBLE_MODELS);
}

/**
 * Fetch several ensemble systems in one request and reduce them to the
 * equal-weight-per-model mixture for `targetDate`.
 *
 * Shaped as an `EnsembleResult` so every existing consumer (σ, μ, member list)
 * works unchanged, plus the per-model breakdown. Returns null on any failure —
 * never throws, exactly like `fetchEnsemble`.
 */
export async function fetchMultiModelEnsemble(
  station: StationConfig,
  targetDate: string,               // YYYY-MM-DD in station.tz
  models: string[] = multiModelList(),
  forecastDays = 7,
): Promise<MultiModelEnsembleResult | null> {
  if (!models || models.length === 0) return null;
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble` +
    `?latitude=${station.lat}&longitude=${station.lon}` +
    `&daily=temperature_2m_max` +
    `&models=${encodeURIComponent(models.join(","))}` +
    `&timezone=${encodeURIComponent(station.tz)}` +
    `&forecast_days=${forecastDays}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const stats = modelStatsForDate(data?.daily, "temperature_2m_max", targetDate);
    if (!stats) return null;

    return {
      dailyMaxMean:   stats.pooled.mean,
      dailyMaxStdDev: stats.pooled.sd,
      // Member indices are meaningless across systems; kept for shape-compat.
      members:        stats.members.map((v, i) => ({ memberIndex: i, dailyMaxC: v })),
      memberCount:    stats.pooled.n,
      rawDailyMaxMembers: stats.members,
      source:         "open-meteo-multi-model",
      fetchedAt:      new Date().toISOString(),
      perModel:       stats.perModel,
      interModelSpread: stats.interModelSpread,
      requested:      models,
    };
  } catch {
    return null;
  }
}
