// netlify/functions/edge-tracker/calibration.mts
//
// Post-hoc probability calibration — model-discovery §7 #2, STEP 1
// (measurement only; does NOT touch live decisions yet).
//
// Maps a raw forecast P(win) → a calibrated probability learned from resolved
// outcomes. This absorbs the risk-neutral→physical measure gap and model bias
// empirically (the pragmatic substitute for estimating a pricing kernel).
//
// Method: PLATT scaling (sigmoid of a logit-linear transform), fit by
// gradient descent with Platt target-smoothing. Platt (not isotonic) is the
// deliberate choice at our sample size — the research is explicit that
// isotonic regression OVERFITS below ~1000 samples, while Platt is the
// low-data-appropriate calibrator. Isotonic/Venn-Abers is a ≥1000-outcome
// follow-up.
//
// Evaluation is strictly WALK-FORWARD (fit on past trades only, score the next
// one, advance) — the load-bearing anti-leakage rule from the research. A
// globally-fit calibrator scored in-sample would manufacture illusory gain on
// a tiny, non-stationary label set. We report raw vs calibrated Brier + log
// score so the operator can see whether calibration WOULD help, measured on
// the same proper-scoring metrics as harness #1 — with no live behaviour change.

import type { ClosedTrade } from "../auto-trader/shared/types.mts";
import { extractWinProbPairs } from "./statistics.mts";

const EPS = 1e-6;
const clip01 = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number) => { const c = clip01(p); return Math.log(c / (1 - c)); };
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logLoss = (p: number, y: number) => { const c = clip01(p); return -(y * Math.log(c) + (1 - y) * Math.log(1 - c)); };

export interface PlattModel { a: number; b: number; }   // calibrated = sigmoid(a·logit(p) + b); identity = {a:1,b:0}

/**
 * Fit a Platt (sigmoid) calibrator mapping raw P(win) → calibrated P(win).
 * Uses logit(p) as the feature so {a:1,b:0} is the identity map, and Platt
 * target-smoothing (Lin-Lin-Weng) so a perfectly-separated small sample does
 * not push weights to ±∞. Gradient descent, fixed iterations. Pure.
 * Returns the identity model when there are <4 pairs or only one class.
 */
export function fitPlatt(ps: number[], ys: number[], iterations = 600, lr = 0.3): PlattModel {
  const n = Math.min(ps.length, ys.length);
  if (n < 4) return { a: 1, b: 0 };
  const nPos = ys.reduce((s, y) => s + (y > 0.5 ? 1 : 0), 0);
  const nNeg = n - nPos;
  if (nPos === 0 || nNeg === 0) return { a: 1, b: 0 };   // one class → nothing to calibrate
  // Platt smoothed targets.
  const hiT = (nPos + 1) / (nPos + 2);
  const loT = 1 / (nNeg + 2);
  const z = ps.map(logit);
  const t = ys.map((y) => (y > 0.5 ? hiT : loT));
  let a = 1, b = 0;
  for (let iter = 0; iter < iterations; iter++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < n; i++) {
      const e = sigmoid(a * z[i] + b) - t[i];
      ga += e * z[i];
      gb += e;
    }
    a -= (lr * ga) / n;
    b -= (lr * gb) / n;
  }
  return { a, b };
}

/** Apply a Platt model to a raw probability. Pure. */
export function applyPlatt(p: number, m: PlattModel): number {
  return sigmoid(m.a * logit(p) + m.b);
}

export interface CalibrationEval {
  n: number;                 // # walk-forward test points scored
  minHistory: number;        // trades required before the first fit
  applicable: boolean;       // enough data to say anything
  rawBrier: number;
  calBrier: number;
  rawLogScore: number;
  calLogScore: number;
  brierImprovement: number;  // rawBrier − calBrier  (>0 ⇒ calibration helps)
  logImprovement: number;    // rawLogScore − calLogScore (>0 ⇒ helps)
  fit: PlattModel;           // full-sample fit (for the curve display only, NOT walk-forward)
  curve: { raw: number; cal: number }[];   // calibration map sampled across [0,1]
  message: string;
}

/**
 * Walk-forward calibration evaluation. For each trade i ≥ minHistory (in
 * chronological order), fit Platt on trades [0..i−1] and score the calibrated
 * forecast for trade i — never fitting on data at or after the point scored.
 * Reports raw vs calibrated Brier + log score. Pure.
 *
 * `trades` must be chronologically sorted (the edge-tracker sorts before
 * calling). The full-sample `fit`/`curve` are for visualising the shape only.
 */
export function computeCalibrationEval(trades: ClosedTrade[], minHistory = 20): CalibrationEval {
  const { ps, ys } = extractWinProbPairs(trades);
  const N = ps.length;
  const identity: PlattModel = { a: 1, b: 0 };
  const sampleCurve = (m: PlattModel) =>
    [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]
      .map((p) => ({ raw: p, cal: Math.round(applyPlatt(p, m) * 1e4) / 1e4 }));

  if (N < minHistory + 1) {
    return {
      n: 0, minHistory, applicable: false,
      rawBrier: 0, calBrier: 0, rawLogScore: 0, calLogScore: 0,
      brierImprovement: 0, logImprovement: 0,
      fit: identity, curve: sampleCurve(identity),
      message: `Need ${minHistory + 1 - N} more resolved forecasts before walk-forward calibration is meaningful.`,
    };
  }

  let rawBrier = 0, calBrier = 0, rawLog = 0, calLog = 0, count = 0;
  for (let i = minHistory; i < N; i++) {
    const m = fitPlatt(ps.slice(0, i), ys.slice(0, i));
    const raw = ps[i];
    const cal = applyPlatt(raw, m);
    const y = ys[i];
    rawBrier += (raw - y) ** 2;
    calBrier += (cal - y) ** 2;
    rawLog += logLoss(raw, y);
    calLog += logLoss(cal, y);
    count += 1;
  }
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const rB = rawBrier / count, cB = calBrier / count;
  const rL = rawLog / count, cL = calLog / count;
  const full = fitPlatt(ps, ys);

  const brierImprovement = rB - cB;
  const helps = brierImprovement > 0;
  const msg = helps
    ? `Walk-forward: calibration lowers Brier ${r4(rB)}→${r4(cB)} (−${(brierImprovement * 100).toFixed(1)}pp). Calibration would help — candidate for a coach-mode toggle once n grows.`
    : `Walk-forward: calibration does NOT improve Brier (${r4(rB)}→${r4(cB)}). Raw forecasts already well-calibrated on this sample, or n too small — do not wire into live decisions yet.`;

  return {
    n: count, minHistory, applicable: true,
    rawBrier: r4(rB), calBrier: r4(cB),
    rawLogScore: r4(rL), calLogScore: r4(cL),
    brierImprovement: r4(brierImprovement), logImprovement: r4(rL - cL),
    fit: { a: r4(full.a), b: r4(full.b) },
    curve: sampleCurve(full),
    message: msg,
  };
}
