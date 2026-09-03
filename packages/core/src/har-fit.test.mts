// packages/core/src/har-fit.test.mts
//
// Regression guard for the HAR-RV coefficient fitter (model-discovery-training
// §3.C / #5 crypto, sprints.md B50). Pure, no I/O.
//
// Run: npx tsx packages/core/src/har-fit.test.mts

import { olsFit, fitHarWeights, evaluateHarForecast } from "./har-fit.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ── 1. olsFit recovers a known linear relation ───────────────────────────────
{
  const t = "ols";
  // y = 2 + 3·x1 − 1·x2, exact.
  const X: number[][] = [], y: number[] = [];
  for (let i = 0; i < 20; i++) {
    const x1 = i, x2 = (i * 7) % 5;
    X.push([1, x1, x2]);
    y.push(2 + 3 * x1 - 1 * x2);
  }
  const beta = olsFit(X, y)!;
  expect(!!beta && approx(beta[0], 2, 1e-4) && approx(beta[1], 3, 1e-4) && approx(beta[2], -1, 1e-4), t, `recovered ${JSON.stringify(beta)}`);
  // singular → null
  expect(olsFit([[1, 2], [2, 4]], [1, 2]) === null, t, "singular → null");
}

// ── 2. fitHarWeights on a synthetic HAR process ──────────────────────────────
{
  const t = "har-fit";
  // Generate RV_t = 0.1 + 0.5·RV_{t-1} + 0.3·RV^(5) + 0.15·RV^(22) + small noise.
  const rv: number[] = [];
  for (let i = 0; i < 25; i++) rv.push(1 + Math.sin(i));            // seed 25 bars
  const mtail = (end: number, k: number) => { let s = 0, lo = Math.max(0, end - k + 1); for (let i = lo; i <= end; i++) s += rv[i]; return s / (end - lo + 1); };
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 0.02; };
  for (let t2 = 25; t2 < 400; t2++) {
    rv.push(Math.max(0, 0.1 + 0.5 * rv[t2 - 1] + 0.3 * mtail(t2 - 1, 5) + 0.15 * mtail(t2 - 1, 22) + rand()));
  }
  const fit = fitHarWeights(rv);
  expect(fit.fitted, t, "fitted");
  expect(fit.r2 > 0.8, t, `high R² on a HAR process, got ${fit.r2.toFixed(3)}`);
  // coefficients in the right ballpark (noisy, so loose bounds)
  expect(fit.betaD > 0.2 && fit.betaD < 0.8, t, `betaD near 0.5, got ${fit.betaD.toFixed(3)}`);
  expect(fit.n > 300, t, `training rows, got ${fit.n}`);
}

// ── 3. too little data → not fitted ──────────────────────────────────────────
{
  const t = "insufficient";
  const fit = fitHarWeights(new Array(30).fill(1.5));
  expect(!fit.fitted, t, "30 bars < 22+30 → not fitted");
  // dud carries equal weights so callers can still degrade.
  expect(approx(fit.betaD, 1 / 3), t, "dud → equal weights");
}

// ── 4. evaluateHarForecast: fitted beats equal on a shocked HAR process ──────
{
  const t = "eval";
  // Volatility clustering: shocks make rvD/rvW/rvM diverge, so the CORRECT
  // (unequal) weighting matters — the reason to fit rather than use 1/3 each.
  const rv: number[] = [];
  for (let i = 0; i < 25; i++) rv.push(2 + Math.cos(i / 2));
  const mtail = (end: number, k: number) => { let s = 0, lo = Math.max(0, end - k + 1); for (let i = lo; i <= end; i++) s += rv[i]; return s / (end - lo + 1); };
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let t2 = 25; t2 < 600; t2++) {
    const shock = rand() < 0.06 ? 3 * rand() : 0;               // occasional vol spike
    const noise = (rand() - 0.5) * 0.1;
    rv.push(Math.max(0, 0.2 + 0.7 * rv[t2 - 1] + 0.2 * mtail(t2 - 1, 5) + 0.05 * mtail(t2 - 1, 22) + shock + noise));
  }
  const ev = evaluateHarForecast(rv);
  expect(ev.n > 100, t, `OOS points, got ${ev.n}`);
  expect(Number.isFinite(ev.fittedMse) && Number.isFinite(ev.equalMse) && Number.isFinite(ev.rwMse), t, "finite MSEs");
  expect(ev.fittedBeatsEqual, t, `fitted should beat equal on a shocked HAR process (${ev.fittedMse} vs ${ev.equalMse})`);
}

// ── 5. degenerate ────────────────────────────────────────────────────────────
{
  const t = "empty";
  expect(!fitHarWeights([]).fitted, t, "empty → not fitted");
  expect(evaluateHarForecast([]).n === 0, t, "empty eval → n 0");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("har-fit.test.mts") || entry.endsWith("har-fit.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("har-fit.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`har-fit.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
