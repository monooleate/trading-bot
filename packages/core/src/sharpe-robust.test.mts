// packages/core/src/sharpe-robust.test.mts
//
// Regression guard for the robust Sharpe stats (model-discovery-expansion §4.B /
// sprints.md B49 #3). Pure, no I/O.
//
// Run: npx tsx packages/core/src/sharpe-robust.test.mts

import {
  normalCdf,
  normalInv,
  skewness,
  kurtosis,
  probabilisticSharpe,
  minTrackRecordLength,
  expectedMaxSharpe,
  deflatedSharpe,
} from "./sharpe-robust.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 2e-3) => Math.abs(a - b) < eps;

// ── normal CDF / inverse ─────────────────────────────────────────────────────
{
  const t = "normal";
  expect(approx(normalCdf(0), 0.5), t, `Φ(0)=0.5, got ${normalCdf(0)}`);
  expect(approx(normalInv(0.975), 1.96, 2e-3), t, `Φ⁻¹(0.975)≈1.96, got ${normalInv(0.975).toFixed(4)}`);
  expect(approx(normalInv(0.95), 1.6449, 2e-3), t, `Φ⁻¹(0.95)≈1.645, got ${normalInv(0.95).toFixed(4)}`);
  expect(normalInv(0.5) === 0 || approx(normalInv(0.5), 0), t, "Φ⁻¹(0.5)=0");
}

// ── moments: skew sign + kurtosis of a fat-tailed sample ─────────────────────
{
  const t = "moments";
  expect(approx(skewness([1, 1, 1, 1, 10]), 1.5, 1.0), t, "right-skewed → positive skew");
  expect(skewness([-5, -1, 0, 1, 5]) === 0 || Math.abs(skewness([-5, -1, 0, 1, 5])) < 1e-9, t, "symmetric → ~0 skew");
  expect(skewness([1, 2]) === 0, t, "n<3 → 0");
  // a spike sample is leptokurtic (raw kurtosis > 3)
  expect(kurtosis([0, 0, 0, 0, 0, 0, 10]) > 3, t, `fat tail → kurt>3, got ${kurtosis([0,0,0,0,0,0,10]).toFixed(2)}`);
  expect(kurtosis([1, 2, 3]) === 3, t, "n<4 → 3");
}

// ── PSR: zero-edge ≈ 0.5, monotone in n, in [0,1] ────────────────────────────
{
  const t = "psr";
  // SR just above 0 with more trades → PSR rises toward 1.
  const p10 = probabilisticSharpe(0.2, 10, 0, 3, 0);
  const p200 = probabilisticSharpe(0.2, 200, 0, 3, 0);
  expect(p200 > p10, t, `PSR rises with n (${p10.toFixed(3)} → ${p200.toFixed(3)})`);
  expect(p10 >= 0 && p200 <= 1, t, "PSR ∈ [0,1]");
  // SR == benchmark → z=0 → 0.5.
  expect(approx(probabilisticSharpe(0.2, 50, 0, 3, 0.2), 0.5, 1e-6), t, "SR==benchmark → 0.5");
  // Fat tails / negative skew lower PSR vs the normal case.
  const pNormal = probabilisticSharpe(0.3, 60, 0, 3, 0);
  const pFat    = probabilisticSharpe(0.3, 60, -1.0, 8, 0);
  expect(pFat < pNormal, t, `neg-skew+fat-tail lowers PSR (${pFat.toFixed(3)} < ${pNormal.toFixed(3)})`);
  expect(Number.isNaN(probabilisticSharpe(0.2, 1, 0, 3)), t, "n<2 → NaN");
}

// ── MinTRL: lower SR needs more trades; SR≤0 → Infinity ──────────────────────
{
  const t = "mintrl";
  const lowSr  = minTrackRecordLength(0.1, 0, 3);
  const highSr = minTrackRecordLength(0.4, 0, 3);
  expect(lowSr > highSr, t, `lower SR needs more trades (${lowSr.toFixed(0)} > ${highSr.toFixed(0)})`);
  expect(lowSr > 1, t, "MinTRL > 1");
  expect(minTrackRecordLength(0, 0, 3) === Infinity, t, "SR=0 → Infinity");
  expect(minTrackRecordLength(-0.2, 0, 3) === Infinity, t, "SR<0 → Infinity");
  // fat tails raise the required length
  expect(minTrackRecordLength(0.3, -1, 8) > minTrackRecordLength(0.3, 0, 3), t, "fat tails raise MinTRL");
}

// ── expected max Sharpe + DSR ────────────────────────────────────────────────
{
  const t = "dsr";
  const e10  = expectedMaxSharpe(10, 0.2);
  const e100 = expectedMaxSharpe(100, 0.2);
  expect(e100 > e10 && e10 > 0, t, `E[maxSR] rises with trials (${e10.toFixed(3)} → ${e100.toFixed(3)})`);
  expect(expectedMaxSharpe(1, 0.2) === 0, t, "N=1 → 0");
  expect(expectedMaxSharpe(50, 0) === 0, t, "σ=0 → 0");
  // DSR deflates PSR: bar (best-of-N) is higher than 0 → DSR < PSR(vs 0).
  const psr0 = probabilisticSharpe(0.35, 80, 0, 3, 0);
  const dsr  = deflatedSharpe(0.35, 80, 0, 3, 20, 0.2);
  expect(dsr < psr0, t, `DSR < PSR-vs-0 (${dsr.toFixed(3)} < ${psr0.toFixed(3)})`);
  expect(dsr >= 0 && dsr <= 1, t, "DSR ∈ [0,1]");
  // pinned reference for E[maxSR] so a coefficient swap can't pass silently
  // (γ=0.5772, N=10, σ=1): (1−γ)·Φ⁻¹(0.9)+γ·Φ⁻¹(1−1/(10e)) ≈ 1.575 (Bailey/LdP).
  expect(approx(expectedMaxSharpe(10, 1), 1.575, 5e-3), t, `E[maxSR](10,1)≈1.575, got ${expectedMaxSharpe(10, 1).toFixed(4)}`);
}

// ── audit fixes: DSR σ_SR fallback + degenerate PSR guard ─────────────────────
{
  const t = "dsr-fallback";
  // sdSharpe≤0 must NOT collapse DSR to PSR-vs-0 — the |SR|-fraction fallback
  // still deflates by best-of-N (audit P3).
  const psr0 = probabilisticSharpe(0.4, 60, 0, 3, 0);
  const dsr0 = deflatedSharpe(0.4, 60, 0, 3, 25, 0);       // degenerate σ_SR proxy
  expect(dsr0 < psr0, t, `σ_SR=0 still deflates (${dsr0.toFixed(3)} < ${psr0.toFixed(3)})`);
  expect(deflatedSharpe(0.4, 60, 0, 3, 1, 0) >= 0, t, "N=1 fallback stays finite");
  // extreme skew/kurtosis making the raw variance term ≤ 0 → neutral 0.5, not a
  // saturated ~0/~1 (audit P3).
  const degen = probabilisticSharpe(0.6, 30, 4, 1.2, 0);   // raw term ≈ −1.38 ≤ 0
  expect(degen === 0.5, t, `degenerate variance term → 0.5, got ${degen}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("sharpe-robust.test.mts") || entry.endsWith("sharpe-robust.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("sharpe-robust.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`sharpe-robust.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
