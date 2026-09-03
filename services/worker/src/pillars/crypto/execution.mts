import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPolymarketConfig, CLOB_API } from "../shared/config.mts";
import { log } from "../shared/logger.mts";
import { fetchClobBook } from "../shared/clob-book.mts";
import { simulateDepthFill, fallbackFill, isFillValid } from "@core/fill-model.mts";
import type { MarketInfo, OrderRecord } from "@core/types.mts";

let _client: any = null;

// ─── Depth-aware paper fill options (model-discovery-expansion §4.A / B49 #1) ─
// Passed from the runner (built from the effective TraderConfig). When
// `enabled` is false the paper fill is bit-identical to the legacy full fill.
export interface PaperFillOpts {
  enabled: boolean;
  participationCap: number;
  /** Reject fills below this many shares (market too thin). Default 5. */
  minOrderSizeShares?: number;
  /** Adverse haircut applied to the ref price when no book is available. Default 0.02. */
  fallbackHaircut?: number;
}

// ─── Client initialization ───────────────────────────────

async function getClient(): Promise<any> {
  if (_client) return _client;

  const config = getPolymarketConfig();
  if (!config.privateKey) {
    throw new Error("POLY_PRIVATE_KEY not set");
  }

  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  // Step 1: create temp client to derive API creds
  const tempClient = new ClobClient(
    CLOB_API,
    137,
    walletClient as any,
  );
  const creds = await (tempClient as any).createOrDeriveApiKey();

  // Step 2: full client with creds
  _client = new ClobClient(
    CLOB_API,
    137,
    walletClient as any,
    creds,
    config.signatureType,
    config.funderAddress || undefined,
  );

  return _client;
}

// ─── Order placement ──────────────────────────────────────

export async function placeBuyOrder(
  market: MarketInfo,
  direction: "YES" | "NO",
  price: number,
  sizeUSDC: number,
  paperMode: boolean,
  isNegRisk: boolean = false, // weather events are negRisk groups; crypto BTC markets are not
  fillOpts?: PaperFillOpts,
): Promise<OrderRecord> {
  const tokenId =
    direction === "YES" ? market.clobTokenIds[0] : market.clobTokenIds[1];

  const record: OrderRecord = {
    orderId: "",
    market: market.slug,
    tokenId,
    direction,
    side: "BUY",
    price,
    size: sizeUSDC,
    filledShares: 0,
    status: "PENDING",
    placedAt: new Date().toISOString(),
    filledAt: null,
  };

  if (paperMode) {
    record.orderId = `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Default (fill model OFF): legacy instant full fill at the displayed price.
    let filledShares = sizeUSDC / price;
    let fillPrice    = price;
    let filledUsdc   = sizeUSDC;
    let partial      = false;
    let fillNote     = "legacy-full";

    // Depth-aware fill (B49 #1): walk the real ask book, cap participation,
    // book partial fills, never credit the unfillable remainder.
    if (fillOpts?.enabled) {
      const book = await fetchClobBook(tokenId);
      let res =
        book && book.asks.length > 0
          ? simulateDepthFill(book.asks, sizeUSDC, { participationCap: fillOpts.participationCap })
          : null;
      if (res && res.ok) {
        fillNote = res.partial ? "depth-partial" : "depth-full";
      } else {
        // No book, or book present but zero fillable depth within the cap →
        // conservative sqrt-law/flat haircut fallback (never a free full fill).
        res = fallbackFill(price, sizeUSDC, fillOpts.fallbackHaircut ?? 0.02);
        fillNote = book ? "fallback-thin" : "fallback-nobook";
      }

      if (res.ok && isFillValid(res.filledShares, res.vwap, fillOpts.minOrderSizeShares ?? 5)) {
        filledShares = res.filledShares;
        fillPrice    = res.vwap;
        filledUsdc   = res.filledUsdc;
        partial      = res.partial;
      } else {
        // Below min order size / invalid VWAP → market too thin to trade.
        record.status = "REJECTED";
        log("ORDER_REJECTED", true, {
          market: market.slug,
          direction,
          reason: "paper fill below min size / invalid",
          requestedUsdc: sizeUSDC,
          fillNote,
        });
        return record;
      }
    }

    record.status = "FILLED";
    record.price = fillPrice;    // VWAP entry (legacy: displayed price)
    record.size = filledUsdc;    // actual notional spent (legacy: full request)
    record.filledShares = filledShares;
    record.filledAt = new Date().toISOString();

    log("ORDER_PLACED", true, {
      orderId: record.orderId,
      market: market.slug,
      direction,
      price: fillPrice,
      size: filledUsdc,
      partial,
      fillNote,
    });
    log("ORDER_FILLED", true, {
      orderId: record.orderId,
      filledShares: record.filledShares,
      fillPrice,
      filledUsdc,
      partial,
      fillNote,
    });

    return record;
  }

  // Live mode
  const client = await getClient();
  try {
    const resp = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side: "BUY",
        size: sizeUSDC,
      },
      { tickSize: "0.01", negRisk: isNegRisk },
      "GTC",
    );

    record.orderId = resp?.orderID || resp?.id || `live_${Date.now()}`;
    record.status = "PLACED";

    log("ORDER_PLACED", false, {
      orderId: record.orderId,
      market: market.slug,
      direction,
      price,
      size: sizeUSDC,
      response: resp,
    });
  } catch (err: any) {
    record.status = "REJECTED";
    log("ORDER_REJECTED", false, {
      market: market.slug,
      error: err.message,
    });
  }

  return record;
}

export async function placeSellOrder(
  market: MarketInfo,
  direction: "YES" | "NO",
  shares: number,
  price: number,
  paperMode: boolean,
  fok: boolean = false,
): Promise<OrderRecord> {
  const tokenId =
    direction === "YES" ? market.clobTokenIds[0] : market.clobTokenIds[1];

  const record: OrderRecord = {
    orderId: "",
    market: market.slug,
    tokenId,
    direction,
    side: "SELL",
    price,
    size: shares,
    filledShares: 0,
    status: "PENDING",
    placedAt: new Date().toISOString(),
    filledAt: null,
  };

  if (paperMode) {
    record.orderId = `paper_sell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    record.status = "FILLED";
    record.filledShares = shares;
    record.filledAt = new Date().toISOString();

    log("SELL_PLACED", true, {
      orderId: record.orderId,
      market: market.slug,
      direction,
      price,
      shares,
      fok,
    });

    return record;
  }

  // Live mode
  const client = await getClient();
  const orderType = fok ? "FOK" : "GTC";

  try {
    const resp = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side: "SELL",
        size: shares,
      },
      { tickSize: "0.01", negRisk: false },
      orderType,
    );

    record.orderId = resp?.orderID || resp?.id || `live_sell_${Date.now()}`;
    record.status = fok ? "FILLED" : "PLACED";
    if (fok) {
      record.filledShares = shares;
      record.filledAt = new Date().toISOString();
    }

    log("SELL_PLACED", false, {
      orderId: record.orderId,
      market: market.slug,
      direction,
      price,
      shares,
      fok,
      response: resp,
    });
  } catch (err: any) {
    record.status = "REJECTED";
    log("ORDER_REJECTED", false, {
      market: market.slug,
      side: "SELL",
      error: err.message,
    });
  }

  return record;
}

// ─── Get current order book best bid/ask ──────────────────

export async function getBestBid(
  tokenId: string,
  paperMode: boolean,
  currentPrice: number,
): Promise<number> {
  if (paperMode) {
    // Paper mode: simulate bid at current price - 1 tick
    return Math.max(0.01, currentPrice - 0.01);
  }

  try {
    const client = await getClient();
    const book = await client.getOrderBook(tokenId);
    if (book?.bids?.length > 0) {
      return parseFloat(book.bids[0].price);
    }
  } catch {}

  return Math.max(0.01, currentPrice - 0.02);
}

// ─── Check order status ───────────────────────────────────

export async function checkOrderStatus(
  orderId: string,
  paperMode: boolean,
): Promise<OrderRecord["status"]> {
  if (paperMode) return "FILLED";

  try {
    const client = await getClient();
    const order = await client.getOrder(orderId);
    if (!order) return "EXPIRED";

    const statusMap: Record<string, OrderRecord["status"]> = {
      MATCHED: "FILLED",
      LIVE: "PLACED",
      CANCELLED: "CANCELLED",
      EXPIRED: "EXPIRED",
    };
    return statusMap[order.status] || "PENDING";
  } catch {
    return "PENDING";
  }
}

// ─── Fill detail (live mode only) ─────────────────────────
//
// CLOB's getOrder returns `size_matched` (filled USDC notional for BUY) and
// the original limit `price`. For marketable limit orders the effective
// fill price is usually within one tick of the limit, but on a crossed
// book a BUY can fill at a *better* (lower) price than its limit. We can't
// get a per-trade VWAP without `getOrderTrades`, but using `size_matched`
// at least makes partial fills reflect accurately. When the API doesn't
// return the expected fields we fall back to the placement values upstream.

export interface FillDetail {
  filledUsdc: number;
  fillPrice:  number;
  rawStatus:  string;
}

export async function fetchOrderFillDetail(orderId: string): Promise<FillDetail | null> {
  try {
    const client = await getClient();
    const order: any = await client.getOrder(orderId);
    if (!order) return null;
    // Polymarket CLOB field naming varies — accept several common spellings.
    const filledUsdc =
      Number(order.size_matched ?? order.sizeMatched ?? order.executedSize ?? order.filledSize ?? NaN);
    const fillPrice = Number(order.price ?? order.fillPrice ?? order.avgPrice ?? NaN);
    if (!Number.isFinite(filledUsdc) || filledUsdc <= 0) return null;
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null;
    return {
      filledUsdc,
      fillPrice,
      rawStatus: String(order.status ?? "UNKNOWN"),
    };
  } catch {
    return null;
  }
}
