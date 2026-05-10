// netlify/functions/auto-trader/hyperliquid/funding-arb/types.mts
// Funding Rate Arbitrage types.
//
// Strategy: delta-neutral carry trade.
//   Leg 1: SHORT the Hyperliquid perp (collects HL funding when rate > 0)
//   Leg 2: LONG the Binance spot (hedge — spot pays NO funding,
//          eliminates directional risk from Leg 1)
//
// Net directional exposure: 0.
// Net income per hour:  hlFundingHourly × notional   (Binance spot has no
//                       funding, so the per-hour carry is just HL's payment
//                       to shorts).
//
// The Binance USDT-M `binanceFundingHourly` is only used at scan time as a
// VIABILITY benchmark (avoid entering when HL pays similarly to the rest of
// the market — the cross-venue arb may be already arbed elsewhere). It is
// NOT a cost line on the spot hedge.

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
  openInterestUSD:     number;
  markPrice:           number;
  isViable:            boolean;
  reason:              string;
}

// ─── Active arbitrage position ─────────────────────────────────────────────
export interface ArbPosition {
  id:                   string;
  coin:                 HlCoin;
  sizeUSDC:             number;
  sizeCoins:            number;
  // HL SHORT leg
  hlShortOrderId:       string;
  hlEntryPrice:         number;
  // Binance LONG leg
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
  positions:              ArbPosition[];  // both open and closed
  totalFundingAllTime:    number;
  totalFundingToday:      string;         // "YYYY-MM-DD:amount"
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
}
