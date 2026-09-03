// packages/core/src/risk-overlay.test.mts
//
// Regression guard for the vol-target + drawdown kill-switch overlays
// (model-discovery-expansion §4.C / sprints.md B49 #8). Pure, no I/O.
//
// Run: npx tsx packages/core/src/risk-overlay.test.mts

import { realisedVol, volTargetMultiplier, drawdownKill } from "./risk-overlay.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ── realisedVol ──────────────────────────────────────────────────────────────
{
  const t = "vol";
  expect(realisedVol([]) === 0, t, "empty → 0");
  expect(realisedVol([0.05]) === 0, t, "one point → 0");
  // sample std of [1,-1,1,-1] = sqrt(sum(1)/3)=sqrt(4/3)≈1.1547
  expect(approx(realisedVol([1, -1, 1, -1]), Math.sqrt(4 / 3)), t, `sample std, got ${realisedVol([1, -1, 1, -1])}`);
}

// ── volTargetMultiplier ──────────────────────────────────────────────────────
{
  const t = "vol-target";
  // realised == target → 1
  expect(approx(volTargetMultiplier(0.1, 0.1), 1), t, "realised==target → 1");
  // realised hot (2× target) → cut to 0.5
  expect(approx(volTargetMultiplier(0.2, 0.1), 0.5), t, `hot vol → 0.5, got ${volTargetMultiplier(0.2, 0.1)}`);
  // realised calm (target 2× realised) → boost, but clamped at maxMult 1.5
  expect(approx(volTargetMultiplier(0.05, 0.1), 1.5), t, `calm vol clamped to 1.5, got ${volTargetMultiplier(0.05, 0.1)}`);
  // floor at minMult
  expect(approx(volTargetMultiplier(100, 0.1), 0.25), t, `extreme vol → floor 0.25, got ${volTargetMultiplier(100, 0.1)}`);
  // no-op cases
  expect(volTargetMultiplier(0, 0.1) === 1, t, "realised 0 → 1 (no-op)");
  expect(volTargetMultiplier(0.1, 0) === 1, t, "target 0 → 1 (no-op)");
}

// ── drawdownKill ─────────────────────────────────────────────────────────────
{
  const t = "dd";
  // 20% drawdown, limit 25% → no kill
  const a = drawdownKill(1000, 800, 0.25);
  expect(!a.kill && approx(a.ddFraction, 0.2), t, `20% DD < 25% → no kill, got ${a.ddFraction}`);
  // 30% drawdown, limit 25% → kill
  const b = drawdownKill(1000, 700, 0.25);
  expect(b.kill && approx(b.ddFraction, 0.3), t, `30% DD ≥ 25% → kill`);
  // current above peak → 0 DD, peak updates
  const c = drawdownKill(1000, 1200, 0.25);
  expect(!c.kill && c.ddFraction === 0 && c.peak === 1200, t, "new high → 0 DD, peak=1200");
  // fail-open on bad input
  expect(drawdownKill(0, 0, 0.25).kill === false, t, "0 peak → fail-open");
  expect(drawdownKill(1000, 500, 0).kill === false, t, "0 limit → fail-open");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("risk-overlay.test.mts") || entry.endsWith("risk-overlay.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("risk-overlay.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`risk-overlay.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
