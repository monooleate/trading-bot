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

// Per the Binance Spot REST docs (POST /api/v3/order, type=MARKET) the
// response contains:
//   { orderId, executedQty, cummulativeQuoteQty, fills: [{price, qty, ...}] }
// `data.price` is always "0.00000000" for MARKET orders, so we MUST use the
// fills array (or cummulativeQuoteQty / executedQty) to compute the true
// average price. The previous version fell through to `data.price` and
// stored 0 as the entryPrice, which then propagated into the closed-trade
// summary as a meaningless mark.
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
  // newOrderRespType=FULL guarantees the `fills` array is populated; the
  // default for MARKET is also FULL but stating it explicitly removes any
  // ambiguity if Binance ever changes the default.
  params.newOrderRespType = "FULL";
  if (side === "BUY"  && quoteOrderQty && quoteOrderQty > 0) params.quoteOrderQty = quoteOrderQty.toFixed(2);
  if (side === "SELL" && quantity      && quantity      > 0) params.quantity      = quantity.toFixed(5);

  // One of quoteOrderQty / quantity MUST be present per the docs.
  if (!params.quoteOrderQty && !params.quantity) {
    return { ok: false, error: "binance order requires quoteOrderQty (BUY) or quantity (SELL)" };
  }

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
    if (!res.ok) {
      // Binance error envelope: { code: -1234, msg: "..." }
      return { ok: false, error: data?.msg || `Binance HTTP ${res.status}` };
    }

    const orderId  = String(data.orderId || "");
    const execQty  = parseFloat(data.executedQty || "0");
    const cumQuote = parseFloat(data.cummulativeQuoteQty || "0");
    const fills    = Array.isArray(data.fills) ? data.fills : [];

    let avgPrice = 0;
    if (fills.length > 0) {
      let qSum = 0, qPrSum = 0;
      for (const f of fills) {
        const px = parseFloat(f?.price ?? "0");
        const q  = parseFloat(f?.qty   ?? "0");
        if (Number.isFinite(px) && Number.isFinite(q) && q > 0) {
          qPrSum += px * q;
          qSum   += q;
        }
      }
      if (qSum > 0) avgPrice = qPrSum / qSum;
    }
    // Fallback: cumQuote / execQty (accurate even when fills are empty,
    // which can happen if newOrderRespType ends up as RESULT/ACK instead).
    if (avgPrice === 0 && execQty > 0 && cumQuote > 0) {
      avgPrice = cumQuote / execQty;
    }

    if (execQty <= 0) {
      return { ok: false, error: `Binance order accepted but executedQty=0 (status=${data?.status ?? "?"})` };
    }

    return { ok: true, orderId, entryPrice: avgPrice, filledQty: execQty };
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
