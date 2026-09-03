// packages/core/src/walk-forward.test.mts
//
// Regression guard for the walk-forward scoring harness (model-discovery-
// expansion §4.B / sprints.md B49 #4). Pure, no I/O.
//
// Run: npx tsx packages/core/src/walk-forward.test.mts

import {
  ledgerPointsFromRecords,
  computeWalkForward,
  type LedgerPoint,
} from "./walk-forward.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const DAY = 86_400_000;
const base = Date.parse("2026-01-01T00:00:00Z");
const pt = (predictedProb: number, marketPrice: number, outcome: number, dayOffset: number): LedgerPoint =>
  ({ predictedProb, marketPrice, outcome, resolvedAtMs: base + dayOffset * DAY, slug: `m${dayOffset}` });

// ── 1. ledgerPointsFromRecords filters unresolved / invalid ──────────────────
{
  const t = "extract";
  const recs = [
    { predictedProb: 0.7, marketPrice: 0.5, outcome: 1, resolvedAt: "2026-01-01T00:00:00Z", slug: "a" }, // ok
    { predictedProb: 0.7, marketPrice: 0.5, outcome: null, resolvedAt: "2026-01-01T00:00:00Z", slug: "b" }, // unresolved
    { predictedProb: 0.7, marketPrice: 1.0, outcome: 1, resolvedAt: "2026-01-01T00:00:00Z", slug: "c" }, // market=1 → no baseline
    { predictedProb: 2.0, marketPrice: 0.5, outcome: 0, resolvedAt: "2026-01-01T00:00:00Z", slug: "d" }, // bad prob
    { predictedProb: 0.3, marketPrice: 0.5, outcome: 0, endDate: "2026-01-02T00:00:00Z", slug: "e" }, // ok via endDate
  ];
  const pts = ledgerPointsFromRecords(recs as any);
  expect(pts.length === 2, t, `2 valid points, got ${pts.length}`);
  expect(pts.map((p) => p.slug).sort().join(",") === "a,e", t, "keeps a,e");
}

// ── 2. model beats market → positive overall Brier skill ─────────────────────
{
  const t = "skill-positive";
  // model always closer to the outcome than the market price.
  const pts = [
    pt(0.9, 0.6, 1, 0), pt(0.1, 0.4, 0, 1), pt(0.85, 0.55, 1, 2),
    pt(0.15, 0.45, 0, 3), pt(0.8, 0.6, 1, 4), pt(0.2, 0.4, 0, 5),
  ];
  const r = computeWalkForward(pts, { blockCount: 3 });
  expect(r.overall.brierModel < r.overall.brierMarket, t, `model Brier < market (${r.overall.brierModel.toFixed(3)} < ${r.overall.brierMarket.toFixed(3)})`);
  expect(r.overall.brierSkill > 0, t, `overall skill > 0, got ${r.overall.brierSkill.toFixed(3)}`);
  expect(r.nBlocks === 3, t, `3 blocks, got ${r.nBlocks}`);
  expect(r.consistency === 1, t, `all blocks positive, got ${r.consistency}`);
  expect(r.overall.logLossModel < r.overall.logLossMarket, t, "model log-loss < market");
}

// ── 3. model == market → skill ~0 ────────────────────────────────────────────
{
  const t = "skill-zero";
  const pts = [pt(0.6, 0.6, 1, 0), pt(0.4, 0.4, 0, 1), pt(0.6, 0.6, 1, 2), pt(0.4, 0.4, 0, 3)];
  const r = computeWalkForward(pts, { blockCount: 2 });
  expect(approx(r.overall.brierSkill, 0, 1e-9), t, `skill ~0, got ${r.overall.brierSkill}`);
}

// ── 4. model worse than market → negative skill ──────────────────────────────
{
  const t = "skill-negative";
  const pts = [pt(0.4, 0.7, 1, 0), pt(0.6, 0.3, 0, 1), pt(0.45, 0.75, 1, 2), pt(0.55, 0.25, 0, 3)];
  const r = computeWalkForward(pts, { blockCount: 2 });
  expect(r.overall.brierSkill < 0, t, `skill < 0, got ${r.overall.brierSkill.toFixed(3)}`);
  expect(r.consistency < 1, t, "not all blocks positive");
}

// ── 5. block splitting + chronological order ─────────────────────────────────
{
  const t = "blocks";
  // 10 points, blockCount 5 → 5 blocks of 2, time-ordered.
  const pts: LedgerPoint[] = [];
  for (let i = 0; i < 10; i++) pts.push(pt(0.55, 0.5, i % 2, i));
  // feed shuffled → harness must sort by time
  const shuffled = [pts[5], pts[0], pts[9], pts[3], pts[7], pts[1], pts[8], pts[2], pts[6], pts[4]];
  const r = computeWalkForward(shuffled, { blockCount: 5 });
  expect(r.nBlocks === 5, t, `5 blocks, got ${r.nBlocks}`);
  expect(r.blocks.every((b) => b.n === 2), t, "each block n=2");
  expect(r.blocks[0].startTs < r.blocks[4].startTs, t, "blocks chronological");
  expect(r.nResolved === 10, t, "10 resolved");
}

// ── 6. correlation caveat: same-day cluster ──────────────────────────────────
{
  const t = "cluster";
  // 4 points all resolving on the same day + 1 on another day.
  const pts = [pt(0.6, 0.5, 1, 0), pt(0.6, 0.5, 1, 0), pt(0.6, 0.5, 0, 0), pt(0.6, 0.5, 1, 0), pt(0.6, 0.5, 0, 5)];
  const r = computeWalkForward(pts, { blockCount: 2 });
  expect(r.effectiveDays === 2, t, `2 distinct days, got ${r.effectiveDays}`);
  expect(approx(r.maxDayShare, 4 / 5), t, `maxDayShare 0.8, got ${r.maxDayShare}`);
}

// ── 7. scarce data ───────────────────────────────────────────────────────────
{
  const t = "scarce";
  expect(computeWalkForward([], {}).nBlocks === 0, t, "empty → 0 blocks");
  expect(computeWalkForward([pt(0.7, 0.5, 1, 0)], {}).nBlocks === 0, t, "1 point → 0 blocks (need ≥2)");
  const r = computeWalkForward([pt(0.9, 0.5, 1, 0), pt(0.1, 0.5, 0, 1)], { blockCount: 5 });
  expect(r.nBlocks <= 2, t, `blockCount shrinks to data, got ${r.nBlocks}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("walk-forward.test.mts") || entry.endsWith("walk-forward.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("walk-forward.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`walk-forward.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
