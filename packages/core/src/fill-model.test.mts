// packages/core/src/fill-model.test.mts
//
// Regression guard for the depth-aware fill model (model-discovery-expansion
// §4.A / sprints.md B49 #1). Imports the REAL dependency-free module → pins
// shipped code. Pure, no I/O.
//
// Run: npx tsx packages/core/src/fill-model.test.mts

import {
  simulateDepthFill,
  sqrtLawImpact,
  fallbackFill,
  defaultTickForPrice,
  snapDownToTick,
  isPriceOnTick,
  isFillValid,
  type BookLevel,
} from "./fill-model.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ── 1. Full fill on a deep book (request small vs depth) ─────────────────────
{
  const t = "full-fill";
  const asks: BookLevel[] = [{ price: 0.5, size: 10000 }];
  const r = simulateDepthFill(asks, 100, { participationCap: 0.2 });
  expect(r.ok, t, "ok");
  expect(approx(r.filledUsdc, 100), t, `filledUsdc=100, got ${r.filledUsdc}`);
  expect(approx(r.filledShares, 200), t, `shares=200 (100/0.5), got ${r.filledShares}`);
  expect(approx(r.vwap, 0.5), t, `vwap=0.5, got ${r.vwap}`);
  expect(r.partial === false, t, "not partial");
  expect(approx(r.fillFraction, 1), t, "fillFraction=1");
}

// ── 2. VWAP across two levels (walk the book) ────────────────────────────────
{
  const t = "vwap-two-levels";
  // cap=1.0 → take full levels. Request exactly 50 + 30 = 80 USDC.
  const asks: BookLevel[] = [{ price: 0.5, size: 100 }, { price: 0.6, size: 100 }];
  const r = simulateDepthFill(asks, 80, { participationCap: 1.0 });
  expect(r.ok, t, "ok");
  expect(approx(r.filledUsdc, 80), t, `filledUsdc=80, got ${r.filledUsdc}`);
  // 100 shares @0.5 (=50) + 50 shares @0.6 (=30) = 150 shares
  expect(approx(r.filledShares, 150), t, `shares=150, got ${r.filledShares}`);
  expect(approx(r.vwap, 80 / 150), t, `vwap=0.5333, got ${r.vwap}`);
  expect(r.levelsConsumed === 2, t, `2 levels, got ${r.levelsConsumed}`);
  expect(r.partial === false, t, "not partial (all 80 spent)");
}

// ── 3. Shallow book → partial fill, remainder dropped ────────────────────────
{
  const t = "partial";
  const asks: BookLevel[] = [{ price: 0.5, size: 100 }];
  const r = simulateDepthFill(asks, 100, { participationCap: 0.2 }); // takeable 20 shares → $10
  expect(r.ok, t, "ok");
  expect(approx(r.filledUsdc, 10), t, `filledUsdc=10, got ${r.filledUsdc}`);
  expect(approx(r.filledShares, 20), t, `shares=20, got ${r.filledShares}`);
  expect(r.partial === true, t, "partial");
  expect(approx(r.fillFraction, 0.1), t, `fillFraction=0.1, got ${r.fillFraction}`);
}

// ── 4. 5¢ longshot: the exact over-credit bug this module kills ───────────────
{
  const t = "longshot-cap";
  // Naive engine: 200/0.05 = 4000 shares. Real thin book with cap: far less.
  const asks: BookLevel[] = [{ price: 0.05, size: 500 }];
  const r = simulateDepthFill(asks, 200, { participationCap: 0.2 }); // takeable 100 shares → $5
  expect(approx(r.filledShares, 100), t, `shares=100 (not 4000), got ${r.filledShares}`);
  expect(approx(r.filledUsdc, 5), t, `filledUsdc=5, got ${r.filledUsdc}`);
  expect(r.partial === true, t, "partial (book cannot absorb $200)");
  expect(r.filledShares < 4000, t, "far below the naive 4000-share fill");
}

// ── 5. Empty / invalid book → ok=false (caller falls back) ───────────────────
{
  const t = "empty-book";
  expect(simulateDepthFill([], 100).ok === false, t, "empty → not ok");
  const bad: BookLevel[] = [{ price: 0, size: 100 }, { price: 0.5, size: 0 }];
  expect(simulateDepthFill(bad, 100).ok === false, t, "all-invalid levels → not ok");
  expect(simulateDepthFill([{ price: 0.5, size: 100 }], 0).ok === false, t, "non-positive request → not ok");
}

// ── 6. Fallback fill applies an adverse haircut, never a free full fill ───────
{
  const t = "fallback";
  const r = fallbackFill(0.05, 200, 0.02);
  expect(r.ok, t, "ok");
  expect(r.vwap > 0.05, t, `vwap worse than ref (${r.vwap} > 0.05)`);
  expect(approx(r.vwap, 0.051), t, `vwap=0.051, got ${r.vwap}`);
  expect(approx(r.filledUsdc, 200), t, "full notional");
  expect(r.filledShares < 200 / 0.05, t, "fewer shares than the naive full fill");
  expect(fallbackFill(0, 200, 0.02).ok === false, t, "invalid ref → not ok");
}

// ── 7. Square-root impact: known value, monotonic, zero on invalid ───────────
{
  const t = "sqrt-law";
  expect(approx(sqrtLawImpact(0.6, 100, 10000), 0.06), t, `Y·σ·√(Q/V)=0.06, got ${sqrtLawImpact(0.6, 100, 10000)}`);
  expect(sqrtLawImpact(0.6, 400, 10000) > sqrtLawImpact(0.6, 100, 10000), t, "monotonic in qty");
  expect(sqrtLawImpact(0, 100, 10000) === 0, t, "σ=0 → 0");
  expect(sqrtLawImpact(0.6, 100, 0) === 0, t, "adv=0 → 0");
}

// ── 8. Tick / min-size validity helpers ──────────────────────────────────────
{
  const t = "tick-minsize";
  expect(defaultTickForPrice(0.02) === 0.001, t, "sub-0.04 → 0.001 tick");
  expect(defaultTickForPrice(0.5) === 0.01, t, "mid → 0.01 tick");
  expect(defaultTickForPrice(0.98) === 0.001, t, "above-0.96 → 0.001 tick");
  expect(approx(snapDownToTick(0.057, 0.01), 0.05), t, `snap 0.057→0.05, got ${snapDownToTick(0.057, 0.01)}`);
  expect(isPriceOnTick(0.05, 0.01) === true, t, "0.05 on 0.01 grid");
  expect(isPriceOnTick(0.053, 0.01) === false, t, "0.053 off 0.01 grid");
  // min-size gate
  expect(isFillValid(20, 0.5, 10) === true, t, "20 shares ≥ min 10 → valid");
  expect(isFillValid(5, 0.5, 10) === false, t, "5 shares < min 10 → invalid");
  expect(isFillValid(20, 1.2, 10) === false, t, "price out of (0,1) → invalid");
}

// ── P2-13: a fill must be plausible against the price we decided on ─────────
// Live incident: one crypto trade booked entry_price 0.10 against a quoted
// market_price_at_entry of 0.375 — a BUY filled 27.5 cents BELOW the market,
// which cannot happen. The two numbers come from different feeds (Gamma
// outcomePrices vs a separately-fetched CLOB book) and nothing compared them;
// simulateDepthFill is not even given the limit price. The dollar cost was
// right, but it booked ~3.75x the shares, so a YES resolution would have paid
// ~275% too much — the phantom-share mode the fill model exists to prevent.
{
  const t = "P2-13 reference-price guard";
  // Without a reference the old behaviour is preserved exactly.
  expect(isFillValid(100, 0.10, 5) === true, t, "no reference ⇒ unchanged (backwards compatible)");

  // The real incident: vwap 0.10 vs quote 0.375.
  expect(isFillValid(89.9, 0.10, 5, 0.375) === false, t,
    "the live 0.10-vs-0.375 fill must be rejected");

  // The four sound fills measured alongside it (+0.013…+0.015 slippage) must pass.
  for (const [vwap, quote] of [[0.26, 0.245], [0.38, 0.385], [0.127, 0.114], [0.26, 0.245]] as [number, number][]) {
    expect(isFillValid(50, vwap, 5, quote) === true, t,
      `legitimate slippage must pass: vwap ${vwap} vs quote ${quote}`);
  }

  // Band is a plausibility check, not a slippage limit — symmetric and wide.
  expect(isFillValid(50, 0.47, 5, 0.38) === true, t, "0.09 deviation is within the band");
  expect(isFillValid(50, 0.49, 5, 0.38) === false, t, "0.11 deviation is outside it");

  // Existing guards still apply, and a bad reference is ignored rather than
  // blocking every fill.
  expect(isFillValid(1, 0.30, 5, 0.30) === false, t, "min-size guard still fires");
  expect(isFillValid(50, 1.4, 5, 0.30) === false, t, "out-of-range vwap still fires");
  for (const bad of [undefined, NaN, 0, -1] as any[]) {
    expect(isFillValid(50, 0.10, 5, bad) === true, t, `unusable reference (${bad}) must not block a fill`);
  }
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("fill-model.test.mts") || entry.endsWith("fill-model.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("fill-model.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`fill-model.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
