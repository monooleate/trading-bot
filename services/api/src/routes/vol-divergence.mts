// netlify/functions/vol-divergence.mts
// GET /.netlify/functions/vol-divergence
//
// Párhuzamosan lekéri:
//   1. Binance 1m klines → realized vol számítás (Yang-Zhang módszer)
//   2. Polymarket BTC 15m kontraktok → implied vol visszaszámítás
//   3. Vol spread = implied - realized
//   4. Fee-adjusted locked profit lehetőség (YES + NO > $1 + fee)
//
// Cache: 2 perc (Netlify Blobs)

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const BINANCE_SPOT  = "https://api.binance.com";
const GAMMA_API     = "https://gamma-api.polymarket.com";
const CLOB_API      = "https://clob.polymarket.com";
const CACHE_TTL     = 2 * 60 * 1000; // 2 perc
const POLYMARKET_FEE = 0.02;          // ~2% taker fee per side (konzervatív becslés)

// ─── Realized Volatility (Close-to-Close log returns, annualizált) ────────────
function realizedVol(closes: number[], periodsPerYear = 365 * 24 * 60): number {
  if (closes.length < 2) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (logReturns.length < 2) return 0;
  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance * periodsPerYear); // annualizált
}

// ─── Implied Vol visszaszámítás binary kontraktból ────────────────────────────
// Binary option pricing: p = N(d) ahol d = (ln(S/K) + 0.5σ²T) / (σ√T)
// Ha p ismert és T kicsi (15 perc), naïv közelítés:
// σ_implied ≈ |p - 0.5| * 2 * √(2π/T) * (p*(1-p))^0.5
// Ez nem Black-Scholes pontosságú, de elegendő a spread detektáláshoz.
function impliedVolFromBinaryPrice(p: number, T_hours: number): number {
  if (p <= 0.01 || p >= 0.99 || T_hours <= 0) return 0;
  const T = T_hours / (365 * 24); // évben
  // Közelítő: a spread 0.5-től való távolsága arányos a vol-lal
  const dist = Math.abs(p - 0.5);
  // σ ≈ 2 * dist / √T (naïv, de monoton és helyes irányú)
  const sigma = (2 * dist) / Math.sqrt(T);
  return Math.min(sigma, 50); // cap 5000%-on
}

// ─── Price data lekérés (geo-block fallback) ─────────────────────────────────
async function fetchPriceData(limit: number): Promise<number[]> {
  // 1. Binance Futures (fapi) - általában nem geo-blokkolt
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const klines = await res.json() as any[][];
      return klines.map(k => parseFloat(k[4])); // close price
    }
  } catch {}

  // 2. Binance Spot (eredeti)
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const klines = await res.json() as any[][];
      return klines.map(k => parseFloat(k[4]));
    }
  } catch {}

  // 3. CoinGecko fallback (OHLC data)
  try {
    const url = `https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const ohlc = await res.json() as number[][];
      // [timestamp, open, high, low, close]
      return ohlc.slice(-limit).map(c => c[4]);
    }
  } catch {}

  throw new Error("All price data sources failed");
}

async function fetchBinanceKlines(symbol: string, interval: string, limit: number) {
  const closes = await fetchPriceData(limit);
  // Alakítsuk vissza klines formátumra [o,h,l,c,...]
  return closes.map(c => [c, c, c, c, c.toString()]);
}

// ─── Polymarket BTC 15m kontraktok keresése ───────────────────────────────────
async function fetchBTCMarkets() {
  // Gamma API search BTC 15m markets
  const params = new URLSearchParams({
    active: "true", closed: "false",
    limit: "50", order: "volume24hr", ascending: "false",
  });
  const res = await fetch(`${GAMMA_API}/markets?${params}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  const data = await res.json() as any;
  const list: any[] = Array.isArray(data) ? data : (data.markets || []);

  // Szűrés: BTC UP/DOWN kontraktok (15 perc — 48 óra között).
  // A korábbi `hoursLeft < 1 → skip` szűrő kizárta a 15 perces piacokat
  // (a tool egyik fő célpontját). Most csak a settlement-hez nagyon közeli
  // (< 1 perc) és a daily-nél hosszabb (> 48h, nincs RV-window match)
  // piacokat dobjuk el.
  return list.filter((m: any) => {
    const q = (m.question || m.title || "").toLowerCase();
    if (!q.includes("btc") && !q.includes("bitcoin")) return false;
    if (m.endDate) {
      const hoursLeft = (new Date(m.endDate).getTime() - Date.now()) / 3600000;
      if (hoursLeft < 1 / 60) return false; // < 1 perc, settlement
      if (hoursLeft > 48)     return false; // daily/weekly, IV-RV összehasonlítás nem értelmes
    }
    // Kizárjuk az extrém árazású piacokat (lejárt vagy túl egyoldalú)
    try {
      const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      const yp = parseFloat(op?.[0] || 0.5);
      if (yp < 0.05 || yp > 0.95) return false;
    } catch {}
    return true;
  }).slice(0, 8);
}

// ─── CLOB midpoint lekérés ────────────────────────────────────────────────────
// Gamma `/markets` does NOT return a `tokens` array — only `clobTokenIds` as
// a JSON-encoded string (verified via the official Polymarket Python SDK and
// the live API). The previous `m.tokens` reference always returned an empty
// list, leaving `mids` empty and falling back to a 0.5 default — silently
// breaking the IV calculation. Parse the documented field instead.
function extractTokenIds(m: any): { yes: string | null; no: string | null } {
  if (m.clobTokenIds) {
    try {
      const ids = typeof m.clobTokenIds === "string"
        ? JSON.parse(m.clobTokenIds)
        : m.clobTokenIds;
      if (Array.isArray(ids) && ids.length >= 2) {
        return { yes: String(ids[0]), no: String(ids[1]) };
      }
    } catch { /* fall through */ }
  }
  // Forward-compatible fallback if Gamma ever surfaces a `tokens` array.
  if (Array.isArray(m.tokens) && m.tokens.length >= 2) {
    const yesT = m.tokens.find((t: any) => /^(yes|up)$/i.test(t.outcome || ""));
    const noT  = m.tokens.find((t: any) => /^(no|down)$/i.test(t.outcome || ""));
    return {
      yes: yesT?.token_id || m.tokens[0]?.token_id || null,
      no:  noT?.token_id  || m.tokens[1]?.token_id || null,
    };
  }
  return { yes: null, no: null };
}

async function fetchMidpoints(markets: any[]): Promise<Map<string, number>> {
  const mids = new Map<string, number>();
  const allTokenIds: string[] = [];
  for (const m of markets) {
    const { yes, no } = extractTokenIds(m);
    if (yes) allTokenIds.push(yes);
    if (no)  allTokenIds.push(no);
  }
  await Promise.allSettled(
    allTokenIds.map(async (tid) => {
      try {
        const r = await fetch(`${CLOB_API}/midpoint?token_id=${tid}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) return;
        const d = await r.json() as any;
        const mid = parseFloat(d.mid || 0);
        if (Number.isFinite(mid) && mid > 0) mids.set(tid, mid);
      } catch {}
    })
  );
  return mids;
}

// ─── Locked profit számítás ───────────────────────────────────────────────────
function lockedProfitAnalysis(yesPrice: number, noPrice: number) {
  const gross  = yesPrice + noPrice;
  // Fee: konzervatív taker fee mindkét oldalon
  const feeEach   = POLYMARKET_FEE * (yesPrice + noPrice) / 2;
  const totalFee  = feeEach * 2;
  const net       = 1.0 - gross - totalFee; // lejáratkor $1 jár
  const hasEdge   = net > 0;

  return {
    yes_price:    yesPrice,
    no_price:     noPrice,
    gross_cost:   gross,
    estimated_fee: totalFee,
    net_profit:   net,
    net_pct:      net * 100,
    has_edge:     hasEdge,
    signal:       net > 0.03 ? "STRONG_EDGE" : net > 0 ? "MARGINAL_EDGE" : "NO_EDGE",
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    // Cache
    const store  = getStore("vol-divergence-cache-v3");
    const cKey   = "vol_div_btc";
    let cached: any = null; try { cached = store ? await store.getWithMetadata(cKey) : null; } catch {}
    if (cached?.metadata) {
      const age = Date.now() - ((cached.metadata as any).ts || 0);
      if (age < CACHE_TTL) {
        return new Response(cached.data as string, {
          status: 200, headers: { ...CORS, "X-Cache": "HIT" },
        });
      }
    }

    // Párhuzamos lekérések
    const [klines30, klines15, klines5, btcMarkets] = await Promise.all([
      fetchBinanceKlines("BTCUSDT", "1m", 30),  // utolsó 30 perc
      fetchBinanceKlines("BTCUSDT", "1m", 15),  // utolsó 15 perc
      fetchBinanceKlines("BTCUSDT", "1m", 5),   // utolsó 5 perc
      fetchBTCMarkets(),
    ]);

    // Realized vol különböző ablakokra
    const closes30 = klines30.map((k: any[]) => parseFloat(k[4]));
    const closes15 = klines15.map((k: any[]) => parseFloat(k[4]));
    const closes5  = klines5.map((k: any[])  => parseFloat(k[4]));
    const currentPrice = closes30[closes30.length - 1];

    const rv30 = realizedVol(closes30, 365 * 24 * 60); // 1m periódusok évente
    const rv15 = realizedVol(closes15, 365 * 24 * 60);
    const rv5  = realizedVol(closes5,  365 * 24 * 60);

    // Polymarket implied vol + locked profit
    const mids = btcMarkets.length > 0 ? await fetchMidpoints(btcMarkets) : new Map();

    const markets = btcMarkets.map((m: any) => {
      // Use the same clobTokenIds-first extractor as fetchMidpoints. If CLOB
      // midpoint is missing, fall back to Gamma's stored `outcomePrices`.
      const ids = extractTokenIds(m);
      const yesMid = ids.yes ? mids.get(ids.yes) : undefined;
      const noMid  = ids.no  ? mids.get(ids.no)  : undefined;

      let storedYes = 0.5, storedNo = 0.5;
      try {
        const op = typeof m.outcomePrices === "string"
          ? JSON.parse(m.outcomePrices)
          : m.outcomePrices;
        if (Array.isArray(op) && op.length >= 2) {
          storedYes = parseFloat(op[0]);
          storedNo  = parseFloat(op[1]);
        }
      } catch {}

      const yesPrice = Number.isFinite(yesMid as number) ? (yesMid as number) : storedYes;
      const noPrice  = Number.isFinite(noMid  as number) ? (noMid  as number) : storedNo;

      // Remaining time estimation. A felső korlát 48h — a fetchBTCMarkets
      // már szűri a hosszabb piacokat. Ha a remaining nem értelmezhető,
      // marad a 15-perces default (a tool elsődleges célpontja).
      const endDate = m.endDate || m.end_date_iso || "";
      let timeRemainingHours = 15 / 60; // default: 15 perc
      if (endDate) {
        const remaining = (new Date(endDate).getTime() - Date.now()) / 1000 / 3600;
        if (remaining > 0 && remaining <= 48) timeRemainingHours = remaining;
      }

      const iv = impliedVolFromBinaryPrice(yesPrice, timeRemainingHours);
      const lp = lockedProfitAnalysis(yesPrice, noPrice);

      return {
        question:           m.question || "N/A",
        slug:               m.slug || "",
        yes_price:          yesPrice,
        no_price:           noPrice,
        implied_vol:        iv,
        time_remaining_h:   timeRemainingHours,
        locked_profit:      lp,
        url: m.slug ? `https://polymarket.com/event/${m.slug}` : "https://polymarket.com",
      };
    });

    // Vol spread összefoglaló
    const avgIV = markets.length > 0
      ? markets.reduce((s, m) => s + m.implied_vol, 0) / markets.length
      : rv30; // ha nincs PM adat, az RV a referencia

    const volSpread30 = avgIV - rv30;
    const volSpread15 = avgIV - rv15;

    // Kereskedési ajánlás
    const edgeMarkets = markets.filter(m => m.locked_profit.has_edge);
    const signal =
      edgeMarkets.length > 0            ? "LOCKED_PROFIT_AVAILABLE" :
      volSpread15 > 0.5                  ? "HIGH_VOL_PREMIUM – consider selling both sides" :
      volSpread15 > 0.2                  ? "MODERATE_PREMIUM – elevated implied vol" :
      volSpread15 < -0.2                 ? "VOL_DISCOUNT – realized > implied, unusual" :
                                           "NORMAL – no significant divergence";

    const payload = JSON.stringify({
      ok: true,
      fetched_at: new Date().toISOString(),
      btc_price: currentPrice,

      realized_vol: {
        rv_5m:  parseFloat((rv5  * 100).toFixed(2)),
        rv_15m: parseFloat((rv15 * 100).toFixed(2)),
        rv_30m: parseFloat((rv30 * 100).toFixed(2)),
        unit:   "annualized %",
        note:   "Close-to-close log return vol from Binance 1m klines",
      },

      implied_vol: {
        avg_iv:  parseFloat((avgIV * 100).toFixed(2)),
        unit:    "annualized % (naïv binary approximation)",
        markets: markets.length,
      },

      vol_spread: {
        spread_30m:  parseFloat((volSpread30 * 100).toFixed(2)),
        spread_15m:  parseFloat((volSpread15 * 100).toFixed(2)),
        signal,
        interpretation:
          volSpread15 > 0.5 ? "Piac túláraz félelmet – a contracts overpriced" :
          volSpread15 > 0   ? "Enyhe vol prémium – normál" :
          volSpread15 < 0   ? "Realized > Implied – ritkán fordul elő" :
          "Kiegyensúlyozott vol",
      },

      polymarket_btc_markets: markets,

      edge_summary: {
        locked_profit_count: edgeMarkets.length,
        best_net_profit:     edgeMarkets.length > 0
          ? Math.max(...edgeMarkets.map(m => m.locked_profit.net_profit))
          : 0,
        fee_note: `Becsült taker fee: ${(POLYMARKET_FEE * 100).toFixed(0)}%/oldal`,
      },
    });

    try { if (store) await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}

    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502, headers: CORS,
    });
  }
}
