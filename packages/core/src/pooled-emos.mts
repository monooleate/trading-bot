// packages/core/src/pooled-emos.mts
//
// B69 step 2 — the multi-model mixture's OWN EMOS calibration. Pure, zero I/O.
//
// WHY: the live EMOS store (`weather-emos`) is fitted per station on the
// GEFS-only ensemble's (μ, σ) — ~181 seeded + forward residuals each. Applying
// those GEFS-fitted maps to the pooled mixture after the `weatherUseMultiModel`
// flip is a calibration of the wrong forecast. Measured on the forward log
// (2026-09-09 → 09-27, 224 station-days): the pool carries a +0.79 °C warm
// residual (obs − μ; the ECMWF systems' documented cold bias) that the
// GEFS-fitted EMOS leaves at +0.59, and pool + GEFS-EMOS scored WORSE than the
// retuned GEFS path. With a calibration fitted on the POOL itself, the pool won
// out of sample in both directions of a date split.
//
// Design (the one that was measured): per station there are only ~12 labelled
// station-days, below EMOS's 20-sample floor, so the (a, b, c, d) map is fitted
// GLOBALLY across stations, and each station gets an additive bias from its own
// residuals, shrunk toward 0 with K pseudo-samples. One sample per
// (station, target date, lead-day): the latest snapshot in the bucket, so
// correlated re-snapshots of one forecast are not counted several times.

import { fitEmos, emosApply, type EmosFit } from "./emos.mts";

export interface PooledCalibrationInput {
  station: string;
  ts: number;         // capture time (ms)
  date: string;       // target date
  leadHours: number;  // capture → 12:00 UTC on the target date
  mean: number;       // pooled μ (°C), BEFORE any correction
  sd: number;         // pooled σ (°C)
  obs: number | null; // realised daily max (°C)
}

export interface PooledEmosModel {
  fit: EmosFit;
  stationBias: Record<string, number>;
  n: number;
  stations: number;
  fittedAt: string;
}

export interface PooledEmosOpts {
  /** Lead-time window in hours (the bot trades T+0 / T+1). Default 48. */
  maxLeadHours?: number;
  /** Minimum samples for a fitted map (EMOS's own floor). Default 20. */
  minSamples?: number;
  /** Pseudo-samples shrinking each station bias toward 0. Default 5. */
  biasK?: number;
  /** σ floor applied before calibration — the live runner's 0.5 °C. */
  sdFloor?: number;
  /** μ transform applied before calibration — live: METAR rounding. */
  transformMean?: (mu: number) => number;
}

/** One sample per (station, date, lead-day): the latest snapshot in each bucket. */
export function selectCalibrationRows(
  rows: PooledCalibrationInput[],
  maxLeadHours = 48,
): PooledCalibrationInput[] {
  const last = new Map<string, PooledCalibrationInput>();
  for (const r of rows ?? []) {
    if (r.obs === null || !Number.isFinite(r.obs)) continue;
    if (!(r.leadHours >= 0 && r.leadHours <= maxLeadHours)) continue;
    if (!Number.isFinite(r.mean) || !Number.isFinite(r.sd) || r.sd < 0) continue;
    const k = `${r.station}|${r.date}|${Math.floor(r.leadHours / 24)}`;
    const prev = last.get(k);
    if (!prev || r.ts > prev.ts) last.set(k, r);
  }
  return [...last.values()];
}

export function fitPooledEmos(rows: PooledCalibrationInput[], opts: PooledEmosOpts = {}): PooledEmosModel {
  const sdFloor = opts.sdFloor ?? 0.5;
  const tf = opts.transformMean ?? ((x: number) => x);
  const K = opts.biasK ?? 5;
  const sel = selectCalibrationRows(rows, opts.maxLeadHours ?? 48);

  const fit = fitEmos(
    sel.map((r) => ({ ensMean: tf(r.mean), ensStd: Math.max(sdFloor, r.sd), obs: r.obs as number })),
    { minSamples: opts.minSamples ?? 20 },
  );

  const stationBias: Record<string, number> = {};
  if (fit.fitted) {
    const sums = new Map<string, { s: number; n: number }>();
    for (const r of sel) {
      const mu = emosApply(fit, tf(r.mean), Math.max(sdFloor, r.sd), fit.varFloor).mu;
      const acc = sums.get(r.station) ?? { s: 0, n: 0 };
      acc.s += (r.obs as number) - mu;
      acc.n += 1;
      sums.set(r.station, acc);
    }
    for (const [st, { s, n }] of sums) stationBias[st] = s / (n + K);
  }

  return {
    fit,
    stationBias,
    n: sel.length,
    stations: new Set(sel.map((r) => r.station)).size,
    fittedAt: new Date().toISOString(),
  };
}

/**
 * Calibrate a pooled (μ, σ). An unfitted model returns the input unchanged
 * (with the σ floor) — i.e. the raw mixture, never the GEFS-fitted map.
 */
export function applyPooledEmos(
  model: PooledEmosModel | null,
  station: string,
  mu: number,
  sd: number,
  sdFloor = 0.5,
): { mu: number; sigma: number; calibrated: boolean } {
  const s = Math.max(sdFloor, sd);
  if (!model || !model.fit.fitted) return { mu, sigma: s, calibrated: false };
  const cal = emosApply(model.fit, mu, s, model.fit.varFloor);
  return { mu: cal.mu + (model.stationBias[station] ?? 0), sigma: cal.sigma, calibrated: true };
}
