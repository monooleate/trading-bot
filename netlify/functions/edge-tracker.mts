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
  computeCalibrationHealth,
  computeSignalCollinearity,
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

// Each auto-trader category has its own Blobs store (so a stopped session
// in one venue does not block another). The Edge Tracker reads from all
// of them so closed trades surface uniformly in the per-venue UI.
interface StoreSpec {
  store: string;
  paperKey: string;
  liveKey: string;
  category: string;            // tag the trade if it lacks ClosedTrade.category
}

const STORE_SPECS: StoreSpec[] = [
  { store: "auto-trader-state",          paperKey: "auto-trader-session",                 liveKey: "auto-trader-session-live",                 category: "crypto" },
  { store: "auto-trader-state",          paperKey: "auto-trader-session-weather",         liveKey: "auto-trader-session-live-weather",         category: "weather" },
  { store: "hyperliquid-session-v1",     paperKey: "session_paper",                       liveKey: "session_live",                             category: "hyperliquid" },
  { store: "hyperliquid-arb-session-v1", paperKey: "arb_paper",                           liveKey: "arb_live",                                 category: "funding-arb" },
  { store: "auto-trader-session-sports", paperKey: "session_paper",                       liveKey: "session_live",                             category: "sports" },
];

// Legacy STORE_NAME / PAPER_KEYS / LIVE_KEYS kept here for code that still
// imports them; new logic should use STORE_SPECS.
const STORE_NAME = "auto-trader-state";
const PAPER_KEYS = ["auto-trader-session", "auto-trader-session-weather"];
const LIVE_KEYS = ["auto-trader-session-live", "auto-trader-session-live-weather"];

// ─── Helpers ──────────────────────────────────────────────

interface SessionLike {
  closedTrades?: ClosedTrade[];
  positions?: any[];          // funding-arb shape uses positions[] with closedAt
}

function tradesFromSession(s: SessionLike, fallbackCategory: string): ClosedTrade[] {
  const out: ClosedTrade[] = [];
  // Standard SessionState shape
  if (Array.isArray(s.closedTrades)) {
    for (const t of s.closedTrades) {
      out.push({ ...t, category: t.category ?? (fallbackCategory as any) });
    }
  }
  // Funding-arb session shape: positions[] with optional closedAt + realizedPnL
  if (Array.isArray(s.positions)) {
    for (const p of s.positions as any[]) {
      if (!p?.closedAt) continue;
      out.push({
        market:               p.coin || p.symbol || "funding-arb",
        direction:            (p.hlSide || "SHORT") === "SHORT" ? "NO" : "YES",
        entryPrice:           p.hlAvgPrice ?? 0,
        exitPrice:            p.hlExitPrice ?? p.hlAvgPrice ?? 0,
        shares:               p.hlSize ?? 0,
        pnl:                  p.realizedPnl ?? p.realizedPnL ?? 0,
        pnlPct:               0,
        openedAt:             p.openedAt || new Date().toISOString(),
        closedAt:             p.closedAt,
        category:             "funding-arb" as any,
        predictedProb:        p.expectedApy,
        marketPriceAtEntry:   p.entrySpread,
        edgeAtEntry:          p.expectedApy ?? 0,
      });
    }
  }
  return out;
}

async function loadTradesFromStore(storeName: string, key: string, fallbackCategory: string): Promise<ClosedTrade[]> {
  try {
    const store = getStore(storeName);
    const raw = await store.get(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw as string);
    return tradesFromSession(parsed, fallbackCategory);
  } catch { return []; }
}

async function loadAllPaperTrades(): Promise<ClosedTrade[]> {
  const lists = await Promise.all(
    STORE_SPECS.map((s) => loadTradesFromStore(s.store, s.paperKey, s.category)),
  );
  return lists.flat();
}

async function loadAllLiveTrades(): Promise<ClosedTrade[]> {
  const lists = await Promise.all(
    STORE_SPECS.map((s) => loadTradesFromStore(s.store, s.liveKey, s.category)),
  );
  return lists.flat();
}

// Legacy helper retained so older imports compile; routes via STORE_SPECS.
async function loadTrades(keys: string[]): Promise<ClosedTrade[]> {
  const matches = STORE_SPECS.filter((s) => keys.includes(s.paperKey) || keys.includes(s.liveKey));
  const lists: ClosedTrade[][] = [];
  for (const s of matches) {
    if (keys.includes(s.paperKey)) lists.push(await loadTradesFromStore(s.store, s.paperKey, s.category));
    if (keys.includes(s.liveKey))  lists.push(await loadTradesFromStore(s.store, s.liveKey,  s.category));
  }
  return lists.flat();
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
        trades = trades.concat(await loadAllPaperTrades());
      }
      if (mode === "live" || mode === "both") {
        trades = trades.concat(await loadAllLiveTrades());
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
    const calibrationHealth = computeCalibrationHealth(trades, 30);
    const collinearity = computeSignalCollinearity(trades);
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
        calibrationHealth,
        collinearity,
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
