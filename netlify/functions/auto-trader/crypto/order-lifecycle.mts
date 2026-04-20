import { placeSellOrder, getBestBid, checkOrderStatus } from "./execution.mts";
import { log } from "../shared/logger.mts";
import type { MarketInfo, Position, ClosedTrade, OrderRecord } from "../shared/types.mts";

const MAX_BUY_RETRIES = 3;
const SELL_RETRY_DELAY_MS = 100;

/**
 * Handle buy order lifecycle: place → check fill → retry if needed.
 * Returns the filled position or null if failed.
 */
export async function handleBuyLifecycle(
  buyOrder: OrderRecord,
  market: MarketInfo,
  paperMode: boolean,
): Promise<Position | null> {
  // Paper mode: already filled in execution.ts
  if (paperMode && buyOrder.status === "FILLED") {
    return {
      market: market.slug,
      tokenId: buyOrder.tokenId,
      direction: buyOrder.direction,
      shares: buyOrder.filledShares,
      avgEntry: buyOrder.price,
      costBasis: buyOrder.size,
      openedAt: buyOrder.placedAt,
      buyOrderId: buyOrder.orderId,
    };
  }

  // Live mode: poll for fill (simplified — in production use WebSocket)
  if (buyOrder.status === "REJECTED") {
    return null;
  }

  // Wait and check (up to 30s with 5s intervals)
  for (let i = 0; i < 6; i++) {
    await delay(5000);
    const status = await checkOrderStatus(buyOrder.orderId, paperMode);

    if (status === "FILLED") {
      log("ORDER_FILLED", paperMode, {
        orderId: buyOrder.orderId,
        filledShares: buyOrder.size / buyOrder.price,
      });

      return {
        market: market.slug,
        tokenId: buyOrder.tokenId,
        direction: buyOrder.direction,
        shares: buyOrder.size / buyOrder.price,
        avgEntry: buyOrder.price,
        costBasis: buyOrder.size,
        openedAt: buyOrder.placedAt,
        buyOrderId: buyOrder.orderId,
      };
    }

    if (status === "EXPIRED" || status === "CANCELLED" || status === "REJECTED") {
      log("ORDER_EXPIRED", paperMode, { orderId: buyOrder.orderId, status });
      return null;
    }
  }

  // Timed out waiting for fill
  log("ORDER_EXPIRED", paperMode, {
    orderId: buyOrder.orderId,
    reason: "timeout waiting for fill",
  });
  return null;
}

/**
 * Handle sell (exit) for an open position.
 * Tries GTC first, then emergency FOK at best bid.
 */
export async function handleSellLifecycle(
  position: Position,
  market: MarketInfo,
  targetPrice: number,
  paperMode: boolean,
): Promise<ClosedTrade> {
  // Try GTC sell at target price
  const sellOrder = await placeSellOrder(
    market,
    position.direction,
    position.shares,
    targetPrice,
    paperMode,
  );

  if (paperMode) {
    // Paper mode: instant fill at target price
    const proceeds = position.shares * targetPrice;
    const pnl = proceeds - position.costBasis;
    const pnlPct = (pnl / position.costBasis) * 100;

    log("TRADE_CLOSED", true, {
      market: market.slug,
      direction: position.direction,
      pnl,
      pnlPct,
    });

    return {
      market: market.slug,
      direction: position.direction,
      entryPrice: position.avgEntry,
      exitPrice: targetPrice,
      shares: position.shares,
      pnl,
      pnlPct,
      openedAt: position.openedAt,
      closedAt: new Date().toISOString(),
    };
  }

  // Live mode: wait for fill, then emergency sell if needed
  for (let i = 0; i < 6; i++) {
    await delay(5000);
    const status = await checkOrderStatus(sellOrder.orderId, paperMode);
    if (status === "FILLED") {
      const proceeds = position.shares * targetPrice;
      const pnl = proceeds - position.costBasis;

      log("TRADE_CLOSED", false, {
        orderId: sellOrder.orderId,
        market: market.slug,
        pnl,
        pnlPct: (pnl / position.costBasis) * 100,
      });

      return {
        market: market.slug,
        direction: position.direction,
        entryPrice: position.avgEntry,
        exitPrice: targetPrice,
        shares: position.shares,
        pnl,
        pnlPct: (pnl / position.costBasis) * 100,
        openedAt: position.openedAt,
        closedAt: new Date().toISOString(),
      };
    }
  }

  // Emergency FOK sell at best bid
  return emergencySell(position, market, paperMode);
}

/**
 * Emergency sell: FOK at best bid, retry until filled.
 */
async function emergencySell(
  position: Position,
  market: MarketInfo,
  paperMode: boolean,
): Promise<ClosedTrade> {
  log("ERROR", paperMode, {
    market: market.slug,
    message: "GTC sell timed out, attempting FOK emergency sell",
  });

  for (let attempt = 0; attempt < 10; attempt++) {
    const bestBid = await getBestBid(position.tokenId, paperMode, position.avgEntry);

    const fokOrder = await placeSellOrder(
      market,
      position.direction,
      position.shares,
      bestBid,
      paperMode,
      true, // FOK
    );

    if (fokOrder.status === "FILLED" || paperMode) {
      const proceeds = position.shares * bestBid;
      const pnl = proceeds - position.costBasis;

      log("TRADE_CLOSED", paperMode, {
        market: market.slug,
        exitType: "emergency_fok",
        attempt,
        pnl,
      });

      return {
        market: market.slug,
        direction: position.direction,
        entryPrice: position.avgEntry,
        exitPrice: bestBid,
        shares: position.shares,
        pnl,
        pnlPct: (pnl / position.costBasis) * 100,
        openedAt: position.openedAt,
        closedAt: new Date().toISOString(),
      };
    }

    await delay(SELL_RETRY_DELAY_MS);
  }

  // Worst case: report as loss of full position
  const pnl = -position.costBasis;
  log("ERROR", paperMode, {
    market: market.slug,
    message: "Emergency sell failed after 10 attempts",
    pnl,
  });

  return {
    market: market.slug,
    direction: position.direction,
    entryPrice: position.avgEntry,
    exitPrice: 0,
    shares: position.shares,
    pnl,
    pnlPct: -100,
    openedAt: position.openedAt,
    closedAt: new Date().toISOString(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
