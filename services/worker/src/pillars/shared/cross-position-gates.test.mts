// netlify/functions/auto-trader/shared/cross-position-gates.test.mts
// Regression guard for the cross-market-consistency primitives.
//
// Run with: npx tsx netlify/functions/auto-trader/shared/cross-position-gates.test.mts
//
// Pins the 2026-05-14 live-incident reproduction: the Crypto bot opened
// `bitcoin-above-78k-on-may-14` NO @ pred=52% and then
// `bitcoin-above-80k-on-may-14` YES @ pred=53% on the same closingTime,
// despite P(>78K) ≥ P(>80K) being a mathematical invariant for nested
// thresholds. The monotonicity helper must reject the second trade.

import {
  parseBtcAboveSlug,
  findMonotonicityViolation,
  findOutcomeOverlapViolation,
  type MonotonicityExisting,
  type OutcomeOverlapExisting,
} from "./cross-position-gates.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── Parser ──────────────────────────────────────────────────────────────
{
  const t = "parseBtcAboveSlug";
  const a = parseBtcAboveSlug("bitcoin-above-78k-on-may-14");
  expect(a !== null && a.K === 78 && a.closingKey === "may-14", t, `78K parse: ${JSON.stringify(a)}`);

  const b = parseBtcAboveSlug("bitcoin-above-80k-on-may-14");
  expect(b !== null && b.K === 80 && b.closingKey === "may-14", t, `80K parse: ${JSON.stringify(b)}`);

  const c = parseBtcAboveSlug("will-bitcoin-be-above-100k-on-2026-05-14");
  expect(c !== null && c.K === 100 && c.closingKey === "2026-05-14", t, `100K parse: ${JSON.stringify(c)}`);

  const d = parseBtcAboveSlug("btc-above-65k-on-may-9");
  expect(d !== null && d.K === 65, t, `btc-above-65k parse: ${JSON.stringify(d)}`);

  // Negative cases
  expect(parseBtcAboveSlug("eth-up-or-down-15m") === null, t, "ETH up-or-down should not parse");
  expect(parseBtcAboveSlug("bitcoin-up-or-down-15m") === null, t, "BTC up-or-down should not parse");
  expect(parseBtcAboveSlug(undefined) === null, t, "undefined input");
  expect(parseBtcAboveSlug("") === null, t, "empty input");
}

// ── Monotonicity violation detector ─────────────────────────────────────
{
  const t = "findMonotonicityViolation";

  // 2026-05-14 live incident reproduction. Open: 78K-NO with predY=0.52.
  // Candidate: 80K-YES with predY=0.53. K_new > K_existing but
  // predNew > predExisting violates P(>78K) ≥ P(>80K).
  const existing78: MonotonicityExisting[] = [{
    K: 78, closingKey: "may-14", predictedYesProb: 0.52,
    slug: "bitcoin-above-78k-on-may-14",
  }];
  const viol = findMonotonicityViolation(
    { K: 80, closingKey: "may-14", predictedYesProb: 0.53 },
    existing78,
  );
  expect(viol !== null, t, "78K-NO @ 52% + 80K-YES @ 53% must be flagged as monotonicity violation");
  expect(viol?.K === 78, t, `violation should point at 78K position, got K=${viol?.K}`);

  // Reverse direction: K_new < K_existing should require predNew ≥ predExisting.
  // Existing 80K @ 30% pred, candidate 78K @ 20% pred — violates (P(>78K) ≥ P(>80K))
  const existing80: MonotonicityExisting[] = [{
    K: 80, closingKey: "may-14", predictedYesProb: 0.30,
    slug: "bitcoin-above-80k-on-may-14",
  }];
  const viol2 = findMonotonicityViolation(
    { K: 78, closingKey: "may-14", predictedYesProb: 0.20 },
    existing80,
  );
  expect(viol2 !== null, t, "K_new<K_existing case: 80K@30% + 78K@20% must be flagged");

  // Consistent case (no violation): 78K @ 60%, 80K candidate @ 50%.
  // K_new > K_existing AND predNew ≤ predExisting → OK.
  const okExisting: MonotonicityExisting[] = [{
    K: 78, closingKey: "may-14", predictedYesProb: 0.60,
    slug: "bitcoin-above-78k-on-may-14",
  }];
  const okCheck = findMonotonicityViolation(
    { K: 80, closingKey: "may-14", predictedYesProb: 0.50 },
    okExisting,
  );
  expect(okCheck === null, t, `monotonic 78K@60% + 80K@50% should NOT flag; got: ${JSON.stringify(okCheck)}`);

  // Different closingKey — should not flag across groups.
  const diffDay: MonotonicityExisting[] = [{
    K: 78, closingKey: "may-13", predictedYesProb: 0.52,
    slug: "bitcoin-above-78k-on-may-13",
  }];
  const acrossDays = findMonotonicityViolation(
    { K: 80, closingKey: "may-14", predictedYesProb: 0.53 },
    diffDay,
  );
  expect(acrossDays === null, t, "Different closingKey groups must not cross-flag");

  // Equal K — not a monotonicity question, should not flag.
  const sameK = findMonotonicityViolation(
    { K: 78, closingKey: "may-14", predictedYesProb: 0.99 },
    [{
      K: 78, closingKey: "may-14", predictedYesProb: 0.10,
      slug: "bitcoin-above-78k-on-may-14",
    }],
  );
  expect(sameK === null, t, "Same K must not be flagged (no monotonicity question)");

  // Empty existing list — pass trivially.
  const empty = findMonotonicityViolation(
    { K: 80, closingKey: "may-14", predictedYesProb: 0.50 },
    [],
  );
  expect(empty === null, t, "No existing positions ⇒ no violation");
}

// ── Outcome-overlap violation detector ──────────────────────────────────
{
  const t = "findOutcomeOverlapViolation";

  // 2026-05-15 live incident reproduction. Existing: NO @ 80K. Candidate:
  // YES @ 82K. Predictions were strictly monotonic (0.4604 > 0.4557), so
  // findMonotonicityViolation correctly returned null. But the side bets
  // are mutually exclusive: NO@80K wins iff BTC ≤ $80K; YES@82K wins iff
  // BTC > $82K. The (80K, 82K] band loses on BOTH. Must flag.
  const noAt80: OutcomeOverlapExisting[] = [{
    K: 80, closingKey: "may-15", direction: "NO",
    slug: "bitcoin-above-80k-on-may-15",
  }];
  const viol = findOutcomeOverlapViolation(
    { K: 82, closingKey: "may-15", direction: "YES" },
    noAt80,
  );
  expect(viol !== null, t, "Pattern A: cand YES @ 82K vs existing NO @ 80K must be flagged");
  expect(viol?.K === 80, t, `violation should point at 80K, got K=${viol?.K}`);

  // Pattern B: candidate NO on lower K, existing YES on higher K.
  // Existing YES @ 82K. Candidate NO @ 80K. NO@80K wins iff BTC ≤ 80K;
  // YES@82K wins iff BTC > 82K. Same double-loss band.
  const yesAt82: OutcomeOverlapExisting[] = [{
    K: 82, closingKey: "may-15", direction: "YES",
    slug: "bitcoin-above-82k-on-may-15",
  }];
  const viol2 = findOutcomeOverlapViolation(
    { K: 80, closingKey: "may-15", direction: "NO" },
    yesAt82,
  );
  expect(viol2 !== null, t, "Pattern B: cand NO @ 80K vs existing YES @ 82K must be flagged");
  expect(viol2?.K === 82, t, `violation should point at 82K, got K=${viol2?.K}`);

  // Consistent case 1: same direction. YES @ 80K + YES @ 82K both win when
  // BTC > 82K — no contradiction, gate passes.
  const yesAt80: OutcomeOverlapExisting[] = [{
    K: 80, closingKey: "may-15", direction: "YES",
    slug: "bitcoin-above-80k-on-may-15",
  }];
  const sameYes = findOutcomeOverlapViolation(
    { K: 82, closingKey: "may-15", direction: "YES" },
    yesAt80,
  );
  expect(sameYes === null, t, `YES@80K + cand YES@82K should NOT flag; got: ${JSON.stringify(sameYes)}`);

  // Consistent case 2: same direction NO + NO — both win when BTC ≤ 78K.
  const noAt78: OutcomeOverlapExisting[] = [{
    K: 78, closingKey: "may-15", direction: "NO",
    slug: "bitcoin-above-78k-on-may-15",
  }];
  const sameNo = findOutcomeOverlapViolation(
    { K: 80, closingKey: "may-15", direction: "NO" },
    noAt78,
  );
  expect(sameNo === null, t, `NO@78K + cand NO@80K should NOT flag; got: ${JSON.stringify(sameNo)}`);

  // Consistent case 3: winning-zone overlap. YES @ 80K (wins if BTC > 80K)
  // + candidate NO @ 82K (wins if BTC ≤ 82K). Both win in (80K, 82K] —
  // an actual overlap, not a contradiction. Must NOT flag.
  const overlap = findOutcomeOverlapViolation(
    { K: 82, closingKey: "may-15", direction: "NO" },
    yesAt80,
  );
  expect(overlap === null, t, `YES@80K + cand NO@82K (overlap zone) should NOT flag; got: ${JSON.stringify(overlap)}`);

  // Different closingKey — must not cross-flag across resolution dates.
  const otherDay: OutcomeOverlapExisting[] = [{
    K: 80, closingKey: "may-14", direction: "NO",
    slug: "bitcoin-above-80k-on-may-14",
  }];
  const crossDay = findOutcomeOverlapViolation(
    { K: 82, closingKey: "may-15", direction: "YES" },
    otherDay,
  );
  expect(crossDay === null, t, "Different closingKey groups must not cross-flag");

  // Same K, opposite direction — covered by separate "no LONG+SHORT same
  // market" intent. This helper deliberately skips it (cand.K === e.K).
  const sameKopp = findOutcomeOverlapViolation(
    { K: 80, closingKey: "may-15", direction: "YES" },
    noAt80,
  );
  expect(sameKopp === null, t, "Same K + opposite side should be handled elsewhere, not here");

  // Empty existing list — pass trivially.
  const emptyOO = findOutcomeOverlapViolation(
    { K: 80, closingKey: "may-15", direction: "YES" },
    [],
  );
  expect(emptyOO === null, t, "No existing positions ⇒ no violation");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("cross-position-gates.test.mts") || entry.endsWith("cross-position-gates.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("cross-position-gates.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`cross-position-gates.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
