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

import { GAMMA_API, getTraderConfig } from "../shared/config.mts";
import { log } from "../shared/logger.mts";
import { closePosition } from "./session-manager.mts";
import type { ClosedTrade, SessionState } from "../shared/types.mts";

// Settlement fee model (audit fix #6, 2026-05-11). The decision-engine
// gates entries with `netEdge = grossEdge − roundtripFeePct` so the paper
// resolver MUST apply the same fee on close, otherwise paper PnL is
// systematically more optimistic than live PnL and signal-IC calibration
// drifts. Live Polymarket CLOB charges 0% taker fees today, but the 3.6%
// roundtrip captures real-world entry slippage (already baked into
// avgEntry as `marketPrice + $0.01`) PLUS the implicit cost of bid-ask
// spread on early exits, redemption gas (~$0.50 per claim), and
// occasional cross-book fills. Applying it once per close on the larger
// of (proceeds, costBasis) is the most conservative interpretation and
// matches the gate logic exactly.
function applySettlementFee(pnlGross: number, proceeds: number, costBasis: number, feePct: number): number {
  const notional = Math.max(proceeds, costBasis);
  return pnlGross - notional * feePct;
}

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

// Per-position diagnostic payload returned by resolvePendingPositions so
// the UI can render the live Gamma state of every pending position without
// a second round of Gamma fetches.
export interface PendingDiagnostic {
  market: string;
  conditionId: string | null;
  ageMin: number;
  gamma: {
    found: boolean;
    closed: boolean | null;
    outcomePrices: number[] | null;
    umaResolutionStatus: string | null;
  } | null;
  /** Plain-language verdict shown in the UI. */
  verdict: string;
  /** True when the resolver SHOULD close this position on the next tick. */
  shouldClose: boolean;
}

async function fetchMarketRaw(conditionId: string): Promise<any | null> {
  if (!conditionId) return null;
  try {
    const url = `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}&closed=true`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "EdgeCalc-PaperResolver/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const arr = Array.isArray(data) ? data : (data?.data ?? []);
    return arr[0] ?? null;
  } catch {
    return null;
  }
}

function parseResolution(m: any): ResolutionInfo {
  let yes = 0.5;
  try {
    const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (Array.isArray(op) && op.length >= 1) yes = parseFloat(String(op[0]));
  } catch {}
  const closed = m.closed === true;
  // UMA finality gate — even closed=true with op at extremes can flip during
  // the dispute window. Only accept resolutions where UMA reached its final
  // "resolved" state (or where the field is absent on legacy markets).
  const umaStatus = String(m.umaResolutionStatus || "").toLowerCase();
  if (UMA_PENDING_STATES.has(umaStatus)) {
    return { resolved: false, yesOutcomePrice: yes, closed };
  }
  // Polymarket sets outcomePrices to a binary {0,1} once a market resolves.
  const isResolved = closed && (yes <= 0.001 || yes >= 0.999);
  return { resolved: isResolved, yesOutcomePrice: yes, closed };
}

function buildDiagnostic(market: string, conditionId: string, ageMin: number, raw: any): PendingDiagnostic {
  let op: number[] | null = null;
  try {
    const parsed = typeof raw.outcomePrices === "string" ? JSON.parse(raw.outcomePrices) : raw.outcomePrices;
    if (Array.isArray(parsed)) op = parsed.map((x: any) => parseFloat(String(x)));
  } catch {}
  const closed = raw.closed === true;
  const uma = String(raw.umaResolutionStatus || "").toLowerCase();
  const yes = op && op.length >= 1 ? op[0] : NaN;
  const isBinary = Number.isFinite(yes) && (yes <= 0.001 || yes >= 0.999);

  let verdict: string;
  let shouldClose = false;
  if (!closed) {
    verdict = `Closed flag still false on Gamma despite ageMin=${ageMin}. Market may not have flipped yet — UMA proposer hasn't pushed an outcome.`;
  } else if (UMA_PENDING_STATES.has(uma)) {
    verdict = `UMA "${uma}" — Polymarket flipped closed=true but UMA is in the dispute/voting window. Typical 2h after proposal. The resolver will auto-close once UMA reaches "resolved".`;
  } else if (!isBinary) {
    verdict = `Closed=true and UMA finalized but outcomePrices=${JSON.stringify(op)} is not binary. ` +
              "Usually indicates a 50/50 dispute resolution; the resolver waits for {0,1}.";
  } else {
    verdict = `Resolved on Gamma: outcomePrices=${JSON.stringify(op)}, UMA="${uma || "n/a"}". Next cron tick should close.`;
    shouldClose = true;
  }
  return {
    market,
    conditionId,
    ageMin,
    gamma: { found: true, closed, outcomePrices: op, umaResolutionStatus: uma || null },
    verdict,
    shouldClose,
  };
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
 *
 * Returns `pendingDiagnostics` for past-endDate positions that did NOT
 * close on this pass — captures the Gamma probe data the resolver already
 * fetched so the UI's "Reconcile pending" button doesn't need a second
 * round of Gamma fetches (which would blow past Netlify's 10s function
 * budget for sessions with multiple pending positions).
 */
export async function resolvePendingPositions(
  session: SessionState,
): Promise<{
  session: SessionState;
  resolutions: ResolutionRecord[];
  pendingDiagnostics: PendingDiagnostic[];
}> {
  if (session.openPositions.length === 0) {
    return { session, resolutions: [], pendingDiagnostics: [] };
  }

  const resolutions: ResolutionRecord[] = [];
  const pendingDiagnostics: PendingDiagnostic[] = [];
  let updated = session;
  const now = Date.now();
  const grace = 30_000; // 30s grace after endDate before we even try to query

  // Pre-pass: collect every conditionId that needs a live Gamma probe.
  // We Promise.all them so the wall-clock cost is one Gamma RTT instead of
  // N × RTT — critical for staying under Netlify's 10s function budget
  // when the session has more than 1 pending position.
  const toFetch: Array<{ pos: typeof session.openPositions[number]; ageMin: number }> = [];
  for (const pos of session.openPositions) {
    const endTs = pos.endDate ? new Date(pos.endDate).getTime() : null;
    if (endTs && now < endTs + grace) {
      log("PAPER_RESOLVE_SKIP", true, { market: pos.market, reason: "market_still_active" });
      continue;
    }
    const ageMin = endTs ? Math.round((now - endTs) / 60_000) : 0;
    if (!pos.conditionId) {
      log("PAPER_RESOLVE_SKIP", true, { market: pos.market, reason: "missing_conditionId" });
      pendingDiagnostics.push({
        market: pos.market,
        conditionId: null,
        ageMin,
        gamma: null,
        verdict: "Missing conditionId — legacy position from before the resolver wiring. Can never auto-close; reset the session to clear it.",
        shouldClose: false,
      });
      continue;
    }
    toFetch.push({ pos, ageMin });
  }

  // Parallel Gamma probe. fetchMarketRaw is already exception-safe (returns
  // null on any failure) so Promise.all here can't reject. Each fetch has
  // its own 8s AbortSignal timeout, so the slowest network round-trip caps
  // the entire pass at ~8s instead of N × 8s.
  const fetchResults = await Promise.all(
    toFetch.map(({ pos }) => fetchMarketRaw(pos.conditionId!)),
  );

  for (let i = 0; i < toFetch.length; i++) {
    const { pos, ageMin } = toFetch[i];
    const raw = fetchResults[i];
    if (!raw) {
      log("PAPER_RESOLVE_SKIP", true, {
        market: pos.market,
        reason: "gamma_no_market",
        conditionId: pos.conditionId,
        ageMin,
      });
      pendingDiagnostics.push({
        market: pos.market,
        conditionId: pos.conditionId!,
        ageMin,
        gamma: { found: false, closed: null, outcomePrices: null, umaResolutionStatus: null },
        verdict: "Gamma returned no market for this conditionId (with closed=true filter). " +
                 "If ageMin < 60 the market may not yet have flipped closed=true; otherwise the conditionId may be stale or wrong.",
        shouldClose: false,
      });
      continue;
    }
    const info = parseResolution(raw);
    if (!info.resolved) {
      log("PAPER_RESOLVE_SKIP", true, {
        market: pos.market,
        reason: "polymarket_not_resolved_yet",
        conditionId: pos.conditionId,
        ageMin,
      });
      pendingDiagnostics.push(buildDiagnostic(pos.market, pos.conditionId!, ageMin, raw));
      continue;
    }

    const exitPrice = pos.direction === "YES" ? info.yesOutcomePrice : 1 - info.yesOutcomePrice;
    // Snap to clean 0/1 — the 0.001 tolerance above can leave float fuzz.
    const exitSnap = exitPrice >= 0.999 ? 1 : exitPrice <= 0.001 ? 0 : exitPrice;

    const proceeds = pos.shares * exitSnap;
    const pnlGross = proceeds - pos.costBasis;
    // Apply the same roundtrip fee the decision-engine gates against, so
    // closed-paper PnL matches what live execution would have produced.
    // Pulls feePct from the env-default config — the runtime override
    // isn't async-available here and the value is stable (0.036).
    const feePct = getTraderConfig().roundtripFeePct;
    const pnl    = applySettlementFee(pnlGross, proceeds, pos.costBasis, feePct);
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
      pnlGross: Math.round(pnlGross * 100) / 100,
      pnlNet:   Math.round(pnl * 100) / 100,
      feePct,
      // Live positions need a separate on-chain CTF redemption to receive
      // USDC; flag that explicitly so the operator can claim via the
      // existing /polymarket-redeem endpoint.
      requiresRedeem: !session.paperMode,
    });
    resolutions.push({ market: pos.market, exitPrice: exitSnap, pnl, method: "real" });
  }

  return { session: updated, resolutions, pendingDiagnostics };
}

// Backwards-compatible alias — the old name is still imported by the
// orchestrator and any external scripts.
export const resolvePendingPaperPositions = resolvePendingPositions;
