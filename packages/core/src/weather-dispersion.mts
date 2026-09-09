// packages/core/src/weather-dispersion.mts
//
// P0-1 (system audit, 2026-09-09) — weather forecast DISPERSION correction.
//
// WHY THIS EXISTS
// ---------------
// The weather pillar hands the bucket matcher a Gaussian (μ, σ). σ comes from
// the 31-member GEFS ensemble stddev, floored at 0.5 °C. Measured against the
// FORWARD half of the EMOS residual store (live METAR observations vs the GEFS
// mean the bot actually used, n = 35):
//
//     mean( err² / σ² )  =  10.04        ← 1.0 would be calibrated
//     median var-ratio   =   1.44        ← vs 0.455 expected for χ²₁
//
// i.e. σ is too small by roughly 1.8× (median, outlier-robust) to 3.2× (mean).
// An ensemble's spread measures the disagreement of its own perturbations; it
// does not see structural model error, so it is systematically overconfident.
// The 0.5 °C floor makes it worse where it binds — the two stations whose
// errors were most one-sided (ZSPD +1.7…+2.8 °C over n=5, RKSS +2.3…+2.8 over
// n=3) are both floored stations.
//
// The consequence is not a wrong direction, it is misplaced conviction: at
// σ = 0.5 a bucket 1.55 °C from μ scores ~1.6%, and the bot sizes ¼-Kelly
// against that near-certainty. Its single worst loss bucket on real trades was
// predictions in [0, 0.15) — n = 7, mean 0.104, realised YES 71.4%, −$20.68.
//
// WHAT THIS IS NOT
// ----------------
// Widening σ is HARM REDUCTION, not edge. It is a monotone transform, so it
// cannot change the sign of corr(prediction, outcome) — measured at −0.316 on
// n = 28 entry-time rows. Simulated on those same rows, λ = 2.0 moves Brier
// 0.3513 → 0.2969 and realised PnL −$11.82 → −$2.96, but Brier stays ABOVE the
// 0.25 of a constant 0.5. This fixes overconfidence. It does not make the
// weather bot profitable, and it must not be described as if it did.
//
// DEFAULT IS OFF (factor 1.0 = exact identity). Per the project's measure-first
// doctrine a behaviour change ships behind a knob the operator flips.

import { gaussianCrps, normalCdf } from "./emos.mts";
import { selectPlateau } from "./plateau.mts";

/** One scored forecast: what the ensemble said, and what actually happened. */
export interface DispersionSample {
  ensMean: number;
  ensStd: number;
  obs: number;
}

export const SIGMA_INFLATION_MIN = 1.0;
export const SIGMA_INFLATION_MAX = 4.0;

/**
 * Scale a forecast σ by `factor`, clamped to [1, 4].
 *
 * `factor = 1` returns σ unchanged — bit-identical, so the knob's default is a
 * true no-op rather than an approximate one. A non-finite or sub-1 factor is
 * treated as 1 (never SHRINK σ: every measurement says the model is already
 * overconfident, so shrinking could only deepen the documented failure).
 */
export function inflateSigma(sigma: number, factor: number): number {
  if (!Number.isFinite(sigma) || sigma <= 0) return sigma;
  if (!Number.isFinite(factor) || factor <= SIGMA_INFLATION_MIN) return sigma;
  const f = Math.min(SIGMA_INFLATION_MAX, factor);
  return sigma * f;
}

export interface DispersionDiagnostics {
  n: number;
  /** mean(err²/σ²). 1.0 = calibrated, >1 = overconfident (σ too small). */
  varRatio: number;
  /** Median of the same ratio — outlier-robust; 0.455 = calibrated (χ²₁ median). */
  medianVarRatio: number;
  /** Mean CRPS in °C. Lower is better. Proper. */
  meanCrps: number;
  /** Mean negative log predictive density. Lower is better. Punishes confident misses. */
  meanLogScore: number;
  /** Kolmogorov–Smirnov distance of the PIT values from U(0,1). Lower is better. */
  pitKs: number;
  /** Mean signed error (obs − μ) in °C — a BIAS diagnostic, untouched by σ. */
  meanBias: number;
}

/** χ²₁ median — the value `medianVarRatio` takes for a perfectly calibrated Gaussian. */
export const CALIBRATED_MEDIAN_VAR_RATIO = 0.4549364;

/**
 * Score a set of realised forecasts under a candidate σ multiplier.
 *
 * Deliberately reports FOUR views. They disagree, and the disagreement is the
 * point: CRPS is in °C and is dominated by μ error, so it moves little; the
 * log score and the variance ratio are the ones that see dispersion, which is
 * the defect being measured. Picking a factor off CRPS alone would understate
 * the correction, and off the log score alone would overstate it.
 */
export function dispersionDiagnostics(
  samples: readonly DispersionSample[],
  factor = 1,
): DispersionDiagnostics {
  const rows = (samples ?? []).filter(
    (s) =>
      s != null &&
      Number.isFinite(s.ensMean) &&
      Number.isFinite(s.obs) &&
      Number.isFinite(s.ensStd) &&
      s.ensStd > 0,
  );
  const n = rows.length;
  if (n === 0) {
    return { n: 0, varRatio: NaN, medianVarRatio: NaN, meanCrps: NaN, meanLogScore: NaN, pitKs: NaN, meanBias: NaN };
  }

  let crpsSum = 0, logSum = 0, ratioSum = 0, biasSum = 0;
  const ratios: number[] = [];
  const pits: number[] = [];

  for (const s of rows) {
    const sd = inflateSigma(s.ensStd, factor);
    const err = s.obs - s.ensMean;
    const z = err / sd;
    crpsSum += gaussianCrps(s.ensMean, sd, s.obs);
    logSum += 0.5 * Math.log(2 * Math.PI * sd * sd) + 0.5 * z * z;
    const ratio = (err * err) / (sd * sd);
    ratioSum += ratio;
    ratios.push(ratio);
    biasSum += err;
    pits.push(normalCdf(z));
  }

  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const medianVarRatio =
    ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;

  pits.sort((a, b) => a - b);
  let pitKs = 0;
  for (let i = 0; i < pits.length; i++) {
    pitKs = Math.max(pitKs, Math.abs(pits[i] - (i + 0.5) / pits.length));
  }

  return {
    n,
    varRatio: ratioSum / n,
    medianVarRatio,
    meanCrps: crpsSum / n,
    meanLogScore: logSum / n,
    pitKs,
    meanBias: biasSum / n,
  };
}

export const DEFAULT_INFLATION_GRID = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 3.5, 4.0];

export interface InflationSuggestion {
  /** Recommended multiplier — the PLATEAU centre, not the peak (B50 #7 discipline). */
  factor: number;
  /** The single best-scoring grid point, for contrast. */
  peakFactor: number;
  /** How many contiguous grid points were within tolerance of the best. */
  plateauWidth: number;
  /** True when the best score is an isolated spike — treat the result as fragile. */
  isPeak: boolean;
  n: number;
  baseline: DispersionDiagnostics;
  recommended: DispersionDiagnostics;
}

/**
 * Recommend a σ multiplier from realised forecasts.
 *
 * Scored on the mean log score, because the failure mode is confidently-wrong
 * extreme probabilities and the log score is the proper score that punishes
 * exactly that. The winner is then chosen with `selectPlateau` rather than
 * argmax, so an isolated spike on a small sample cannot become the default —
 * the same discipline the regularisation-budget work (B50 #7) established.
 *
 * Returns null below `minSamples`; n = 35 is already thin and the caller must
 * be able to tell "no recommendation" from "no correction needed".
 */
export function suggestSigmaInflation(
  samples: readonly DispersionSample[],
  opts: { grid?: readonly number[]; minSamples?: number } = {},
): InflationSuggestion | null {
  const grid = opts.grid ?? DEFAULT_INFLATION_GRID;
  const minSamples = opts.minSamples ?? 20;

  const baseline = dispersionDiagnostics(samples, 1);
  if (!Number.isFinite(baseline.n) || baseline.n < minSamples) return null;

  const candidates = grid.map((value) => ({
    value,
    score: -dispersionDiagnostics(samples, value).meanLogScore, // higher = better
    n: baseline.n,
  }));

  const plateau = selectPlateau(candidates);
  if (!plateau) return null;

  return {
    factor: plateau.value,
    peakFactor: plateau.peakValue,
    plateauWidth: plateau.plateauWidth,
    isPeak: plateau.isPeak,
    n: baseline.n,
    baseline,
    recommended: dispersionDiagnostics(samples, plateau.value),
  };
}
