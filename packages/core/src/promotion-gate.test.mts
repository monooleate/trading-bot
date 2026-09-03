// packages/core/src/promotion-gate.test.mts
//
// Regression guard for the promotion gate (model-discovery-training §3 / #1,
// sprints.md B50). Pure, no I/O.
//
// Run: npx tsx packages/core/src/promotion-gate.test.mts

import {
  evaluatePromotionGate,
  PROMOTION_THRESHOLDS,
  type PromotionGateInput,
} from "./promotion-gate.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// A baseline input where every HARD gate passes and every advisory passes too.
function passing(): PromotionGateInput {
  return {
    scoredN: 60,
    brierSkillScore: 0.08,
    logSkillScore: 0.06,
    wfBrierSkill: 0.05,
    wfConsistency: 0.8,
    wfMaxDayShare: 0.3,
    wfNResolved: 40,
    psr: 0.98,
    dsr: 0.97,
    minTrl: 45,
    tradeN: 60,
    nTrials: 12,
  };
}

// ── 1. all gates pass → PROMOTE ──────────────────────────────────────────────
{
  const t = "promote";
  const r = evaluatePromotionGate(passing());
  expect(r.decision === "PROMOTE", t, `expected PROMOTE, got ${r.decision}`);
  expect(r.hardPassed === r.hardTotal, t, `all hard pass (${r.hardPassed}/${r.hardTotal})`);
  expect(r.headline === "PROMOTE", t, "headline PROMOTE");
}

// ── 2. thin proper-score sample → INSUFFICIENT_DATA (short-circuits) ─────────
{
  const t = "insufficient";
  const r = evaluatePromotionGate({ ...passing(), scoredN: 12 });
  expect(r.decision === "INSUFFICIENT_DATA", t, `expected INSUFFICIENT_DATA, got ${r.decision}`);
  // Even with a failing Brier skill it must still report INSUFFICIENT (sample gates first).
  const r2 = evaluatePromotionGate({ ...passing(), scoredN: 5, brierSkillScore: -0.2 });
  expect(r2.decision === "INSUFFICIENT_DATA", t, "sample gate dominates a bad skill");
}

// ── 3. Brier skill ≤ 0 → HOLD ────────────────────────────────────────────────
{
  const t = "hold-brier";
  const r = evaluatePromotionGate({ ...passing(), brierSkillScore: -0.03 });
  expect(r.decision === "HOLD", t, `expected HOLD, got ${r.decision}`);
  const brier = r.checks.find((c) => c.label === "Brier skill vs base-rate");
  expect(!!brier && brier.kind === "hard" && !brier.passed, t, "brier hard gate fails");
}

// ── 4. does not beat market OOS → HOLD ───────────────────────────────────────
{
  const t = "hold-market";
  const r = evaluatePromotionGate({ ...passing(), wfBrierSkill: -0.02 });
  expect(r.decision === "HOLD", t, `expected HOLD, got ${r.decision}`);
  const g = r.checks.find((c) => c.label === "Beats market (out-of-sample)");
  expect(!!g && g.kind === "hard" && !g.passed, t, "beats-market hard gate fails");
}

// ── 5. inconsistent / clustered walk-forward → HOLD ──────────────────────────
{
  const t = "hold-consistency";
  const r = evaluatePromotionGate({ ...passing(), wfConsistency: 0.4 });
  expect(r.decision === "HOLD", t, `consistency fail → HOLD, got ${r.decision}`);
  const r2 = evaluatePromotionGate({ ...passing(), wfMaxDayShare: 0.8 });
  expect(r2.decision === "HOLD", t, `cluster fail → HOLD, got ${r2.decision}`);
  const g = r2.checks.find((c) => c.label === "Not one correlated cluster");
  expect(!!g && !g.passed, t, "cluster gate fails");
}

// ── 6. thin ledger → walk-forward gates become advisory, not hard-fail ───────
{
  const t = "thin-ledger";
  // No usable market baseline (e.g. F-arb/sports) — proper-score gates still decide.
  const r = evaluatePromotionGate({ ...passing(), wfNResolved: 3 });
  expect(r.decision === "PROMOTE", t, `thin ledger still PROMOTE on proper score, got ${r.decision}`);
  const g = r.checks.find((c) => c.label === "Beats market (out-of-sample)");
  expect(!!g && g.kind === "advisory", t, "beats-market downgraded to advisory when ledger thin");
  // The advisory walk-forward note must NOT be counted in the hard tally.
  const hard = r.checks.filter((c) => c.kind === "hard");
  expect(hard.every((c) => c.passed), t, "all hard gates pass with thin ledger");
}

// ── 7. advisory PSR/DSR/MinTRL failing never blocks a PROMOTE ────────────────
{
  const t = "advisory-noblock";
  const r = evaluatePromotionGate({ ...passing(), psr: 0.2, dsr: 0.3, minTrl: 999999, tradeN: 60 });
  expect(r.decision === "PROMOTE", t, `advisory fails but hard pass → PROMOTE, got ${r.decision}`);
  expect(r.detail.includes("conservatively"), t, "detail warns to size conservatively when confirmation weak");
  const psr = r.checks.find((c) => c.label.startsWith("PSR"));
  expect(!!psr && psr.kind === "advisory" && !psr.passed, t, "PSR advisory + failing");
}

// ── 8. challenger applicable + improves → hard gate passes ───────────────────
{
  const t = "challenger-good";
  const r = evaluatePromotionGate({
    ...passing(),
    challenger: { label: "useRealizedIC", applicable: true, brierImprovement: 0.012 },
  });
  expect(r.decision === "PROMOTE", t, `improving challenger → PROMOTE, got ${r.decision}`);
  const g = r.checks.find((c) => c.label.includes("useRealizedIC"));
  expect(!!g && g.kind === "hard" && g.passed, t, "challenger hard gate passes");
  expect(r.detail.includes("«useRealizedIC»"), t, "detail names the challenger");
}

// ── 9. challenger not improving → HOLD; not applicable → advisory (no block) ──
{
  const t = "challenger-bad";
  const r = evaluatePromotionGate({
    ...passing(),
    challenger: { label: "Platt", applicable: true, brierImprovement: -0.004 },
  });
  expect(r.decision === "HOLD", t, `non-improving challenger → HOLD, got ${r.decision}`);

  const r2 = evaluatePromotionGate({
    ...passing(),
    challenger: { label: "AdaHedge", applicable: false, brierImprovement: 0 },
  });
  expect(r2.decision === "PROMOTE", t, `inapplicable challenger is advisory, does not block; got ${r2.decision}`);
  const g = r2.checks.find((c) => c.label.includes("AdaHedge"));
  expect(!!g && g.kind === "advisory", t, "inapplicable challenger is advisory");
}

// ── 10. hard/advisory tally is internally consistent ─────────────────────────
{
  const t = "tally";
  const r = evaluatePromotionGate(passing());
  const hard = r.checks.filter((c) => c.kind === "hard");
  expect(r.hardTotal === hard.length, t, `hardTotal matches (${r.hardTotal} vs ${hard.length})`);
  expect(r.hardPassed === hard.filter((c) => c.passed).length, t, "hardPassed matches");
  expect(r.hardPassed <= r.hardTotal, t, "passed ≤ total");
}

// ── 11. pre-registered thresholds are pinned (the gate itself) ───────────────
{
  const t = "thresholds";
  expect(PROMOTION_THRESHOLDS.minScoredN === 30, t, "minScoredN 30");
  expect(PROMOTION_THRESHOLDS.minWfConsistency === 0.6, t, "minWfConsistency 0.6");
  expect(PROMOTION_THRESHOLDS.maxWfDayShare === 0.5, t, "maxWfDayShare 0.5");
  expect(PROMOTION_THRESHOLDS.minPsr === 0.95 && PROMOTION_THRESHOLDS.minDsr === 0.95, t, "PSR/DSR 0.95");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("promotion-gate.test.mts") || entry.endsWith("promotion-gate.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("promotion-gate.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`promotion-gate.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
