// netlify/functions/auto-trader/hyperliquid/funding-arb/arb-detector.mts
// Converts FundingData into ArbOpportunity, applying viability checks
// (minimum spread, minimum OI, fee-aware break-even horizon).

import type { FundingData, ArbOpportunity, FrArbConfig } from "./types.mts";

export function detectArbOpportunity(d: FundingData, config: FrArbConfig): ArbOpportunity {
  const spread           = d.hlFundingHourly - d.binanceFundingHourly;
  const spreadAnnualized = spread * 8760 * 100;

  const base: ArbOpportunity = {
    coin:                 d.coin,
    hlFundingHourly:      d.hlFundingHourly,
    binanceFundingHourly: d.binanceFundingHourly,
    spread,
    spreadAnnualized,
    openInterestUSD:      d.openInterestUSD,
    markPrice:            d.markPrice,
    isViable:             false,
    reason:               "",
  };

  // Spread must be positive (HL pays more than Binance to shorts)
  if (spread < config.minSpreadHourly) {
    return {
      ...base,
      reason: `Spread ${(spread * 100).toFixed(4)}%/h < min ${(config.minSpreadHourly * 100).toFixed(4)}%/h`,
    };
  }

  // Fee-aware break-even: spread × holdHours must exceed total roundtrip fees
  const totalFees     = config.feeRoundtripHl + config.feeRoundtripBinance;
  const breakEvenH    = totalFees / Math.max(spread, 1e-9);
  const breakEvenDays = breakEvenH / 24;
  if (breakEvenDays > config.maxHoldDays) {
    return {
      ...base,
      reason: `Break-even hold ${breakEvenDays.toFixed(1)}d > max ${config.maxHoldDays}d (spread too low vs fees)`,
    };
  }

  // Liquidity floor
  if (d.openInterestUSD < config.minOpenInterestUSD) {
    return {
      ...base,
      reason: `OI $${(d.openInterestUSD / 1e6).toFixed(1)}M < min $${(config.minOpenInterestUSD / 1e6).toFixed(0)}M`,
    };
  }

  return {
    ...base,
    isViable: true,
    reason:   `${spreadAnnualized.toFixed(1)}%/yr annualised, break-even in ${breakEvenDays.toFixed(1)}d`,
  };
}

export function rankOpportunities(opps: ArbOpportunity[]): ArbOpportunity[] {
  return [...opps].sort((a, b) => b.spread - a.spread);
}
