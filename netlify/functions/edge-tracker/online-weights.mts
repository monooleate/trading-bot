// netlify/functions/edge-tracker/online-weights.mts
//
// Online adaptive signal weighting — model-discovery §7 #4, STEP 1
// (measurement only; does NOT change the live combiner weights yet).
//
// The combiner uses STATIC IC weights (academic priors + Bayesian-shrunk
// realized IC). But per-signal IC drifts and FLIPS SIGN across regimes (a
// signal that predicts well in a bearish week predicts badly in a bullish one
// — documented repeatedly in the changelog). Prediction-with-expert-advice
// treats each signal as an "expert" and reweights continuously by realized
// loss.
//
// Algorithm: ADAHEDGE (de Rooij, van Erven, Grünwald, Koolen 2014) — a
// PARAMETER-FREE Hedge/multiplicative-weights variant that sets the learning
// rate η adaptively from the observed mixability gap. Parameter-free is the
// point: a hand-tuned η would be another degree of freedom to overfit on a
// tiny, non-stationary label set (the research's load-bearing warning).
//
// AdaHedge is INHERENTLY online/walk-forward: the weights it uses to predict
// round t depend only on rounds 0..t−1. So a single pass yields a leakage-free
// walk-forward comparison of static-IC-weighted vs AdaHedge-weighted combined
// forecasts, scored by Brier. Measurement only — nothing is fed to the live
// decision engine until the harness (#1) shows a gain and a coach-mode toggle
// is added.

import type { ClosedTrade } from "../auto-trader/shared/types.mts";

// Static IC priors — mirror of SIGNAL_ICS in signal-combiner.mts (kept local
// so this pure module has no Netlify-runtime import). Order is fixed.
const PRIORS: Record<string, number> = {
  vol_divergence: 0.06, orderflow: 0.09, apex_consensus: 0.08, cond_prob: 0.07,
  funding_rate: 0.05, momentum: 0.06, contrarian: 0.05, pairs_spread: 0.07,
};
const SIGNALS = Object.keys(PRIORS);

// YES-resolution (0/1) of a closed trade, direction-agnostic. Local copy of
// prediction-ledger's helper to keep this module dependency-light. Returns
// null on a push (pnl==0) or non-finite pnl.
function yesOutcome(t: any): number | null {
  const pnl = Number(t.pnl ?? t.pnlUSDC);
  if (!Number.isFinite(pnl) || pnl === 0) return null;
  const won = pnl > 0;
  const yesLike = t.direction === "YES" || t.direction === "LONG";
  return yesLike === won ? 1 : 0;
}

/** Stable Hedge weights ∝ exp(−η·L). η=∞ → uniform over the argmin set. Pure. */
export function hedgeWeights(L: number[], eta: number): number[] {
  const K = L.length;
  if (K === 0) return [];
  if (!Number.isFinite(eta)) {
    const mn = Math.min(...L);
    const mask = L.map((l): number => (l <= mn + 1e-12 ? 1 : 0));
    const s = mask.reduce((a, b) => a + b, 0) || 1;
    return mask.map((m) => m / s);
  }
  const mn = Math.min(...L);
  const e = L.map((l) => Math.exp(-eta * (l - mn)));
  const z = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((x) => x / z);
}

export interface AdaHedgeResult {
  weights: number[];         // final weights over experts
  trajectory: number[][];    // trajectory[t] = weights used to PREDICT round t (from rounds 0..t−1)
  cumLoss: number[];         // final cumulative per-expert loss
}

/**
 * AdaHedge over a loss matrix (rows = rounds, cols = experts; each loss in
 * [0,1]). Returns the final weights, the pre-round weight trajectory (for
 * walk-forward scoring), and cumulative losses. Pure.
 */
export function adaHedge(lossMatrix: number[][]): AdaHedgeResult {
  const T = lossMatrix.length;
  const K = T > 0 ? lossMatrix[0].length : 0;
  const L = new Array(K).fill(0);
  const trajectory: number[][] = [];
  let Delta = 0;
  for (let t = 0; t < T; t++) {
    const eta = Delta > 0 ? Math.log(Math.max(2, K)) / Delta : Infinity;
    const w = hedgeWeights(L, eta);
    trajectory.push(w);
    const ell = lossMatrix[t];
    const h = w.reduce((s, wk, k) => s + wk * ell[k], 0);           // Hedge (mean) loss
    let m: number;                                                  // mix loss
    if (!Number.isFinite(eta)) {
      m = Math.min(...ell);
    } else {
      const minE = Math.min(...ell);
      let z = 0;
      for (let k = 0; k < K; k++) z += w[k] * Math.exp(-eta * (ell[k] - minE));
      m = minE - Math.log(z || 1e-300) / eta;
    }
    Delta += Math.max(0, h - m);                                    // mixability gap
    for (let k = 0; k < K; k++) L[k] += ell[k];
  }
  const etaFinal = Delta > 0 ? Math.log(Math.max(2, K)) / Delta : Infinity;
  return { weights: hedgeWeights(L, etaFinal), trajectory, cumLoss: L };
}

export interface OnlineWeightEval {
  n: number;                 // walk-forward test rounds scored
  minHistory: number;
  applicable: boolean;
  staticBrier: number;       // IC-prior-weighted combined forecast
  adaptiveBrier: number;     // AdaHedge-weighted combined forecast (walk-forward)
  brierImprovement: number;  // static − adaptive (>0 ⇒ adaptive helps)
  weights: { signal: string; prior: number; adaptive: number }[];  // final normalized weights
  message: string;
}

/**
 * Walk-forward comparison of static-IC vs AdaHedge signal weighting, scored by
 * Brier on the YES-outcome. Each signal's per-round value is its P(YES) from
 * signalBreakdown; a signal absent that round is treated as 0.5 (neutral) so
 * the expert set stays fixed — a documented approximation, immaterial while
 * most signals fire most rounds. Pure; `trades` must be chronologically sorted.
 */
export function computeOnlineWeightEval(trades: ClosedTrade[], minHistory = 20): OnlineWeightEval {
  // Build aligned rounds: per-signal values + YES-outcome.
  const rows: { vals: number[]; y: number }[] = [];
  for (const t of trades) {
    const sb: any = (t as any).signalBreakdown;
    if (!sb) continue;
    const y = yesOutcome(t);
    if (y === null) continue;
    const vals = SIGNALS.map((s) => {
      const v = sb[s];
      return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
    });
    rows.push({ vals, y });
  }
  const N = rows.length;
  const priorSum = SIGNALS.reduce((s, k) => s + PRIORS[k], 0);
  const priorW = SIGNALS.map((k) => PRIORS[k] / priorSum);
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

  if (N < minHistory + 1) {
    return {
      n: 0, minHistory, applicable: false,
      staticBrier: 0, adaptiveBrier: 0, brierImprovement: 0,
      weights: SIGNALS.map((s, i) => ({ signal: s, prior: r4(priorW[i]), adaptive: r4(priorW[i]) })),
      message: `Need ${minHistory + 1 - N} more resolved forecasts (with signal breakdowns) before online weighting is meaningful.`,
    };
  }

  const lossMatrix = rows.map((row) => row.vals.map((v) => (v - row.y) ** 2));
  const ada = adaHedge(lossMatrix);

  let staticBrier = 0, adaptiveBrier = 0, count = 0;
  for (let t = minHistory; t < N; t++) {
    const { vals, y } = rows[t];
    const wAda = ada.trajectory[t];                                 // online: from rounds 0..t−1
    const fStatic = vals.reduce((s, v, k) => s + priorW[k] * v, 0);
    const fAda = vals.reduce((s, v, k) => s + wAda[k] * v, 0);
    staticBrier += (fStatic - y) ** 2;
    adaptiveBrier += (fAda - y) ** 2;
    count += 1;
  }
  const sB = staticBrier / count, aB = adaptiveBrier / count;
  const improvement = sB - aB;
  const helps = improvement > 0;

  return {
    n: count, minHistory, applicable: true,
    staticBrier: r4(sB), adaptiveBrier: r4(aB), brierImprovement: r4(improvement),
    weights: SIGNALS.map((s, i) => ({ signal: s, prior: r4(priorW[i]), adaptive: r4(ada.weights[i]) })),
    message: helps
      ? `Walk-forward: AdaHedge weighting lowers Brier ${r4(sB)}→${r4(aB)} (−${(improvement * 100).toFixed(1)}pp). Adaptive reweighting would help — candidate for a coach-mode toggle.`
      : `Walk-forward: AdaHedge does NOT beat static IC weights (${r4(sB)}→${r4(aB)}). Static priors adequate on this sample, or n too small — keep static weights.`,
  };
}
