// netlify/functions/auto-trader/sports/paper-resolver.mts
//
// Settlement resolver for Sports positions. Same pattern as crypto's
// v3 paper-resolver: NO simulator path, ONLY closes positions when
// Polymarket Gamma reports closed=true + outcomePrices ∈ {0,1} +
// umaResolutionStatus="resolved" (defensive UMA finality gate).

import { GAMMA_API } from "../shared/config.mts";
import { log } from "../shared/logger.mts";
import type { SportsSessionState, SportsClosedTrade } from "./types.mts";
import { closeOpenPosition } from "./session-manager.mts";

const UMA_PENDING_STATES = new Set([
  "proposed", "disputed", "challenged", "settled_pending",
]);

interface ResolutionInfo {
  resolved:        boolean;
  yesOutcomePrice: number;
  closed:          boolean;
}

async function fetchMarketResolution(conditionId: string): Promise<ResolutionInfo | null> {
  if (!conditionId) return null;
  try {
    const url = `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}&closed=true`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "EdgeCalc-SportsResolver/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const arr = Array.isArray(data) ? data : (data?.data ?? []);
    const m = arr[0];
    if (!m) return null;

    let yes = 0.5;
    try {
      const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      if (Array.isArray(op) && op.length >= 1) yes = parseFloat(String(op[0]));
    } catch {}

    const closed = m.closed === true;

    // UMA finality gate (2026-05-11 (i) defensive fix mintát követi).
    const umaStatus = String(m.umaResolutionStatus || "").toLowerCase();
    if (UMA_PENDING_STATES.has(umaStatus)) {
      console.warn(
        `[sports-resolver] skipping ${conditionId.slice(0, 12)}…: ` +
        `closed=true but umaResolutionStatus="${umaStatus}" — waiting for finality`,
      );
      return { resolved: false, yesOutcomePrice: yes, closed };
    }

    const isResolved = closed && (yes <= 0.001 || yes >= 0.999);
    return { resolved: isResolved, yesOutcomePrice: yes, closed };
  } catch {
    return null;
  }
}

export interface SportsResolutionRecord {
  market:    string;
  exitPrice: number;
  pnl:       number;
}

export async function resolvePendingSportsPositions(
  session: SportsSessionState,
): Promise<{ session: SportsSessionState; resolutions: SportsResolutionRecord[] }> {
  if (session.openPositions.length === 0) {
    return { session, resolutions: [] };
  }

  const resolutions: SportsResolutionRecord[] = [];
  let updated = session;
  const now = Date.now();
  const grace = 30_000;

  for (const pos of session.openPositions) {
    const endTs = pos.endDate ? new Date(pos.endDate).getTime() : null;
    if (endTs && now < endTs + grace) continue;

    const info = await fetchMarketResolution(pos.conditionId);
    if (!info?.resolved) {
      log("PAPER_RESOLVE_SKIP", true, {
        market: pos.market,
        category: "sports",
        reason: "polymarket_not_resolved_yet",
        conditionId: pos.conditionId,
        ageMin: endTs ? Math.round((now - endTs) / 60_000) : null,
      });
      continue;
    }

    const exitPrice = pos.direction === "YES" ? info.yesOutcomePrice : 1 - info.yesOutcomePrice;
    const exitSnap = exitPrice >= 0.999 ? 1 : exitPrice <= 0.001 ? 0 : exitPrice;
    const proceeds = pos.shares * exitSnap;
    const pnl = proceeds - pos.costBasis;

    const trade: SportsClosedTrade = {
      market:              pos.market,
      question:            pos.question,
      league:              pos.league,
      direction:           pos.direction,
      entryPrice:          pos.avgEntry,
      exitPrice:           exitSnap,
      shares:              pos.shares,
      pnl,
      pnlPct:              (pnl / Math.max(pos.costBasis, 1e-9)) * 100,
      openedAt:            pos.openedAt,
      closedAt:            new Date().toISOString(),
      marketPriceAtEntry:  pos.marketPriceAtEntry,
      predictedProb:       pos.predictedProb,
    };

    updated = closeOpenPosition(updated, pos.conditionId, trade);
    log("PAPER_RESOLVED", session.paperMode, {
      market:    pos.market,
      category:  "sports",
      direction: pos.direction,
      entryPrice: pos.avgEntry,
      exitPrice: exitSnap,
      pnl,
    });
    resolutions.push({ market: pos.market, exitPrice: exitSnap, pnl });
  }

  return { session: updated, resolutions };
}
