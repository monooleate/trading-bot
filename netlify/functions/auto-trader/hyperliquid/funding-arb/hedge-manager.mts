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

// ─── Binance LOT_SIZE precision cache ──────────────────────────────────────
//
// Per the Spot REST docs, every symbol carries a `LOT_SIZE` filter inside
// `exchangeInfo.symbols[X].filters`. The `stepSize` is the smallest size
// increment the matching engine accepts; submitting a `quantity` with more
// precision than that is rejected with `-1013 Filter failure: LOT_SIZE`.
//
// Without this, the previous `quantity = sizeCoins.toFixed(5)` worked for
// BTC (stepSize 0.00001) and ETH (0.0001) but rejected SELL orders for
// SOL/AVAX (0.01) and DOGE (1) on amounts the toFixed widened past the
// step. The cache is a 6h TTL — exchangeInfo is multi-MB and stable, so
// re-fetching every cron tick would waste bandwidth.
interface LotSizeRule {
  stepSize:    number;
  minQty:      number;
  fetchedAt:   number;
}
const LOT_SIZE_TTL_MS = 6 * 60 * 60 * 1000;
let lotSizeCache: Map<string, LotSizeRule> = new Map();
let lotSizeCacheFetchedAt = 0;

async function ensureLotSizeCache(): Promise<void> {
  const now = Date.now();
  if (now - lotSizeCacheFetchedAt < LOT_SIZE_TTL_MS && lotSizeCache.size > 0) return;
  try {
    // Filter to just the symbols we trade so the response stays small.
    const symbols = Object.values(BINANCE_SPOT_SYMBOL);
    const param = encodeURIComponent(JSON.stringify(symbols));
    const r = await fetch(
      `https://api.binance.com/api/v3/exchangeInfo?symbols=${param}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return;
    const d = await r.json() as any;
    const fresh = new Map<string, LotSizeRule>();
    for (const s of d?.symbols ?? []) {
      const sym = s?.symbol;
      const ls = (s?.filters ?? []).find((f: any) => f?.filterType === "LOT_SIZE");
      const step = parseFloat(ls?.stepSize ?? "0");
      const min  = parseFloat(ls?.minQty   ?? "0");
      if (typeof sym === "string" && Number.isFinite(step) && step > 0) {
        fresh.set(sym, { stepSize: step, minQty: min, fetchedAt: now });
      }
    }
    if (fresh.size > 0) {
      lotSizeCache = fresh;
      lotSizeCacheFetchedAt = now;
    }
  } catch {
    // Keep whatever we already had (or the empty cache, which falls
    // through to a no-op rounding via lookupLotPrecision).
  }
}

/**
 * Round `qty` DOWN to the symbol's stepSize. Defaults to a 5-decimal toFixed
 * if the cache is empty (covers BTC / ETH safely; cache miss only happens on
 * cold start before exchangeInfo loads, in which case we avoid placing the
 * SELL until the next tick instead of risking a rejection).
 */
function roundToStep(qty: number, sym: string): { quantityStr: string; ok: boolean; reason?: string } {
  const rule = lotSizeCache.get(sym);
  if (!rule) {
    // Defer: we can't safely format without knowing the step. Caller should
    // surface this as a transient error (LOT_SIZE rule unknown, retry next
    // tick after exchangeInfo loads).
    return { quantityStr: "", ok: false, reason: `LOT_SIZE rule unknown for ${sym}` };
  }
  const stepped = Math.floor(qty / rule.stepSize) * rule.stepSize;
  if (stepped < rule.minQty) {
    return { quantityStr: "", ok: false, reason: `qty ${stepped} < minQty ${rule.minQty}` };
  }
  // Express in fixed-point with the step's own decimal count to avoid
  // float-printing round trips (e.g. 0.1+0.2 = "0.30000000000000004").
  const decimals = Math.max(0, -Math.floor(Math.log10(rule.stepSize)));
  return { quantityStr: stepped.toFixed(decimals), ok: true };
}

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

  // Refresh the LOT_SIZE cache before formatting the SELL quantity so
  // pairs with stepSize ≥ 0.01 (SOL/AVAX/DOGE) don't get rejected with
  // -1013 LOT_SIZE. BUY uses quoteOrderQty (USD), so step doesn't apply.
  if (side === "SELL") await ensureLotSizeCache();

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
  if (side === "SELL" && quantity      && quantity      > 0) {
    const r = roundToStep(quantity, sym);
    if (!r.ok) return { ok: false, error: `Binance LOT_SIZE: ${r.reason}` };
    params.quantity = r.quantityStr;
  }

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

// ─── Paper simulator (slippage modelled) ───────────────────────────────────
//
// Live MARKET orders fill at the book's ask (BUY) or bid (SELL). On the
// majors we trade, the typical Binance Spot bid/ask spread is 0.02-0.08%;
// modelling 0.05% adverse paper slippage keeps paper PnL within a few bp
// of what live would book without micro-managing per-coin spreads.
const BINANCE_SPOT_SLIPPAGE = 0.0005;
function paperFill(coin: HlCoin, side: "BUY" | "SELL", markPrice: number, sizeCoins: number): HedgeOrderResult {
  const fillPrice = side === "BUY"
    ? markPrice * (1 + BINANCE_SPOT_SLIPPAGE)   // pay slightly more
    : markPrice * (1 - BINANCE_SPOT_SLIPPAGE);  // receive slightly less
  return {
    ok:         true,
    orderId:    `paper-binance-${Date.now()}-${coin}`,
    entryPrice: fillPrice,
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
