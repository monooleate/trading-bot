// netlify/functions/bybit-trade.mts
// GET  /.netlify/functions/bybit-trade?action=balance
// GET  /.netlify/functions/bybit-trade?action=positions
// GET  /.netlify/functions/bybit-trade?action=funding&symbol=BTCUSDT
// POST /.netlify/functions/bybit-trade  { action:"order", symbol, side, qty, orderType, price? }
//
// Env vars:
//   BYBIT_API_KEY
//   BYBIT_API_SECRET
//   BYBIT_TESTNET=true|false   (testnet biztonságosabb kezdésnek!)

import type { Context } from "@netlify/functions";
import { checkAuth } from "./_auth-guard";
import { createHmac } from "crypto";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const isTestnet = process.env.BYBIT_TESTNET === "true";
const BASE = isTestnet
  ? "https://api-testnet.bybit.com"
  : "https://api.bybit.com";

// ── Bybit v5 aláírás ──────────────────────────────────────────────────────────
function sign(apiKey: string, secret: string, timestamp: string, recvWindow: string, body: string): string {
  const payload = timestamp + apiKey + recvWindow + body;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function bybitRequest(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string> = {},
  body: object | null = null
): Promise<any> {
  const apiKey    = process.env.BYBIT_API_KEY!;
  const apiSecret = process.env.BYBIT_API_SECRET!;
  if (!apiKey || !apiSecret) throw new Error("BYBIT_API_KEY / BYBIT_API_SECRET missing");

  const timestamp  = Date.now().toString();
  const recvWindow = "5000";

  let url = `${BASE}${path}`;
  let bodyStr = "";

  if (method === "GET" && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(params).toString();
    bodyStr = qs;
    url += "?" + qs;
  } else if (method === "POST" && body) {
    bodyStr = JSON.stringify(body);
  }

  const signature = sign(apiKey, apiSecret, timestamp, recvWindow, bodyStr);

  const headers: Record<string, string> = {
    "X-BAPI-API-KEY":     apiKey,
    "X-BAPI-SIGN":        signature,
    "X-BAPI-TIMESTAMP":   timestamp,
    "X-BAPI-RECV-WINDOW": recvWindow,
    "Content-Type":       "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: method === "POST" ? bodyStr : undefined,
    signal: AbortSignal.timeout(8000),
  });

  const data = await res.json() as any;
  if (data.retCode !== 0) throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  return data.result;
}

export default async function handler(req: Request, ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (!process.env.BYBIT_API_KEY) {
    return new Response(JSON.stringify({
      ok: false,
      error: "BYBIT API key not configured",
      hint: "Add BYBIT_API_KEY to Netlify env vars"
    }), { status: 200, headers: CORS });
  }

  // ── Auth ellenőrzés ───────────────────────────────────────────────────
  const auth = await checkAuth(req);
  if (!auth.ok) return auth.error;

  const url    = new URL(req.url);
  const action = req.method === "GET" ? url.searchParams.get("action") : null;

  try {
    // ── GET: egyenleg ─────────────────────────────────────────────────
    if (req.method === "GET" && action === "balance") {
      const result = await bybitRequest("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });
      const coins  = result?.list?.[0]?.coin || [];
      const balances = coins
        .filter((c: any) => parseFloat(c.walletBalance) > 0)
        .map((c: any) => ({
          coin:           c.coin,
          wallet_balance: parseFloat(c.walletBalance),
          available:      parseFloat(c.availableToWithdraw || c.availableToBorrow || 0),
          usd_value:      parseFloat(c.usdValue || 0),
        }));
      return new Response(JSON.stringify({ ok: true, balances, testnet: isTestnet }), { headers: CORS });
    }

    // ── GET: nyitott pozíciók ─────────────────────────────────────────
    if (req.method === "GET" && action === "positions") {
      const symbol = url.searchParams.get("symbol") || "";
      const params: Record<string, string> = { category: "linear", settleCoin: "USDT" };
      if (symbol) params.symbol = symbol;
      const result   = await bybitRequest("GET", "/v5/position/list", params);
      const positions = (result?.list || [])
        .filter((p: any) => parseFloat(p.size) > 0)
        .map((p: any) => ({
          symbol:       p.symbol,
          side:         p.side,
          size:         parseFloat(p.size),
          entry_price:  parseFloat(p.avgPrice),
          mark_price:   parseFloat(p.markPrice),
          unrealised_pnl: parseFloat(p.unrealisedPnl),
          leverage:     parseFloat(p.leverage),
        }));
      return new Response(JSON.stringify({ ok: true, positions, testnet: isTestnet }), { headers: CORS });
    }

    // ── GET: funding rate ─────────────────────────────────────────────
    if (req.method === "GET" && action === "funding") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const result = await bybitRequest("GET", "/v5/market/funding/history", { category: "linear", symbol, limit: "1" });
      const latest = result?.list?.[0];
      return new Response(JSON.stringify({
        ok: true,
        symbol,
        funding_rate: parseFloat(latest?.fundingRate || 0) * 100,
        funding_rate_timestamp: latest?.fundingRateTimestamp,
        testnet: isTestnet,
      }), { headers: CORS });
    }

    // ── POST: order leadás ────────────────────────────────────────────
    if (req.method === "POST") {
      const body = await req.json() as any;
      if (body.action !== "order") {
        return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers: CORS });
      }

      const { symbol, side, qty, orderType, price } = body;
      if (!symbol || !side || !qty || !orderType) {
        return new Response(JSON.stringify({ ok: false, error: "symbol, side, qty, orderType required" }), { status: 400, headers: CORS });
      }

      const orderBody: Record<string, any> = {
        category:  "linear",
        symbol,
        side,           // Buy | Sell
        orderType,      // Market | Limit
        qty:   String(qty),
        timeInForce: orderType === "Market" ? "IOC" : "GTC",
      };
      if (orderType === "Limit" && price) orderBody.price = String(price);

      const result = await bybitRequest("POST", "/v5/order/create", {}, orderBody);
      return new Response(JSON.stringify({ ok: true, order_id: result.orderId, testnet: isTestnet }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers: CORS });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
