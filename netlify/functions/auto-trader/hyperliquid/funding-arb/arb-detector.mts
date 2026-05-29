// netlify/functions/auto-trader/hyperliquid/funding-arb/arb-detector.mts
// Converts FundingData into ArbOpportunity, applying viability checks
// (minimum spread, minimum OI, fee-aware break-even horizon).

import type { FundingData, ArbOpportunity, FrArbConfig } from "./types.mts";

export function detectArbOpportunity(d: FundingData, config: FrArbConfig): ArbOpportunity {
  const spread           = d.hlFundingHourly - d.binanceFundingHourly;
  const spreadAnnualized = spread * 8760 * 100;

  // Direction-aware carry (2026-05-29, B20). The carry available to a
  // delta-neutral position is symmetric in the spread:
  //   FORWARD (HL-short + Binance-spot-long): collects +spread*-ish (gate),
  //            realised carry = HL funding. Viable when spread ≥ min.
  //   REVERSE (HL-long + Binance-perp-short): collects −spread. Viable when
  //            −spread ≥ min, i.e. a strongly NEGATIVE spread.
  // Pick the better-scoring side; both gate on the SAME minSpreadHourly.
  const forwardScore = spread;
  const reverseScore = -spread;
  const direction: "forward" | "reverse" =
    reverseScore > forwardScore ? "reverse" : "forward";
  const score = direction === "reverse" ? reverseScore : forwardScore;

  // Reverse is paper-only: the live hedge would need a Binance futures/margin
  // SHORT, but the live hedge-manager is deliberately spot-only. Detect it
  // either way (so the UI shows the opportunity), but flag live reverse as
  // non-viable with a clear reason — the run loop also guards this.
  const reverseLiveBlocked = direction === "reverse" && !config.paperMode;

  const base: ArbOpportunity = {
    coin:                 d.coin,
    hlFundingHourly:      d.hlFundingHourly,
    binanceFundingHourly: d.binanceFundingHourly,
    spread,
    spreadAnnualized,
    direction,
    score,
    openInterestUSD:      d.openInterestUSD,
    markPrice:            d.markPrice,
    isViable:             false,
    reason:               "",
  };

  const dirLabel = direction === "reverse" ? "reverse (HL-long)" : "forward (HL-short)";

  // Carry magnitude must clear the minimum hourly threshold.
  if (score < config.minSpreadHourly) {
    return {
      ...base,
      reason: `Best carry ${(score * 100).toFixed(4)}%/h (${dirLabel}) < min ${(config.minSpreadHourly * 100).toFixed(4)}%/h`,
    };
  }

  if (reverseLiveBlocked) {
    return {
      ...base,
      reason: `Reverse arb (HL-long, ${(score * 100).toFixed(4)}%/h) needs a Binance futures short — live-gated (spot-only). Paper-only until B20.`,
    };
  }

  // Fee-aware break-even: carry × holdHours must exceed total roundtrip fees
  const totalFees     = config.feeRoundtripHl + config.feeRoundtripBinance;
  const breakEvenH    = totalFees / Math.max(score, 1e-9);
  const breakEvenDays = breakEvenH / 24;
  if (breakEvenDays > config.maxHoldDays) {
    return {
      ...base,
      reason: `Break-even hold ${breakEvenDays.toFixed(1)}d > max ${config.maxHoldDays}d (carry too low vs fees)`,
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
    reason:   `${dirLabel} · ${(score * 8760 * 100).toFixed(1)}%/yr annualised, break-even in ${breakEvenDays.toFixed(1)}d`,
  };
}

// Rank by direction-aware carry magnitude (score), best first — so a strong
// reverse opportunity competes head-to-head with forward ones.
export function rankOpportunities(opps: ArbOpportunity[]): ArbOpportunity[] {
  return [...opps].sort((a, b) => b.score - a.score);
}
