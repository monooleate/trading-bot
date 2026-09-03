// packages/core/src/emos-seed.mts
//
// Offline EMOS seed — model-discovery-training §3.C / #5 (sprints.md B50). Pure,
// portable (zero I/O). The fetch + store orchestration lives in the worker
// (services/worker/src/pillars/weather/emos-seed.mts); these are the pure
// response parsers + sample builder so they are unit-tested.
//
// WHY: the weather EMOS calibrator (B49 #6) only fits once ≥20 forward residuals
// accumulate — so `weatherUseEmos` does nothing for weeks after deploy. But the
// systematic station bias (a city's forecast runs warm/cold) and the TRUE
// forecast-error spread (the underdispersion fix) are estimable from HISTORY now:
// Open-Meteo archives past model runs (multiple models → an inter-model spread,
// a legitimate ensemble-spread proxy) and ERA5 gives the realised daily max. We
// build (ensMean, ensStd, obs) triples from that and seed the SAME per-station
// store the forward pipeline uses, so the calibrator is fitted from day one.
//
// Honest caveat (why it is a SEED, not the truth): the inter-model historical
// spread is not the production ensemble's spread, and ERA5 is grid-cell not the
// exact METAR station — so the seed is DOWN-WEIGHTED by design: it lands on OLD
// dates and ages out of the rolling per-station window as forward-logged
// (production-matched, METAR-obs) residuals accumulate and replace it.

export interface SeedSample {
  date: string;
  ensMean: number;
  ensStd: number;
  obs: number;
}

/**
 * Parse an Open-Meteo `daily` block ({time:[...], [valueKey]:[...]}) into a
 * date→value map, dropping non-finite / mismatched entries. Pure.
 */
export function parseDailySeries(daily: any, valueKey: string): Map<string, number> {
  const out = new Map<string, number>();
  const times = daily?.time;
  const vals = daily?.[valueKey];
  if (!Array.isArray(times) || !Array.isArray(vals)) return out;
  const n = Math.min(times.length, vals.length);
  for (let i = 0; i < n; i++) {
    const t = times[i];
    const raw = vals[i];
    if (raw === null || raw === undefined) continue;  // Number(null)===0 would slip through
    const v = Number(raw);
    if (typeof t === "string" && t.length >= 8 && Number.isFinite(v)) out.set(t, v);
  }
  return out;
}

/**
 * Build seed samples by joining per-model historical-forecast series to the
 * realised series. For each date with a realised obs and ≥ `minModels` model
 * values, ensMean = mean across models, ensStd = population std across models
 * (the inter-model spread). Sorted by date. Pure.
 */
export function buildSeedSamples(
  modelSeries: Map<string, number>[],
  realized: Map<string, number>,
  minModels = 2,
): SeedSample[] {
  const out: SeedSample[] = [];
  for (const [date, obs] of realized) {
    if (!Number.isFinite(obs)) continue;
    const vals: number[] = [];
    for (const m of modelSeries) {
      const v = m.get(date);
      if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length < minModels) continue;
    const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
    const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length; // population
    out.push({ date, ensMean: mean, ensStd: Math.sqrt(variance), obs });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Inclusive YYYY-MM-DD window ending `endExclusiveDays` before today (default 1 —
 * yesterday, so today's incomplete day is excluded) spanning `months`. Pure given
 * `now`. Returns { start, end }.
 */
export function seedDateWindow(months: number, now: number = Date.now(), endExclusiveDays = 1): { start: string; end: string } {
  const day = 86_400_000;
  const end = new Date(now - endExclusiveDays * day);
  const start = new Date(end.getTime() - Math.max(1, months) * 30 * day);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}
