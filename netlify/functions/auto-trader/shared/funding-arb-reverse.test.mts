// netlify/functions/auto-trader/shared/funding-arb-reverse.test.mts
//
// Lives under auto-trader/shared/ (NOT directly in netlify/functions/) so
// Netlify never bundles it as a serverless function — a top-level *.test.mts
// yields an illegal "...test" function name and fails the deploy.
//
// Regression guard for the bidirectional F-Arb (2026-05-29, B20):
//   FORWARD  (HL-short + Binance-spot-long): viable on POSITIVE spread,
//            carry = hlFunding, accrual = notional × hlFunding × hours.
//   REVERSE  (HL-long  + Binance-perp-short): viable on NEGATIVE spread,
//            carry = −spread, accrual = notional × (binanceRate − hlRate).
//   Reverse is PAPER-ONLY (live hedge is spot-only, can't short) → live
//   reverse opportunities are detected but flagged non-viable.
//
// Run: npx tsx netlify/functions/auto-trader/shared/funding-arb-reverse.test.mts

import { detectArbOpportunity } from "../hyperliquid/funding-arb/arb-detector.mts";
import { accrueFunding, creditArbPnl, resetArbSession, topupArbSession, DEFAULT_ARB_BANKROLL } from "../hyperliquid/funding-arb/fr-session.mts";
import type { FundingData, FrArbConfig, ArbSessionState, ArbPosition } from "../hyperliquid/funding-arb/types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

const CFG = (paperMode: boolean): FrArbConfig => ({
  paperMode,
  minSpreadHourly:     0.0001,   // 0.01%/h
  minOpenInterestUSD:  5_000_000,
  maxArbPositions:     3,
  maxCapitalPct:       0.5,
  minPositionUSDC:     10,
  maxHoldDays:         14,
  minSpreadToClose:    0.00005,
  feeRoundtripHl:      0.0007,
  feeRoundtripBinance: 0.001,
  maxSpreadHourly:     0.005,
});

const fd = (over: Partial<FundingData>): FundingData => ({
  coin:                "BTC" as any,
  hlFundingHourly:     0,
  hlFundingAnnualized: 0,
  binanceFundingHourly: 0,
  openInterestUSD:     50_000_000,
  markPrice:           70_000,
  fetchedAt:           "2026-05-29T00:00:00Z",
  ...over,
});

// ── Detector: FORWARD on positive spread ───────────────────────────────────
{
  const o = detectArbOpportunity(fd({ hlFundingHourly: 0.0008, binanceFundingHourly: 0.0001 }), CFG(true));
  expect(o.direction === "forward", "fwd.direction", `expected forward, got ${o.direction}`);
  expect(o.isViable, "fwd.viable", `expected viable; reason="${o.reason}"`);
  expect(approx(o.score, 0.0007), "fwd.score", `expected score=spread=0.0007, got ${o.score}`);
  expect(approx(o.spread, 0.0007), "fwd.spread", `got ${o.spread}`);
}

// ── Detector: REVERSE on negative spread (paper) ────────────────────────────
{
  // BTC live regime: hl −0.10%/h, binance +0.01%/h → spread −0.11%/h.
  const o = detectArbOpportunity(fd({ hlFundingHourly: -0.0010, binanceFundingHourly: 0.0001 }), CFG(true));
  expect(o.direction === "reverse", "rev.direction", `expected reverse, got ${o.direction}`);
  expect(o.isViable, "rev.viable", `expected viable (paper); reason="${o.reason}"`);
  expect(approx(o.score, 0.0011), "rev.score", `expected score=−spread=0.0011, got ${o.score}`);
  expect(o.spread < 0, "rev.spreadNeg", `expected negative spread, got ${o.spread}`);
}

// ── Detector: REVERSE is live-gated (paperMode=false) ───────────────────────
{
  const o = detectArbOpportunity(fd({ hlFundingHourly: -0.0010, binanceFundingHourly: 0.0001 }), CFG(false));
  expect(o.direction === "reverse", "revLive.direction", `expected reverse, got ${o.direction}`);
  expect(!o.isViable, "revLive.blocked", `expected NOT viable in live; reason="${o.reason}"`);
  expect(/futures short|live-gated|B20/i.test(o.reason), "revLive.reason", `reason should explain live-gate, got "${o.reason}"`);
}

// ── Detector: |spread| below threshold → skip ───────────────────────────────
{
  const o = detectArbOpportunity(fd({ hlFundingHourly: 0.00003, binanceFundingHourly: -0.00002 }), CFG(true));
  expect(!o.isViable, "small.skip", `expected not viable for |spread|<min; reason="${o.reason}"`);
}

// ── Detector: sanity cap catches a glitchy huge NEGATIVE spread ─────────────
{
  const o = detectArbOpportunity(fd({ hlFundingHourly: -0.02, binanceFundingHourly: 0.0 }), CFG(true));
  // score = 0.02 > maxSpreadHourly 0.005 → must NOT be viable (the run-loop
  // sanity gate uses opp.score; the detector itself returns direction+score).
  expect(o.score > (CFG(true).maxSpreadHourly ?? 0.005), "glitch.score", `score ${o.score} should exceed sanity cap`);
}

// ── Accrual: FORWARD earns hlFunding ────────────────────────────────────────
function mkSession(pos: ArbPosition): ArbSessionState {
  return {
    startedAt: "2026-05-29T00:00:00Z",
    paperMode: true,
    bankrollStart: 200,
    bankrollCurrent: 200,
    positions: [pos],
    totalFundingAllTime: 0,
    totalFundingToday: { date: "2026-05-29", amount: 0 },
    stopped: false,
    stoppedReason: null,
  };
}
const basePos = (over: Partial<ArbPosition>): ArbPosition => ({
  id: "arb-test", coin: "BTC" as any,
  sizeUSDC: 100, sizeCoins: 0.001,         // notional = 0.001 × 70000 = $70
  hlShortOrderId: "x", hlEntryPrice: 70_000,
  binanceOrderId: "y", binanceEntryPrice: 70_000,
  openedAt: "2026-05-29T00:00:00Z",
  entryHlFunding: 0, entryBinanceFunding: 0, entrySpread: 0,
  accumulatedFunding: 0,
  lastFundingUpdateAt: "2026-05-29T00:00:00Z",
  status: "OPEN",
  ...over,
});

{
  const now = new Date("2026-05-29T01:00:00Z");   // exactly 1h after lastUpdate
  const pos = basePos({ direction: "forward", entryHlFunding: 0.001 });
  const snap = new Map([["BTC", { rate: 0.001, markPrice: 70_000, binanceRate: 0.0005 }]]);
  const out = accrueFunding(mkSession(pos), now, snap as any);
  const got = out.positions[0].accumulatedFunding;
  const want = 70 * 0.001 * 1;   // notional × hlRate × 1h = 0.07
  expect(approx(got, want, 1e-4), "fwd.accrual", `forward should accrue hlRate only: want ${want}, got ${got}`);
}

// ── Accrual: REVERSE earns (binanceRate − hlRate) = −spread ─────────────────
{
  const now = new Date("2026-05-29T01:00:00Z");
  const pos = basePos({ direction: "reverse", entryHlFunding: -0.001, entryBinanceFunding: 0.0005 });
  const snap = new Map([["BTC", { rate: -0.001, markPrice: 70_000, binanceRate: 0.0005 }]]);
  const out = accrueFunding(mkSession(pos), now, snap as any);
  const got = out.positions[0].accumulatedFunding;
  const want = 70 * (0.0005 - (-0.001)) * 1;   // notional × (binance − hl) = 70 × 0.0015 = 0.105
  expect(approx(got, want, 1e-4), "rev.accrual", `reverse should accrue (binance−hl): want ${want}, got ${got}`);
  expect(got > 0, "rev.accrualPositive", `reverse on negative hl funding should be POSITIVE carry, got ${got}`);
}

// ── Own bankroll (2026-05-29): F-Arb no longer shares HL's pool ─────────────
{
  // reset → own default bankroll, fresh
  const s = resetArbSession(true);
  expect(s.bankrollStart === DEFAULT_ARB_BANKROLL && s.bankrollCurrent === DEFAULT_ARB_BANKROLL,
    "reset.default", `reset should seed own bankroll ${DEFAULT_ARB_BANKROLL}, got ${s.bankrollCurrent}`);
  expect(s.positions.length === 0, "reset.clean", "reset should clear positions");

  // reset with override
  const s2 = resetArbSession(true, 350);
  expect(s2.bankrollStart === 350 && s2.bankrollCurrent === 350, "reset.override", `got ${s2.bankrollCurrent}`);

  // credit realised PnL flows into bankroll
  const s3 = creditArbPnl(s2, 12.5);
  expect(approx(s3.bankrollCurrent, 362.5, 1e-6), "credit.pnl", `350 + 12.5 = 362.5, got ${s3.bankrollCurrent}`);
  expect(s3.bankrollStart === 350, "credit.startUnchanged", `start should stay 350, got ${s3.bankrollStart}`);

  // credit a loss
  const s4 = creditArbPnl(s3, -5);
  expect(approx(s4.bankrollCurrent, 357.5, 1e-6), "credit.loss", `362.5 − 5 = 357.5, got ${s4.bankrollCurrent}`);

  // topup is additive, preserves current+start growth
  const s5 = topupArbSession(s4, 100);
  expect(approx(s5.bankrollCurrent, 457.5, 1e-6) && approx(s5.bankrollStart, 450, 1e-6),
    "topup.additive", `expected current 457.5 / start 450, got ${s5.bankrollCurrent}/${s5.bankrollStart}`);
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log("funding-arb-reverse.test: all checks passed");
} else {
  console.error(`funding-arb-reverse.test: ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.test}: ${f.message}`);
  process.exit(1);
}
