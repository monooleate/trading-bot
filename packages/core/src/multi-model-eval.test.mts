// packages/core/src/multi-model-eval.test.mts
//
// Pins the B52 read-out maths: point scores, the dispersion diagnosis
// (under/over/calibrated) and CRPS skill.

import { scoreForecasts, crpsSkill, dispersionVerdict } from "./multi-model-eval.mts";
import { gaussianCrps } from "./emos.mts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function near(name: string, actual: number, expected: number, tol = 1e-3) {
  check(name, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);
}

// ─── 1. Point scores ──────────────────────────────────────────────────────
console.log("\n1. scoreForecasts — point scores");
{
  const s = scoreForecasts([
    { mean: 11, sd: 1, obs: 10 },   // err +1
    { mean: 9,  sd: 1, obs: 10 },   // err −1
    { mean: 13, sd: 1, obs: 10 },   // err +3
  ])!;
  near("n", s.n, 3);
  near("bias = mean signed error", s.bias, 1);
  near("mae", s.mae, 5 / 3);
  near("rmse = sqrt((1+1+9)/3)", s.rmse, Math.sqrt(11 / 3));
  near("meanSd", s.meanSd, 1);
  near("varianceRatio = mean(err²)/mean(σ²)", s.varianceRatio, 11 / 3);
  near("cover1Sd: 2 of 3 within ±1σ", s.cover1Sd, 2 / 3);
  near("cover2Sd: 2 of 3 within ±2σ", s.cover2Sd, 2 / 3);
}
{
  const s = scoreForecasts([{ mean: 10, sd: 2, obs: 10 }])!;
  near("perfect forecast → 0 bias/mae/rmse", s.rmse, 0);
  near("perfect forecast → varianceRatio 0", s.varianceRatio, 0);
  near("CRPS matches the core Gaussian CRPS", s.crps, gaussianCrps(10, 2, 10));
}

// ─── 2. Dispersion diagnosis ──────────────────────────────────────────────
console.log("\n2. dispersionVerdict");
{
  // σ = 1 but errors are ±2 → ratio 4 → under-dispersed (the documented bug).
  const under = scoreForecasts(
    Array.from({ length: 20 }, (_, i) => ({ mean: 10 + (i % 2 ? 2 : -2), sd: 1, obs: 10 })),
  )!;
  near("under-dispersed ratio", under.varianceRatio, 4);
  check("verdict: under", dispersionVerdict(under) === "under");
  check("coverage collapses when σ is too narrow", under.cover1Sd === 0);

  // σ = 4 with ±1 errors → ratio 1/16 → over-dispersed.
  const over = scoreForecasts(
    Array.from({ length: 20 }, (_, i) => ({ mean: 10 + (i % 2 ? 1 : -1), sd: 4, obs: 10 })),
  )!;
  check("verdict: over", dispersionVerdict(over) === "over");

  // σ = 1 with ±1 errors → ratio 1 → calibrated.
  const ok = scoreForecasts(
    Array.from({ length: 20 }, (_, i) => ({ mean: 10 + (i % 2 ? 1 : -1), sd: 1, obs: 10 })),
  )!;
  near("calibrated ratio", ok.varianceRatio, 1);
  check("verdict: calibrated", dispersionVerdict(ok) === "calibrated");

  check("small sample → insufficient",
    dispersionVerdict(scoreForecasts([{ mean: 10, sd: 1, obs: 11 }])!) === "insufficient");
  check("null → insufficient", dispersionVerdict(null) === "insufficient");
}

// ─── 3. CRPS skill ────────────────────────────────────────────────────────
console.log("\n3. crpsSkill");
{
  // Same μ, but the honest σ must win on CRPS: errors are ±2, one claims σ=1
  // (over-confident), the other σ=2 (honest). This is the whole B52 argument
  // in one assertion — a point score cannot tell these two apart.
  const samples = Array.from({ length: 20 }, (_, i) => ({ mean: 10 + (i % 2 ? 2 : -2), obs: 10 }));
  const overconfident = scoreForecasts(samples.map((s) => ({ ...s, sd: 1 })))!;
  const honest = scoreForecasts(samples.map((s) => ({ ...s, sd: 2 })))!;
  near("identical point error", overconfident.rmse, honest.rmse);
  check("honest σ scores better on CRPS", honest.crps < overconfident.crps,
    `${honest.crps} vs ${overconfident.crps}`);
  const skill = crpsSkill(honest, overconfident)!;
  check("positive skill for the honest variant", skill > 0, String(skill));

  check("self-skill is 0", crpsSkill(honest, honest) === 0);
  check("null candidate → null", crpsSkill(null, honest) === null);
  check("null baseline → null", crpsSkill(honest, null) === null);
}

// ─── 4. Robustness ────────────────────────────────────────────────────────
console.log("\n4. Robustness");
{
  check("empty → null", scoreForecasts([]) === null);
  check("undefined → null", scoreForecasts(undefined as any) === null);
  check("all-junk → null", scoreForecasts([{ mean: NaN, sd: 1, obs: 2 }]) === null);

  const mixed = scoreForecasts([
    { mean: 10, sd: 1, obs: 11 },
    { mean: NaN, sd: 1, obs: 11 },
    { mean: 10, sd: 1, obs: NaN as any },
  ])!;
  near("junk rows dropped", mixed.n, 1);

  // σ = 0 rows still count for the point scores but not for dispersion.
  const zeroSd = scoreForecasts([
    { mean: 10, sd: 0, obs: 12 },
    { mean: 10, sd: 2, obs: 12 },
  ])!;
  near("σ=0 row kept for the point score", zeroSd.n, 2);
  near("dispersion uses only the σ>0 row", zeroSd.varianceRatio, 4 / 4);
}

console.log(`\n=== multi-model-eval: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
