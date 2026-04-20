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

// ─── TP / SL price calculator (asymmetric 2:1 RR) ─────────────────────────
export function computeTpSl(params: {
  entryPrice: number;
  direction:  "LONG" | "SHORT";
  edge:       number;
  tpMultiple?: number;    // default 2x edge
  slMultiple?: number;    // default 1x edge
}): { tpPrice: number; slPrice: number } {
  const tp = params.tpMultiple ?? 2;
  const sl = params.slMultiple ?? 1;
  const isLong = params.direction === "LONG";
  const tpPct = params.edge * tp;
  const slPct = params.edge * sl;
  const tpPrice = isLong
    ? params.entryPrice * (1 + tpPct)
    : params.entryPrice * (1 - tpPct);
  const slPrice = isLong
    ? params.entryPrice * (1 - slPct)
    : params.entryPrice * (1 + slPct);
  return { tpPrice, slPrice };
}
