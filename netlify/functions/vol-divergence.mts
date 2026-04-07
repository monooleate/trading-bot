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

// ─── Binance klines lekérés ───────────────────────────────────────────────────
async function fetchBinanceKlines(symbol: string, interval: string, limit: number) {
  const url = `${BINANCE_SPOT}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  return res.json() as Promise<any[][]>;
}

// ─── Polymarket BTC 15m kontraktok keresése ───────────────────────────────────
async function fetchBTCMarkets() {
  // Gamma API search BTC 15m markets
  const params = new URLSearchParams({
    active: "true", closed: "false",
    limit: "30", order: "volume24hr", ascending: "false",
    tag_slug: "crypto",
  });
  const res = await fetch(`${GAMMA_API}/markets?${params}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  const data = await res.json() as any;
  const list: any[] = Array.isArray(data) ? data : (data.markets || []);

  // Szűrés: BTC UP/DOWN kontraktok (15 perc)
  return list.filter((m: any) => {
    const q = (m.question || m.title || "").toLowerCase();
    return (q.includes("btc") || q.includes("bitcoin")) &&
           (q.includes("15") || q.includes("up") || q.includes("down"));
  }).slice(0, 6);
}

// ─── CLOB midpoint lekérés ────────────────────────────────────────────────────
async function fetchMidpoints(markets: any[]): Promise<Map<string, number>> {
  const mids = new Map<string, number>();
  await Promise.allSettled(
    markets.flatMap((m: any) =>
      (m.tokens || []).map(async (t: any) => {
        const tid = t.token_id || t.tokenId;
        if (!tid) return;
        try {
          const r = await fetch(`${CLOB_API}/midpoint?token_id=${tid}`, {
            signal: AbortSignal.timeout(4000),
          });
          const d = await r.json() as any;
          mids.set(tid, parseFloat(d.mid || 0));
        } catch {}
      })
    )
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
    const store  = getStore("vol-divergence-cache");
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
      const tokens = (m.tokens || []).map((t: any) => {
        const tid = t.token_id || t.tokenId;
        return { outcome: t.outcome, token_id: tid, mid: mids.get(tid) ?? 0 };
      });

      const yes = tokens.find((t: any) => t.outcome?.toUpperCase() === "YES" || t.outcome?.toUpperCase() === "UP");
      const no  = tokens.find((t: any) => t.outcome?.toUpperCase() === "NO"  || t.outcome?.toUpperCase() === "DOWN");

      const yesPrice = yes?.mid ?? 0.5;
      const noPrice  = no?.mid  ?? 0.5;

      // Remaining time estimation (15m kontraktnál max 15 perc van hátra)
      const endDate = m.endDate || m.end_date_iso || "";
      let timeRemainingHours = 15 / 60; // default: 15 perc
      if (endDate) {
        const remaining = (new Date(endDate).getTime() - Date.now()) / 1000 / 3600;
        if (remaining > 0 && remaining < 1) timeRemainingHours = remaining;
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
