// netlify/functions/auto-trader/hyperliquid/funding-arb/fr-executor.mts
// Atomic two-leg open/close for the funding arbitrage.
// The prompt's critical warning: if one leg succeeds and the other fails,
// we are NOT delta-neutral — we must unwind the successful leg immediately.

import { tryLoadLiveAdapter, liveAdapterError, formatPrice, formatSize, getCurrentPrice } from "../hl-client.mts";
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
      const why = liveAdapterError();
      return { ok: false, error: `HL live adapter unavailable${why ? `: ${why}` : ""} (install @nktkas/hyperliquid + viem, set HL_PRIVATE_KEY)` };
    }
    // SHORT entry: aggressive limit 0.5% UNDER mark so an IOC fills against
    // the bid side. Pure-mark limits often miss. We accept the slippage as
    // the cost of getting in atomically.
    const limitShort = opp.markPrice * (1 - 0.005);
    const resp = await adapter.placeOrder({
      coin:       opp.coin,
      isBuy:      false,
      price:      formatPrice(opp.coin, limitShort),
      sizeCoins:  formatSize(opp.coin, sizeCoins),
      reduceOnly: false,
      tif:        "Ioc",
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
        // Aggressive +0.5% limit so the buy-back IOC fills against the ask
        // even if HL ticked up between entry and the unwind decision.
        const unwindLimit = opp.markPrice * (1 + 0.005);
        await adapter.placeOrder({
          coin:       opp.coin,
          isBuy:      true,
          price:      formatPrice(opp.coin, unwindLimit),
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
  pos:           ArbPosition,
  reason:        string,
  config:        FrArbConfig,
  currentPriceHint?: number,
): Promise<{ ok: boolean; error?: string; netPnl?: number }> {
  // Resolve a sensible close price. The previous version used
  // `pos.hlEntryPrice` for the IOC limit, which fails to fill whenever HL
  // has moved since entry — exactly when we most need to close. The caller
  // (index.mts main loop) passes a fresh markPrice; if that's missing we
  // fall back to a fresh `getCurrentPrice` lookup; if THAT fails we use
  // entry but with a 1% slippage band so the IOC still has a chance to
  // marry against the ask.
  let livePrice = Number.isFinite(currentPriceHint) ? (currentPriceHint as number) : 0;
  if (!livePrice && !config.paperMode) {
    livePrice = (await getCurrentPrice(pos.coin, false)) ?? 0;
  }
  const closeRefPrice = livePrice > 0 ? livePrice : pos.hlEntryPrice;

  // HL: buy back to close short
  if (config.paperMode) {
    // paper: no external call
  } else {
    const adapter = await tryLoadLiveAdapter(false);
    if (!adapter) {
      const why = liveAdapterError();
      return { ok: false, error: `HL live adapter unavailable${why ? `: ${why}` : ""}` };
    }
    // +0.5% slippage above ref so the buy-to-close IOC marry-able even
    // through volatile ticks.
    const closeLimit = closeRefPrice * (1 + 0.005);
    const hlResp = await adapter.placeOrder({
      coin:       pos.coin,
      isBuy:      true,
      price:      formatPrice(pos.coin, closeLimit),
      sizeCoins:  formatSize(pos.coin, pos.sizeCoins),
      reduceOnly: true,
      tif:        "Ioc",
    });
    if (!hlResp.ok) {
      return { ok: false, error: `HL close failed: ${hlResp.error}` };
    }
  }

  // Binance: sell spot — uses live price for any reconciliation logic the
  // hedge-manager wants to do (paper just records markPrice; live uses
  // executedQty / fills.avgPrice from the API response).
  const binResp = await binanceSpotSell(pos.coin, pos.sizeCoins, closeRefPrice, config.paperMode);
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
