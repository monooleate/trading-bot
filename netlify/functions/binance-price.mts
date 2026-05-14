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

const BYBIT_API     = "https://api.bybit.com";
const BINANCE_API   = "https://api.binance.com";
const COINBASE_API  = "https://api.exchange.coinbase.com";    // works from Netlify edges where Bybit + Binance are geo-blocked
const CACHE_TTL_MS  = 15 * 1000;         // 15s — fresh enough, cheap enough

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

// Map our Binance-style symbol (BTCUSDT) to Coinbase product (BTC-USD).
// Coinbase quotes against USD, not USDT — the spot prices track within
// fractions of a percent, which is fine for a "spot reference" widget.
function symbolToCoinbase(symbol: string): string | null {
  if (!symbol.endsWith("USDT") && !symbol.endsWith("USD")) return null;
  const base = symbol.replace(/USDT?$/, "");
  return `${base}-USD`;
}

async function fetchCoinbase(symbols: string[]): Promise<PriceTicker[]> {
  // Coinbase Exchange `/products/<X>/stats` is per-symbol; parallelize.
  // Returns: { open, high, low, last, volume, volume_30day } — `volume` is
  // base-asset volume so we approximate USDT volume as `volume * last`.
  const results = await Promise.allSettled(symbols.map(async (sym) => {
    const product = symbolToCoinbase(sym);
    if (!product) throw new Error(`bad symbol ${sym}`);
    const res = await fetch(
      `${COINBASE_API}/products/${product}/stats`,
      { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "edgecalc-price/1.0" } },
    );
    if (!res.ok) throw new Error(`Coinbase ${res.status} ${product}`);
    const j = await res.json() as any;
    const price = Number(j.last);
    const open  = Number(j.open);
    if (!Number.isFinite(price) || !Number.isFinite(open) || open <= 0) {
      throw new Error(`bad payload ${product}`);
    }
    const pct = (price - open) / open;
    const baseVol = Number(j.volume) || 0;
    return {
      symbol:       sym,                        // keep the original BTCUSDT shape so UI doesn't need to know about the swap
      price,
      change24h:    price - open,
      changePct24h: pct,
      high24h:      Number(j.high) || price,
      low24h:       Number(j.low)  || price,
      volume24h:    baseVol * price,            // approximate USD turnover
    } as PriceTicker;
  }));
  return results
    .filter((r): r is PromiseFulfilledResult<PriceTicker> => r.status === "fulfilled")
    .map((r) => r.value);
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

  // ─── Fetch (Bybit → Binance → Coinbase) ────────────────────────
  // Bybit (403) and Binance (451) are both geo-blocked from several
  // Netlify edge regions. Coinbase Exchange has no such restriction and
  // serves as the reliable production fallback. Order kept as Bybit-
  // first because *when* it works it returns a single batched payload
  // (cheapest), but the chain doesn't surrender to a 4xx — it falls
  // straight through to Coinbase.
  let tickers: PriceTicker[] = [];
  let source: "bybit" | "binance" | "coinbase" | "none" = "none";
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
    try {
      tickers = await fetchCoinbase(symbols);
      if (tickers.length > 0) source = "coinbase";
    } catch (e: any) {
      lastError = (lastError ? lastError + "; " : "") + `coinbase: ${e?.message ?? "fail"}`;
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
