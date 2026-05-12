// netlify/functions/auto-trader/hyperliquid/types.mts
// Hyperliquid-specific types. Adapts the perpetual-futures execution engine
// described in edgecalc-hyperliquid-prompt.md to the Netlify serverless
// architecture (stateless functions + Blobs + cron), reusing the signal-
// combiner and funding-rates endpoints that already exist.

import type { SignalBreakdown, EntryDecisionSnapshot } from "../shared/types.mts";

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
  // Signal metadata captured at entry. The paper-resolver carries these
  // forward into HlClosedTrade so the edge-tracker IC computation can
  // correlate predicted probability with realised PnL.
  predictedProb?:    number;
  edgeAtEntry?:      number;
  signalBreakdown?:  SignalBreakdown;
  // Frozen decision snapshot — same shape as crypto's, so the UI's
  // `RationaleBlock` renders the open-position "Why?" panel without a
  // per-bot branch. HL is signal-driven, so the full crypto-style mix
  // (signalBreakdown, kellyRaw → capped, gates) is meaningful.
  entryDecision?:    EntryDecisionSnapshot;
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
  // Bumped when paper PnL semantics change so older sessions auto-archive
  // on load (mirrors the crypto bot's PAPER_SIM_VERSION pattern).
  simVersion?:        number;
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
  // Hard caps on TP/SL price-distance. The signal-combiner edge is a
  // BINARY-market directional bias (|prob−0.5|×2), NOT a perpetual
  // futures price-move target. Without these caps an edge of 0.20
  // produced TP=+40% / SL=−20%, which BTC almost never hits in a 4h
  // hold window — so every trade timed out flat. The clamps keep TP/SL
  // proportional to edge for small edges but cap them at sensible
  // perp-side bounds (default 2% / 1% = 2:1 RR over a 4h horizon).
  tpPctMax:         number;         // e.g. 0.02 = ±2% from entry
  slPctMax:         number;         // e.g. 0.01 = ±1% from entry
  // Min signals from the 8-signal combiner. Default 3 (HL has higher fees
  // than Polymarket, so requires more convergence than crypto's 2).
  minActiveSignals?: number;
  // Paper sim version: bumped when paper PnL semantics change so old
  // sessions auto-reset on load. v2 adds TP/SL clamps + paper funding
  // accrual + paper-side volatility gate.
  paperSimVersion:  number;
}
