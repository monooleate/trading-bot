import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPolymarketConfig, CLOB_API } from "../shared/config.mts";
import { log } from "../shared/logger.mts";
import type { MarketInfo, OrderRecord } from "../shared/types.mts";

let _client: any = null;

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
    // Paper mode: simulate instant fill
    record.orderId = `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    record.status = "FILLED";
    record.filledShares = sizeUSDC / price;
    record.filledAt = new Date().toISOString();

    log("ORDER_PLACED", true, {
      orderId: record.orderId,
      market: market.slug,
      direction,
      price,
      size: sizeUSDC,
    });
    log("ORDER_FILLED", true, {
      orderId: record.orderId,
      filledShares: record.filledShares,
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
      { tickSize: "0.01", negRisk: false },
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
