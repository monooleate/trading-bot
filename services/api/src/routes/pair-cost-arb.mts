// netlify/functions/pair-cost-arb.mts
// GET /.netlify/functions/pair-cost-arb?minProfit=0.03&minVolume=1000&minDepth=50
//
// Riskless YES+NO pair-cost arbitrage scanner (C4 from master-plan).
// For every active Polymarket binary market, fetch the top YES ask and
// the top NO ask. If `yesAsk + noAsk < 1` minus a configurable buffer,
// buying both sides and redeeming guarantees $1 per share.
//
// Cache TTL: 60s (gas-fee buffer accounts for redemption + slippage).
// Auth: not strictly required because this is a read-only scanner; same
// posture as polymarket-proxy. The follow-up trade execution lives in
// polymarket-trade.mts (intent-only) and polymarket-redeem.mts.

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API  = "https://clob.polymarket.com";
const TTL_MS    = 60 * 1000;
const STORE     = "pair-arb-cache";
const FETCH_TIMEOUT = 8000;

// ─── Helpers ──────────────────────────────────────────────────────

async function gamma(path: string, params: Record<string, string> = {}) {
  const qs = Object.keys(params).length ? "?" + new URLSearchParams(params) : "";
  const r = await fetch(`${GAMMA_API}${path}${qs}`, {
    headers: { Accept: "application/json", "User-Agent": "EdgeCalc-PairArb/1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!r.ok) throw new Error(`gamma ${r.status}`);
  return r.json();
}

interface BookSnap {
  asks: { price: number; size: number }[];
  bids: { price: number; size: number }[];
}

async function fetchBook(tokenId: string): Promise<BookSnap | null> {
  try {
    const r = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const norm = (rows: any[]) =>
      rows.slice(0, 10).map((row: any) => ({
        price: parseFloat(row.price ?? row[0]),
        size:  parseFloat(row.size  ?? row[1]),
      })).filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size));
    return { asks: norm(j.asks || []), bids: norm(j.bids || []) };
  } catch { return null; }
}

// Walk the ask side until `targetUSDC` worth of YES exposure is taken.
// Returns the volume-weighted average cost per share, or null if depth
// is insufficient.
function vwapCost(book: BookSnap, targetUSDC: number): { vwap: number; share: number } | null {
  let usdcSpent = 0, sharesAcquired = 0;
  for (const lvl of book.asks) {
    const remaining = targetUSDC - usdcSpent;
    if (remaining <= 0) break;
    const lvlNotional = lvl.price * lvl.size;
    if (lvlNotional <= remaining) {
      usdcSpent += lvlNotional;
      sharesAcquired += lvl.size;
    } else {
      const partialShares = remaining / lvl.price;
      sharesAcquired += partialShares;
      usdcSpent += remaining;
      break;
    }
  }
  if (usdcSpent < targetUSDC * 0.95) return null; // < 95% filled = too thin
  return { vwap: usdcSpent / sharesAcquired, share: sharesAcquired };
}

// ─── Scanner core ─────────────────────────────────────────────────

interface ArbCandidate {
  slug: string;
  title: string;
  endDate: string;
  yesAsk: number;
  noAsk: number;
  combined: number;
  profitPct: number;
  yesVwap: number | null;
  noVwap: number | null;
  combinedVwap: number | null;
  profitPctVwap: number | null;
  testNotional: number;
  volume24h: number;
  liquidity: number;
}

async function scan(opts: {
  minProfit: number;
  minVolume: number;
  testNotional: number;
  maxMarkets: number;
}): Promise<ArbCandidate[]> {
  const events: any[] = await gamma("/events", {
    closed: "false", active: "true", limit: "60",
    order: "volume24hr", ascending: "false",
  });

  const cands: ArbCandidate[] = [];
  const now = Date.now();
  const minEnd = now + 24 * 60 * 60 * 1000; // ≥ 24h until resolution

  // Flatten markets, keep only binary (2 outcomes) ones
  const markets: any[] = [];
  for (const evt of Array.isArray(events) ? events : []) {
    for (const m of evt.markets || []) {
      if (m.closed || !m.active) continue;
      if (m.endDate && new Date(m.endDate).getTime() < minEnd) continue;
      const ids = typeof m.clobTokenIds === "string"
        ? safeParse(m.clobTokenIds)
        : m.clobTokenIds;
      if (!Array.isArray(ids) || ids.length !== 2) continue;
      const vol24 = parseFloat(m.volume24hr || m.volume || "0");
      if (vol24 < opts.minVolume) continue;
      markets.push({ market: m, tokens: ids });
      if (markets.length >= opts.maxMarkets) break;
    }
    if (markets.length >= opts.maxMarkets) break;
  }

  // Fetch YES + NO books in parallel batches of 6 to stay under rate limits
  const batchSize = 6;
  for (let i = 0; i < markets.length; i += batchSize) {
    const batch = markets.slice(i, i + batchSize);
    await Promise.all(batch.map(async ({ market, tokens }) => {
      const [yesBook, noBook] = await Promise.all([fetchBook(tokens[0]), fetchBook(tokens[1])]);
      if (!yesBook?.asks?.length || !noBook?.asks?.length) return;
      const yesAsk = yesBook.asks[0].price;
      const noAsk  = noBook.asks[0].price;
      const combined = yesAsk + noAsk;
      const profitPct = (1 - combined) / combined;
      if (profitPct < opts.minProfit) return;

      // Validate at the requested notional with a VWAP walk on both sides
      const yesV = vwapCost(yesBook, opts.testNotional);
      const noV  = vwapCost(noBook,  opts.testNotional);
      const combinedVwap = yesV && noV ? yesV.vwap + noV.vwap : null;
      const profitPctVwap = combinedVwap ? (1 - combinedVwap) / combinedVwap : null;

      cands.push({
        slug:          market.slug || "",
        title:         market.question || market.title || "",
        endDate:       market.endDate || "",
        yesAsk:        parseFloat(yesAsk.toFixed(4)),
        noAsk:         parseFloat(noAsk.toFixed(4)),
        combined:      parseFloat(combined.toFixed(4)),
        profitPct:     parseFloat(profitPct.toFixed(4)),
        yesVwap:       yesV?.vwap ? parseFloat(yesV.vwap.toFixed(4)) : null,
        noVwap:        noV?.vwap  ? parseFloat(noV.vwap.toFixed(4))  : null,
        combinedVwap:  combinedVwap ? parseFloat(combinedVwap.toFixed(4)) : null,
        profitPctVwap: profitPctVwap !== null ? parseFloat(profitPctVwap.toFixed(4)) : null,
        testNotional:  opts.testNotional,
        volume24h:     parseFloat(market.volume24hr || market.volume || "0"),
        liquidity:     parseFloat(market.liquidityNum || market.liquidity || "0"),
      });
    }));
  }

  cands.sort((a, b) => (b.profitPctVwap ?? b.profitPct) - (a.profitPctVwap ?? a.profitPct));
  return cands;
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

// ─── Handler ──────────────────────────────────────────────────────

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers: CORS });
  }

  const url = new URL(req.url);
  const minProfit    = parseFloat(url.searchParams.get("minProfit")    || "0.03"); // 3% net
  const minVolume    = parseFloat(url.searchParams.get("minVolume")    || "1000");
  const testNotional = parseFloat(url.searchParams.get("notional")     || "50");   // $50 default
  const maxMarkets   = parseInt(  url.searchParams.get("maxMarkets")   || "40", 10);

  const cacheKey = `arb:${minProfit}:${minVolume}:${testNotional}:${maxMarkets}`;

  try {
    const store = getStore(STORE);
    const cached = await store.getWithMetadata(cacheKey);
    if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < TTL_MS) {
      return new Response(cached.data as string, {
        status: 200, headers: { ...CORS, "X-Cache": "HIT" },
      });
    }

    const candidates = await scan({ minProfit, minVolume, testNotional, maxMarkets });
    const payload = JSON.stringify({
      ok: true,
      params: { minProfit, minVolume, testNotional, maxMarkets },
      count: candidates.length,
      candidates,
      fetchedAt: new Date().toISOString(),
    }, null, 2);

    try { await store.set(cacheKey, payload, { metadata: { ts: Date.now() } }); } catch {}
    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502, headers: CORS,
    });
  }
}
