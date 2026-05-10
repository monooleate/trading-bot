// Position settlement resolver: closes open positions (paper AND live) using
// the real Polymarket resolution outcome. No simulation, no fallback.
//
// Why this module exists
// ──────────────────────
// The previous paper exits relied on simulators (halfway-toward-prediction
// in v1, Brownian-bridge in v2). Both produced fake results that didn't
// reflect real market outcomes — v1 made every signal-set look profitable,
// v2 instant-triggered on deep-OTM entries because the fixed bound checks
// fired on the first iteration whenever entry was outside the [SL, TP] band.
//
// v3 contract: paper PnL == live PnL would have been. The only way to close
// a position is to read `outcomePrices` from Polymarket Gamma after the
// market resolves. If a market hasn't resolved yet, the position stays
// open — exactly like a real position would.
//
// v4 generalization (2026-05-10 audit fix #A): the same logic now also
// closes LIVE positions. The bot's session-state PnL is finalised the same
// way for both modes; the only difference is that for live mode the user
// must redeem the on-chain CTF position via `/polymarket-redeem` to
// actually receive USDC into their funder address. This is logged on close
// so the user can act on it.
//
// Gamma quirk (the bug v2 hit): the default `?condition_ids=...` query
// filters resolved markets out. Resolved markets only appear when you
// explicitly add `&closed=true`.

import { GAMMA_API } from "../shared/config.mts";
import { log } from "../shared/logger.mts";
import { closePosition } from "./session-manager.mts";
import type { ClosedTrade, SessionState } from "../shared/types.mts";

interface ResolutionInfo {
  resolved: boolean;
  yesOutcomePrice: number; // 0 or 1 once resolved
  closed: boolean;
}

// UMA states we treat as "not yet final". Anything outside this set is
// either fully resolved or the field is missing on legacy markets — both
// fall through to the price-based check below. Same defensive gate the
// weather resolver uses (2026-05-10 (i)).
const UMA_PENDING_STATES = new Set([
  "proposed",
  "disputed",
  "challenged",
  "settled_pending",
]);

async function fetchMarketResolution(conditionId: string): Promise<ResolutionInfo | null> {
  if (!conditionId) return null;
  try {
    // `closed=true` is required: without it Gamma hides resolved markets
    // and the response is `[]` even for legit conditionIds.
    const url = `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}&closed=true`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "EdgeCalc-PaperResolver/1.0" },
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

    // UMA finality gate — even closed=true with op at extremes can flip
    // during the dispute window. Only accept resolutions where UMA reached
    // its final "resolved" state (or where the field is absent on legacy
    // markets).
    const umaStatus = String(m.umaResolutionStatus || "").toLowerCase();
    if (UMA_PENDING_STATES.has(umaStatus)) {
      console.warn(
        `[paper-resolver] skipping ${conditionId.slice(0, 12)}…: ` +
        `closed=true but umaResolutionStatus="${umaStatus}" — waiting for finality`,
      );
      return { resolved: false, yesOutcomePrice: yes, closed };
    }

    // Polymarket sets outcomePrices to a binary {0,1} once a market resolves.
    // The 0.001 tolerance guards against string-parsing quirks.
    const isResolved = closed && (yes <= 0.001 || yes >= 0.999);
    return { resolved: isResolved, yesOutcomePrice: yes, closed };
  } catch {
    return null;
  }
}

// ─── Position resolution orchestrator ─────────────────────────────────

export interface ResolutionRecord {
  market: string;
  exitPrice: number;
  pnl: number;
  method: "real";
}

/**
 * Walks every open position (paper or live) and closes those whose
 * Polymarket market has resolved. Markets that haven't resolved yet stay
 * open — the v3 invariant: paper PnL == live PnL.
 *
 * For live positions, the close mutates the bot's session-state PnL the
 * same way as paper. Receiving the actual USDC requires a separate
 * `/polymarket-redeem` call (CTF redemption is intent-only); this is
 * logged via PAPER_RESOLVED with `mode: "live"` so the user can claim.
 */
export async function resolvePendingPositions(
  session: SessionState,
): Promise<{ session: SessionState; resolutions: ResolutionRecord[] }> {
  if (session.openPositions.length === 0) {
    return { session, resolutions: [] };
  }

  const resolutions: ResolutionRecord[] = [];
  let updated = session;
  const now = Date.now();
  const grace = 30_000; // 30s grace after endDate before we even try to query

  for (const pos of session.openPositions) {
    const endTs = pos.endDate ? new Date(pos.endDate).getTime() : null;
    // Market still active → don't try to resolve. Querying every open
    // market every tick is wasteful and the only valid exit price is the
    // settled outcome.
    if (endTs && now < endTs + grace) {
      log("PAPER_RESOLVE_SKIP", true, { market: pos.market, reason: "market_still_active" });
      continue;
    }

    if (!pos.conditionId) {
      log("PAPER_RESOLVE_SKIP", true, { market: pos.market, reason: "missing_conditionId" });
      continue;
    }

    const info = await fetchMarketResolution(pos.conditionId);
    if (!info?.resolved) {
      // Market past endDate but Polymarket hasn't published resolution yet
      // (UMA voting / dispute window). Wait — paper PnL must match real.
      log("PAPER_RESOLVE_SKIP", true, {
        market: pos.market,
        reason: "polymarket_not_resolved_yet",
        conditionId: pos.conditionId,
        ageMin: endTs ? Math.round((now - endTs) / 60_000) : null,
      });
      continue;
    }

    const exitPrice = pos.direction === "YES" ? info.yesOutcomePrice : 1 - info.yesOutcomePrice;
    // Snap to clean 0/1 — the 0.001 tolerance above can leave float fuzz.
    const exitSnap = exitPrice >= 0.999 ? 1 : exitPrice <= 0.001 ? 0 : exitPrice;

    const proceeds = pos.shares * exitSnap;
    const pnl = proceeds - pos.costBasis;
    const trade: ClosedTrade = {
      market: pos.market,
      direction: pos.direction,
      entryPrice: pos.avgEntry,
      exitPrice: exitSnap,
      shares: pos.shares,
      pnl,
      pnlPct: (pnl / Math.max(pos.costBasis, 1e-9)) * 100,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
      category: pos.category ?? "crypto",
      predictedProb: pos.predictedProb,
      marketPriceAtEntry: pos.marketPriceAtEntry,
      edgeAtEntry:
        pos.predictedProb !== undefined && pos.marketPriceAtEntry !== undefined
          ? Math.abs(pos.predictedProb - pos.marketPriceAtEntry)
          : undefined,
      signalBreakdown: pos.signalBreakdown ?? null,
    };

    updated = closePosition(updated, pos.buyOrderId, trade);
    log("PAPER_RESOLVED", session.paperMode, {
      market: pos.market,
      direction: pos.direction,
      method: "real",
      mode: session.paperMode ? "paper" : "live",
      entryPrice: pos.avgEntry,
      exitPrice: exitSnap,
      pnl: Math.round(pnl * 100) / 100,
      // Live positions need a separate on-chain CTF redemption to receive
      // USDC; flag that explicitly so the operator can claim via the
      // existing /polymarket-redeem endpoint.
      requiresRedeem: !session.paperMode,
    });
    resolutions.push({ market: pos.market, exitPrice: exitSnap, pnl, method: "real" });
  }

  return { session: updated, resolutions };
}

// Backwards-compatible alias — the old name is still imported by the
// orchestrator and any external scripts.
export const resolvePendingPaperPositions = resolvePendingPositions;
