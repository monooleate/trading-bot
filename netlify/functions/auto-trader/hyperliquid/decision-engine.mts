// netlify/functions/auto-trader/hyperliquid/decision-engine.mts
// Final-stage decision gates for Hyperliquid entries.
// Short-circuits as soon as any gate rejects, so the reason string reflects
// the first failure rather than a compound condition.

import type { HlSessionState, HlTraderConfig, HlCoin } from "./types.mts";
import type { HlSignalResult } from "./signal-source.mts";

// Per-coin cooldown (in-memory — reset on cold start; Netlify cron is every 3m).
const cooldownMap = new Map<HlCoin, number>();

export function setCooldown(coin: HlCoin, seconds: number) {
  cooldownMap.set(coin, Date.now() + seconds * 1000);
}

export function isOnCooldown(coin: HlCoin): boolean {
  const until = cooldownMap.get(coin);
  return !!(until && until > Date.now());
}

export function clearAllCooldowns() {
  cooldownMap.clear();
}

export interface HlDecision {
  shouldTrade: boolean;
  reason:      string;
  edge:        number;
  threshold:   number;
}

export function makeHlDecision(
  signal:  HlSignalResult,
  session: HlSessionState,
  config:  HlTraderConfig,
): HlDecision {
  const threshold = config.paperMode
    ? config.edgeThresholdPaper
    : config.edgeThresholdLive;

  // Session-level gates
  if (session.stopped) {
    return { shouldTrade: false, reason: `Session stopped: ${session.stoppedReason}`, edge: signal.edge, threshold };
  }
  if (session.pausedUntil && new Date(session.pausedUntil).getTime() > Date.now()) {
    return { shouldTrade: false, reason: `Paused until ${session.pausedUntil}`, edge: signal.edge, threshold };
  }
  if (session.sessionLoss >= config.sessionLossLimit) {
    return { shouldTrade: false, reason: `Session loss limit reached ($${config.sessionLossLimit})`, edge: signal.edge, threshold };
  }
  if (session.openPositions.length >= config.maxOpenPositions) {
    return { shouldTrade: false, reason: `Max open positions (${config.maxOpenPositions}) reached`, edge: signal.edge, threshold };
  }
  if (session.consecutiveLosses >= config.consecutiveLossLimit) {
    return { shouldTrade: false, reason: `${config.consecutiveLossLimit} consecutive losses — pause required`, edge: signal.edge, threshold };
  }

  // Coin-level gates
  if (isOnCooldown(signal.coin)) {
    return { shouldTrade: false, reason: `${signal.coin} on cooldown`, edge: signal.edge, threshold };
  }
  if (session.openPositions.some(p => p.coin === signal.coin)) {
    return { shouldTrade: false, reason: `Already have open ${signal.coin} position`, edge: signal.edge, threshold };
  }

  // Signal-quality gates
  if (signal.activeSignals < 3) {
    return { shouldTrade: false, reason: `Only ${signal.activeSignals}/5 signals active`, edge: signal.edge, threshold };
  }
  if (signal.resolutionCategory === "SKIP") {
    return { shouldTrade: false, reason: "Underlying market resolution risk = SKIP", edge: signal.edge, threshold };
  }

  // Edge gate (fee-aware)
  const netEdge = signal.edge - config.roundtripFeePct;
  if (netEdge < threshold) {
    return {
      shouldTrade: false,
      reason: `Net edge ${(netEdge * 100).toFixed(1)}% < ${(threshold * 100).toFixed(1)}% threshold`,
      edge: netEdge,
      threshold,
    };
  }

  return { shouldTrade: true, reason: "all gates passed", edge: netEdge, threshold };
}
