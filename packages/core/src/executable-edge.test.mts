// packages/core/src/executable-edge.test.mts
//
// Regression guard for the executable-edge gate (B75). Pure, no I/O.
// The two live cases are taken verbatim from the 2026-09-28 worker log.
//
// Run: npx tsx packages/core/src/executable-edge.test.mts

import { evaluateExecutableEdge, POLYMARKET_MIN_ORDER_SHARES } from "./executable-edge.mts";
import { simulateDepthFill } from "./fill-model.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const base = { exitFeePct: 0.015, edgeThreshold: 0.15 };

// ── Live case 1: the quote hid the spread ────────────────────────────────────
// bitcoin-above-84k-on-september-28-2026, NO, logged net edge 15.26% on the
// quote (YES 0.79 → NO quote 0.22), book VWAP 0.37. Model P(YES) = 0.6014.
{
  const t = "live-spread";
  const r = evaluateExecutableEdge({
    ...base,
    predProbYes: 0.6014,
    direction: "NO",
    quotedSidePrice: 0.22,
    requestedUsdc: 6.72,
    fill: { ok: true, filledShares: 6.72 / 0.37, filledUsdc: 6.72, vwap: 0.37 },
  });
  expect(!r.ok, t, "must block");
  expect(r.failure === "edge_below_threshold", t, `failure edge_below_threshold, got ${r.failure}`);
  expect(approx(r.executableEdge, 0.3986 - 0.37 - 0.015), t, `exec edge ≈ 1.4%, got ${r.executableEdge}`);
  expect(approx(r.slippage, 0.15), t, `slippage 15¢, got ${r.slippage}`);
  expect(r.reason.includes("VWAP 0.370"), t, `reason names the VWAP: ${r.reason}`);
}

// ── Live case 2: vol-target shrank the order under the minimum ───────────────
// bitcoin-above-84k-on-september-25-2026, NO, $2.24 requested (8.95 × 0.25),
// VWAP 0.75 → 2.99 shares < 5.
{
  const t = "live-min-size";
  const r = evaluateExecutableEdge({
    ...base,
    predProbYes: 0.1,
    direction: "NO",
    quotedSidePrice: 0.66,
    requestedUsdc: 2.24,
    fill: { ok: true, filledShares: 2.24 / 0.75, filledUsdc: 2.24, vwap: 0.75 },
  });
  expect(!r.ok && r.failure === "below_min_size", t, `below_min_size, got ${r.failure}`);
  expect(r.reason.includes(`< ${POLYMARKET_MIN_ORDER_SHARES}`), t, `reason names the minimum: ${r.reason}`);
}

// ── Genuine edge passes ──────────────────────────────────────────────────────
{
  const t = "pass";
  const r = evaluateExecutableEdge({
    ...base,
    predProbYes: 0.8,
    direction: "YES",
    quotedSidePrice: 0.55,
    requestedUsdc: 10,
    fill: { ok: true, filledShares: 10 / 0.58, filledUsdc: 10, vwap: 0.58 },
  });
  expect(r.ok && r.failure === null, t, `should pass, got ${r.failure} / ${r.reason}`);
  expect(approx(r.executableEdge, 0.8 - 0.58 - 0.015), t, `exec edge, got ${r.executableEdge}`);
}

// ── No fill / invalid VWAP ───────────────────────────────────────────────────
{
  const t = "no-fill";
  const r = evaluateExecutableEdge({
    ...base, predProbYes: 0.9, direction: "YES", quotedSidePrice: 0.5, requestedUsdc: 10,
    fill: { ok: false, filledShares: 0, filledUsdc: 0, vwap: NaN },
  });
  expect(!r.ok && r.failure === "no_fill", t, `no_fill, got ${r.failure}`);
  const r2 = evaluateExecutableEdge({
    ...base, predProbYes: 0.9, direction: "YES", quotedSidePrice: 0.5, requestedUsdc: 10,
    fill: { ok: true, filledShares: 10, filledUsdc: 10, vwap: 1.2 },
  });
  expect(!r2.ok && r2.failure === "no_fill", t, `vwap ≥ 1 is not a fill, got ${r2.failure}`);
}

// ── End-to-end with the real depth walk ──────────────────────────────────────
// A thin top level (quote) and a fat second level 8¢ higher. The quote edge
// is 20%; walking the book for $20 at a 20% participation cap exhausts the top
// level and fills mostly at 0.58, so the executable edge drops below 15%.
{
  const t = "depth-walk";
  const asks = [{ price: 0.50, size: 20 }, { price: 0.58, size: 1000 }];
  const fill = simulateDepthFill(asks, 20, { participationCap: 0.2 });
  const r = evaluateExecutableEdge({
    ...base, predProbYes: 0.715, direction: "YES", quotedSidePrice: 0.50, requestedUsdc: 20, fill,
  });
  expect(fill.ok && fill.vwap > 0.57, t, `VWAP pulled to the second level, got ${fill.vwap}`);
  expect(!r.ok && r.failure === "edge_below_threshold", t, `quote-edge 20% must not survive the walk, got ${r.failure} ${r.executableEdge}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("executable-edge.test.mts") || entry.endsWith("executable-edge.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("executable-edge.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`executable-edge.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
