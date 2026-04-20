// netlify/functions/auto-trader/hyperliquid/funding-arb/hedge-manager.mts
// Binance spot adapter for the hedge leg.
// Paper mode: pure simulation. Live mode: HMAC-signed REST calls.
//
// Security: only SPOT trading permissions required on the Binance API key —
// never enable futures or withdrawal. Keys come from env, never from code.

import type { HlCoin } from "../types.mts";

export interface HedgeOrderResult {
  ok:         boolean;
  orderId?:   string;
  entryPrice?: number;
  filledQty?: number;
  error?:     string;
}

const BINANCE_SPOT_SYMBOL: Record<HlCoin, string> = {
  BTC:  "BTCUSDT",
  ETH:  "ETHUSDT",
  SOL:  "SOLUSDT",
  XRP:  "XRPUSDT",
  DOGE: "DOGEUSDT",
  AVAX: "AVAXUSDT",
};

async function binanceSign(params: Record<string, string>): Promise<string> {
  const secret = process.env.BINANCE_API_SECRET || "";
  if (!secret) throw new Error("BINANCE_API_SECRET not set");
  const qs = new URLSearchParams(params).toString();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(qs));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function binanceSpotMarket(
  coin: HlCoin,
  side: "BUY" | "SELL",
  quoteOrderQty?: number,   // dollar amount (for BUY)
  quantity?: number,         // coin amount     (for SELL)
): Promise<HedgeOrderResult> {
  const apiKey = process.env.BINANCE_API_KEY;
  if (!apiKey) return { ok: false, error: "BINANCE_API_KEY not set" };

  const sym = BINANCE_SPOT_SYMBOL[coin];
  if (!sym) return { ok: false, error: `No Binance symbol for ${coin}` };

  const params: Record<string, string> = {
    symbol:    sym,
    side,
    type:      "MARKET",
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  };
  if (side === "BUY"  && quoteOrderQty) params.quoteOrderQty = quoteOrderQty.toFixed(2);
  if (side === "SELL" && quantity)       params.quantity      = quantity.toFixed(5);

  try {
    const signature = await binanceSign(params);
    const body = new URLSearchParams({ ...params, signature }).toString();
    const res = await fetch("https://api.binance.com/api/v3/order", {
      method:  "POST",
      headers: {
        "X-MBX-APIKEY": apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal:  AbortSignal.timeout(8000),
    });
    const data = await res.json() as any;
    if (!res.ok) return { ok: false, error: data?.msg || `HTTP ${res.status}` };

    const orderId   = String(data.orderId || "");
    const fills     = Array.isArray(data.fills) ? data.fills : [];
    const avgPrice  = fills.length > 0
      ? fills.reduce((s: number, f: any) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
        fills.reduce((s: number, f: any) => s + parseFloat(f.qty), 0)
      : parseFloat(data.price || "0");
    const qty       = parseFloat(data.executedQty || "0");

    return { ok: true, orderId, entryPrice: avgPrice, filledQty: qty };
  } catch (err: any) {
    return { ok: false, error: err?.message || "binance fetch failed" };
  }
}

// ─── Paper simulator (no external call) ────────────────────────────────────
function paperFill(coin: HlCoin, side: "BUY" | "SELL", markPrice: number, sizeCoins: number): HedgeOrderResult {
  return {
    ok:         true,
    orderId:    `paper-binance-${Date.now()}-${coin}`,
    entryPrice: markPrice,
    filledQty:  sizeCoins,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────
export async function binanceSpotBuy(
  coin: HlCoin,
  usdcAmount: number,
  markPrice: number,
  paperMode: boolean,
): Promise<HedgeOrderResult> {
  if (paperMode) return paperFill(coin, "BUY", markPrice, usdcAmount / markPrice);
  return binanceSpotMarket(coin, "BUY", usdcAmount);
}

export async function binanceSpotSell(
  coin: HlCoin,
  sizeCoins: number,
  markPrice: number,
  paperMode: boolean,
): Promise<HedgeOrderResult> {
  if (paperMode) return paperFill(coin, "SELL", markPrice, sizeCoins);
  return binanceSpotMarket(coin, "SELL", undefined, sizeCoins);
}
