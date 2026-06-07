// netlify/functions/auto-trader/hyperliquid/funding-arb/types.mts
// Funding Rate Arbitrage types.
//
// Strategy: delta-neutral carry trade. TWO directions (2026-05-29, B20):
//
//   FORWARD (live-safe, spot hedge — collects POSITIVE HL funding):
//     Leg 1: SHORT the Hyperliquid perp (collects HL funding when rate > 0)
//     Leg 2: LONG  the Binance SPOT     (hedge — spot pays NO funding)
//     Net carry/hour = hlFundingHourly × notional.
//
//   REVERSE (paper-only — captures the symmetric NEGATIVE-spread opportunity):
//     Leg 1: LONG  the Hyperliquid perp (collects −HL funding when rate < 0)
//     Leg 2: SHORT the Binance perp     (collects +Binance funding)
//     Net carry/hour = (binanceFundingHourly − hlFundingHourly) × notional
//                    = −spread × notional.
//     NOTE: Binance SPOT cannot be shorted, so the reverse hedge needs a
//     Binance USDT-M futures (or margin) short. The live hedge-manager is
//     deliberately SPOT-ONLY (no futures/withdrawal perms), so reverse is
//     gated to PAPER mode. Live reverse opportunities are detected but
//     SKIPPED until a futures-short adapter + perms are added (→ B20).
//
// Net directional exposure (either direction): 0.
//
// FORWARD viability gate uses the spread (hl − binance) as a benchmark:
// avoid entering when HL pays similarly to the rest of the market (the
// cross-venue arb may be already arbed elsewhere). REVERSE gates on
// −spread, which equals its own realized perp-perp carry.

import type { HlCoin } from "../types.mts";
import type { EntryDecisionSnapshot } from "../../shared/types.mts";

// ─── Funding data for a single coin ────────────────────────────────────────
export interface FundingData {
  coin:                HlCoin;
  hlFundingHourly:     number;   // e.g. 0.0005 = 0.05%/h
  hlFundingAnnualized: number;   // % per year
  binanceFundingHourly:  number;
  openInterestUSD:     number;
  markPrice:           number;
  fetchedAt:           string;
}

// ─── Detected arbitrage opportunity ────────────────────────────────────────
export interface ArbOpportunity {
  coin:                HlCoin;
  hlFundingHourly:     number;
  binanceFundingHourly:  number;
  spread:              number;   // hl - binance per hour
  spreadAnnualized:    number;   // %
  // Direction-aware carry (2026-05-29, B20). FORWARD captures positive
  // spread (HL-short), REVERSE captures negative spread (HL-long). `score`
  // is the direction's per-hour carry magnitude (forward=spread,
  // reverse=−spread) — the value the viability gate, break-even, and
  // ranking all key off, so a strongly negative spread is now a viable
  // (reverse) opportunity instead of an automatic skip.
  direction:           "forward" | "reverse";
  score:               number;   // = spread (forward) | −spread (reverse), ≥ 0 when viable
  openInterestUSD:     number;
  markPrice:           number;
  isViable:            boolean;
  reason:              string;
}

// ─── Active arbitrage position ─────────────────────────────────────────────
export interface ArbPosition {
  id:                   string;
  coin:                 HlCoin;
  // Direction (2026-05-29, B20). Optional for backward compat — positions
  // opened before this field default to "forward" on read. FORWARD: HL leg
  // is SHORT, Binance leg is SPOT-LONG. REVERSE: HL leg is LONG, Binance leg
  // is a (paper) SHORT. The `hl*`/`binance*` field names below are kept for
  // storage stability; interpret the side via `direction`.
  direction?:           "forward" | "reverse";
  sizeUSDC:             number;
  sizeCoins:            number;
  // HL leg (SHORT for forward, LONG for reverse)
  hlShortOrderId:       string;
  hlEntryPrice:         number;
  // Binance leg (SPOT-LONG for forward, SHORT for reverse)
  binanceOrderId:       string;
  binanceEntryPrice:    number;
  // Tracking
  openedAt:             string;
  entryHlFunding:       number;  // at open
  entryBinanceFunding:  number;
  entrySpread:          number;
  accumulatedFunding:   number;  // USDC earned so far (estimated)
  lastFundingUpdateAt:  string;
  status:               "OPEN" | "CLOSING" | "CLOSED";
  closedAt?:            string;
  closeReason?:         string;
  closeFundingNet?:     number;  // final net after fees
  // Frozen entry-decision snapshot (spread-flavor) — powers the
  // unified "Why?" panel on the open-position card. Optional for
  // backward compat with positions opened before this field existed.
  entryDecision?:       EntryDecisionSnapshot;
}

// ─── Session state for the arb layer (separate blob from directional) ──────
export interface ArbSessionState {
  startedAt:              string;
  paperMode:              boolean;
  // Own bankroll (2026-05-29). Previously F-Arb borrowed the directional HL
  // session's bankroll, but the two are INDEPENDENT strategies (a directional
  // speculator vs a delta-neutral funding harvester), so sharing one capital
  // pool made no sense. F-Arb now keeps its own ledger: bankrollCurrent grows
  // by realised funding PnL on close; open margin is tracked via
  // deployedCapital() against bankrollCurrent × maxCapitalPct. Optional on the
  // type for backward-compat — loadArbSession migrates legacy blobs to the
  // default on read.
  bankrollStart:          number;
  bankrollCurrent:        number;
  positions:              ArbPosition[];  // both open and closed
  totalFundingAllTime:    number;
  // Typed daily funding tracker: previous shape was a "YYYY-MM-DD:amount"
  // string that required brittle slicing on every read. The typed object
  // is JSON-stable and tolerant of clock skew (re-rolls cleanly when the
  // UTC date string differs from `date`).
  totalFundingToday:      { date: string; amount: number };
  stopped:                boolean;
  stoppedReason:          string | null;
}

// ─── Config ────────────────────────────────────────────────────────────────
export interface FrArbConfig {
  paperMode:          boolean;
  minSpreadHourly:    number;   // fee-aware minimum
  minOpenInterestUSD: number;
  maxArbPositions:    number;
  maxCapitalPct:      number;   // fraction of bankroll in arb
  minPositionUSDC:    number;
  maxHoldDays:        number;
  minSpreadToClose:   number;   // close when spread falls below this
  feeRoundtripHl:     number;   // HL taker+taker
  feeRoundtripBinance: number;  // Binance spot taker+taker
  // Paper-mode price-leg slippage charged on close (roundtrip, fraction of
  // notional). Live mode bakes slippage into fills, so this is paper-only.
  // 2026-06-07 (B26): recalibrated 0.016 → 0.004. The old 0.016 summed the
  // IOC LIMIT bands (HL entry 0.5% + close 1.0% + Binance 0.1%) as if every
  // order filled at its worst marry-able price; real IOC fills on liquid
  // BTC/ETH/SOL land near mid, so ~0.4% roundtrip is the realistic expected
  // slippage. CRITICAL: the break-even gate (arb-detector) must use the SAME
  // value as the close charge (fr-executor) — otherwise the bot opens trades
  // it can't profitably close (the 2026-06-06 fee-negative bug).
  paperSlippageRoundtrip: number;
  // Sanity ceiling on the observed spread. Real funding spreads ~max
  // around 0.1%/h even in extreme regimes; anything above 0.5%/h is
  // almost certainly a feed glitch (one side returned NaN, wrong tick,
  // or stale cache). Default 0.005 = 0.5%/h ≈ 4380%/yr ann.
  maxSpreadHourly?:   number;
}
