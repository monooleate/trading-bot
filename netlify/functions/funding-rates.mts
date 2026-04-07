// netlify/functions/funding-rates.mts
// GET /.netlify/functions/funding-rates
// Lekéri a top crypto párok funding rate adatait a Binance Futures API-ról.

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const BINANCE_FAPI = "https://fapi.binance.com";
const CACHE_KEY    = "funding_cache";
const CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8 óra (funding rate periódus)

// Top párok amiket figyelünk
const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT",
  "ARBUSDT", "AVAXUSDT", "DOGEUSDT", "LINKUSDT",
];

export default async function handler(req: Request, context: Context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // ── Cache ─────────────────────────────────────────────────────────────
    const store = getStore("funding-cache");
    let cached: any = null; try { cached = await store.getWithMetadata(CACHE_KEY); } catch {}
    if (cached?.metadata) {
      const age = Date.now() - ((cached.metadata as any).ts || 0);
      if (age < CACHE_TTL_MS) {
        return new Response(cached.data as string, {
          status: 200,
          headers: { ...corsHeaders, "X-Cache": "HIT" },
        });
      }
    }

    // ── Binance premiumIndex endpoint (funding rate + mark price) ─────────
    const results = await Promise.allSettled(
      SYMBOLS.map(s =>
        fetch(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${s}`, {
          signal: AbortSignal.timeout(5000),
        }).then(r => r.json())
      )
    );

    const pairs = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map(r => r.value)
      .filter(d => d.symbol)
      .map(d => {
        const fr = parseFloat(d.lastFundingRate || 0) * 100; // % formátum
        const markPrice = parseFloat(d.markPrice || 0);
        const annual = fr * 3 * 365; // 3 funding/nap * 365 nap
        return {
          symbol:       d.symbol.replace("USDT", "/USDT"),
          mark_price:   markPrice,
          funding_rate: Math.round(fr * 10000) / 10000,
          funding_rate_annual_pct: Math.round(annual * 100) / 100,
          interval_hours: 8,
          next_funding_time: d.nextFundingTime,
          quality: Math.abs(fr) > 0.03 ? "strong" : Math.abs(fr) > 0.01 ? "weak" : "skip",
          direction: fr > 0 ? "Long spot / Short futures" : "Short spot / Long futures",
        };
      })
      .sort((a, b) => Math.abs(b.funding_rate) - Math.abs(a.funding_rate));

    const payload = JSON.stringify({
      ok: true,
      fetched_at: new Date().toISOString(),
      pairs,
    });

    await store.set(CACHE_KEY, payload, { metadata: { ts: Date.now() } });

    return new Response(payload, {
      status: 200,
      headers: { ...corsHeaders, "X-Cache": "MISS" },
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502,
      headers: corsHeaders,
    });
  }
}
