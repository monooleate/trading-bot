import type { TradeDecision, TraderConfig, AggregatedSignal, MarketInfo } from "../shared/types.mts";

// ─── Cooldown tracker (in-memory, resets on function restart) ──

const cooldownMap = new Map<string, number>();

export function isOnCooldown(slug: string, cooldownSeconds: number): boolean {
  const lastTrade = cooldownMap.get(slug);
  if (!lastTrade) return false;
  return Date.now() - lastTrade < cooldownSeconds * 1000;
}

export function setCooldown(slug: string): void {
  cooldownMap.set(slug, Date.now());
}

// ─── Decision engine ──────────────────────────────────────

export function makeDecision(
  signal: AggregatedSignal,
  market: MarketInfo,
  bankrollUSDC: number,
  sessionLoss: number,
  config: TraderConfig,
): TradeDecision {
  const { finalProb, kellyFraction } = signal;
  const marketPrice = market.currentPrice;

  const noResult = (reason: string): TradeDecision => ({
    shouldTrade: false,
    direction: "YES",
    positionSizeUSDC: 0,
    entryPrice: 0,
    edge: 0,
    kellyUsed: 0,
    reason,
  });

  // 1. Session loss limit check
  if (sessionLoss >= config.sessionLossLimit) {
    return noResult(`Session loss limit reached: $${sessionLoss.toFixed(2)} >= $${config.sessionLossLimit}`);
  }

  // 2. Minimum active signals
  if (signal.activeSignals < 2) {
    return noResult(`Too few active signals: ${signal.activeSignals} < 2`);
  }

  // 3. Cooldown check
  if (isOnCooldown(market.slug, config.cooldownSeconds)) {
    return noResult(`Market on cooldown: ${market.slug}`);
  }

  // 4. Open interest check
  if (market.openInterest < config.minOpenInterest) {
    return noResult(`Low OI: $${market.openInterest} < $${config.minOpenInterest}`);
  }

  // 5. Edge calculation (net of roundtrip fees)
  const grossEdge = Math.abs(finalProb - marketPrice);
  const netEdge = grossEdge - config.roundtripFeePct;
  const direction = finalProb > marketPrice ? "YES" : "NO";

  if (netEdge < config.edgeThreshold) {
    return noResult(
      `Net edge ${(netEdge * 100).toFixed(1)}% < threshold ${(config.edgeThreshold * 100)}% ` +
      `(gross ${(grossEdge * 100).toFixed(1)}% - fees ${(config.roundtripFeePct * 100).toFixed(1)}%)`,
    );
  }

  // 6. Kelly sizing (capped)
  const kellyCapped = Math.min(kellyFraction, config.maxKellyFraction);
  const positionSize = Math.max(1, bankrollUSDC * kellyCapped); // min $1

  // 7. Entry price (1 tick above market for YES, 1 tick above for NO)
  const entryPrice =
    direction === "YES"
      ? Math.min(marketPrice + 0.01, 0.99)
      : Math.max(1 - marketPrice + 0.01, 0.01);

  return {
    shouldTrade: true,
    direction,
    positionSizeUSDC: Math.round(positionSize * 100) / 100,
    entryPrice: Math.round(entryPrice * 100) / 100,
    edge: netEdge,
    kellyUsed: kellyCapped,
    reason:
      `Net edge ${(netEdge * 100).toFixed(1)}% (gross ${(grossEdge * 100).toFixed(1)}%), ` +
      `Kelly ${(kellyCapped * 100).toFixed(1)}%, ` +
      `${signal.activeSignals} signals active`,
  };
}
