// packages/core/src/config-fingerprint.test.mts
//
// Regression guard for the config fingerprint + A/B attribution (model-discovery-
// training §2.C / #4, sprints.md B50). Pure, no I/O.
//
// Run: npx tsx packages/core/src/config-fingerprint.test.mts

import { hash32, configFingerprint, computeConfigAttribution } from "./config-fingerprint.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── 1. hash32 stable + 8-hex ─────────────────────────────────────────────────
{
  const t = "hash32";
  const h = hash32("combinerConfidenceMin=0.05");
  expect(/^[0-9a-f]{8}$/.test(h), t, `8 hex, got ${h}`);
  expect(hash32("abc") === hash32("abc"), t, "deterministic");
  expect(hash32("abc") !== hash32("abd"), t, "distinct inputs differ");
}

// ── 2. configFingerprint ─────────────────────────────────────────────────────
{
  const t = "fingerprint";
  expect(configFingerprint({}) === "default", t, "empty → default");
  expect(configFingerprint(null) === "default", t, "null → default");
  expect(configFingerprint(undefined) === "default", t, "undefined → default");
  // order-independent
  const a = configFingerprint({ x: 1, y: 2 });
  const b = configFingerprint({ y: 2, x: 1 });
  expect(a === b, t, `order-independent, got ${a} vs ${b}`);
  // value change → different hash
  expect(configFingerprint({ x: 1 }) !== configFingerprint({ x: 2 }), t, "value change → different");
  // non-numeric values ignored (so {x:1, s:"foo"} == {x:1})
  expect(configFingerprint({ x: 1, s: "foo" as any }) === configFingerprint({ x: 1 }), t, "non-numeric ignored");
  // all-non-numeric → default
  expect(configFingerprint({ s: "foo" as any }) === "default", t, "all non-numeric → default");
}

// ── 3. computeConfigAttribution: grouping + skill + skips ────────────────────
{
  const t = "attribution";
  const rec = (configHash: string, predictedProb: number, marketPrice: number, outcome: number | null) =>
    ({ configHash, predictedProb, marketPrice, outcome });
  const recs = [
    // config A: model closer to outcome than market → positive skill
    rec("A", 0.9, 0.6, 1), rec("A", 0.1, 0.4, 0), rec("A", 0.85, 0.55, 1),
    // config B: model worse than market → negative skill
    rec("B", 0.4, 0.7, 1), rec("B", 0.6, 0.3, 0),
    // unresolved → skipped
    rec("A", 0.5, 0.5, null),
    // no fingerprint → "unlabeled"
    { predictedProb: 0.8, marketPrice: 0.5, outcome: 1 } as any,
    // bad baseline (market=1) → skipped
    rec("A", 0.9, 1, 1),
  ];
  const rows = computeConfigAttribution(recs);
  const A = rows.find((r) => r.configHash === "A")!;
  const B = rows.find((r) => r.configHash === "B")!;
  const U = rows.find((r) => r.configHash === "unlabeled")!;
  expect(!!A && A.n === 3, t, `config A has 3 resolved (unresolved+bad-baseline skipped), got ${A?.n}`);
  expect(A.brierSkill > 0, t, `A beats market, got ${A.brierSkill}`);
  expect(!!B && B.n === 2 && B.brierSkill < 0, t, `B worse than market, got ${JSON.stringify(B)}`);
  expect(!!U && U.n === 1, t, "records without fingerprint bucket under 'unlabeled'");
  // sorted by n desc
  expect(rows[0].n >= rows[rows.length - 1].n, t, "sorted by n desc");
}

// ── 4. empty input ───────────────────────────────────────────────────────────
{
  const t = "empty";
  expect(computeConfigAttribution([]).length === 0, t, "empty → []");
  expect(computeConfigAttribution(null as any).length === 0, t, "null → []");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("config-fingerprint.test.mts") || entry.endsWith("config-fingerprint.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("config-fingerprint.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`config-fingerprint.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
