// packages/core/src/multi-model-eval.mts
//
// Scoring for the B52 #1 head-to-head: is the multi-system mixture (μ, σ) a
// better probabilistic forecast than the single-family GEFS ensemble the bot
// uses today? Pure — the I/O lives in scripts/eval-multimodel.ts.
//
// The decision this feeds is NOT "which mean is closer" (a point score would
// miss the whole argument). It is "which distribution is honest", so the table
// leads with CRPS (the proper score for a Gaussian forecast) and the VARIANCE
// RATIO — mean(error²) / mean(σ²):
//
//     ratio ≈ 1  → σ is right-sized
//     ratio > 1  → UNDER-dispersed: σ too narrow, Kelly oversizes  ← the documented bug
//     ratio < 1  → over-dispersed: σ too wide, Kelly under-bets
//
// A variant can have a worse MAE and still be the one to ship, if it is the one
// whose σ tells the truth: the weather bot's problem is sizing, not direction
// (forecast_edge IC +0.393, payoffRatio 0.44).

import { gaussianCrps } from "./emos.mts";

export interface ScoredSample {
  mean: number;   // forecast μ (°C)
  sd: number;     // forecast σ (°C)
  obs: number;    // realised daily max (°C)
}

export interface ForecastScore {
  n: number;
  bias: number;          // mean(μ − obs) — signed
  mae: number;
  rmse: number;
  crps: number;          // mean Gaussian CRPS (lower is better)
  meanSd: number;        // mean forecast σ — what the model CLAIMED
  varianceRatio: number; // mean(err²)/mean(σ²); >1 ⇒ under-dispersed
  cover1Sd: number;      // fraction with |err| ≤ σ   (well-calibrated ≈ 0.68)
  cover2Sd: number;      // fraction with |err| ≤ 2σ  (well-calibrated ≈ 0.95)
}

const round = (v: number, dp = 3) => parseFloat(v.toFixed(dp));

/**
 * Score a set of (μ, σ, obs) triples. Samples with a non-finite field are
 * dropped; σ ≤ 0 is dropped from the dispersion statistics but kept for the
 * point scores. Returns null when nothing usable remains. Pure.
 */
export function scoreForecasts(samples: ScoredSample[]): ForecastScore | null {
  const clean = (samples ?? []).filter(
    (s) => Number.isFinite(s?.mean) && Number.isFinite(s?.obs) && Number.isFinite(s?.sd),
  );
  if (clean.length === 0) return null;

  let sumErr = 0, sumAbs = 0, sumSq = 0, sumCrps = 0, sumSd = 0;
  let sumVar = 0, nVar = 0, in1 = 0, in2 = 0;

  for (const s of clean) {
    const err = s.mean - s.obs;
    sumErr += err;
    sumAbs += Math.abs(err);
    sumSq += err * err;
    sumCrps += gaussianCrps(s.mean, s.sd, s.obs);
    sumSd += s.sd;
    if (s.sd > 0) {
      sumVar += s.sd * s.sd;
      nVar++;
      if (Math.abs(err) <= s.sd) in1++;
      if (Math.abs(err) <= 2 * s.sd) in2++;
    }
  }

  const n = clean.length;
  const meanVar = nVar > 0 ? sumVar / nVar : 0;
  return {
    n,
    bias: round(sumErr / n),
    mae: round(sumAbs / n),
    rmse: round(Math.sqrt(sumSq / n)),
    crps: round(sumCrps / n),
    meanSd: round(sumSd / n),
    varianceRatio: meanVar > 0 ? round(sumSq / n / meanVar) : 0,
    cover1Sd: nVar > 0 ? round(in1 / nVar) : 0,
    cover2Sd: nVar > 0 ? round(in2 / nVar) : 0,
  };
}

/**
 * CRPS skill of `candidate` against `baseline`: 1 − crps_cand/crps_base.
 * Positive ⇒ the candidate is the better probabilistic forecast. Returns null
 * when either side is missing or the baseline CRPS is degenerate. Pure.
 */
export function crpsSkill(candidate: ForecastScore | null, baseline: ForecastScore | null): number | null {
  if (!candidate || !baseline || !(baseline.crps > 0)) return null;
  return round(1 - candidate.crps / baseline.crps, 4);
}

/**
 * How far a variant's dispersion is from honest, as a plain verdict. The
 * thresholds are deliberately loose — this is a read-out for an operator
 * deciding whether to flip a knob, not a hypothesis test.
 */
export function dispersionVerdict(score: ForecastScore | null): "under" | "over" | "calibrated" | "insufficient" {
  if (!score || score.n < 10 || !(score.varianceRatio > 0)) return "insufficient";
  if (score.varianceRatio > 1.3) return "under";
  if (score.varianceRatio < 0.7) return "over";
  return "calibrated";
}
