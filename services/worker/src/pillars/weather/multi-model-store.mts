// services/worker/src/pillars/weather/multi-model-store.mts
//
// B52 #1 — multi-model log-forward recorder (measurement only, zero trading
// effect). Each snapshot records, for one (station, target date) at one point
// in time: what every ensemble system said, what the POOLED mixture said, and
// what the bot ACTUALLY used that tick (the GEFS-only μ/σ). Once the date has
// passed, `obs` is filled with the realised daily max and the record becomes a
// scoreable head-to-head.
//
// WHY a forward log and not a backtest: Open-Meteo's historical-forecast API
// returns WeatherNext 2 only from ~2026-09-04 and has no AIFS-ENS archive at
// all, so the comparison CANNOT be reconstructed later (B50 #2 doctrine — same
// reason the OI and CLOB-book recorders exist). Every un-logged day is lost.
//
// Cost control: throttled per (station, date) — the systems refresh every 6–12 h,
// so the default 3 h cadence loses nothing while keeping the Open-Meteo call
// budget flat. The fetch itself is ~30 KB / ~0.2 s.
//
// obs is copied from the EMOS store, which already fills the realised daily max
// from METAR for every scanned station+date — deliberately NOT a second METAR
// fetch. Best-effort and non-throwing throughout: this must never affect a tick.

import { getStore } from "@netlify/blobs";
import { capSnapshots, dueForSnapshot } from "@core/market-recorder.mts";
import type { ModelStats } from "@core/multi-model-ensemble.mts";
import { loadResolvedObs } from "./emos-store.mts";

const STORE = "weather-multimodel";
const CAP = 400;                       // snapshots per station (rolling)
const DEFAULT_INTERVAL_MIN = 180;      // 3 h — systems update every 6–12 h

export interface MultiModelSnapshot {
  ts: number;                 // capture time (ms)
  date: string;               // target date (station-local), YYYY-MM-DD
  /** Hours from capture to 12:00 UTC on the target date. Lead-time bucket for
   *  the analysis; the UTC-noon convention keeps it comparable across stations. */
  leadHours: number;
  perModel: ModelStats[];     // per-system n / mean / sd
  pooledMean: number;         // equal-weight-per-model mixture μ
  pooledSd: number;           // ... and σ
  interModelSpread: number;   // population sd of the per-model means
  /** What the bot actually used this tick: the GEFS-only ensemble μ/σ, or null
   *  when that fetch failed (the heuristic σ fallback kicked in). This is the
   *  baseline the pooled numbers are scored against. */
  baseMean: number | null;
  baseSd: number | null;
  obs: number | null;         // realised daily max °C (copied from the EMOS store)
}

interface StationRecord {
  snapshots: MultiModelSnapshot[];
}

const keyFor = (station: string) => `v1:${station}`;

async function load(station: string): Promise<StationRecord> {
  try {
    const raw = await getStore(STORE).get(keyFor(station));
    if (!raw) return { snapshots: [] };
    const p = JSON.parse(raw as string);
    return { snapshots: Array.isArray(p?.snapshots) ? p.snapshots : [] };
  } catch {
    return { snapshots: [] };
  }
}

async function save(station: string, rec: StationRecord): Promise<void> {
  try { await getStore(STORE).set(keyFor(station), JSON.stringify(rec)); } catch { /* best-effort */ }
}

/** Recorder cadence in ms (`WEATHER_MULTIMODEL_INTERVAL_MIN`, default 180). */
export function recordIntervalMs(): number {
  const raw = parseFloat(process.env.WEATHER_MULTIMODEL_INTERVAL_MIN || "");
  const min = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MIN;
  return min * 60_000;
}

/**
 * Is a fresh snapshot due for this (station, date)? Throttles per target date,
 * so a newly-appearing market is captured immediately even when another date
 * was recorded a minute ago. Best-effort — returns false on any read error so
 * a broken store can never stall the tick.
 */
export async function isRecordDue(station: string, date: string, nowMs = Date.now()): Promise<boolean> {
  try {
    const rec = await load(station);
    return dueForSnapshot(rec.snapshots.filter((s) => s.date === date), nowMs, recordIntervalMs());
  } catch {
    return false;
  }
}

/** Append a snapshot (rolling cap). Best-effort, non-throwing. */
export async function recordSnapshot(
  station: string,
  snap: Omit<MultiModelSnapshot, "leadHours" | "obs">,
): Promise<void> {
  if (!station || !snap?.date || !Number.isFinite(snap.pooledMean)) return;
  try {
    const rec = await load(station);
    const noonUtc = Date.parse(`${snap.date}T12:00:00Z`);
    rec.snapshots.push({
      ...snap,
      leadHours: Number.isFinite(noonUtc)
        ? parseFloat(((noonUtc - snap.ts) / 3_600_000).toFixed(1))
        : 0,
      obs: null,
    });
    rec.snapshots = capSnapshots(rec.snapshots, CAP);
    await save(station, rec);
  } catch { /* swallow */ }
}

/**
 * Copy realised daily maxima from the EMOS store into pending snapshots
 * (obs === null). No extra METAR traffic — the EMOS reconciler already fetched
 * them. Best-effort, non-throwing.
 */
export async function fillObsFromEmos(station: string): Promise<{ filled: number }> {
  let filled = 0;
  try {
    const rec = await load(station);
    const pending = rec.snapshots.filter((s) => s.obs === null);
    if (pending.length === 0) return { filled: 0 };
    const obs = await loadResolvedObs(station);
    for (const snap of pending) {
      const v = obs[snap.date];
      if (typeof v === "number" && Number.isFinite(v)) { snap.obs = v; filled++; }
    }
    if (filled > 0) await save(station, rec);
  } catch { /* swallow */ }
  return { filled };
}

/** All snapshots for a station (oldest first). Read-only helper for analysis. */
export async function loadSnapshots(station: string): Promise<MultiModelSnapshot[]> {
  const rec = await load(station);
  return rec.snapshots;
}
