// netlify/functions/edge-tracker.mts
// GET /.netlify/functions/edge-tracker
//   ?mode=paper|live|both         (default: paper)
//   &category=all|crypto|weather  (default: all)
//   &days=7|30|90|all             (default: 30)
//   &mock=1                       (force mock data)
//
// Read-only: aggregates closed trades from auto-trader session state
// and returns statistics for the Edge Tracker UI.

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import type { ClosedTrade, SessionState } from "./auto-trader/shared/types.mts";
import { generateMockTrades } from "./edge-tracker/mock-trades.mts";
import {
  computeSummary,
  computeCumulativePnl,
  computeCalibration,
  computeSignalIC,
  computeEdgeDecay,
  computeWinRateHeatmap,
  computePnlDistribution,
} from "./edge-tracker/statistics.mts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const STORE_NAME = "auto-trader-state";
const PAPER_KEYS = ["auto-trader-session", "auto-trader-session-weather"];
const LIVE_KEYS = ["auto-trader-session-live", "auto-trader-session-live-weather"];

// ─── Helpers ──────────────────────────────────────────────

async function loadTrades(keys: string[]): Promise<ClosedTrade[]> {
  const all: ClosedTrade[] = [];
  try {
    const store = getStore(STORE_NAME);
    for (const key of keys) {
      try {
        const raw = await store.get(key);
        if (!raw) continue;
        const session: SessionState = JSON.parse(raw);
        if (session.closedTrades) all.push(...session.closedTrades);
      } catch {}
    }
  } catch {}
  return all;
}

function filterByCategory(trades: ClosedTrade[], category: string): ClosedTrade[] {
  if (category === "all") return trades;
  return trades.filter((t) => (t.category ?? "crypto") === category);
}

function filterByDays(trades: ClosedTrade[], days: string): ClosedTrade[] {
  if (days === "all") return trades;
  const n = parseInt(days, 10);
  if (!Number.isFinite(n) || n <= 0) return trades;
  const cutoff = Date.now() - n * 24 * 60 * 60 * 1000;
  return trades.filter((t) => new Date(t.closedAt).getTime() >= cutoff);
}

// ─── Main handler ─────────────────────────────────────────

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "paper";
  const category = url.searchParams.get("category") ?? "all";
  const days = url.searchParams.get("days") ?? "30";
  const forceMock = url.searchParams.get("mock") === "1";

  try {
    // 1. Load trades from storage (or mock)
    let trades: ClosedTrade[] = [];
    let isMock = false;

    if (!forceMock) {
      if (mode === "paper" || mode === "both") {
        const paper = await loadTrades(PAPER_KEYS);
        trades = trades.concat(paper);
      }
      if (mode === "live" || mode === "both") {
        const live = await loadTrades(LIVE_KEYS);
        trades = trades.concat(live);
      }
    }

    // 2. Fall back to mock if empty or forced
    if (forceMock || trades.length === 0) {
      trades = generateMockTrades(100);
      isMock = true;
    }

    // 3. Sort chronologically
    trades.sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());

    // 4. Apply filters (after mock fallback so filter works on mock too)
    trades = filterByCategory(trades, category);
    trades = filterByDays(trades, days);

    // 5. Compute statistics (all pure functions, run in parallel would be overkill)
    const summary = computeSummary(trades);
    const cumulativePnl = computeCumulativePnl(trades);
    const calibration = computeCalibration(trades);
    const signalIC = computeSignalIC(trades);
    const edgeDecay = computeEdgeDecay(trades);
    const heatmap = computeWinRateHeatmap(trades);
    const distribution = computePnlDistribution(trades);

    // 6. Last 50 trades for the table (newest first)
    const recentTrades = trades
      .slice(-50)
      .reverse()
      .map((t) => ({
        closedAt: t.closedAt,
        openedAt: t.openedAt,
        category: t.category ?? "unknown",
        market: t.market,
        direction: t.direction,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        shares: t.shares,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        edgeAtEntry: t.edgeAtEntry ?? 0,
        predictedProb: t.predictedProb ?? 0,
      }));

    return new Response(
      JSON.stringify({
        ok: true,
        fetchedAt: new Date().toISOString(),
        filters: { mode, category, days },
        isMock,
        summary,
        cumulativePnl,
        calibration,
        signalIC,
        edgeDecay,
        heatmap,
        distribution,
        trades: recentTrades,
      }),
      { status: 200, headers: CORS },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: CORS },
    );
  }
}
