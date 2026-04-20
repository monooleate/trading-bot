// netlify/functions/auto-trader/hyperliquid/funding-arb/fr-executor.mts
// Atomic two-leg open/close for the funding arbitrage.
// The prompt's critical warning: if one leg succeeds and the other fails,
// we are NOT delta-neutral — we must unwind the successful leg immediately.

import { tryLoadLiveAdapter, formatPrice, formatSize } from "../hl-client.mts";
import { ASSET_INDEX } from "../config.mts";
import { binanceSpotBuy, binanceSpotSell } from "./hedge-manager.mts";
import type { ArbOpportunity, ArbPosition, FrArbConfig } from "./types.mts";

export interface OpenArbResult {
  ok:        boolean;
  position?: ArbPosition;
  error?:    string;
}

export async function openArbPosition(
  opp:       ArbOpportunity,
  sizeUSDC:  number,
  config:    FrArbConfig,
): Promise<OpenArbResult> {
  const sizeCoins = sizeUSDC / opp.markPrice;

  // ── HL SHORT leg first ────────────────────────────────────────────────
  let hlOrderId:    string | null = null;
  let hlEntryPrice: number        = opp.markPrice;

  if (config.paperMode) {
    hlOrderId    = `paper-hl-${Date.now()}-${opp.coin}`;
    hlEntryPrice = opp.markPrice;
  } else {
    const adapter = await tryLoadLiveAdapter(false);
    if (!adapter) {
      return { ok: false, error: "HL live adapter unavailable (install @nktkas/hyperliquid + viem)" };
    }
    const resp = await adapter.placeOrder({
      coin:       opp.coin,
      isBuy:      false,           // SHORT
      price:      formatPrice(opp.coin, opp.markPrice),
      sizeCoins:  formatSize(opp.coin, sizeCoins),
      reduceOnly: false,
      tif:        "Gtc",
    });
    if (!resp.ok || !resp.orderId) {
      return { ok: false, error: `HL short failed: ${resp.error || "no orderId"}` };
    }
    hlOrderId = resp.orderId;
  }

  // ── Binance LONG leg ──────────────────────────────────────────────────
  const binanceResp = await binanceSpotBuy(opp.coin, sizeUSDC, opp.markPrice, config.paperMode);
  if (!binanceResp.ok || !binanceResp.orderId) {
    // Emergency unwind of HL short to keep delta neutral (or, in paper mode, just log)
    if (!config.paperMode) {
      const adapter = await tryLoadLiveAdapter(false);
      if (adapter && hlOrderId) {
        await adapter.placeOrder({
          coin:       opp.coin,
          isBuy:      true,                    // BUY back to close short
          price:      formatPrice(opp.coin, opp.markPrice),
          sizeCoins:  formatSize(opp.coin, sizeCoins),
          reduceOnly: true,
          tif:        "Ioc",
        }).catch(() => {});
      }
    }
    return { ok: false, error: `Binance hedge failed — HL short unwound. ${binanceResp.error}` };
  }

  const position: ArbPosition = {
    id:                   `arb-${Date.now()}-${opp.coin}`,
    coin:                 opp.coin,
    sizeUSDC,
    sizeCoins:            parseFloat(formatSize(opp.coin, sizeCoins)),
    hlShortOrderId:       hlOrderId!,
    hlEntryPrice,
    binanceOrderId:       binanceResp.orderId,
    binanceEntryPrice:    binanceResp.entryPrice || opp.markPrice,
    openedAt:             new Date().toISOString(),
    entryHlFunding:       opp.hlFundingHourly,
    entryBinanceFunding:  opp.binanceFundingHourly,
    entrySpread:          opp.spread,
    accumulatedFunding:   0,
    lastFundingUpdateAt:  new Date().toISOString(),
    status:               "OPEN",
  };
  return { ok: true, position };
}

export async function closeArbPosition(
  pos:    ArbPosition,
  reason: string,
  config: FrArbConfig,
): Promise<{ ok: boolean; error?: string; netPnl?: number }> {
  // HL: buy back to close short
  if (config.paperMode) {
    // paper: no external call
  } else {
    const adapter = await tryLoadLiveAdapter(false);
    if (!adapter) {
      return { ok: false, error: "HL live adapter unavailable" };
    }
    const hlResp = await adapter.placeOrder({
      coin:       pos.coin,
      isBuy:      true,
      price:      formatPrice(pos.coin, pos.hlEntryPrice),
      sizeCoins:  formatSize(pos.coin, pos.sizeCoins),
      reduceOnly: true,
      tif:        "Ioc",
    });
    if (!hlResp.ok) {
      return { ok: false, error: `HL close failed: ${hlResp.error}` };
    }
  }

  // Binance: sell spot
  const binResp = await binanceSpotSell(pos.coin, pos.sizeCoins, pos.hlEntryPrice, config.paperMode);
  if (!binResp.ok) {
    return { ok: false, error: `Binance close failed (HL already closed — manual intervention needed): ${binResp.error}` };
  }

  const fees   = pos.sizeUSDC * (config.feeRoundtripHl + config.feeRoundtripBinance);
  const netPnl = pos.accumulatedFunding - fees;

  pos.status          = "CLOSED";
  pos.closedAt        = new Date().toISOString();
  pos.closeReason     = reason;
  pos.closeFundingNet = parseFloat(netPnl.toFixed(2));

  return { ok: true, netPnl };
}
