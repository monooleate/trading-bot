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
    try { store = getStore("polymarket-cache-v3"); } catch {}

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

    // ── 2. Events API → helyes event slug + market slugs + tokens ───────
    const eventsUrl = `${GAMMA_API}/events?limit=${limit}&order=volume24hr&ascending=false&active=true`;
    const res = await fetch(eventsUrl, {
      headers: { "Accept": "application/json", "User-Agent": "EdgeCalc/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);

    const events: any[] = await res.json().then(d => Array.isArray(d) ? d : []);

    // ── 3. Flatten events → markets with correct URLs ────────────────────
    const markets: any[] = [];
    for (const evt of events) {
      const eventSlug = evt.slug || "";
      for (const m of (evt.markets || [])) {
        // Skip closed/expired markets
        if (m.closed === true) continue;
        if (m.endDate) {
          const end = new Date(m.endDate).getTime();
          if (end < Date.now()) continue;
        }
        const vol = parseFloat(m.volume24hr || m.volume || 0);
        if (vol < 5000) continue;

        let yp = 0.5, np = 0.5;
        try {
          const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          if (Array.isArray(op) && op.length >= 2) { yp = parseFloat(op[0]); np = parseFloat(op[1]); }
        } catch {}

        const cat = (() => {
          const tags = evt.tags || m.tags || [];
          if (!Array.isArray(tags) || !tags[0]) return "egyéb";
          return (typeof tags[0] === "object" ? tags[0].label : tags[0] || "egyéb").toLowerCase();
        })();

        // Parse clobTokenIds for CLOB order book
        let tokens: { outcome: string; token_id: string }[] = [];
        try {
          if (m.tokens && Array.isArray(m.tokens) && m.tokens.length > 0) {
            tokens = m.tokens.map((t: any) => ({ outcome: t.outcome || "", token_id: t.token_id || "" }));
          } else if (m.clobTokenIds) {
            const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
            if (Array.isArray(ids) && ids.length >= 2) {
              tokens = [{ outcome: "YES", token_id: ids[0] }, { outcome: "NO", token_id: ids[1] }];
            }
          }
        } catch {}

        const marketSlug = m.slug || "";
        // Correct URL: /event/{eventSlug}/{marketSlug}
        const url = eventSlug && marketSlug
          ? `https://polymarket.com/event/${eventSlug}/${marketSlug}`
          : eventSlug
            ? `https://polymarket.com/event/${eventSlug}`
            : "https://polymarket.com";

        markets.push({
          question:    m.question || m.title || evt.title || "N/A",
          slug:        marketSlug,
          event_slug:  eventSlug,
          category:    cat,
          yes_price:   Math.round(yp * 10000) / 10000,
          no_price:    Math.round(np * 10000) / 10000,
          volume_24h:  vol,
          liquidity:   parseFloat(m.liquidityNum || m.liquidity || 0),
          end_date:    m.endDate || "",
          tokens,
          signal_note: yp < 0.1 ? "⚠ Nagyon alacsony ár" : yp > 0.9 ? "⚠ Nagyon magas ár" : "Közel 50/50 – saját kutatás kell",
          url,
        });
      }
    }

    // Sort by volume and take top N
    markets.sort((a, b) => b.volume_24h - a.volume_24h);
    markets.splice(parseInt(limit));

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
