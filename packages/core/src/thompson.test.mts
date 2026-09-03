// packages/core/src/thompson.test.mts
//
// Regression guard for the discounted Thompson-sampling config selector
// (model-discovery-training §3.C / #6 + #8, sprints.md B50). Pure, no I/O.
//
// Run: npx tsx packages/core/src/thompson.test.mts

import {
  forgettingWeight, betaPosteriors, thompsonRank, banditArmsFromRecords,
  type BanditArm,
} from "./thompson.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ── 1. forgettingWeight (#8) ─────────────────────────────────────────────────
{
  const t = "forget";
  expect(forgettingWeight(0, 75) === 1, t, "age 0 → 1");
  expect(approx(forgettingWeight(75, 75), 0.5), t, "one half-life → 0.5");
  expect(approx(forgettingWeight(150, 75), 0.25), t, "two half-lives → 0.25");
  expect(forgettingWeight(100, 0) === 1, t, "halfLife 0 → no decay");
  expect(forgettingWeight(100, -5) === 1, t, "negative halfLife → no decay");
}

// ── 2. betaPosteriors: discounted counts ─────────────────────────────────────
{
  const t = "posteriors";
  const arms: BanditArm[] = [
    { arm: "A", rewards: [{ reward: 1, age: 0 }, { reward: 1, age: 0 }, { reward: 0, age: 0 }] },
  ];
  // no decay (halfLife 0): alpha = 1+2, beta = 1+1
  const p0 = betaPosteriors(arms, 0)[0];
  expect(approx(p0.alpha, 3) && approx(p0.beta, 2), t, `no-decay counts, got a=${p0.alpha} b=${p0.beta}`);
  expect(approx(p0.mean, 3 / 5), t, `mean 0.6, got ${p0.mean}`);
  expect(p0.nRaw === 3, t, "raw count 3");
  // old rewards discounted → nEff shrinks
  const armsOld: BanditArm[] = [{ arm: "A", rewards: [{ reward: 1, age: 150 }] }];
  const pOld = betaPosteriors(armsOld, 75)[0];
  expect(approx(pOld.nEff, 0.25, 1e-9), t, `discounted nEff 0.25, got ${pOld.nEff}`);
  expect(approx(pOld.alpha, 1.25), t, "alpha reflects discounted reward");
}

// ── 3. thompsonRank: a clearly-better arm wins prob-best ─────────────────────
{
  const t = "rank";
  const arms: BanditArm[] = [
    { arm: "good", rewards: Array.from({ length: 40 }, (_, i) => ({ reward: i < 32 ? 1 : 0, age: 0 })) }, // 80%
    { arm: "bad", rewards: Array.from({ length: 40 }, (_, i) => ({ reward: i < 12 ? 1 : 0, age: 0 })) },  // 30%
  ];
  const ranked = thompsonRank(arms, { halfLifeSteps: 0, samples: 4000, seed: 1 });
  expect(ranked.length === 2, t, "2 arms");
  expect(ranked[0].arm === "good", t, `good arm ranked first, got ${ranked[0].arm}`);
  expect(ranked[0].probBest > 0.95, t, `good arm prob-best > 0.95, got ${ranked[0].probBest}`);
  // prob-best sums to ~1
  expect(approx(ranked[0].probBest + ranked[1].probBest, 1, 1e-6), t, "prob-best sums to 1");
  // determinism
  const ranked2 = thompsonRank(arms, { halfLifeSteps: 0, samples: 4000, seed: 1 });
  expect(ranked[0].probBest === ranked2[0].probBest, t, "deterministic across runs");
}

// ── 4. equal arms → prob-best near 0.5 each ──────────────────────────────────
{
  const t = "equal";
  const mk = (name: string): BanditArm => ({ arm: name, rewards: Array.from({ length: 30 }, (_, i) => ({ reward: i < 15 ? 1 : 0, age: 0 })) });
  const ranked = thompsonRank([mk("x"), mk("y")], { halfLifeSteps: 0, samples: 4000, seed: 2 });
  expect(Math.abs(ranked[0].probBest - 0.5) < 0.15, t, `near 50/50, got ${ranked[0].probBest}`);
}

// ── 5. banditArmsFromRecords: reward = model beats market, grouped by config ──
{
  const t = "from-records";
  const recs = [
    // config A: model closer than market → reward 1
    { configHash: "A", predictedProb: 0.9, marketPrice: 0.6, outcome: 1, resolvedAt: "2026-01-03T00:00:00Z" },
    { configHash: "A", predictedProb: 0.2, marketPrice: 0.5, outcome: 0, resolvedAt: "2026-01-02T00:00:00Z" },
    // config B: model worse → reward 0
    { configHash: "B", predictedProb: 0.4, marketPrice: 0.8, outcome: 1, resolvedAt: "2026-01-01T00:00:00Z" },
    // unresolved → skipped
    { configHash: "A", predictedProb: 0.5, marketPrice: 0.5, outcome: null, resolvedAt: "2026-01-04T00:00:00Z" },
    // no fingerprint → "unlabeled"
    { predictedProb: 0.7, marketPrice: 0.5, outcome: 1, resolvedAt: "2026-01-05T00:00:00Z" },
  ];
  const arms = banditArmsFromRecords(recs as any);
  const A = arms.find((a) => a.arm === "A")!;
  const B = arms.find((a) => a.arm === "B")!;
  const U = arms.find((a) => a.arm === "unlabeled")!;
  expect(!!A && A.rewards.length === 2 && A.rewards.every((r) => r.reward === 1), t, "A: 2 rewards, both 1");
  expect(!!B && B.rewards.length === 1 && B.rewards[0].reward === 0, t, "B: model worse → 0");
  expect(!!U && U.rewards.length === 1, t, "unlabeled bucket");
  // newest resolved (unlabeled, 01-05) has age 0
  expect(U.rewards[0].age === 0, t, `newest → age 0, got ${U.rewards[0].age}`);
}

// ── 6. empty ─────────────────────────────────────────────────────────────────
{
  const t = "empty";
  expect(thompsonRank([]).length === 0, t, "no arms → []");
  expect(banditArmsFromRecords([]).length === 0, t, "no records → []");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("thompson.test.mts") || entry.endsWith("thompson.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("thompson.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`thompson.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
