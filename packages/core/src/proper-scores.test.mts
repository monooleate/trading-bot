// netlify/functions/auto-trader/shared/proper-scores.test.mts
//
// NOTE: lives under auto-trader/shared/ (alongside the other *.test.mts
// guards) and NOT loose in netlify/functions/. A loose *.test.mts becomes a
// Netlify function named "...test" — the dot is illegal and breaks deploy
// (it broke the 2026-05-15 prod deploy). Files under auto-trader/ are part of
// the single `auto-trader` function, so test modules here never deploy as
// their own function. This file imports the REAL implementation from
// ./statistics.mts (a type-only-import module, no Netlify
// runtime deps) so it pins the shipped code, not a copy.
//
// Regression guard for `computeProperScores` — the model-discovery §7 #1
// proper-scoring harness (log-score + Brier-Murphy decomposition +
// reliability diagram). See internal-docs/roadmap/model-discovery-forecasting.md.
//
// Run: npx tsx netlify/functions/auto-trader/shared/proper-scores.test.mts

import { computeProperScores } from "./statistics.mts";
import type { ClosedTrade } from "./types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

// Minimal ClosedTrade factory. Only direction / predictedProb / pnl feed the
// scorer; the rest are filler to satisfy the type. `win` drives pnl sign
// (the scorer's outcome = pnl > 0). LONG/SHORT are cast (HL venue uses them).
function trade(
  predictedProb: number | undefined,
  direction: "YES" | "NO" | "LONG" | "SHORT",
  win: boolean,
): ClosedTrade {
  return {
    market: "m",
    direction: direction as any,
    entryPrice: 0.5,
    exitPrice: win ? 1 : 0,
    shares: 10,
    pnl: win ? 1 : -1,
    pnlPct: win ? 10 : -10,
    openedAt: "2026-01-01T00:00:00Z",
    closedAt: "2026-01-01T01:00:00Z",
    predictedProb,
  };
}

// ── Empty / no-forecast inputs ──────────────────────────────────────────────
{
  const t = "empty";
  const r = computeProperScores([]);
  expect(r.n === 0, t, `empty → n=0, got ${r.n}`);
  expect(r.reliabilityBins.length === 0, t, "empty → no bins");
  expect(/no closed trades/i.test(r.message), t, `empty message, got "${r.message}"`);

  // A trade without predictedProb is skipped, not scored.
  const noProb = computeProperScores([trade(undefined, "YES", true)]);
  expect(noProb.n === 0, t, `undefined predictedProb → skipped, got n=${noProb.n}`);
}

// ── Brier + log-score scalar pin ────────────────────────────────────────────
// p_win = [0.8 (win), 0.6 (loss)] → y = [1, 0].
//   Brier = ((0.8−1)² + (0.6−0)²)/2 = (0.04 + 0.36)/2 = 0.20
//   Log   = (−ln0.8 − ln0.4)/2 = (0.223144 + 0.916291)/2 = 0.569717
{
  const t = "scalar-pin";
  const r = computeProperScores([trade(0.8, "YES", true), trade(0.6, "YES", false)]);
  expect(r.n === 2, t, `n=2, got ${r.n}`);
  expect(approx(r.brier, 0.20), t, `Brier=0.20, got ${r.brier}`);
  expect(approx(r.logScore, 0.5697), t, `LogScore=0.5697, got ${r.logScore}`);
  expect(approx(r.baseRate, 0.5), t, `baseRate=0.5, got ${r.baseRate}`);
  expect(approx(r.uncertainty, 0.25), t, `uncertainty=0.25, got ${r.uncertainty}`);
  // Brier skill vs base rate: 1 − 0.20/0.25 = 0.20.
  expect(approx(r.brierSkillScore, 0.20), t, `BSS=0.20, got ${r.brierSkillScore}`);
}

// ── Murphy decomposition: singleton bins ⇒ residual ≈ 0 ──────────────────────
// With each forecast alone in its own bin, Brier = Reliability − Resolution +
// Uncertainty exactly (resolution = uncertainty for binary y). Reuse the
// scalar-pin set (0.8→bin8, 0.6→bin6 are distinct bins).
{
  const t = "decomposition";
  const r = computeProperScores([trade(0.8, "YES", true), trade(0.6, "YES", false)]);
  expect(approx(r.reliability, 0.20), t, `reliability=0.20, got ${r.reliability}`);
  expect(approx(r.resolution, 0.25), t, `resolution=0.25, got ${r.resolution}`);
  expect(approx(r.decompositionResidual, 0, 1e-6), t, `residual≈0, got ${r.decompositionResidual}`);
  // Identity holds within rounding: brier ≈ reliability − resolution + uncertainty + residual.
  const recon = r.reliability - r.resolution + r.uncertainty + r.decompositionResidual;
  expect(approx(recon, r.brier, 1e-6), t, `reconstructed=${recon} vs brier=${r.brier}`);
  expect(r.reliabilityBins.length === 2, t, `2 non-empty bins, got ${r.reliabilityBins.length}`);
}

// ── Direction inversion: NO/SHORT score the taken side (1 − predictedProb) ───
{
  const t = "direction-inversion";
  // NO @ predictedProb 0.30 → p_win = 0.70; wins → y=1 → Brier=(0.7−1)²=0.09.
  const no = computeProperScores([trade(0.30, "NO", true)]);
  expect(approx(no.brier, 0.09), t, `NO p_win=0.70 → Brier=0.09, got ${no.brier}`);
  expect(no.reliabilityBins.length === 1 && approx(no.reliabilityBins[0].meanPredicted, 0.70), t,
    `NO bin meanPredicted=0.70, got ${no.reliabilityBins[0]?.meanPredicted}`);
  // SHORT @ predictedProb 0.30 → p_win = 0.70; loses → y=0 → Brier=(0.7−0)²=0.49.
  const sh = computeProperScores([trade(0.30, "SHORT", false)]);
  expect(approx(sh.brier, 0.49), t, `SHORT p_win=0.70 loss → Brier=0.49, got ${sh.brier}`);
}

// ── Log-score clipping: confident-wrong forecast stays finite ────────────────
{
  const t = "clip";
  // YES @ predictedProb 1.0 that LOSES → p_win=1, y=0. Without clipping this is
  // −ln(0) = ∞. Clipped to 1−1e−6 → ≈ 13.8155, finite.
  const r = computeProperScores([trade(1.0, "YES", false)]);
  expect(Number.isFinite(r.logScore), t, `logScore finite, got ${r.logScore}`);
  expect(r.logScore > 10 && r.logScore < 20, t, `logScore≈13.8, got ${r.logScore}`);
}

// ── Near-perfect skill: high-p wins, low-p losses ───────────────────────────
{
  const t = "high-skill";
  const r = computeProperScores([trade(0.9, "YES", true), trade(0.1, "YES", false)]);
  // Brier = ((0.9−1)² + (0.1−0)²)/2 = 0.01 → BSS = 1 − 0.01/0.25 = 0.96.
  expect(approx(r.brier, 0.01), t, `Brier=0.01, got ${r.brier}`);
  expect(approx(r.brierSkillScore, 0.96), t, `BSS=0.96, got ${r.brierSkillScore}`);
  expect(r.brierSkillScore > 0 && /beats/i.test(r.message), t, `positive-skill message, got "${r.message}"`);
}

// ── Anti-skill: high-p loses, low-p wins ⇒ negative Brier skill ─────────────
{
  const t = "anti-skill";
  const r = computeProperScores([trade(0.9, "YES", false), trade(0.1, "YES", true)]);
  // Brier = ((0.9−0)² + (0.1−1)²)/2 = (0.81+0.81)/2 = 0.81 → BSS = 1 − 0.81/0.25 = −2.24.
  expect(approx(r.brier, 0.81), t, `Brier=0.81, got ${r.brier}`);
  expect(r.brierSkillScore < 0 && /does not beat/i.test(r.message), t,
    `negative skill + message, got BSS=${r.brierSkillScore} "${r.message}"`);
}

// ── Small-sample warning ────────────────────────────────────────────────────
{
  const t = "noise-flag";
  const r = computeProperScores([trade(0.7, "YES", true)]);
  expect(/n<20/i.test(r.message), t, `n<20 warning present, got "${r.message}"`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("proper-scores.test.mts") || entry.endsWith("proper-scores.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("proper-scores.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`proper-scores.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
