// netlify/functions/auto-trader/shared/online-weights.test.mts
//
// Regression guard for the #4 online adaptive weighting (AdaHedge) measurement
// layer. Lives under auto-trader/shared/ so a *.test.mts never deploys as its
// own Netlify function. Imports the REAL module (../../edge-tracker/
// online-weights.mts — type-only import, no Netlify runtime deps).
//
// Run: npx tsx netlify/functions/auto-trader/shared/online-weights.test.mts

import {
  hedgeWeights,
  adaHedge,
  computeOnlineWeightEval,
} from "../../edge-tracker/online-weights.mts";
import type { ClosedTrade } from "./types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

// ── hedgeWeights: η=∞ argmin, uniform ties, finite softmax ──────────────────
{
  const t = "hedgeWeights";
  // η=∞, distinct minima → all weight on the argmin.
  const w1 = hedgeWeights([2, 1, 3], Infinity);
  expect(approx(w1[1], 1) && approx(w1[0], 0) && approx(w1[2], 0), t, `argmin gets all weight, got ${JSON.stringify(w1)}`);
  // η=∞, tie → uniform over the tied minima.
  const w2 = hedgeWeights([1, 1, 3], Infinity);
  expect(approx(w2[0], 0.5) && approx(w2[1], 0.5) && approx(w2[2], 0), t, `tie → split, got ${JSON.stringify(w2)}`);
  // finite η: normalized, lower loss → higher weight.
  const w3 = hedgeWeights([0, 1], 1);
  expect(approx(sum(w3), 1) && w3[0] > w3[1], t, `finite softmax, got ${JSON.stringify(w3)}`);
}

// ── adaHedge: favors the consistently-best expert; trajectory is online ─────
{
  const t = "adaHedge";
  // 3 experts, expert 0 always best (loss 0), others lossy.
  const T = 40;
  const lossMatrix = Array.from({ length: T }, () => [0.0, 0.5, 0.4]);
  const r = adaHedge(lossMatrix);
  expect(r.trajectory.length === T, t, `trajectory length T, got ${r.trajectory.length}`);
  // First round: no history → uniform.
  expect(approx(r.trajectory[0][0], 1 / 3), t, `first weights uniform, got ${JSON.stringify(r.trajectory[0])}`);
  // Final: expert 0 dominates.
  expect(r.weights[0] > 0.9, t, `best expert dominates, got ${JSON.stringify(r.weights.map((x) => +x.toFixed(3)))}`);
  expect(approx(sum(r.weights), 1), t, "weights normalized");
}

// ── computeOnlineWeightEval: insufficient data ──────────────────────────────
function trade(y: number, breakdown: Record<string, number>): ClosedTrade {
  return {
    market: "m", direction: "YES", entryPrice: 0.5, exitPrice: y ? 1 : 0,
    shares: 10, pnl: y ? 1 : -1, pnlPct: y ? 10 : -10,
    openedAt: "2026-01-01T00:00:00Z", closedAt: "2026-01-01T01:00:00Z",
    predictedProb: 0.5, signalBreakdown: breakdown as any,
  };
}
{
  const t = "eval-insufficient";
  const few = Array.from({ length: 10 }, (_, i) => trade(i % 2, { orderflow: 0.6 }));
  const r = computeOnlineWeightEval(few, 20);
  expect(r.applicable === false && r.n === 0, t, `n<minHistory+1 → not applicable, got ${r.applicable}`);
  expect(r.weights.length === 8, t, `still lists 8 signals, got ${r.weights.length}`);
}

// ── computeOnlineWeightEval: AdaHedge beats static when one signal is best ───
{
  const t = "eval-adaptive-wins";
  // orderflow perfectly tracks the outcome; the other 7 signals are noise (0.5).
  const N = 80;
  const trades: ClosedTrade[] = [];
  for (let i = 0; i < N; i++) {
    const y = i % 2;                       // base rate 0.5
    trades.push(trade(y, {
      orderflow: y ? 0.99 : 0.01,          // oracle signal
      vol_divergence: 0.5, apex_consensus: 0.5, cond_prob: 0.5,
      funding_rate: 0.5, momentum: 0.5, contrarian: 0.5, pairs_spread: 0.5,
    }));
  }
  const r = computeOnlineWeightEval(trades, 20);
  expect(r.applicable === true && r.n === N - 20, t, `walk-forward scored n=${r.n}`);
  expect(r.brierImprovement > 0, t, `AdaHedge improves Brier (static=${r.staticBrier} adaptive=${r.adaptiveBrier})`);
  expect(r.adaptiveBrier < r.staticBrier, t, "adaptive Brier < static Brier");
  // AdaHedge should upweight orderflow far above its static prior.
  const of = r.weights.find((w) => w.signal === "orderflow")!;
  expect(of.adaptive > of.prior, t, `orderflow adaptive(${of.adaptive}) > prior(${of.prior})`);
  expect(/would help/i.test(r.message), t, `positive message, got "${r.message}"`);
}

// ── neutral case: all signals equally useless → no false improvement ────────
{
  const t = "eval-no-edge";
  const N = 60;
  const trades: ClosedTrade[] = [];
  for (let i = 0; i < N; i++) {
    // every signal 0.5 regardless of outcome → nothing to learn.
    trades.push(trade(i % 2, {
      orderflow: 0.5, vol_divergence: 0.5, apex_consensus: 0.5, cond_prob: 0.5,
      funding_rate: 0.5, momentum: 0.5, contrarian: 0.5, pairs_spread: 0.5,
    }));
  }
  const r = computeOnlineWeightEval(trades, 20);
  // Both forecasts are 0.5 → identical Brier, ~zero improvement (no spurious gain).
  expect(Math.abs(r.brierImprovement) < 1e-6, t, `no spurious gain, got ${r.brierImprovement}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("online-weights.test.mts") || entry.endsWith("online-weights.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("online-weights.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`online-weights.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
