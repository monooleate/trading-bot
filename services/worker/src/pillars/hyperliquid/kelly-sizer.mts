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
import { log } from "../shared/logger.mts";
import type { HlCoin } from "./types.mts";

// Hard cap on leverage. Above this the bot refuses to scale up regardless
// of `HL_MAX_LEVERAGE` env. A 3x cap keeps the SL=−1% loss bounded at 3%
// of margin (≈0.45% of bankroll at the default 15% maxPctBankroll), which
// is well below the consecutive-loss pause trigger of 3 losses.
const HL_LEVERAGE_HARD_CAP = 3;
let leverageWarningSent = false;

export interface KellyToPerpInput {
  bankrollUSDC:   number;
  kellyFraction:  number;   // raw full-Kelly from signal-combiner (BROKEN — ignored)
  edge:           number;
  currentPrice:   number;
  leverage:       number;
  maxPctBankroll: number;
  coin:           HlCoin;
  // Perp Kelly inputs (added 2026-05-12). The combiner's kellyFraction is
  // structurally always ~0 (uses model prob as implicit price). We re-derive
  // here using perp R/R math: Kelly = max(0, (p − (1−p)/RR)) where
  // RR = tpPct / slPct. Defaults match decision-engine TP/SL multipliers.
  predProb?:      number;   // finalProb (LONG side win prob)
  direction?:     "LONG" | "SHORT";
  tpPct?:         number;   // expected take-profit distance, default 0.02
  slPct?:         number;   // expected stop-loss distance, default 0.01
}

export interface KellyToPerpOutput {
  sizeUSDC:      number;   // notional (before leverage)
  sizeCoins:     number;   // perp contracts in coin units
  sizeCoinsStr:  string;   // HL-formatted
  leverageUsed:  number;
  cappedByLimit: boolean;
}

export function kellyToPerpSize(p: KellyToPerpInput): KellyToPerpOutput {
  // Re-derive Kelly from perp-specific R/R math. The combiner's
  // `p.kellyFraction` is structurally always ~0 (collapses to 0 at the
  // model's own fair-implied pricing — see signal-combiner.mts:1028).
  // Using it as the sizing input meant every HL trade was $0.
  // New formula: f = max(0, p − (1−p)/RR), where RR = tpPct / slPct.
  // Fallback to the old combiner kelly only if predProb is missing.
  let rawKelly = Math.max(0, p.kellyFraction);
  if (typeof p.predProb === "number" && Number.isFinite(p.predProb)) {
    const tp = p.tpPct ?? 0.02;
    const sl = p.slPct ?? 0.01;
    const rr = Math.max(0.1, tp / sl);
    const win = p.direction === "SHORT" ? 1 - p.predProb : p.predProb;
    const loss = 1 - win;
    rawKelly = Math.max(0, win - loss / rr);
  }
  const quarterKelly = rawKelly * 0.25;
  const cappedFrac   = Math.min(quarterKelly, p.maxPctBankroll);
  const cappedByLimit = cappedFrac < quarterKelly;

  const sizeUSDC  = Math.max(0, p.bankrollUSDC * cappedFrac);
  // Hard cap leverage and surface a warning the first time someone
  // configures a value above the cap. Previously the clamp was silent —
  // an operator setting HL_MAX_LEVERAGE=5 would never know it was being
  // ignored.
  if (p.leverage > HL_LEVERAGE_HARD_CAP && !leverageWarningSent) {
    log("ERROR", false, {
      venue:        "hyperliquid",
      configWarning: `HL_MAX_LEVERAGE=${p.leverage} clamped to ${HL_LEVERAGE_HARD_CAP}x hard cap`,
      hint: "Update HL_MAX_LEVERAGE to <=3 to silence this warning, or remove the override.",
    });
    leverageWarningSent = true;
  }
  const leverage  = Math.max(1, Math.min(p.leverage, HL_LEVERAGE_HARD_CAP));
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
