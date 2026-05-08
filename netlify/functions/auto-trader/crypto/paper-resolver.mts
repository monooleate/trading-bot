// Paper-mode resolver: closes open paper positions using real Polymarket
// resolution data (gold standard) or, when a market is past its end-time
// but resolution data hasn't propagated yet, a Brownian-bridge simulation
// in YES-price space.
//
// Why this module exists
// ──────────────────────
// The previous paper exit (`simulatePaperExit` in index.mts) computed
//
//   exitPrice = marketPrice + (finalProb - marketPrice) * 0.5
//
// which made the realised PnL a function of our own prediction. That made
// every signal-set look profitable in paper, including pure noise (IC=0).
// Both approaches here are deliberately INDEPENDENT of `finalProb`:
//
//   1. `fetchMarketResolution` reads the actual market outcome from
//      Polymarket's gamma API. After the market resolves, outcomePrices is
//      [1,0] (YES won) or [0,1] (NO won). The position closes at the real
//      payoff, so the IC computation in edge-tracker measures whether our
//      signals correlate with real-world outcomes.
//
//   2. `simulateBrownianBridgeExit` is a fallback for the rare case where
//      a market has expired but Polymarket hasn't published resolution
//      data within ~30 minutes. It samples a Bernoulli terminal outcome
//      based on `marketPriceAtEntry` (efficient-market null), then walks
//      a logit-space Brownian bridge between entry and terminal, checking
//      TP/SL crossings along the way. Both ingredients ignore `finalProb`.

import { GAMMA_API } from "../shared/config.mts";
import { log } from "../shared/logger.mts";
import { closePosition } from "./session-manager.mts";
import type { ClosedTrade, Position, SessionState } from "../shared/types.mts";

// ─── Real Polymarket resolution ───────────────────────────────────────

interface ResolutionInfo {
  resolved: boolean;
  yesOutcomePrice: number; // 0 or 1 once resolved; current YES mid otherwise
  closed: boolean;
}

async function fetchMarketResolution(conditionId: string): Promise<ResolutionInfo | null> {
  if (!conditionId) return null;
  try {
    const url = `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
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
    // Polymarket sets outcomePrices to a binary {0,1} once a market resolves.
    // The 0.001 tolerance guards against string-parsing quirks.
    const isResolved = closed && (yes <= 0.001 || yes >= 0.999);
    return { resolved: isResolved, yesOutcomePrice: yes, closed };
  } catch {
    return null;
  }
}

// ─── Brownian-bridge fallback ─────────────────────────────────────────

function randomNormal(): number {
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.max(1e-9, Math.random());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const EPS = 1e-3;
const clamp01 = (x: number) => Math.min(1 - EPS, Math.max(EPS, x));
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface BrownianExitResult {
  exitPrice: number;             // exit price in *position-side* space
  reason: "TP" | "SL" | "EXPIRY";
  yesAtExit: number;             // YES-side price at exit, for logging
}

/**
 * Simulates the YES-price path of a binary market between entry and resolution
 * using a logit-space Brownian bridge anchored on a Bernoulli terminal.
 *
 * KEY PROPERTY: this function does NOT take `finalProb` as input. The expected
 * win rate matches `marketPriceAtEntry` (efficient null) regardless of how
 * confident our signal-combiner was.
 */
export function simulateBrownianBridgeExit(
  marketPriceAtEntry: number,
  direction: "YES" | "NO",
  durationMs: number,
  cfg: { tpTarget: number; slTarget: number },
  sigmaPerSqrtMin: number = 0.45,
): BrownianExitResult {
  const mp = clamp01(marketPriceAtEntry);
  // Sample terminal under efficient-market null: P(YES wins) = marketPrice.
  const outcomeYes = Math.random() < mp;
  const terminalYes = outcomeYes ? 1 - EPS : EPS;
  const logitTerminal = logit(terminalYes);

  // TP/SL bounds expressed in YES-price space.
  const upperYes = direction === "YES" ? cfg.tpTarget : 1 - cfg.slTarget;
  const lowerYes = direction === "YES" ? cfg.slTarget : 1 - cfg.tpTarget;

  const totalMin = Math.max(1, durationMs / 60_000);
  const steps = Math.max(20, Math.min(500, Math.round(totalMin * 4)));
  const dt = totalMin / steps;

  let yesPrice = mp;
  for (let i = 0; i < steps; i++) {
    const stepsLeft = steps - i;
    // Bridge drift: pull the path toward the sampled terminal proportionally
    // to the distance, so the path lands near `terminalYes` at expiry.
    const driftStep = (logitTerminal - logit(yesPrice)) / Math.max(stepsLeft, 1);
    const z = randomNormal();
    const diffStep = sigmaPerSqrtMin * Math.sqrt(dt) * z;

    const newLogit = logit(yesPrice) + driftStep + diffStep;
    yesPrice = clamp01(sigmoid(newLogit));

    if (yesPrice >= upperYes) {
      const exitPos = direction === "YES" ? upperYes : 1 - upperYes;
      return { exitPrice: exitPos, reason: direction === "YES" ? "TP" : "SL", yesAtExit: yesPrice };
    }
    if (yesPrice <= lowerYes) {
      const exitPos = direction === "YES" ? lowerYes : 1 - lowerYes;
      return { exitPrice: exitPos, reason: direction === "YES" ? "SL" : "TP", yesAtExit: yesPrice };
    }
  }

  // Reached expiry with neither bound triggered → settle at terminal.
  const finalYes = outcomeYes ? 1 : 0;
  return {
    exitPrice: direction === "YES" ? finalYes : 1 - finalYes,
    reason: "EXPIRY",
    yesAtExit: finalYes,
  };
}

// ─── Position resolution orchestrator ─────────────────────────────────

export interface ResolutionRecord {
  market: string;
  exitPrice: number;
  pnl: number;
  method: "real" | "sim_TP" | "sim_SL" | "sim_EXPIRY";
}

export interface ResolutionConfig {
  tpTarget: number;
  slTarget: number;
  // ms after endDate before we give up waiting for real resolution and
  // fall through to the Brownian-bridge sim.
  fallbackAfterMs: number;
  // Logit-space sigma per sqrt(minute) for the Brownian fallback.
  brownianSigma: number;
}

/**
 * Walks every open paper position, closes those whose underlying market has
 * resolved (or is stale enough to fall through to the simulator), and returns
 * the updated session.
 */
export async function resolvePendingPaperPositions(
  session: SessionState,
  cfg: ResolutionConfig,
): Promise<{ session: SessionState; resolutions: ResolutionRecord[] }> {
  if (!session.paperMode || session.openPositions.length === 0) {
    return { session, resolutions: [] };
  }

  const resolutions: ResolutionRecord[] = [];
  let updated = session;
  const now = Date.now();
  const grace = 30_000; // 30s grace after endDate before we even try to query

  for (const pos of session.openPositions) {
    const endTs = pos.endDate ? new Date(pos.endDate).getTime() : null;
    // Market still active → don't try to resolve; we'd just see the live
    // mid-price and (a) it isn't a settled outcome, (b) querying every
    // open market every tick is wasteful.
    if (endTs && now < endTs + grace) {
      log("PAPER_RESOLVE_SKIP", true, { market: pos.market, reason: "market_still_active" });
      continue;
    }

    let exitPrice: number | null = null;
    let method: ResolutionRecord["method"] | null = null;

    if (pos.conditionId) {
      const info = await fetchMarketResolution(pos.conditionId);
      if (info?.resolved) {
        exitPrice = pos.direction === "YES" ? info.yesOutcomePrice : 1 - info.yesOutcomePrice;
        method = "real";
      }
    }

    // Fallback if we can't get a real resolution within fallbackAfterMs.
    if (exitPrice === null && endTs !== null && now > endTs + cfg.fallbackAfterMs) {
      const openTs = new Date(pos.openedAt).getTime();
      const durMs = Math.max(60_000, endTs - openTs);
      const sim = simulateBrownianBridgeExit(
        pos.marketPriceAtEntry ?? pos.avgEntry,
        pos.direction,
        durMs,
        { tpTarget: cfg.tpTarget, slTarget: cfg.slTarget },
        cfg.brownianSigma,
      );
      exitPrice = sim.exitPrice;
      method = sim.reason === "TP" ? "sim_TP" : sim.reason === "SL" ? "sim_SL" : "sim_EXPIRY";
    }

    if (exitPrice === null || method === null) continue;

    const proceeds = pos.shares * exitPrice;
    const pnl = proceeds - pos.costBasis;
    const trade: ClosedTrade = {
      market: pos.market,
      direction: pos.direction,
      entryPrice: pos.avgEntry,
      exitPrice,
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
    log("PAPER_RESOLVED", true, {
      market: pos.market,
      direction: pos.direction,
      method,
      entryPrice: pos.avgEntry,
      exitPrice,
      pnl: Math.round(pnl * 100) / 100,
    });
    resolutions.push({ market: pos.market, exitPrice, pnl, method });
  }

  return { session: updated, resolutions };
}
