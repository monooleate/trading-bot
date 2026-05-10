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
import { getAllMids, hlInfoPost } from "./hl-client.mts";
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

// One bulk fetch of HL hourly funding rates per coin, mirroring fr-scanner
// but kept local so paper-resolver stays self-contained. Returns a
// coin → hourlyRate map; missing coins default to 0 (no accrual).
async function getHlFundingMap(paperMode: boolean): Promise<Map<HlCoin, number>> {
  const out = new Map<HlCoin, number>();
  try {
    const resp = await hlInfoPost(paperMode, { type: "metaAndAssetCtxs" }, 6000);
    if (!Array.isArray(resp) || resp.length < 2) return out;
    const meta = resp[0];
    const ctxs = resp[1];
    if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return out;
    for (let i = 0; i < meta.universe.length; i++) {
      const u = meta.universe[i];
      if (!u || u.isDelisted) continue;
      const name = u.name;
      if (typeof name !== "string") continue;
      const r = parseFloat(ctxs[i]?.funding ?? "0");
      if (Number.isFinite(r)) out.set(name as HlCoin, r);
    }
  } catch {}
  return out;
}

export interface HlResolution {
  coin: HlCoin;
  exitPrice: number;
  pnlUSDC: number;
  reason: "tp" | "sl" | "timeout";
}

// On a real HL perp position, funding is paid/received hourly: a LONG pays
// `position_value × fundingRate` when the rate is positive, a SHORT receives
// it. The previous paper PnL ignored funding entirely, so paper trades over-
// stated PnL on coins with persistent positive funding (every BTC/ETH long
// during a bull tape) and understated it on negative-funding rebates. Now
// we accrue at the latest observed hourly rate × hold time × position
// notional. The notional is approximated as (sizeCoins × entry+exit avg)
// — a midpoint that's exact for hold periods short relative to BTC drift
// and within a few bps for longer holds.
function pnlOfClose(
  p: HlPosition,
  exitPrice: number,
  feeRoundtrip: number,
  fundingHourlyRate: number,
  holdHours: number,
) {
  const isLong = p.direction === "LONG";
  const priceMovePct = isLong
    ? (exitPrice - p.entryPrice) / p.entryPrice
    : (p.entryPrice - exitPrice) / p.entryPrice;
  const grossPnl = p.sizeUSDC * p.leverage * priceMovePct;
  const fees     = p.sizeUSDC * p.leverage * feeRoundtrip;

  // Funding leg. Position value at entry == sizeUSDC × leverage; at exit
  // == |sizeCoins| × exitPrice. Use the midpoint as the per-hour notional.
  const entryNotional = p.sizeUSDC * p.leverage;
  const exitNotional  = Math.abs(p.sizeCoins) * exitPrice;
  const avgNotional   = (entryNotional + exitNotional) / 2;
  const fundingPaid   = avgNotional * fundingHourlyRate * holdHours;
  // LONG pays funding when rate > 0; SHORT receives.
  const fundingPnl    = isLong ? -fundingPaid : fundingPaid;

  const pnlUSDC  = grossPnl - fees + fundingPnl;
  const pnlPct   = p.sizeUSDC > 0 ? pnlUSDC / p.sizeUSDC : 0;
  return {
    pnlUSDC:    parseFloat(pnlUSDC.toFixed(2)),
    pnlPct:     parseFloat(pnlPct.toFixed(4)),
    fundingPnl: parseFloat(fundingPnl.toFixed(4)),
  };
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
  // and try again on the next tick. The funding-rate fetch is best-effort
  // (parallel) — on failure we fall back to 0 so PnL still books, with
  // the funding leg silently skipped rather than blocking the close.
  let mids: Record<string, number>;
  let fundingMap: Map<HlCoin, number>;
  try {
    [mids, fundingMap] = await Promise.all([
      getAllMids(session.paperMode),
      getHlFundingMap(session.paperMode),
    ]);
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

    const openedAtMs   = new Date(pos.openedAt).getTime();
    const holdHours    = Math.max(0, (now - openedAtMs) / 3_600_000);
    const fundingRate  = fundingMap.get(pos.coin) ?? 0;
    const { pnlUSDC, pnlPct, fundingPnl } = pnlOfClose(
      pos,
      exitPrice,
      cfg.feeRoundtrip,
      fundingRate,
      holdHours,
    );

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
      venue:       "hyperliquid",
      coin:        pos.coin,
      direction:   pos.direction,
      method:      "markprice",
      reason,
      entryPrice:  pos.entryPrice,
      exitPrice,
      markPrice:   px,
      holdHours:   parseFloat(holdHours.toFixed(2)),
      fundingRate,
      fundingPnl,
      pnl:         pnlUSDC,
    });
    resolutions.push({ coin: pos.coin, exitPrice, pnlUSDC, reason });
  }

  return { session: updated, resolutions };
}
