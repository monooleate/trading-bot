// netlify/functions/auto-trader/sports/decision-engine.mts
//
// Contrarian fan-bias fade strategy. The bot bets AGAINST extreme YES
// pricing on sports markets. Underlying assumption: retail / fans
// over-weight popular teams → YES price > true probability.
//
// Predicted fair value: a simple "regression toward 0.5" Bayesian shrink.
//   predicted = 0.5 + (marketPrice − 0.5) × shrinkFactor
// where shrinkFactor = 0.70 below fanExtremeLow, 0.85 between, 0.55 above.
// This produces a NO bet when YES is above the high threshold, and a
// YES bet when YES is below the low threshold.

import type { SportsMarket, SportsTradeDecision } from "./types.mts";
import type { SportsConfig } from "./config.mts";
import type { DecisionGate } from "../shared/types.mts";

// Quarter-Kelly with hard cap. Same shape as crypto/HL Kelly sizer.
function kellyBinary(p: number, marketPrice: number, bankroll: number, cap: number): { fStar: number; size: number } {
  if (marketPrice <= 0.01 || marketPrice >= 0.99) return { fStar: 0, size: 0 };
  const b = (1 / marketPrice) - 1;
  const q = 1 - p;
  const f = Math.max(0, (p * b - q) / b);
  const fQuarter = Math.min(f * 0.25, cap);
  return { fStar: fQuarter, size: fQuarter * bankroll };
}

export interface DecideInput {
  market:       SportsMarket;
  bankroll:     number;
  openCount:    number;
  config:       SportsConfig;
}

export function makeSportsDecision(input: DecideInput): SportsTradeDecision {
  const { market, bankroll, openCount, config } = input;
  const yp = market.yesPrice;
  const gates: DecisionGate[] = [];

  // Gate 1: max open positions
  gates.push({
    label:    "Open positions",
    passed:   openCount < config.maxOpenPositions,
    actual:   `${openCount}/${config.maxOpenPositions}`,
    required: `< ${config.maxOpenPositions}`,
  });

  // Decide direction + predicted fair value based on fan-extreme position.
  let direction: "YES" | "NO" = "NO";
  let predicted = 0.5;
  let bias: "extreme_high" | "extreme_low" | "neutral";
  if (yp >= config.fanExtremeHigh) {
    bias = "extreme_high";
    // YES is over-priced (fan bias). Shrink towards 0.5.
    predicted = 0.5 + (yp - 0.5) * 0.55;
    direction = "NO";
  } else if (yp <= config.fanExtremeLow) {
    bias = "extreme_low";
    predicted = 0.5 + (yp - 0.5) * 0.55;  // also shrinks toward 0.5 from below
    direction = "YES";
  } else {
    bias = "neutral";
    // No fan-extreme signal — predicted ≈ market, no edge.
    predicted = yp;
  }

  // Gate 2: fan-extreme present
  gates.push({
    label:    "Fan-extreme zone",
    passed:   bias !== "neutral",
    actual:   `YES @ ${(yp * 100).toFixed(1)}¢ (${bias.replace("_", " ")})`,
    required: `<= ${(config.fanExtremeLow * 100).toFixed(0)}¢ or >= ${(config.fanExtremeHigh * 100).toFixed(0)}¢`,
    hint:     "Bot only trades when YES is at fan-bias extreme.",
  });

  // Edge calculation: predicted − marketPriceForChosenSide, minus fees.
  const marketPriceForSide = direction === "YES" ? yp : market.noPrice;
  const grossEdge = Math.abs(predicted - marketPriceForSide);
  const netEdge   = grossEdge - config.roundtripFeePct;

  // Gate 3: net edge after fees
  gates.push({
    label:    "Net edge after fees",
    passed:   netEdge >= config.edgeThreshold,
    actual:   `${(netEdge * 100).toFixed(2)}%`,
    required: `>= ${(config.edgeThreshold * 100).toFixed(1)}%`,
    hint:     `gross ${(grossEdge*100).toFixed(2)}% − fee ${(config.roundtripFeePct*100).toFixed(1)}%`,
  });

  // Kelly sizing
  const probForKelly = direction === "YES" ? predicted : 1 - predicted;
  const { fStar, size } = kellyBinary(probForKelly, marketPriceForSide, bankroll, config.maxKellyFraction);
  const cappedSize = Math.min(size, config.maxPositionUSDC);

  // Gate 4: Kelly conviction
  gates.push({
    label:    "Kelly conviction",
    passed:   fStar > 0,
    actual:   `${(fStar * 100).toFixed(2)}% bankroll`,
    required: "> 0%",
  });

  // Gate 5: min position size
  gates.push({
    label:    "Min position size",
    passed:   cappedSize >= config.minPositionUSDC,
    actual:   `$${cappedSize.toFixed(2)}`,
    required: `>= $${config.minPositionUSDC}`,
  });

  const allPassed = gates.every((g) => g.passed);
  const firstFail = gates.find((g) => !g.passed);

  return {
    shouldTrade:      allPassed,
    direction,
    positionSizeUSDC: parseFloat(cappedSize.toFixed(2)),
    entryPrice:       marketPriceForSide,
    edge:             parseFloat(netEdge.toFixed(4)),
    kellyUsed:        parseFloat(fStar.toFixed(4)),
    reason:           allPassed ? "All gates passed" : `Blocked: ${firstFail?.label}`,
    gates,
  };
}

export { kellyBinary as _internalKelly };
