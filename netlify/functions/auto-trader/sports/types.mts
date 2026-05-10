// netlify/functions/auto-trader/sports/types.mts
//
// Type definitions for the Sports bot.
// Strategy: contrarian fan-bias fade — when a Polymarket sports market
// is priced at fan-extreme (YES > 0.85 or YES < 0.15), the bot bets the
// opposite side. Edge comes from fans over-weighting their team.

import type { EntryDecisionSnapshot, DecisionGate } from "../shared/types.mts";

export type SportsLeague = "NBA" | "NFL" | "MLB" | "NHL" | "EPL" | "UCL" | "Other";

/** Discovered Polymarket sports market. */
export interface SportsMarket {
  slug:            string;
  conditionId:     string;
  question:        string;
  league:          SportsLeague;
  yesTokenId:      string;
  noTokenId:       string;
  yesPrice:        number;        // 0..1
  noPrice:         number;        // 0..1
  volume24h:       number;        // USDC
  liquidity:       number;        // USDC
  endDate:         string;        // ISO
  eventSlug:       string;        // for Polymarket URL
}

/** Per-position state stored on the session blob. */
export interface SportsPosition {
  market:              string;     // market slug
  conditionId:         string;
  yesTokenId:          string;
  noTokenId:           string;
  direction:           "YES" | "NO";
  shares:              number;
  avgEntry:            number;     // 0..1
  costBasis:           number;     // USDC
  openedAt:            string;
  endDate:             string;
  league:              SportsLeague;
  question:            string;
  marketPriceAtEntry:  number;
  predictedProb:       number;     // bot's fair-value estimate
  entryDecision:       EntryDecisionSnapshot;
}

export interface SportsClosedTrade {
  market:              string;
  question:            string;
  league:              SportsLeague;
  direction:           "YES" | "NO";
  entryPrice:          number;
  exitPrice:           number;
  shares:              number;
  pnl:                 number;
  pnlPct:              number;
  openedAt:            string;
  closedAt:            string;
  marketPriceAtEntry:  number;
  predictedProb:       number;
}

/** Session blob shape. */
export interface SportsSessionState {
  startedAt:          string;
  paperMode:          boolean;
  stopped:            boolean;
  stoppedReason:      string | null;
  bankrollStart:      number;
  bankrollCurrent:    number;
  sessionPnL:         number;
  sessionLoss:        number;     // absolute sum of losing trades
  openPositions:      SportsPosition[];
  closedTrades:       SportsClosedTrade[];
  simVersion:         number;
}

export interface SportsTradeDecision {
  shouldTrade:        boolean;
  direction:          "YES" | "NO";
  positionSizeUSDC:   number;
  entryPrice:         number;
  edge:               number;
  kellyUsed:          number;
  reason:             string;
  gates:              DecisionGate[];
}
