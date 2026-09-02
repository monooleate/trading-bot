// netlify/functions/auto-trader/shared/farb-breakeven.test.mts
//
// Lives under auto-trader/shared/ (NOT top-level) so Netlify never bundles it
// as a serverless function. Regression guard for the 2026-06-07 B26 fix:
// the funding-arb break-even gate must charge the SAME roundtrip cost the
// close actually books (fees + paper slippage), so the bot never opens a
// position it can't profitably close. Pre-B26 the gate counted only fees
// (0.29%) and ignored the paper slippage → structurally fee-negative trades.
//
// Run: npx tsx netlify/functions/auto-trader/shared/farb-breakeven.test.mts

import { detectArbOpportunity } from "../hyperliquid/funding-arb/arb-detector.mts";
import type { FrArbConfig, FundingData } from "../hyperliquid/funding-arb/types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

const CFG = (paperMode: boolean): FrArbConfig => ({
  paperMode,
  minSpreadHourly:     0.00001,    // low — let the break-even gate decide
  minOpenInterestUSD:  5_000_000,
  maxArbPositions:     3,
  maxCapitalPct:       0.5,
  minPositionUSDC:     10,
  maxHoldDays:         14,          // 336h
  minSpreadToClose:    0.00005,
  feeRoundtripHl:      0.0009,      // 0.09%
  feeRoundtripBinance: 0.002,       // 0.20%
  maxSpreadHourly:     0.005,
  paperSlippageRoundtrip: 0.004,    // 0.40%
});

// HL-short forward opportunity at a given hourly spread, deep OI.
const fd = (spreadHourly: number): FundingData => ({
  coin:                "BTC" as any,
  hlFundingHourly:     spreadHourly,   // binance 0 ⇒ spread = hlFundingHourly
  hlFundingAnnualized: spreadHourly * 8760,
  binanceFundingHourly: 0,
  openInterestUSD:     50_000_000,
  markPrice:           60_000,
} as any);

// Cost arithmetic (must mirror arb-detector):
//   paper totalCost = 0.0009 + 0.002 + 0.004 = 0.0069 (0.69%)
//   live  totalCost = 0.0009 + 0.002         = 0.0029 (0.29%)
//   break-even days = totalCost / spreadHourly / 24
const PAPER_COST = 0.0069, LIVE_COST = 0.0029, HOLD = 14;

// ── 1. Paper: a thin spread that beat the OLD (fee-only) gate now FAILS ──────
{
  // spread 0.00002/h: paper break-even = 0.0069/0.00002/24 = 14.375d > 14 → reject
  //                   (old fee-only:    0.0029/0.00002/24 = 6.04d < 14 → would pass)
  const spread = 0.00002;
  const beDaysPaper = PAPER_COST / spread / 24;
  const beDaysFeeOnly = LIVE_COST / spread / 24;
  expect(beDaysPaper > HOLD && beDaysFeeOnly < HOLD, "setup.thin",
    `fixture must straddle the gate: paper ${beDaysPaper.toFixed(2)}d>14, fee-only ${beDaysFeeOnly.toFixed(2)}d<14`);
  const o = detectArbOpportunity(fd(spread), CFG(true));
  expect(o.isViable === false, "paper.thinRejected",
    `thin spread must be rejected in paper (cost-aware), got isViable=${o.isViable} reason=${o.reason}`);
  expect(/break-even/i.test(o.reason), "paper.thinReason", `reason should cite break-even, got: ${o.reason}`);
}

// ── 2. Paper: a wide spread that clears the full cost is VIABLE ──────────────
{
  // spread 0.00006/h: paper break-even = 0.0069/0.00006/24 = 4.79d < 14 → viable
  const o = detectArbOpportunity(fd(0.00006), CFG(true));
  expect(o.isViable === true, "paper.wideViable",
    `wide spread should be viable, got isViable=${o.isViable} reason=${o.reason}`);
}

// ── 3. Live: no paper slippage ⇒ the same thin spread is viable (fees only) ──
{
  const o = detectArbOpportunity(fd(0.00002), CFG(false));
  expect(o.isViable === true, "live.thinViable",
    `live (no paper slippage) should accept the thin spread, got isViable=${o.isViable} reason=${o.reason}`);
}

// ── 4. Boundary: exactly at the paper break-even spread is accepted ──────────
{
  // spread = totalCost / (HOLD*24) = 0.0069/336 = 0.00002054 → break-even ≈ 14.0d
  const spread = PAPER_COST / (HOLD * 24) + 1e-9;
  const o = detectArbOpportunity(fd(spread), CFG(true));
  expect(o.isViable === true, "paper.boundary",
    `spread at exactly the break-even floor should pass, got isViable=${o.isViable} reason=${o.reason}`);
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log("farb-breakeven.test: all checks passed");
} else {
  console.error(`farb-breakeven.test: ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.test}: ${f.message}`);
  process.exit(1);
}
