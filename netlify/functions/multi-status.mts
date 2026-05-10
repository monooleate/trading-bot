// netlify/functions/multi-status.mts
// GET /.netlify/functions/multi-status?paper=true
//
// Aggregates session state across every auto-trader category in a single
// response so the home page can show "total bankroll" and a per-category
// breakdown without firing 4 separate /auto-trader hits.
//
// Read-only. Reads from the same Netlify Blobs stores each category writes
// to, returns simplified per-category snapshots + a top-line summary.

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

interface Snapshot {
  category: string;
  label: string;
  found: boolean;
  paperMode: boolean | null;
  bankrollStart: number;
  bankrollCurrent: number;
  sessionPnL: number;
  closedTrades: number;
  openPositions: number;
  stopped: boolean;
  startedAt: string | null;
  // True when bankrollCurrent is borrowed from another category's session
  // (Funding-Arb shares the directional HL session's bankroll). The totals
  // reducer skips bankroll/start fields for these so we don't double-count.
  bankrollShared?: boolean;
}

const EMPTY = (category: string, label: string, paperMode: boolean): Snapshot => ({
  category,
  label,
  found: false,
  paperMode,
  bankrollStart: 0,
  bankrollCurrent: 0,
  sessionPnL: 0,
  closedTrades: 0,
  openPositions: 0,
  stopped: false,
  startedAt: null,
});

async function readJson<T>(storeName: string, key: string): Promise<T | null> {
  try {
    const store = getStore(storeName);
    const raw = await store.get(key);
    if (!raw) return null;
    return JSON.parse(raw as string) as T;
  } catch {
    return null;
  }
}

// ─── Per-category readers ─────────────────────────────────────────────

async function readCrypto(paperMode: boolean): Promise<Snapshot> {
  const key = paperMode ? "auto-trader-session" : "auto-trader-session-live";
  const s: any = await readJson("auto-trader-state", key);
  if (!s) return EMPTY("crypto", "Crypto Auto-Trader", paperMode);
  return {
    category: "crypto",
    label: "Crypto Auto-Trader",
    found: true,
    paperMode: s.paperMode,
    bankrollStart: s.bankrollStart || 0,
    bankrollCurrent: s.bankrollCurrent || 0,
    sessionPnL: s.sessionPnL || 0,
    closedTrades: Array.isArray(s.closedTrades) ? s.closedTrades.length : (s.tradeCount || 0),
    openPositions: Array.isArray(s.openPositions) ? s.openPositions.length : 0,
    stopped: !!s.stopped,
    startedAt: s.startedAt || null,
  };
}

async function readWeather(paperMode: boolean): Promise<Snapshot> {
  const key = paperMode ? "auto-trader-session-weather" : "auto-trader-session-live-weather";
  const s: any = await readJson("auto-trader-state", key);
  if (!s) return EMPTY("weather", "Weather Trader", paperMode);
  return {
    category: "weather",
    label: "Weather Trader",
    found: true,
    paperMode: s.paperMode,
    bankrollStart: s.bankrollStart || 0,
    bankrollCurrent: s.bankrollCurrent || 0,
    sessionPnL: s.sessionPnL || 0,
    closedTrades: Array.isArray(s.closedTrades) ? s.closedTrades.length : (s.tradeCount || 0),
    openPositions: Array.isArray(s.openPositions) ? s.openPositions.length : 0,
    stopped: !!s.stopped,
    startedAt: s.startedAt || null,
  };
}

async function readHyperliquid(paperMode: boolean): Promise<Snapshot> {
  const key = paperMode ? "session_paper" : "session_live";
  const s: any = await readJson("hyperliquid-session-v1", key);
  if (!s) return EMPTY("hyperliquid", "Hyperliquid Perp", paperMode);
  return {
    category: "hyperliquid",
    label: "Hyperliquid Perp",
    found: true,
    paperMode: s.paperMode,
    bankrollStart: s.bankrollStart || 0,
    bankrollCurrent: s.bankrollCurrent || 0,
    sessionPnL: s.sessionPnL || 0,
    closedTrades: Array.isArray(s.closedTrades) ? s.closedTrades.length : (s.tradeCount || 0),
    openPositions: Array.isArray(s.openPositions) ? s.openPositions.length : 0,
    stopped: !!s.stopped,
    startedAt: s.startedAt || null,
  };
}

async function readFundingArb(paperMode: boolean): Promise<Snapshot> {
  const key = paperMode ? "arb_paper" : "arb_live";
  const s: any = await readJson("hyperliquid-arb-session-v1", key);
  if (!s) return EMPTY("funding-arb", "Funding Arbitrage", paperMode);
  // Funding arb session shape is different: positions[] without bankroll fields.
  // F-Arb shares the directional HL session's bankroll (capital comes from
  // there), so surface that here too — `bankrollShared: true` flags the
  // totals reducer to NOT add it again to avoid double-counting.
  const positions = Array.isArray(s.positions) ? s.positions : [];
  const open = positions.filter((p: any) => !p.closedAt).length;
  const closed = positions.length - open;
  const hlKey = paperMode ? "session_paper" : "session_live";
  const hl: any = await readJson("hyperliquid-session-v1", hlKey);
  return {
    category: "funding-arb",
    label: "Funding Arbitrage",
    found: true,
    paperMode: s.paperMode,
    bankrollStart:   hl?.bankrollStart   ?? 0,
    bankrollCurrent: hl?.bankrollCurrent ?? 0,
    bankrollShared:  true,
    sessionPnL: typeof s.totalFundingAllTime === "number" ? s.totalFundingAllTime : 0,
    closedTrades: closed,
    openPositions: open,
    stopped: !!s.stopped,
    startedAt: s.startedAt || null,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405, headers: CORS,
    });
  }

  const url = new URL(req.url);
  const paperMode = url.searchParams.get("paper") !== "false"; // default paper

  const [crypto, weather, hl, fr] = await Promise.all([
    readCrypto(paperMode),
    readWeather(paperMode),
    readHyperliquid(paperMode),
    readFundingArb(paperMode),
  ]);

  const all = [crypto, weather, hl, fr];
  const found = all.filter((s) => s.found);

  // Skip bankroll for `bankrollShared: true` categories (F-Arb borrows the
  // HL session's pool — adding it twice would inflate the home page total).
  // PnL and trade counts are NOT shared, so those still aggregate.
  const totals = found.reduce(
    (acc, s) => {
      if (!s.bankrollShared) {
        acc.bankrollStart   += s.bankrollStart;
        acc.bankrollCurrent += s.bankrollCurrent;
      }
      acc.sessionPnL    += s.sessionPnL;
      acc.closedTrades  += s.closedTrades;
      acc.openPositions += s.openPositions;
      return acc;
    },
    { bankrollStart: 0, bankrollCurrent: 0, sessionPnL: 0, closedTrades: 0, openPositions: 0 },
  );

  return new Response(
    JSON.stringify({
      ok: true,
      paperMode,
      totals,
      categories: all,
      activeCount: found.length,
      fetchedAt: new Date().toISOString(),
    }, null, 2),
    { headers: CORS },
  );
}
