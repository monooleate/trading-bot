// packages/core/src/arb-scan.test.mts
//
// Regression guard for the B81 arbitrage arithmetic: the documented fee
// example, VWAP depth-walk, the NO-ask mirror, partition and nested arbs with
// a positive control (a planted arb is found) and a negative control (a fair
// book shows none), and ladder rung / direction detection. Pure, no I/O.
//
// Run: npx tsx packages/core/src/arb-scan.test.mts

import {
  takerFeePerShare,
  buyVwap,
  mirrorAsks,
  partitionBuyYes,
  partitionBuyNo,
  nestedArb,
  parseRung,
  spearman,
  ladderPairs,
  rungDirection,
  type Leg,
} from "./arb-scan.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const leg = (ask: number, bid: number, feeRate = 0, size = 1000): Leg =>
  ({ yesAsks: [{ price: ask, size }], yesBids: [{ price: bid, size }], feeRate });

// ── fee: the docs example (crypto, 100 shares @ 0.50 → $1.75) ───────────────
{
  const t = "fee";
  expect(approx(100 * takerFeePerShare(0.5, 0.07), 1.75), t, `100 × 0.07 × 0.5 × 0.5 = 1.75`);
}

// ── VWAP walk + thin book ───────────────────────────────────────────────────
{
  const t = "vwap";
  const f = buyVwap([{ price: 0.52, size: 50 }, { price: 0.50, size: 30 }], 60, 0);
  expect(approx(f.cost, 30 * 0.50 + 30 * 0.52) && f.complete, t, `cheapest first, got ${f.cost}`);
  const thin = buyVwap([{ price: 0.5, size: 3 }], 10, 0);
  expect(!thin.complete && thin.shares === 3, t, `thin book flagged incomplete`);
  // Pins the B81 first-scan artefact: a decided market's winning side asks 1.00;
  // filtering it out made "YES(over 0.5) + NO(over 1.5)" look like $0.10 for $100.
  const decided = nestedArb({ yesAsks: [{ price: 0.001, size: 1000 }], yesBids: [{ price: 0.999, size: 1000 }], feeRate: 0 },
    { yesAsks: [{ price: 1, size: 1000 }], yesBids: [{ price: 0.999, size: 1000 }], feeRate: 0 }, 100);
  expect(decided.complete && approx(decided.cost, 100.1) && decided.profit < 0, t, `an ask at 1.00 is a real price, got ${JSON.stringify(decided)}`);
  const m = mirrorAsks([{ price: 0.4, size: 7 }]);
  expect(approx(m[0].price, 0.6) && m[0].size === 7, t, `YES bid 0.40 → NO ask 0.60`);
}

// ── partition: positive + negative control ──────────────────────────────────
{
  const t = "partition";
  const planted = partitionBuyYes([leg(0.30, 0.29), leg(0.30, 0.29), leg(0.30, 0.29)], 100);
  expect(approx(planted.profit, 10) && planted.complete, t, `Σask 0.90 → +$10 on 100, got ${planted.profit}`);
  const fair = partitionBuyYes([leg(0.35, 0.33), leg(0.35, 0.33), leg(0.35, 0.33)], 100);
  expect(fair.profit < 0, t, `Σask 1.05 → no arb, got ${fair.profit}`);
  const no = partitionBuyNo([leg(0.42, 0.40), leg(0.42, 0.40), leg(0.42, 0.40)], 100);
  expect(approx(no.payout, 200) && approx(no.profit, 20), t, `Σbid 1.20 → NO arb +$20, got ${no.profit}`);
}

// ── nested: A ⊆ B, with fees ────────────────────────────────────────────────
{
  const t = "nested";
  const sub = leg(0.52, 0.50, 0.07);  // "above 110k"
  const sup = leg(0.45, 0.43, 0.07);  // "above 100k" priced BELOW its subset → violation
  const r = nestedArb(sub, sup, 100);
  const feePerShare = 0.07 * 0.45 * 0.55 + 0.07 * 0.5 * 0.5;
  expect(approx(r.profit, 100 * (1 - 0.45 - 0.5 - feePerShare)), t, `net = 1 − 0.45 − 0.50 − fees, got ${r.profit}`);
  const ok = nestedArb(leg(0.30, 0.28), leg(0.60, 0.58), 100);
  expect(ok.profit < 0, t, `consistent prices → no arb, got ${ok.profit}`);
}

// ── rung parsing ────────────────────────────────────────────────────────────
{
  const t = "parse-rung";
  const a = parseRung("Spread -20.5");
  expect(a?.template === "Spread {N}" && a.value === -20.5, t, `spread: ${JSON.stringify(a)}`);
  const b = parseRung("September 20");
  expect(b?.template === "{D}" && b.value === 920, t, `date: ${JSON.stringify(b)}`);
  const c = parseRung("↑ 120,000");
  expect(c?.value === 120000, t, `thousands separator: ${JSON.stringify(c)}`);
  const d = parseRung("$1.5M");
  expect(d?.value === 1.5e6, t, `suffix: ${JSON.stringify(d)}`);
  expect(parseRung("No change") === null, t, `no number → null`);
  // Pins the B81 second-scan artefact: both teams' spreads share the title.
  const lal = parseRung("Spread -3.5", "Spread: Lakers (-3.5)");
  const uta = parseRung("Spread -3.5", "Spread: Jazz (-3.5)");
  expect(lal?.template === "Spread: Lakers ({N})" && uta?.template === "Spread: Jazz ({N})", t,
    `the question separates the teams: ${lal?.template} / ${uta?.template}`);
}

// ── ladder direction ────────────────────────────────────────────────────────
{
  const t = "direction";
  expect(rungDirection("Will Bitcoin reach ${N} by December 31, 2026?") === 1, t, `reach → larger narrower`);
  expect(rungDirection("Will Bitcoin dip to ${N} by December 31, 2026?") === -1, t, `dip → larger wider`);
  expect(rungDirection("Spread: Walsall FC ({N})") === -1, t, `spread → −1.5 wider than −2.5`);
  expect(rungDirection("Walsall FC vs. Salford City FC: O/U {N}") === 1, t, `O/U (Over) → larger narrower`);
  expect(rungDirection("Will X happen by {D}?") === -1, t, `by date → later wider`);
  expect(rungDirection("US x Iran ceasefire continues through {D}?") === 1, t, `through date → later narrower`);
  expect(rungDirection("Who will win: {N}") === 0, t, `unknown wording → skipped`);
  // Pins a B81 pre-verdict artefact: "reach … or lower" is a DOWN ladder.
  expect(rungDirection("Will the Fed’s lower bound reach {N}% or lower before 2027?") === -1, t, `"or lower" overrides "reach"`);
}
{
  const t = "ladder";
  expect(approx(spearman([1, 2, 3], [3, 2, 1]), -1), t, `ρ = −1`);
  const R = (vals: number[], mids: number[], tight = true) => vals.map((value, i) => ({ value, mid: mids[i], tight, item: value }));
  // "above K": higher strike = narrower. One planted violation (120 priced over 110) is still paired.
  const pairs = ladderPairs(R([100, 110, 120, 130], [0.8, 0.5, 0.6, 0.1]), 1);
  const has = (s: number, b: number) => pairs?.some((p) => p.subset.item === s && p.superset.item === b);
  expect(!!has(120, 110) && !!has(130, 100) && !has(100, 130), t, `higher strike is the subset`);
  // Pins the B81 third-scan artefact: junk mids on thin rungs must not flip a spread ladder.
  const walsall = [-1.5, -2.5, -3.5, -4.5, -5.5].map((value, i) =>
    ({ value, mid: [0.11, 0.04, 0.44, 0.355, 0.48][i], tight: i < 2, item: value }));
  const wp = ladderPairs(walsall, -1);
  expect(wp?.some((p) => p.subset.item === -2.5 && p.superset.item === -1.5) === true &&
    !wp?.some((p) => p.subset.item === -1.5 && p.superset.item === -2.5), t, `−2.5 ⊆ −1.5 regardless of thin-rung mids`);
  // A tight ladder strongly ordered against the stated direction = template misread → skipped.
  expect(ladderPairs(R([1, 2, 3, 4], [0.1, 0.3, 0.5, 0.7]), 1) === null, t, `contradicted direction → skipped`);
  expect(ladderPairs(R([1, 2, 3], [0.6, 0.4, 0.2]), 0) === null, t, `unknown direction → skipped`);
}

const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("arb-scan.test.mts") || entry.endsWith("arb-scan.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("arb-scan.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`arb-scan.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
