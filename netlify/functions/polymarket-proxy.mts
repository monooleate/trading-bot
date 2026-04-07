// netlify/functions/polymarket-proxy.mts
// GET /.netlify/functions/polymarket-proxy?limit=30
// Lekéri az aktív Polymarket piacokat a Gamma API-ról és visszaadja a frontendnek.
// CORS probléma megkerülése: a böngésző nem tud közvetlenül hívni, a szerver igen.

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CACHE_KEY = "markets_cache";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 óra

export default async function handler(req: Request, context: Context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const limit  = url.searchParams.get("limit")  || "30";
  const forceRefresh = url.searchParams.get("refresh") === "1";

  try {
    // ── 1. Cache ellenőrzés (Netlify Blobs) ──────────────────────────────
    let store: any = null;
    try { store = getStore("polymarket-cache"); } catch {}

    if (!forceRefresh) {
      let cached: any = null; try { cached = store ? await store.getWithMetadata(CACHE_KEY) : null; } catch {}
      if (cached?.metadata) {
        const meta = cached.metadata as { ts: number };
        const age  = Date.now() - (meta.ts || 0);
        if (age < CACHE_TTL_MS) {
          return new Response(cached.data as string, {
            status: 200,
            headers: { ...corsHeaders, "X-Cache": "HIT", "X-Cache-Age": String(Math.round(age / 1000)) + "s" },
          });
        }
      }
    }

    // ── 2. Friss adat a Gamma API-ról ─────────────────────────────────────
    const apiUrl = `${GAMMA_API}/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`;
    const res = await fetch(apiUrl, {
      headers: { "Accept": "application/json", "User-Agent": "EdgeCalc/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Gamma API error: ${res.status}`);
    }

    const raw = await res.json() as any;
    const list: any[] = Array.isArray(raw) ? raw : (raw.markets || raw.data || []);

    // ── 3. Feldolgozás ────────────────────────────────────────────────────
    const markets = list
      .filter((m: any) => parseFloat(m.volume24hr || 0) > 5000)
      .slice(0, parseInt(limit))
      .map((m: any) => {
        let yp = 0.5, np = 0.5;
        try {
          const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          if (Array.isArray(op) && op.length >= 2) { yp = parseFloat(op[0]); np = parseFloat(op[1]); }
        } catch {}
        const cat = (() => {
          if (!Array.isArray(m.tags) || !m.tags[0]) return "egyéb";
          return (typeof m.tags[0] === "object" ? m.tags[0].label : m.tags[0] || "egyéb").toLowerCase();
        })();
        return {
          question:   m.question || m.title || "N/A",
          slug:       m.slug || "",
          category:   cat,
          yes_price:  Math.round(yp * 10000) / 10000,
          no_price:   Math.round(np * 10000) / 10000,
          volume_24h: parseFloat(m.volume24hr || 0),
          liquidity:  parseFloat(m.liquidityNum || m.liquidity || 0),
          end_date:   m.endDate || "",
          signal_note: yp < 0.1 ? "⚠ Nagyon alacsony ár" : yp > 0.9 ? "⚠ Nagyon magas ár" : "Közel 50/50 – saját kutatás kell",
          url: m.slug ? `https://polymarket.com/event/${m.slug}` : "https://polymarket.com",
        };
      });

    const payload = JSON.stringify({
      ok: true,
      fetched_at: new Date().toISOString(),
      market_count: markets.length,
      markets,
    });

    // ── 4. Cache mentés ───────────────────────────────────────────────────
    try { if (store) await store.set(CACHE_KEY, payload, { metadata: { ts: Date.now() } }); } catch {}

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
