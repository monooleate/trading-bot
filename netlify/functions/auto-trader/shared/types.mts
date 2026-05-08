// ─── Category types ───────────────────────────────────────

export type Category = "crypto" | "weather" | "sports" | "politics" | "macro";

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
  // Optional duration metadata for short-market exit/entry filters (P1.2).
  // Populated by btc-market-finder for BTC 5m/15m markets.
  durationMs?: number;            // total market lifetime
  openedAtEstimate?: string;      // ISO of estimated market open (endDate - durationMs)
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
  // P1.3: optional Binance order-book imbalance confirmation. UP/DOWN
  // is set only when the bid/ask depth ratio crosses the configured
  // thresholds; NEUTRAL or null mean the imbalance gate is open.
  obImbalance?: {
    ratio: number;                // bidDepth / askDepth (top-10)
    direction: "UP" | "DOWN" | "NEUTRAL";
  } | null;
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
  // Paper-resolver metadata: lets the next cron tick close this position
  // by querying real Polymarket resolution or running a finalProb-independent
  // Brownian-bridge fallback.
  conditionId?: string;
  endDate?: string;
  marketPriceAtEntry?: number;
  predictedProb?: number;
  signalBreakdown?: SignalBreakdown | null;
  category?: Category;
  // Weather-only reconciliation context. Populated by the weather trader at
  // open and consumed by the weather reconciler cron, which queries actual
  // METAR observations and settles the position with real PnL (instead of
  // the old synthetic Bernoulli draw against the model's own win prob).
  weatherMeta?: WeatherPositionMeta;
}

export interface WeatherPositionMeta {
  city:         string;          // e.g. "hong-kong"
  date:         string;          // YYYY-MM-DD in station tz
  stationIcao:  string;          // e.g. "VHHH" — METAR query target
  bucketLabel:  string;          // e.g. "21°C", "27°C or higher"
  bucketTempC:  number;          // bucket center temperature in °C
  predictedMaxC: number;         // our forecast (after corrections)
  rawGfsMaxC:   number | null;
  rawEcmwfMaxC: number | null;
  rawNoaaMaxC:  number | null;
  ensembleMaxC: number;
  reconcileAfter: string;        // ISO — earliest moment to attempt settlement
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
  // Bumped when we change the paper simulator semantics. Sessions with an
  // older simVersion are auto-reset on load so analysis is run on a single
  // clean methodology rather than a mix of legacy (halfway-toward-prediction)
  // and current (real-resolution + Brownian-bridge) trades.
  simVersion?: number;
  // Tracks whether a calibration-noise alert has been sent for the current
  // session, so we don't spam Telegram on every cron tick.
  calibrationAlertSentAt?: string | null;
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
  | "PAPER_RESOLVED"
  | "PAPER_RESOLVE_SKIP"
  | "CALIBRATION_ALARM"
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
