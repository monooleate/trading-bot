// netlify/functions/auto-trader/sports/config.mts
//
// Env-driven defaults for the Sports bot. Override-able via the
// Settings tab Blobs store (future — not wired yet).

export interface SportsConfig {
  paperMode:           boolean;
  /** Fan-extreme YES-price threshold above which we fade YES (bet NO). */
  fanExtremeHigh:      number;     // default 0.85
  /** Fan-extreme YES-price threshold below which we fade NO (bet YES). */
  fanExtremeLow:       number;     // default 0.15
  /** Minimum edge after fees to enter (predictedProb − marketPrice). */
  edgeThreshold:       number;     // default 0.08
  /** Quarter-Kelly fraction cap on bankroll. */
  maxKellyFraction:    number;     // default 0.05
  /** Per-position $ cap (hard limit on top of Kelly). */
  maxPositionUSDC:     number;     // default 20
  /** Minimum $ for an entry — under this we skip rather than over-trade. */
  minPositionUSDC:     number;     // default 1
  /** Session daily loss limit — auto-stop when sessionLoss exceeds. */
  sessionLossLimit:    number;     // default 30
  /** Minimum 24h volume for a market to be considered (liquidity gate). */
  minVolume24h:        number;     // default 5000
  /** Minimum hours until market end-date (avoid last-minute liquidity drops). */
  minHoursToEnd:       number;     // default 2
  /** Max open positions at once. */
  maxOpenPositions:    number;     // default 3
  /** Polymarket roundtrip fee estimate (taker × 2 sides). */
  roundtripFeePct:     number;     // default 0.04
  /** Skip events whose sub-market count exceeds this — mutex pattern
   *  (e.g. "Will country X win the World Cup?" 32 outcomes). Contrarian
   *  fan-bias fade only works on binary moneyline (1-3 markets/event). */
  maxMarketsPerEvent:  number;     // default 3
}

export function getSportsConfig(): SportsConfig {
  return {
    paperMode:        process.env.SPORTS_PAPER_MODE !== "false",
    fanExtremeHigh:   parseFloat(process.env.SPORTS_FAN_EXTREME_HIGH || "0.85"),
    fanExtremeLow:    parseFloat(process.env.SPORTS_FAN_EXTREME_LOW  || "0.15"),
    edgeThreshold:    parseFloat(process.env.SPORTS_EDGE_THRESHOLD   || "0.08"),
    maxKellyFraction: parseFloat(process.env.SPORTS_MAX_KELLY        || "0.05"),
    maxPositionUSDC:  parseFloat(process.env.SPORTS_MAX_POSITION_USD || "20"),
    minPositionUSDC:  parseFloat(process.env.SPORTS_MIN_POSITION_USD || "1"),
    sessionLossLimit: parseFloat(process.env.SPORTS_SESSION_LOSS_LIMIT || "30"),
    minVolume24h:     parseFloat(process.env.SPORTS_MIN_VOLUME_24H   || "5000"),
    minHoursToEnd:    parseFloat(process.env.SPORTS_MIN_HOURS_TO_END || "2"),
    maxOpenPositions: parseInt  (process.env.SPORTS_MAX_OPEN_POSITIONS || "3", 10),
    roundtripFeePct:  parseFloat(process.env.SPORTS_ROUNDTRIP_FEE    || "0.04"),
    maxMarketsPerEvent: parseInt(process.env.SPORTS_MAX_MARKETS_PER_EVENT || "3", 10),
  };
}

export const SPORTS_DEFAULT_BANKROLL = 50;  // $50 USDC paper-mode start
// 2026-05-11 (k) bump: v1 sessions allowed mutex events (FIFA WC 32-way)
// to slip through fan-bias-fade, opening systematically losing long-tail
// YES positions. v2 added the maxMarketsPerEvent filter.
//
// 2026-05-11 (l) bump: v2 still let through per-event 1-market mutex
// patterns like "Will Arsenal win the 2025-26 EPL?" — separate events
// per candidate but mutually exclusive outcomes (only ONE team wins
// EPL). v3 adds isMutexQuestion() — keyword filter on the question
// text. Loading a v2 session auto-archives + starts fresh.
export const SPORTS_SIM_VERSION      = 3;
