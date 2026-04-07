// netlify/functions/polymarket-trade.mts
// GET  /.netlify/functions/polymarket-trade?action=positions
// GET  /.netlify/functions/polymarket-trade?action=balance
// POST /.netlify/functions/polymarket-trade  { action:"order", tokenId, side, amount, price }
//
// Env vars:
//   POLYMARKET_PRIVATE_KEY   – Polygon wallet private key (0x...)
//   POLYMARKET_PROXY_ADDRESS – Proxy/funder address (Polymarket dashboardon látható)
//
// FIGYELEM: A private key NAGYON érzékeny adat.
// Soha ne commitold, csak Netlify environment variable-ként add meg.
// Ajánlott: dedikált hot wallet kis összegekkel.

import type { Context } from "@netlify/functions";
import { checkAuth } from "./_auth-guard";
import { createHash, createHmac } from "crypto";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const CLOB_HOST  = "https://clob.polymarket.com";
const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CHAIN_ID   = 137; // Polygon mainnet

// ── Egyszerű API credentials lekérés (L1 auth) ───────────────────────────────
// Polymarket L1: csak GET kérésekhez, nem kell aláírás
// Polymarket L2: order leadáshoz ECDSA aláírás kell
// → Mivel az ECDSA Polygon aláírás komplex (ethers.js kell),
//   itt read-only endpointokat valósítunk meg teljesen,
//   az order leadást pedig a py-clob-client-re delegáljuk.

async function clobGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs  = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${CLOB_HOST}${path}${qs}`, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`CLOB ${res.status}: ${path}`);
  return res.json();
}

async function gammaGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs  = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${GAMMA_HOST}${path}${qs}`, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Gamma ${res.status}: ${path}`);
  return res.json();
}

export default async function handler(req: Request, ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const auth = await checkAuth(req);
  if (!auth.ok) return auth.error;

  const url    = new URL(req.url);
  const action = req.method === "GET" ? url.searchParams.get("action") : null;

  try {
    // ── GET: top piacok árai ──────────────────────────────────────────
    if (req.method === "GET" && action === "markets") {
      const limit = url.searchParams.get("limit") || "20";
      const data  = await gammaGet("/markets", {
        active: "true", closed: "false",
        limit, order: "volume24hr", ascending: "false",
      });
      const list  = Array.isArray(data) ? data : (data.markets || []);
      const markets = list.slice(0, parseInt(limit)).map((m: any) => {
        let yp = 0.5;
        try {
          const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          if (Array.isArray(op)) yp = parseFloat(op[0]);
        } catch {}
        return {
          question:   m.question,
          slug:       m.slug,
          yes_price:  Math.round(yp * 10000) / 10000,
          no_price:   Math.round((1 - yp) * 10000) / 10000,
          volume_24h: parseFloat(m.volume24hr || 0),
          end_date:   m.endDate,
          tokens:     (m.tokens || []).map((t: any) => ({ outcome: t.outcome, token_id: t.token_id })),
          url: `https://polymarket.com/event/${m.slug}`,
        };
      });
      return new Response(JSON.stringify({ ok: true, markets }), { headers: CORS });
    }

    // ── GET: order book egy tokenre ───────────────────────────────────
    if (req.method === "GET" && action === "orderbook") {
      const tokenId = url.searchParams.get("token_id");
      if (!tokenId) return new Response(JSON.stringify({ ok: false, error: "token_id required" }), { status: 400, headers: CORS });
      const [book, mid] = await Promise.all([
        clobGet("/book", { token_id: tokenId }),
        clobGet("/midpoint", { token_id: tokenId }),
      ]);
      return new Response(JSON.stringify({
        ok: true,
        midpoint:  parseFloat(mid.mid || 0),
        best_bid:  book.bids?.[0]?.price,
        best_ask:  book.asks?.[0]?.price,
        bids:      (book.bids || []).slice(0, 5),
        asks:      (book.asks || []).slice(0, 5),
      }), { headers: CORS });
    }

    // ── POST: order intent (nem valódi order – Python scriptre delegál) ──
    // Valódi Polymarket order leadáshoz az ethers.js ECDSA aláírás kell,
    // ami Netlify Function-ben megvalósítható, de a private key kezelés
    // biztonsági kockázatot jelent szerver oldalon.
    // Ajánlott workflow: ez a function visszaad egy "trade intent"-et,
    // amit a Python script végrehajt lokálisan.
    if (req.method === "POST") {
      const body = await req.json() as any;

      if (body.action === "order_intent") {
        // Visszaad egy előkészített trade intent JSON-t
        // amit a polymarket_trade.py végrehajt
        const intent = {
          token_id:  body.token_id,
          side:      body.side,      // BUY | SELL
          amount:    body.amount,    // USDC összeg
          price:     body.price,     // 0-1 között
          order_type: body.order_type || "GTC",
          created_at: new Date().toISOString(),
        };
        return new Response(JSON.stringify({
          ok: true,
          intent,
          note: "Execute with: python polymarket_trade.py --intent '<json>'",
        }), { headers: CORS });
      }

      return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers: CORS });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
