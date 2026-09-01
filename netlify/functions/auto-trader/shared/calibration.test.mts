// netlify/functions/auto-trader/shared/calibration.test.mts
//
// Regression guard for the post-hoc calibration layer (model-discovery §7 #2,
// measurement step). Lives under auto-trader/shared/ so a *.test.mts never
// deploys as its own Netlify function. Imports the REAL module
// (../../edge-tracker/calibration.mts — type-only + statistics import, no
// Netlify runtime deps) so it pins shipped code.
//
// Run: npx tsx netlify/functions/auto-trader/shared/calibration.test.mts

import {
  fitPlatt,
  applyPlatt,
  computeCalibrationEval,
} from "../../edge-tracker/calibration.mts";
import type { ClosedTrade } from "./types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

function trade(predictedProb: number, win: boolean, direction: "YES" | "NO" = "YES"): ClosedTrade {
  return {
    market: "m", direction, entryPrice: 0.5, exitPrice: win ? 1 : 0,
    shares: 10, pnl: win ? 1 : -1, pnlPct: win ? 10 : -10,
    openedAt: "2026-01-01T00:00:00Z", closedAt: "2026-01-01T01:00:00Z",
    predictedProb,
  };
}

// ── fitPlatt / applyPlatt identity + guards ─────────────────────────────────
{
  const t = "platt-identity";
  // <4 pairs → identity.
  expect(approx(fitPlatt([0.6, 0.7], [1, 0]).a, 1) && approx(fitPlatt([0.6], [1]).b, 0), t, "tiny sample → identity");
  // one class → identity (nothing to calibrate).
  const oneClass = fitPlatt([0.6, 0.7, 0.8, 0.9], [1, 1, 1, 1]);
  expect(oneClass.a === 1 && oneClass.b === 0, t, "single class → identity");
  // identity map returns input.
  expect(approx(applyPlatt(0.73, { a: 1, b: 0 }), 0.73), t, `applyPlatt identity, got ${applyPlatt(0.73, { a: 1, b: 0 })}`);
}

// ── fitPlatt recovers a correction for overconfident forecasts ──────────────
{
  const t = "platt-recovery";
  // Forecast always 0.9, true win-rate 0.5 → calibrated(0.9) should pull toward 0.5.
  const ps = Array.from({ length: 40 }, () => 0.9);
  const ys = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const m = fitPlatt(ps, ys);
  const cal = applyPlatt(0.9, m);
  expect(Math.abs(cal - 0.5) < 0.15, t, `calibrated 0.9 pulled toward 0.5, got ${cal.toFixed(3)}`);
  expect(Math.abs(cal - 0.5) < Math.abs(0.9 - 0.5), t, "calibrated is closer to base rate than raw");
}

// ── computeCalibrationEval: insufficient data ───────────────────────────────
{
  const t = "eval-insufficient";
  const few = Array.from({ length: 10 }, () => trade(0.6, true));
  const r = computeCalibrationEval(few, 20);
  expect(r.applicable === false && r.n === 0, t, `n<minHistory+1 → not applicable, got applicable=${r.applicable}`);
  expect(/more resolved forecasts/i.test(r.message), t, "insufficient message");
  // curve is still returned (identity) for a stable UI.
  expect(r.curve.length === 10 && approx(r.curve[4].cal, r.curve[4].raw, 1e-3), t, "identity curve when insufficient");
}

// ── computeCalibrationEval: walk-forward shows gain on overconfident data ────
{
  const t = "eval-walk-forward";
  // 80 trades, forecast always p_win=0.8, true win-rate ~0.55 spread evenly so
  // every chronological prefix is ~0.55 (walk-forward fits learn the shift).
  const N = 80;
  const trades: ClosedTrade[] = [];
  for (let i = 0; i < N; i++) {
    const win = Math.floor((i + 1) * 0.55) > Math.floor(i * 0.55);  // ~55% ones, evenly spaced
    trades.push(trade(0.8, win));
  }
  const r = computeCalibrationEval(trades, 20);
  expect(r.applicable === true && r.n === N - 20, t, `walk-forward scored n=${r.n}`);
  // Raw 0.8 vs 0.55 base rate is overconfident → calibration must lower Brier.
  expect(r.brierImprovement > 0, t, `Brier improves (rawB=${r.rawBrier} calB=${r.calBrier}, impr=${r.brierImprovement})`);
  expect(r.calBrier < r.rawBrier, t, "calibrated Brier < raw Brier");
  expect(/would help/i.test(r.message), t, `positive message, got "${r.message}"`);
  // Full-sample fit maps 0.8 downward toward the base rate.
  expect(applyPlatt(0.8, r.fit) < 0.8, t, `fit pulls 0.8 down, got ${applyPlatt(0.8, r.fit).toFixed(3)}`);
}

// ── direction inversion flows through (NO trade scored on 1−predictedProb) ──
{
  const t = "eval-direction";
  // NO trades with predictedProb 0.2 → p_win 0.8; same overconfident setup.
  const N = 60;
  const trades: ClosedTrade[] = [];
  for (let i = 0; i < N; i++) {
    const win = Math.floor((i + 1) * 0.55) > Math.floor(i * 0.55);
    trades.push(trade(0.2, win, "NO"));   // p_win = 1 − 0.2 = 0.8
  }
  const r = computeCalibrationEval(trades, 20);
  expect(r.applicable && r.brierImprovement > 0, t, `NO-side p_win=0.8 overconfidence detected, impr=${r.brierImprovement}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("calibration.test.mts") || entry.endsWith("calibration.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("calibration.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`calibration.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
