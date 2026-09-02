// netlify/functions/auto-trader/hyperliquid/live-resolver.mts
//
// Mirrors paper-resolver.mts but for LIVE positions. The previous
// architecture had no live exit path: when TP or SL fired on HL the
// session blob still showed the position as open, so the next cron tick
// hit the "Already have open <COIN> position" gate forever. This blocked
// real-money usage entirely (CLAUDE.md §9.A documented the issue).
//
// Per-tick algorithm:
//   1. Pull `clearinghouseState({user})` once. Build a Set of open coins.
//   2. For each session-open position whose coin is NOT in that set →
//      the trade was closed on HL. Look up the closing fill via
//      `userFillsByTime` (since the position's openedAt) and:
//        - Match the fill against tpOrderId / slOrderId / manual close
//        - Use the fill's price as exitPrice and `closedPnl` as PnL
//        - Book the close in session via closePosition(...)
//   3. If the coin IS still in the open set, leave the position alone.
//
// Edge cases:
//   - Fill record not yet visible: HL data API is eventually consistent
//     within a few seconds. We return without booking; the next tick
//     will retry. No phantom close is booked.
//   - Manual close from HL UI: the fill won't match tpOrderId/slOrderId
//     but will still be found by coin+time. We mark closeReason="manual".
//   - Multiple partial fills: we sum filled size and use a size-weighted
//     average price.

import { log } from "../shared/logger.mts";
import { tryLoadLiveAdapter, getClearinghouseState, getUserFillsByTime } from "./hl-client.mts";
import type { HlFill } from "./hl-client.mts";
import { closePosition } from "./session-manager.mts";
import type {
  HlSessionState,
  HlPosition,
  HlClosedTrade,
  HlCoin,
} from "./types.mts";

export interface HlLiveResolution {
  coin:      HlCoin;
  exitPrice: number;
  pnlUSDC:   number;
  reason:    "tp" | "sl" | "manual";
}

function pickClosingFills(fills: HlFill[], pos: HlPosition): HlFill[] {
  const openedAt = new Date(pos.openedAt).getTime();
  // CLOSE direction: SHORT closes via "B" (buy), LONG closes via "A" (sell).
  const wantSide: "A" | "B" = pos.direction === "LONG" ? "A" : "B";
  return fills.filter(
    (f) => f.coin === pos.coin && f.time >= openedAt && f.side === wantSide,
  );
}

function classifyReason(fills: HlFill[], pos: HlPosition): "tp" | "sl" | "manual" {
  for (const f of fills) {
    if (typeof f.oid !== "number") continue;
    if (pos.tpOrderId && String(f.oid) === pos.tpOrderId) return "tp";
    if (pos.slOrderId && String(f.oid) === pos.slOrderId) return "sl";
  }
  return "manual";
}

function weightedAvgPrice(fills: HlFill[]): { exitPrice: number; sizeFilled: number; pnlSum: number } {
  let qSum = 0;
  let qPx = 0;
  let pnlSum = 0;
  for (const f of fills) {
    const px = parseFloat(f.px);
    const q  = parseFloat(f.sz);
    if (!Number.isFinite(px) || !Number.isFinite(q) || q <= 0) continue;
    qPx   += px * q;
    qSum  += q;
    const cp = parseFloat(f.closedPnl ?? "0");
    if (Number.isFinite(cp)) pnlSum += cp;
  }
  return {
    exitPrice:  qSum > 0 ? qPx / qSum : 0,
    sizeFilled: qSum,
    pnlSum,
  };
}

export async function resolveOpenHlLivePositions(
  session: HlSessionState,
): Promise<{ session: HlSessionState; resolutions: HlLiveResolution[] }> {
  if (session.paperMode || session.openPositions.length === 0) {
    return { session, resolutions: [] };
  }
  const adapter = await tryLoadLiveAdapter(false);
  if (!adapter) {
    // No live adapter → nothing to reconcile against. Skip silently; the
    // entry path will surface the same "live adapter unavailable" error
    // on the next attempted entry.
    return { session, resolutions: [] };
  }
  const address = adapter.getAddress();
  const cs = await getClearinghouseState(address, false);
  if (!cs) {
    // Network blip — leave positions alone, retry next tick.
    return { session, resolutions: [] };
  }

  // Build the set of coins HL still considers open for THIS wallet.
  const openOnHl = new Set<string>();
  const positions = Array.isArray(cs?.assetPositions) ? cs.assetPositions : [];
  for (const ap of positions) {
    const coin = ap?.position?.coin;
    const sz   = parseFloat(ap?.position?.szi ?? "0");
    if (typeof coin === "string" && Math.abs(sz) > 0) openOnHl.add(coin);
  }

  // Walk session-open positions; reconcile any whose coin disappeared
  // from HL. Use the OLDEST openedAt as the userFillsByTime startTime so
  // a single API call covers every position we need to inspect.
  const candidates = session.openPositions.filter((p) => !openOnHl.has(p.coin));
  if (candidates.length === 0) {
    return { session, resolutions: [] };
  }
  const earliest = candidates.reduce(
    (acc, p) => Math.min(acc, new Date(p.openedAt).getTime()),
    Date.now(),
  );
  const fills = await getUserFillsByTime(address, earliest, false);

  let updated = session;
  const resolutions: HlLiveResolution[] = [];

  for (const pos of candidates) {
    const matching = pickClosingFills(fills, pos);
    if (matching.length === 0) {
      // HL says position is gone but no closing fill is visible yet —
      // data API is eventually consistent. Wait for the next tick.
      log("PAPER_RESOLVE_SKIP", false, {
        venue: "hyperliquid",
        coin:  pos.coin,
        reason: "live_position_closed_but_no_fill_yet",
      });
      continue;
    }

    const reason = classifyReason(matching, pos);
    const { exitPrice, sizeFilled, pnlSum } = weightedAvgPrice(matching);
    if (exitPrice <= 0 || sizeFilled <= 0) {
      log("PAPER_RESOLVE_SKIP", false, {
        venue: "hyperliquid",
        coin:  pos.coin,
        reason: "fill_data_invalid",
      });
      continue;
    }

    const pnlUSDC = parseFloat(pnlSum.toFixed(2));
    const pnlPct  = pos.sizeUSDC > 0 ? pnlUSDC / pos.sizeUSDC : 0;

    const closed: HlClosedTrade = {
      coin:          pos.coin,
      direction:     pos.direction,
      entryPrice:    pos.entryPrice,
      exitPrice:     parseFloat(exitPrice.toFixed(4)),
      sizeCoins:     pos.sizeCoins,
      pnlUSDC,
      pnlPct:        parseFloat(pnlPct.toFixed(4)),
      openedAt:      pos.openedAt,
      closedAt:      new Date().toISOString(),
      closeReason:   reason === "manual" ? "manual" : reason,
      edgeAtEntry:     pos.edgeAtEntry   ?? 0,
      predictedProb:   pos.predictedProb ?? 0.5,
      signalBreakdown: pos.signalBreakdown,
    };

    updated = closePosition(updated, pos.entryOrderId, closed);
    log("TRADE_CLOSED", false, {
      venue:      "hyperliquid",
      coin:       pos.coin,
      direction:  pos.direction,
      method:     "live_fill",
      reason,
      entryPrice: pos.entryPrice,
      exitPrice,
      pnl:        pnlUSDC,
      fills:      matching.length,
    });
    resolutions.push({ coin: pos.coin, exitPrice, pnlUSDC, reason });
  }

  return { session: updated, resolutions };
}
