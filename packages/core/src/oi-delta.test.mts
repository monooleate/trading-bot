// packages/core/src/oi-delta.test.mts
//
// Regression guard for the OI-Δ × price signal (model-discovery-expansion §4.D /
// sprints.md B49 #5). Pure, no I/O.
//
// Run: npx tsx packages/core/src/oi-delta.test.mts

import { classifyOiQuadrant, oiDeltaProb } from "./oi-delta.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ── 1. quadrant classification ───────────────────────────────────────────────
{
  const t = "quadrant";
  expect(classifyOiQuadrant(0.02, 0.05) === "fresh_longs", t, "price↑ OI↑ → fresh_longs");
  expect(classifyOiQuadrant(0.02, -0.05) === "short_covering", t, "price↑ OI↓ → short_covering");
  expect(classifyOiQuadrant(-0.02, 0.05) === "fresh_shorts", t, "price↓ OI↑ → fresh_shorts");
  expect(classifyOiQuadrant(-0.02, -0.05) === "long_unwind", t, "price↓ OI↓ → long_unwind");
  expect(classifyOiQuadrant(0.0001, 0.05) === "neutral", t, "tiny move → neutral");
}

// ── 2. rising OI confirms → strong tilt; direction correct ───────────────────
{
  const t = "confirm";
  const up = oiDeltaProb(0.02, 0.05);   // fresh longs → >0.5
  const dn = oiDeltaProb(-0.02, 0.05);  // fresh shorts → <0.5
  expect(up > 0.5, t, `fresh longs → P(up)>0.5, got ${up.toFixed(3)}`);
  expect(dn < 0.5, t, `fresh shorts → P(up)<0.5, got ${dn.toFixed(3)}`);
  // symmetric around 0.5 for symmetric inputs
  expect(approx(up - 0.5, 0.5 - dn), t, "symmetric tilt");
}

// ── 3. falling OI dampens the same price move ────────────────────────────────
{
  const t = "dampen";
  const confirmed = oiDeltaProb(0.02, 0.05);   // OI rising
  const unwound   = oiDeltaProb(0.02, -0.05);  // OI falling → weaker
  expect(unwound > 0.5 && unwound < confirmed, t, `short-cover weaker than fresh-longs (${unwound.toFixed(3)} < ${confirmed.toFixed(3)})`);
  // dampen factor 0.3 → tilt is 30% of the confirmed tilt
  expect(approx(unwound - 0.5, (confirmed - 0.5) * 0.3, 1e-6), t, "dampen = 0.3× tilt");
}

// ── 4. magnitude + cap + clamp ───────────────────────────────────────────────
{
  const t = "magnitude";
  const small = oiDeltaProb(0.005, 0.05);
  const big   = oiDeltaProb(0.03, 0.05);
  expect(big > small, t, "bigger move → bigger tilt");
  // spike beyond prCap is capped, not pegged to the extreme
  const capped = oiDeltaProb(0.5, 0.05, { scale: 8, prCap: 0.05 }); // 0.5+0.05*8=0.9
  expect(approx(capped, 0.9), t, `capped at prCap → 0.9, got ${capped}`);
  // clamp to hi
  const clamped = oiDeltaProb(0.5, 0.05, { scale: 100, prCap: 0.05 });
  expect(clamped === 0.95, t, `clamped to hi 0.95, got ${clamped}`);
}

// ── 5. neutral + invalid ─────────────────────────────────────────────────────
{
  const t = "edge";
  expect(oiDeltaProb(0.0001, 0.05) === 0.5, t, "flat move → 0.5");
  expect(Number.isNaN(oiDeltaProb(NaN, 0.05)), t, "NaN price → NaN");
  expect(Number.isNaN(oiDeltaProb(0.02, NaN)), t, "NaN oi → NaN");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("oi-delta.test.mts") || entry.endsWith("oi-delta.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("oi-delta.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`oi-delta.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
