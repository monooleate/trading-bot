// Mock trade generator for development / empty-state testing.
// Generates ~100 realistic paper trades with:
//  - Win rate ~60%
//  - Avg edge ~14% at entry
//  - Fat-tail PnL distribution (mostly small wins, occasional big loss)
//  - Signal breakdown correlated with outcome (so IC > 0)
//  - Mixed crypto + weather categories

import type { ClosedTrade, SignalBreakdown } from "../auto-trader/shared/types.mts";

function gaussian(mu: number, sigma: number): number {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp01(v: number): number {
  return Math.max(0.01, Math.min(0.99, v));
}

const CRYPTO_MARKETS = [
  "btc-above-62k-", "btc-above-65k-", "btc-above-70k-",
  "eth-above-3000-", "eth-above-3500-",
  "btc-updown-5m-", "btc-updown-15m-",
];

const WEATHER_CITIES = [
  "shanghai", "london", "new-york", "los-angeles", "tokyo",
];

function randomMarketSlug(category: "crypto" | "weather", daysAgo: number): string {
  if (category === "weather") {
    const city = WEATHER_CITIES[Math.floor(Math.random() * WEATHER_CITIES.length)];
    return `highest-temp-in-${city}-day-${Math.floor(Math.random() * 1000)}`;
  }
  const base = CRYPTO_MARKETS[Math.floor(Math.random() * CRYPTO_MARKETS.length)];
  return `${base}${Math.floor(Math.random() * 10000)}`;
}

function makeSignalBreakdown(outcomeWin: boolean): SignalBreakdown {
  // Correlate signal values with outcome (positive IC)
  // Winner trades: signals slightly above 0.5
  // Loser trades: signals slightly below 0.5
  const bias = outcomeWin ? 0.08 : -0.08;
  return {
    funding_rate: clamp01(0.5 + bias + gaussian(0, 0.12)),
    orderflow:    clamp01(0.5 + bias * 1.5 + gaussian(0, 0.14)),  // strongest signal
    vol_divergence: clamp01(0.5 + bias * 0.8 + gaussian(0, 0.15)),
    apex_consensus: clamp01(0.5 + bias * 1.2 + gaussian(0, 0.13)),
    cond_prob:    clamp01(0.5 + bias + gaussian(0, 0.15)),
  };
}

export function generateMockTrades(count: number = 100): ClosedTrade[] {
  const trades: ClosedTrade[] = [];
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    // Spread trades over last 30 days, older first
    const daysAgo = 30 - (i / count) * 30 + gaussian(0, 0.3);
    const openedAtMs = now - daysAgo * dayMs;
    const holdMinutes = 5 + Math.abs(gaussian(30, 40)); // 5–120 min typical
    const closedAtMs = openedAtMs + holdMinutes * 60 * 1000;

    const category: "crypto" | "weather" = Math.random() < 0.7 ? "crypto" : "weather";
    const direction: "YES" | "NO" = Math.random() < 0.55 ? "YES" : "NO";

    // Predicted prob: biased toward 0.55–0.80 (where we have edge)
    const predictedProb = clamp01(0.5 + Math.abs(gaussian(0.15, 0.08)));
    // Edge: predicted vs market, centered around 14%
    const edgeAtEntry = Math.max(0.05, Math.abs(gaussian(0.14, 0.05)));
    const marketPriceAtEntry = direction === "YES"
      ? clamp01(predictedProb - edgeAtEntry)
      : clamp01(predictedProb + edgeAtEntry);

    const entryPrice = direction === "YES"
      ? clamp01(marketPriceAtEntry + 0.01)
      : clamp01(1 - marketPriceAtEntry + 0.01);

    const size = 5 + Math.abs(gaussian(12, 6)); // $5–$30 typical position

    // Outcome: true prob of winning = predictedProb × calibration noise
    // We add ~60% realized win rate target, so bias slightly
    const winProb = clamp01(predictedProb - 0.03 + gaussian(0, 0.03));
    const isWin = Math.random() < winProb;

    // PnL: wins → +shares × (1 - entryPrice), losses → -costBasis
    const shares = size / entryPrice;
    const exitPrice = isWin ? 1.0 : 0.0;
    const pnl = shares * exitPrice - size;
    const pnlPct = (pnl / size) * 100;

    trades.push({
      market: randomMarketSlug(category, daysAgo),
      direction,
      entryPrice: Math.round(entryPrice * 100) / 100,
      exitPrice,
      shares: Math.round(shares * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 10) / 10,
      openedAt: new Date(openedAtMs).toISOString(),
      closedAt: new Date(closedAtMs).toISOString(),
      category,
      predictedProb: Math.round(predictedProb * 1000) / 1000,
      marketPriceAtEntry: Math.round(marketPriceAtEntry * 1000) / 1000,
      edgeAtEntry: Math.round(edgeAtEntry * 1000) / 1000,
      signalBreakdown: category === "crypto" ? makeSignalBreakdown(isWin) : null,
    });
  }

  // Sort chronologically
  trades.sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());
  return trades;
}
