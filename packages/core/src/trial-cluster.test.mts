// packages/core/src/trial-cluster.test.mts
//
// Regression guard for effective-trial clustering (model-discovery-training §3.A
// / #3, sprints.md B50). Pure, no I/O.
//
// Run: npx tsx packages/core/src/trial-cluster.test.mts

import { jaccard, effectiveTrialCount } from "./trial-cluster.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const S = (...xs: string[]) => new Set(xs);
const trial = (...keys: string[]) => ({ keys });

// ── 1. jaccard ───────────────────────────────────────────────────────────────
{
  const t = "jaccard";
  expect(approx(jaccard(S("a"), S("a")), 1), t, "identical → 1");
  expect(approx(jaccard(S("a"), S("b")), 0), t, "disjoint → 0");
  expect(approx(jaccard(S("a"), S("a", "b")), 0.5), t, "{a} vs {a,b} → 0.5");
  expect(approx(jaccard(S("a", "b"), S("b", "c")), 1 / 3), t, "{a,b} vs {b,c} → 1/3");
  expect(approx(jaccard(S(), S()), 1), t, "two empty → 1");
}

// ── 2. degenerate inputs ─────────────────────────────────────────────────────
{
  const t = "degenerate";
  expect(effectiveTrialCount([]) === 0, t, "empty → 0");
  expect(effectiveTrialCount([trial(), trial()]) === 0, t, "all empty-key → 0");
  expect(effectiveTrialCount([trial("a")]) === 1, t, "single → 1");
}

// ── 3. identical tweaks collapse (the point) ─────────────────────────────────
{
  const t = "dedup";
  // The same knob nudged 5 times = ~1 effective trial.
  const trials = Array.from({ length: 5 }, () => trial("combinerConfidenceMin"));
  expect(effectiveTrialCount(trials) === 1, t, `5 same-knob tweaks → 1, got ${effectiveTrialCount(trials)}`);
}

// ── 4. disjoint knobs stay independent ───────────────────────────────────────
{
  const t = "disjoint";
  const trials = [trial("a"), trial("b"), trial("c")];
  expect(effectiveTrialCount(trials) === 3, t, `3 disjoint → 3, got ${effectiveTrialCount(trials)}`);
}

// ── 5. threshold + bounded chaining ──────────────────────────────────────────
{
  const t = "threshold";
  // {A} and {A,B}: J=0.5 → merged at default 0.5.
  expect(effectiveTrialCount([trial("A"), trial("A", "B")]) === 1, t, "{A},{A,B} merge at 0.5");
  // {A,B} and {B,C}: J=1/3 < 0.5 → separate.
  expect(effectiveTrialCount([trial("A", "B"), trial("B", "C")]) === 2, t, "{A,B},{B,C} separate at 0.5");
  // chain {A},{A,B},{B,C}: A–AB merge, AB–BC not → 2 components.
  expect(effectiveTrialCount([trial("A"), trial("A", "B"), trial("B", "C")]) === 2, t, "bounded chain → 2 components");
  // a stricter threshold splits {A} from {A,B}.
  expect(effectiveTrialCount([trial("A"), trial("A", "B")], 0.9) === 2, t, "threshold 0.9 keeps them apart");
}

// ── 6. mixed realistic log: some dups, some unique ───────────────────────────
{
  const t = "mixed";
  const trials = [
    trial("weatherInvertDirection"),
    trial("weatherInvertDirection"),           // dup
    trial("useRealizedIC"),
    trial("useRealizedIC"),                     // dup
    trial("weatherKellyScale"),
    trial("sportsMinPrice", "sportsEdgeThreshold"),
  ];
  // clusters: {invert×2}, {useRealizedIC×2}, {kellyScale}, {sports pair} = 4
  expect(effectiveTrialCount(trials) === 4, t, `expected 4 effective, got ${effectiveTrialCount(trials)}`);
  expect(effectiveTrialCount(trials) < trials.length, t, "effective < literal");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("trial-cluster.test.mts") || entry.endsWith("trial-cluster.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("trial-cluster.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`trial-cluster.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
