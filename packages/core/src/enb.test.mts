// packages/core/src/enb.test.mts
//
// Regression guard for the Effective Number of Bets monitor (model-discovery-
// expansion §4.C / sprints.md B49 #9). Pure, no I/O.
//
// Run: npx tsx packages/core/src/enb.test.mts

import { pearson, correlationMatrix, jacobiEigenvalues, effectiveNumberOfBets } from "./enb.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 2e-3) => Math.abs(a - b) < eps;
const sortedAsc = (a: number[]) => [...a].sort((x, y) => x - y);

// ── pearson ──────────────────────────────────────────────────────────────────
{
  const t = "pearson";
  expect(approx(pearson([1, 2, 3], [1, 2, 3]), 1), t, "identical → 1");
  expect(approx(pearson([1, 2, 3], [3, 2, 1]), -1), t, "opposite → -1");
  expect(Number.isNaN(pearson([1, 1, 1], [1, 2, 3])), t, "flat → NaN");
}

// ── jacobi eigenvalues (known matrices) ──────────────────────────────────────
{
  const t = "jacobi";
  expect(sortedAsc(jacobiEigenvalues([[2, 0], [0, 3]])).every((v, i) => approx(v, [2, 3][i])), t, "diagonal → {2,3}");
  expect(sortedAsc(jacobiEigenvalues([[2, 1], [1, 2]])).every((v, i) => approx(v, [1, 3][i])), t, "[[2,1],[1,2]] → {1,3}");
  // 3×3 identity → {1,1,1}
  expect(jacobiEigenvalues([[1,0,0],[0,1,0],[0,0,1]]).every((v) => approx(v, 1)), t, "I3 → all 1");
}

// ── ENB: uncorrelated → N, fully correlated → 1 ──────────────────────────────
{
  const t = "enb-extremes";
  const I3 = [[1,0,0],[0,1,0],[0,0,1]];
  const e1 = effectiveNumberOfBets(I3);
  expect(approx(e1.enb, 3, 1e-2), t, `identity → ENB≈3, got ${e1.enb.toFixed(3)}`);
  expect(approx(e1.topFactorShare, 1 / 3, 1e-2), t, "identity top share ≈ 1/3");

  const allOne = [[1,1,1],[1,1,1],[1,1,1]];
  const e2 = effectiveNumberOfBets(allOne);
  expect(approx(e2.enb, 1, 1e-2), t, `all-correlated → ENB≈1, got ${e2.enb.toFixed(3)}`);
  expect(approx(e2.topFactorShare, 1, 1e-2), t, "all-correlated top share ≈ 1");
}

// ── ENB: partial correlation is between 1 and N ──────────────────────────────
{
  const t = "enb-partial";
  const R = [[1, 0.6], [0.6, 1]];   // eigenvalues 1.6, 0.4
  const e = effectiveNumberOfBets(R);
  expect(e.enb > 1 && e.enb < 2, t, `ρ=0.6 → 1<ENB<2, got ${e.enb.toFixed(3)}`);
  expect(e.topFactorShare > 0.5, t, `top factor dominates, got ${e.topFactorShare.toFixed(3)}`);
  // higher correlation → lower ENB
  const eHigh = effectiveNumberOfBets([[1, 0.95], [0.95, 1]]);
  expect(eHigh.enb < e.enb, t, `higher ρ → lower ENB (${eHigh.enb.toFixed(3)} < ${e.enb.toFixed(3)})`);
}

// ── correlationMatrix + the barbell case (3 correlated crypto bots) ──────────
{
  const t = "corr-barbell";
  // three near-identical crypto-beta return series + one uncorrelated bot
  const btc = [0.02, -0.01, 0.03, -0.02, 0.01, -0.015];
  const hl  = btc.map((x) => x * 0.98 + 0.0005);       // ~same as btc
  const far = btc.map((x) => -x * 0.99);               // ~same (anti → |ρ|~1 still one factor)
  const wx  = [0.01, 0.012, -0.005, 0.008, -0.011, 0.002]; // uncorrelated
  const R = correlationMatrix([btc, hl, far, wx]);
  expect(approx(R[0][0], 1) && approx(R[1][1], 1), t, "diagonal = 1");
  expect(R[0][1] > 0.9, t, `btc~hl highly correlated, got ${R[0][1].toFixed(3)}`);
  const e = effectiveNumberOfBets(R);
  // 4 "bots" but 3 share one factor → ENB well below 4 (≈2)
  expect(e.enb < 3 && e.enb > 1, t, `barbell: 4 bots but ENB≈2, got ${e.enb.toFixed(3)}`);
}

// ── edge cases ───────────────────────────────────────────────────────────────
{
  const t = "edge";
  expect(effectiveNumberOfBets([]).enb === 0, t, "empty → 0");
  expect(effectiveNumberOfBets([[1]]).enb === 1, t, "single → 1");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("enb.test.mts") || entry.endsWith("enb.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("enb.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`enb.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
