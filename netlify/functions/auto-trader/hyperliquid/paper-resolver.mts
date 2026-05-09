// netlify/functions/auto-trader/hyperliquid/paper-resolver.mts
//
// Closes open HL paper positions using the actual Hyperliquid markPrice,
// not a deterministic pull toward TP/SL. The previous `simulatePaperPnl`
// in order-manager.mts decided exit magnitude from the SIGN of price
// movement (favoured -> 60% to TP, otherwise 50% to SL), which made every
// signal look profitable in paper as long as the markPrice happened to
// drift in the same direction as our LONG/SHORT pick.
//
// This module mirrors the crypto paper-resolver pattern:
//
//   1. On each cron tick, walk open paper positions and fetch the current
//      HL markPrice via `hlInfoPost({type: "allMids"})`.
//   2. If markPrice has crossed the TP or SL since entry, close the
//      position at exactly TP/SL (the discrete-tick simplification — a
//      finer model would walk the trade tape, but markPrice ticks every
//      few seconds so the error is small relative to TP/SL distances).
//   3. If neither bound has been crossed and the position has aged past
//      `maxPaperHoldMs`, close at the current markPrice (timeout). This
//      keeps stale positions from accumulating across cron ticks if the
//      coin trades sideways forever.
//
// IMPORTANT: this resolver is INDEPENDENT of `signal.finalProb` and
// `signal.kellyFraction`. The exit price is a function of the live HL
// market only, so the IC computed by edge-tracker reflects whether our
// signals correlate with real HL price moves.

import { log } from "../shared/logger.mts";
import { getAllMids } from "./hl-client.mts";
import { closePosition } from "./session-manager.mts";
import type {
  HlSessionState,
  HlPosition,
  HlClosedTrade,
  HlCoin,
} from "./types.mts";

export interface HlResolutionConfig {
  feeRoundtrip: number;       // pct (e.g. 0.0007)
  maxPaperHoldMs: number;     // close at market after this much hold time
}

export interface HlResolution {
  coin: HlCoin;
  exitPrice: number;
  pnlUSDC: number;
  reason: "tp" | "sl" | "timeout";
}

function pnlOfClose(p: HlPosition, exitPrice: number, feeRoundtrip: number) {
  const isLong = p.direction === "LONG";
  const priceMovePct = isLong
    ? (exitPrice - p.entryPrice) / p.entryPrice
    : (p.entryPrice - exitPrice) / p.entryPrice;
  const grossPnl = p.sizeUSDC * p.leverage * priceMovePct;
  const fees     = p.sizeUSDC * p.leverage * feeRoundtrip;
  const pnlUSDC  = grossPnl - fees;
  const pnlPct   = p.sizeUSDC > 0 ? pnlUSDC / p.sizeUSDC : 0;
  return { pnlUSDC: parseFloat(pnlUSDC.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(4)) };
}

export async function resolveOpenHlPaperPositions(
  session: HlSessionState,
  cfg: HlResolutionConfig,
): Promise<{ session: HlSessionState; resolutions: HlResolution[] }> {
  if (!session.paperMode || session.openPositions.length === 0) {
    return { session, resolutions: [] };
  }

  // One bulk fetch covers every open coin — the markPrice map keys are
  // already coin tickers. If the call fails, we keep the positions open
  // and try again on the next tick.
  let mids: Record<string, number>;
  try {
    mids = await getAllMids(session.paperMode);
  } catch {
    return { session, resolutions: [] };
  }

  const resolutions: HlResolution[] = [];
  let updated = session;
  const now = Date.now();

  for (const pos of session.openPositions) {
    const px = mids?.[pos.coin];
    if (!Number.isFinite(px)) continue;

    const isLong = pos.direction === "LONG";
    let exitPrice: number | null = null;
    let reason: HlResolution["reason"] | null = null;

    // TP/SL crossing check — markPrice driven, NOT prediction-driven.
    if (isLong) {
      if (px >= pos.tpPrice)      { exitPrice = pos.tpPrice; reason = "tp"; }
      else if (px <= pos.slPrice) { exitPrice = pos.slPrice; reason = "sl"; }
    } else {
      // SHORT: TP is below entry, SL is above
      if (px <= pos.tpPrice)      { exitPrice = pos.tpPrice; reason = "tp"; }
      else if (px >= pos.slPrice) { exitPrice = pos.slPrice; reason = "sl"; }
    }

    // Timeout fallback at current markPrice if the position has aged out
    if (exitPrice === null) {
      const openedAtMs = new Date(pos.openedAt).getTime();
      if (now - openedAtMs >= cfg.maxPaperHoldMs) {
        exitPrice = px;
        reason = "timeout";
      }
    }

    if (exitPrice === null || reason === null) continue;

    const { pnlUSDC, pnlPct } = pnlOfClose(pos, exitPrice, cfg.feeRoundtrip);

    const closed: HlClosedTrade = {
      coin:          pos.coin,
      direction:     pos.direction,
      entryPrice:    pos.entryPrice,
      exitPrice:     parseFloat(exitPrice.toFixed(4)),
      sizeCoins:     pos.sizeCoins,
      pnlUSDC,
      pnlPct,
      openedAt:      pos.openedAt,
      closedAt:      new Date().toISOString(),
      closeReason:   reason === "timeout" ? "timeout" : reason,
      // Carry the signal context captured at entry through to the closed
      // trade so edge-tracker IC computation has real predictions to
      // correlate with realised PnL. Older positions stored before the
      // metadata patch fall back to neutral defaults.
      edgeAtEntry:     pos.edgeAtEntry   ?? 0,
      predictedProb:   pos.predictedProb ?? 0.5,
      signalBreakdown: pos.signalBreakdown,
    };

    updated = closePosition(updated, pos.entryOrderId, closed);
    log("TRADE_CLOSED", session.paperMode, {
      venue:      "hyperliquid",
      coin:       pos.coin,
      direction:  pos.direction,
      method:     "markprice",
      reason,
      entryPrice: pos.entryPrice,
      exitPrice,
      markPrice:  px,
      pnl:        pnlUSDC,
    });
    resolutions.push({ coin: pos.coin, exitPrice, pnlUSDC, reason });
  }

  return { session: updated, resolutions };
}
