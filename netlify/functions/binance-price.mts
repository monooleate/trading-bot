// netlify/functions/binance-price.mts
// GET /.netlify/functions/binance-price?symbols=BTCUSDT,ETHUSDT,SOLUSDT
//
// Lightweight ticker proxy for the trader pages. Returns 24hr summary
// (last price, change, %change, high, low, volume) for the requested
// spot symbols. Bybit primary (Binance is geo-blocked on Netlify); we
// rely on the same fallback pattern used by funding-rates.mts.
//
// Cache: 15s in Netlify Blobs — frontends typically poll every 30s, so
// every other call hits the cache. Bybit allows hundreds of req/s on
// /v5/market/tickers, but a 15s TTL is still respectful and protects
// against accidental client-side request storms.

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const BYBIT_API    = "https://api.bybit.com";
const BINANCE_API  = "https://api.binance.com";
const CACHE_TTL_MS = 15 * 1000;          // 15s — fresh enough, cheap enough

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
} as const;

interface PriceTicker {
  symbol:       string;
  price:        number;
  change24h:    number;    // absolute USD change
  changePct24h: number;    // % change as 0.0235 = 2.35%
  high24h:      number;
  low24h:       number;
  volume24h:    number;    // USDT volume
}

function pickSymbols(raw: string | null): string[] {
  if (!raw) return DEFAULT_SYMBOLS;
  const list = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (list.length === 0) return DEFAULT_SYMBOLS;
  // Cap at 10 to avoid abuse — the widget needs at most 3-5.
  return list.slice(0, 10);
}

async function fetchBybit(symbols: string[]): Promise<PriceTicker[]> {
  const res = await fetch(
    `${BYBIT_API}/v5/market/tickers?category=spot`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) throw new Error(`Bybit ${res.status}`);
  const json = await res.json() as any;
  const list = json?.result?.list ?? [];
  const set = new Set(symbols);
  const out: PriceTicker[] = [];
  for (const t of list) {
    if (!set.has(t.symbol)) continue;
    const price = Number(t.lastPrice);
    const pct = Number(t.price24hPcnt);                              // already ratio (e.g. 0.012)
    if (!Number.isFinite(price) || !Number.isFinite(pct)) continue;
    const prev = price / (1 + pct);
    out.push({
      symbol:       t.symbol,
      price,
      change24h:    price - prev,
      changePct24h: pct,
      high24h:      Number(t.highPrice24h) || price,
      low24h:       Number(t.lowPrice24h)  || price,
      volume24h:    Number(t.turnover24h)  || 0,                     // turnover is USDT-denominated
    });
  }
  return out;
}

async function fetchBinance(symbols: string[]): Promise<PriceTicker[]> {
  const symbolsParam = encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(
    `${BINANCE_API}/api/v3/ticker/24hr?symbols=${symbolsParam}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  const list = await res.json() as any[];
  return list.map((t) => {
    const price = Number(t.lastPrice);
    return {
      symbol:       t.symbol,
      price,
      change24h:    Number(t.priceChange),
      changePct24h: Number(t.priceChangePercent) / 100,
      high24h:      Number(t.highPrice) || price,
      low24h:       Number(t.lowPrice)  || price,
      volume24h:    Number(t.quoteVolume) || 0,
    };
  }).filter((t) => Number.isFinite(t.price));
}

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const symbols = pickSymbols(url.searchParams.get("symbols"));
  const cacheKey = `price:${symbols.slice().sort().join(",")}`;

  // ─── Cache ──────────────────────────────────────────────────────
  let store: any = null;
  try { store = getStore("binance-price-cache-v1"); } catch { /* Blobs unavailable in some dev modes */ }
  if (store) {
    try {
      const cached = await store.getWithMetadata(cacheKey);
      const ts = (cached?.metadata as any)?.ts ?? 0;
      if (cached?.data && Date.now() - ts < CACHE_TTL_MS) {
        return new Response(cached.data as string, {
          status: 200,
          headers: { ...CORS, "X-Cache": "HIT" },
        });
      }
    } catch { /* fall through to fetch */ }
  }

  // ─── Fetch (Bybit → Binance fallback) ──────────────────────────
  let tickers: PriceTicker[] = [];
  let source: "bybit" | "binance" | "none" = "none";
  let lastError: string | null = null;
  try {
    tickers = await fetchBybit(symbols);
    if (tickers.length > 0) source = "bybit";
  } catch (e: any) {
    lastError = `bybit: ${e?.message ?? "fail"}`;
  }
  if (tickers.length === 0) {
    try {
      tickers = await fetchBinance(symbols);
      if (tickers.length > 0) source = "binance";
    } catch (e: any) {
      lastError = (lastError ? lastError + "; " : "") + `binance: ${e?.message ?? "fail"}`;
    }
  }

  if (tickers.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: lastError ?? "no tickers" }),
      { status: 502, headers: CORS },
    );
  }

  // Sort to match requested order so the UI doesn't reshuffle between hits.
  tickers.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));

  const payload = JSON.stringify({
    ok: true,
    source,
    fetchedAt: new Date().toISOString(),
    tickers,
  });

  if (store) {
    try { await store.set(cacheKey, payload, { metadata: { ts: Date.now() } }); }
    catch { /* non-fatal */ }
  }
  return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });
}
