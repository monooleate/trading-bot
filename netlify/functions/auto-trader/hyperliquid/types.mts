// netlify/functions/auto-trader/hyperliquid/types.mts
// Hyperliquid-specific types. Adapts the perpetual-futures execution engine
// described in edgecalc-hyperliquid-prompt.md to the Netlify serverless
// architecture (stateless functions + Blobs + cron), reusing the signal-
// combiner and funding-rates endpoints that already exist.

import type { SignalBreakdown } from "../shared/types.mts";

export type HlCoin = "BTC" | "ETH" | "SOL" | "XRP" | "DOGE" | "AVAX";
export type HlDirection = "LONG" | "SHORT";

// ─── Trade signal (what the decision engine consumes) ──────────────────────────
export interface HlTradeSignal {
  coin:      HlCoin;
  direction: HlDirection;
  sizeUSDC:  number;
  kelly:     number;               // [0-1] quarter-kelly fraction
  edge:      number;               // [0-1]
  signals:   SignalBreakdown;
  timestamp: string;
  paper:     boolean;
}

// ─── Position opened on Hyperliquid ────────────────────────────────────────────
export interface HlPosition {
  coin:         HlCoin;
  direction:    HlDirection;
  entryPrice:   number;
  sizeCoins:    number;            // perp size in coin units
  sizeUSDC:     number;            // notional at entry
  leverage:     number;
  openedAt:     string;
  entryOrderId: string;
  tpPrice:      number;
  slPrice:      number;
  tpOrderId:    string | null;
  slOrderId:    string | null;
}

// ─── Closed trade (for Edge Tracker + summary) ─────────────────────────────────
export interface HlClosedTrade {
  coin:         HlCoin;
  direction:    HlDirection;
  entryPrice:   number;
  exitPrice:    number;
  sizeCoins:    number;
  pnlUSDC:      number;
  pnlPct:       number;
  openedAt:     string;
  closedAt:     string;
  closeReason:  "tp" | "sl" | "manual" | "paper_sim" | "timeout";
  edgeAtEntry:  number;
  predictedProb: number;
  signalBreakdown?: SignalBreakdown;
}

// ─── Session state (Netlify Blobs-persisted) ───────────────────────────────────
export interface HlSessionState {
  startedAt:          string;
  paperMode:          boolean;
  bankrollStart:      number;
  bankrollCurrent:    number;
  sessionPnL:         number;
  sessionLoss:        number;       // absolute sum of losing trades
  tradeCount:         number;
  openPositions:      HlPosition[];
  closedTrades:       HlClosedTrade[];
  consecutiveLosses:  number;
  pausedUntil:        string | null; // ISO — consecutive-loss pause or manual pause
  stopped:            boolean;
  stoppedReason:      string | null;
}

// ─── Config ────────────────────────────────────────────────────────────────────
export interface HlTraderConfig {
  paperMode:        boolean;
  maxLeverage:      number;         // max 3x
  maxPctBankroll:   number;         // max 15% of bankroll per trade
  edgeThresholdPaper: number;       // 0.12 paper
  edgeThresholdLive:  number;       // 0.18 live
  sessionLossLimit: number;         // USD
  cooldownSeconds:  number;
  maxOpenPositions: number;
  consecutiveLossPauseHours: number; // pause after N losses
  consecutiveLossLimit: number;
  volGateRvPct:     number;         // RV % threshold (annualised)
  roundtripFeePct:  number;         // 0.07% maker+taker roundtrip
}
