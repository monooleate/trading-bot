// netlify/functions/auto-trader/hyperliquid/kelly-sizer.mts
// Binary-market Kelly → perpetual-futures size conversion.
//
// The signal-combiner outputs a Kelly fraction calibrated for binary
// prediction markets. On a perpetual future the payoff profile and
// leverage are different, so we:
//   1. Apply quarter-Kelly (institutional standard)
//   2. Cap to `maxPctBankroll`
//   3. Convert USD notional → coin size via leverage and current price

import { formatSize } from "./hl-client.mts";
import type { HlCoin } from "./types.mts";

export interface KellyToPerpInput {
  bankrollUSDC:   number;
  kellyFraction:  number;   // raw full-Kelly from signal-combiner
  edge:           number;
  currentPrice:   number;
  leverage:       number;
  maxPctBankroll: number;
  coin:           HlCoin;
}

export interface KellyToPerpOutput {
  sizeUSDC:      number;   // notional (before leverage)
  sizeCoins:     number;   // perp contracts in coin units
  sizeCoinsStr:  string;   // HL-formatted
  leverageUsed:  number;
  cappedByLimit: boolean;
}

export function kellyToPerpSize(p: KellyToPerpInput): KellyToPerpOutput {
  const quarterKelly = Math.max(0, p.kellyFraction) * 0.25;
  const cappedFrac   = Math.min(quarterKelly, p.maxPctBankroll);
  const cappedByLimit = cappedFrac < quarterKelly;

  const sizeUSDC  = Math.max(0, p.bankrollUSDC * cappedFrac);
  const leverage  = Math.max(1, Math.min(p.leverage, 3));  // hard-cap 3x
  const sizeCoins = p.currentPrice > 0
    ? (sizeUSDC * leverage) / p.currentPrice
    : 0;

  const sizeCoinsStr = formatSize(p.coin, sizeCoins);
  const sizeCoinsRounded = parseFloat(sizeCoinsStr);

  return {
    sizeUSDC:      parseFloat(sizeUSDC.toFixed(2)),
    sizeCoins:     sizeCoinsRounded,
    sizeCoinsStr,
    leverageUsed:  leverage,
    cappedByLimit,
  };
}

// ─── TP / SL price calculator (asymmetric 2:1 RR, clamped) ────────────────
// The combiner edge = |prob_yes − 0.5| × 2 expresses a binary-market
// directional bias, NOT a perpetual-future price-move target. Multiplying
// it directly by 2/1 gave TP=+40% / SL=−20% on edge=0.20 — magnitudes BTC
// almost never reaches inside a 4h hold window. The clamps below cap the
// edge-driven scaling at sensible perp distances (default 2% / 1%), so:
//   • Small edges (<1%) still produce small TP/SL distances
//   • Large edges saturate at the cap rather than blowing up
//   • The 2:1 reward-risk ratio is preserved as long as tpPctMax = 2 × slPctMax
export function computeTpSl(params: {
  entryPrice: number;
  direction:  "LONG" | "SHORT";
  edge:       number;
  tpMultiple?: number;    // default 2x edge
  slMultiple?: number;    // default 1x edge
  tpPctMax?:   number;    // hard cap on TP distance (default 0.02 = 2%)
  slPctMax?:   number;    // hard cap on SL distance (default 0.01 = 1%)
}): { tpPrice: number; slPrice: number } {
  const tp = params.tpMultiple ?? 2;
  const sl = params.slMultiple ?? 1;
  const tpCap = params.tpPctMax ?? 0.02;
  const slCap = params.slPctMax ?? 0.01;
  const isLong = params.direction === "LONG";
  const tpPct = Math.min(params.edge * tp, tpCap);
  const slPct = Math.min(params.edge * sl, slCap);
  const tpPrice = isLong
    ? params.entryPrice * (1 + tpPct)
    : params.entryPrice * (1 - tpPct);
  const slPrice = isLong
    ? params.entryPrice * (1 - slPct)
    : params.entryPrice * (1 + slPct);
  return { tpPrice, slPrice };
}
