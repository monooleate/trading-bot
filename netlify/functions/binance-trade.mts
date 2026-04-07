// netlify/functions/binance-trade.mts
// GET  /.netlify/functions/binance-trade?action=balance
// GET  /.netlify/functions/binance-trade?action=positions
// GET  /.netlify/functions/binance-trade?action=funding&symbol=BTCUSDT
// POST /.netlify/functions/binance-trade  { action:"order", symbol, side, type, quantity, price? }
//
// Env vars:
//   BINANCE_API_KEY
//   BINANCE_API_SECRET
//   BINANCE_TESTNET=true|false

import type { Context } from "@netlify/functions";
import { checkAuth } from "./_auth-guard";
import { createHmac } from "crypto";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const isTestnet = process.env.BINANCE_TESTNET === "true";
const BASE = isTestnet
  ? "https://testnet.binancefuture.com"
  : "https://fapi.binance.com";

function sign(secret: string, queryString: string): string {
  return createHmac("sha256", secret).update(queryString).digest("hex");
}

async function binanceRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string> = {}
): Promise<any> {
  const apiKey    = process.env.BINANCE_API_KEY!;
  const apiSecret = process.env.BINANCE_API_SECRET!;
  if (!apiKey || !apiSecret) throw new Error("BINANCE_API_KEY / BINANCE_API_SECRET missing");

  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const qs        = new URLSearchParams(allParams).toString();
  const signature = sign(apiSecret, qs);
  const fullQs    = `${qs}&signature=${signature}`;

  const url = method === "GET" || method === "DELETE"
    ? `${BASE}${path}?${fullQs}`
    : `${BASE}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? fullQs : undefined,
    signal: AbortSignal.timeout(8000),
  });

  const data = await res.json() as any;
  if (data.code && data.code < 0) throw new Error(`Binance error ${data.code}: ${data.msg}`);
  return data;
}

export default async function handler(req: Request, ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const auth = await checkAuth(req);
  if (!auth.ok) return auth.error;

  const url    = new URL(req.url);
  const action = req.method === "GET" ? url.searchParams.get("action") : null;

  try {
    // ── GET: egyenleg ─────────────────────────────────────────────────
    if (req.method === "GET" && action === "balance") {
      const data = await binanceRequest("GET", "/fapi/v2/balance");
      const balances = (Array.isArray(data) ? data : [])
        .filter((b: any) => parseFloat(b.balance) > 0)
        .map((b: any) => ({
          coin:             b.asset,
          wallet_balance:   parseFloat(b.balance),
          available:        parseFloat(b.availableBalance),
          unrealised_pnl:   parseFloat(b.crossUnPnl || 0),
        }));
      return new Response(JSON.stringify({ ok: true, balances, testnet: isTestnet }), { headers: CORS });
    }

    // ── GET: pozíciók ─────────────────────────────────────────────────
    if (req.method === "GET" && action === "positions") {
      const symbol = url.searchParams.get("symbol") || "";
      const params: Record<string, string> = {};
      if (symbol) params.symbol = symbol;
      const data = await binanceRequest("GET", "/fapi/v2/positionRisk", params);
      const positions = (Array.isArray(data) ? data : [])
        .filter((p: any) => parseFloat(p.positionAmt) !== 0)
        .map((p: any) => ({
          symbol:           p.symbol,
          side:             parseFloat(p.positionAmt) > 0 ? "Long" : "Short",
          size:             Math.abs(parseFloat(p.positionAmt)),
          entry_price:      parseFloat(p.entryPrice),
          mark_price:       parseFloat(p.markPrice),
          unrealised_pnl:   parseFloat(p.unRealizedProfit),
          leverage:         parseFloat(p.leverage),
        }));
      return new Response(JSON.stringify({ ok: true, positions, testnet: isTestnet }), { headers: CORS });
    }

    // ── GET: funding rate ─────────────────────────────────────────────
    if (req.method === "GET" && action === "funding") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const data   = await binanceRequest("GET", "/fapi/v1/premiumIndex", { symbol });
      const item   = Array.isArray(data) ? data[0] : data;
      return new Response(JSON.stringify({
        ok: true,
        symbol: item.symbol,
        funding_rate:           parseFloat(item.lastFundingRate || 0) * 100,
        mark_price:             parseFloat(item.markPrice),
        next_funding_time:      item.nextFundingTime,
        testnet: isTestnet,
      }), { headers: CORS });
    }

    // ── POST: order leadás ────────────────────────────────────────────
    if (req.method === "POST") {
      const body = await req.json() as any;
      if (body.action !== "order") {
        return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers: CORS });
      }

      const { symbol, side, type, quantity, price, reduceOnly } = body;
      if (!symbol || !side || !type || !quantity) {
        return new Response(JSON.stringify({ ok: false, error: "symbol, side, type, quantity required" }), { status: 400, headers: CORS });
      }

      const params: Record<string, string> = {
        symbol,
        side:           side.toUpperCase(),   // BUY | SELL
        type:           type.toUpperCase(),   // MARKET | LIMIT
        quantity:       String(quantity),
      };
      if (type.toUpperCase() === "LIMIT" && price) {
        params.price       = String(price);
        params.timeInForce = "GTC";
      }
      if (reduceOnly) params.reduceOnly = "true";

      const result = await binanceRequest("POST", "/fapi/v1/order", params);
      return new Response(JSON.stringify({ ok: true, order_id: result.orderId, status: result.status, testnet: isTestnet }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers: CORS });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
