// ─── Category types ───────────────────────────────────────

export type Category = "crypto" | "sports" | "politics" | "macro";

// ─── Market types ─────────────────────────────────────────

export interface MarketInfo {
  slug: string;
  conditionId: string;
  questionId: string;
  title: string;
  clobTokenIds: [string, string]; // [YES, NO]
  currentPrice: number;           // YES price 0–1
  openInterest: number;           // USD
  volume24h: number;
  endDate: string;
  active: boolean;
}

// ─── Signal types ─────────────────────────────────────────

export interface SignalBreakdown {
  funding_rate: number | null;    // 0–1 score
  orderflow: number | null;       // 0–1 score (VPIN-based)
  vol_divergence: number | null;  // 0–1 score
  apex_consensus: number | null;  // 0–1 score
  cond_prob: number | null;       // 0–1 score
}

export interface AggregatedSignal {
  finalProb: number;              // combined probability 0–1
  kellyFraction: number;          // raw kelly fraction 0–1
  signalBreakdown: SignalBreakdown;
  activeSignals: number;          // count of non-null signals
  timestamp: string;
}

// ─── Decision types ───────────────────────────────────────

export interface TradeDecision {
  shouldTrade: boolean;
  direction: "YES" | "NO";
  positionSizeUSDC: number;
  entryPrice: number;
  edge: number;
  kellyUsed: number;              // capped kelly fraction
  reason: string;
}

// ─── Order / Position types ───────────────────────────────

export type OrderStatus = "PENDING" | "PLACED" | "FILLED" | "PARTIAL" | "EXPIRED" | "REJECTED" | "CANCELLED";

export interface OrderRecord {
  orderId: string;
  market: string;                 // slug
  tokenId: string;
  direction: "YES" | "NO";
  side: "BUY" | "SELL";
  price: number;
  size: number;                   // USDC
  filledShares: number;
  status: OrderStatus;
  placedAt: string;
  filledAt: string | null;
}

export interface Position {
  market: string;                 // slug
  tokenId: string;
  direction: "YES" | "NO";
  shares: number;
  avgEntry: number;
  costBasis: number;              // USDC spent
  openedAt: string;
  buyOrderId: string;
}

// ─── Session types ────────────────────────────────────────

export interface SessionState {
  startedAt: string;
  bankrollStart: number;
  bankrollCurrent: number;
  sessionPnL: number;
  sessionLoss: number;            // absolute sum of losing trades
  tradeCount: number;
  openPositions: Position[];
  closedTrades: ClosedTrade[];
  paperMode: boolean;
  stopped: boolean;
  stoppedReason: string | null;
}

export interface ClosedTrade {
  market: string;
  direction: "YES" | "NO";
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
  // ─ Edge Tracker fields (optional for backward compat) ─
  category?: Category;
  predictedProb?: number;           // signal-combiner finalProb or weather confidence
  marketPriceAtEntry?: number;      // market price when we entered
  edgeAtEntry?: number;             // |predictedProb - marketPriceAtEntry|
  signalBreakdown?: SignalBreakdown | null;
}

// ─── Logger types ─────────────────────────────────────────

export type LogEvent =
  | "SIGNAL"
  | "DECISION_SKIP"
  | "DECISION_TRADE"
  | "ORDER_PLACED"
  | "ORDER_FILLED"
  | "ORDER_EXPIRED"
  | "ORDER_REJECTED"
  | "SELL_PLACED"
  | "TRADE_CLOSED"
  | "SESSION_START"
  | "SESSION_STOP"
  | "ARB_OPEN"
  | "ARB_CLOSE"
  | "ERROR";

export interface LogEntry {
  ts: string;
  event: LogEvent;
  paper: boolean;
  [key: string]: unknown;
}

// ─── Telegram types ───────────────────────────────────────

export type AlertType =
  | "SIGNAL_FOUND"
  | "TRADE_OPEN"
  | "TRADE_CLOSED"
  | "SESSION_STOP"
  | "ERROR";

// ─── Config types ─────────────────────────────────────────

export interface TraderConfig {
  paperMode: boolean;
  edgeThreshold: number;
  maxKellyFraction: number;
  cooldownSeconds: number;
  sessionLossLimit: number;
  minOpenInterest: number;
  roundtripFeePct: number;        // 0.036 for crypto (1.8% × 2)
}

export interface PolymarketConfig {
  privateKey: string;
  funderAddress: string;
  signatureType: number;
}
