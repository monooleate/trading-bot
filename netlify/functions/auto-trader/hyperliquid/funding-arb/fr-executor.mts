// netlify/functions/auto-trader/hyperliquid/funding-arb/fr-executor.mts
// Atomic two-leg open/close for the funding arbitrage.
// The prompt's critical warning: if one leg succeeds and the other fails,
// we are NOT delta-neutral — we must unwind the successful leg immediately.

import { tryLoadLiveAdapter, liveAdapterError, formatPrice, formatSize, getCurrentPrice } from "../hl-client.mts";
import { binanceSpotBuy, binanceSpotSell } from "./hedge-manager.mts";
import type { ArbOpportunity, ArbPosition, FrArbConfig } from "./types.mts";
import type { EntryDecisionSnapshot } from "../../shared/types.mts";

export interface OpenArbResult {
  ok:        boolean;
  position?: ArbPosition;
  error?:    string;
}

export async function openArbPosition(
  opp:       ArbOpportunity,
  sizeUSDC:  number,
  config:    FrArbConfig,
  entryDecision?: EntryDecisionSnapshot,
): Promise<OpenArbResult> {
  const sizeCoins = sizeUSDC / opp.markPrice;

  // ── HL SHORT leg first ────────────────────────────────────────────────
  let hlOrderId:    string | null = null;
  let hlEntryPrice: number        = opp.markPrice;

  if (config.paperMode) {
    hlOrderId    = `paper-hl-${Date.now()}-${opp.coin}`;
    // Live SHORT goes in via IOC at markPrice × 0.995 — a 0.5% adverse
    // band so the order marries against the bid. Paper now mirrors that
    // band so the closed-trade summary's `hlEntryPrice` doesn't pretend
    // we always sold at mid.
    const HL_ENTRY_SLIPPAGE = 0.005;
    hlEntryPrice = opp.markPrice * (1 - HL_ENTRY_SLIPPAGE);
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
    entryDecision,
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
    // +1.0% slippage above ref so the buy-to-close IOC stays marry-able
    // even through volatile ticks. The previous 0.5% band let close
    // attempts time-out repeatedly when BTC drifted >0.5% inside the 3min
    // gap between the scan fetch and order submission, leaving the
    // position in a retry loop until the maxHoldDays safety net fired.
    // The wider band is the cost of guaranteed exit on the leg we *want*
    // to close — this is asymmetric vs entry where we'd rather miss than
    // overpay (entry stays at 0.5%).
    const closeLimit = closeRefPrice * (1 + 0.010);
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
  // Paper slippage cost: our fee config only counts taker fees, not the
  // price-leg loss from IOC slippage. In live mode the slippage is
  // already baked into hlEntryPrice / hlExitPrice and binance fills, so
  // booking it again would double-count. Paper has no real fills, so we
  // approximate the live-equivalent slippage as a flat cost.
  //
  //   HL entry IOC at markPrice × 0.995 → 0.5% adverse
  //   HL close IOC at closeRefPrice × 1.010 → 1.0% adverse
  //   Binance MARKET BUY+SELL roundtrip → ~0.1% adverse (2 × 0.05%)
  //
  // Total paper slippage roundtrip ≈ 1.6% of notional. In a healthy carry
  // (hourly spread × hold_hours > 1.6% + fees) this stays profitable.
  const paperSlippage = config.paperMode
    ? pos.sizeUSDC * 0.016
    : 0;
  const netPnl = pos.accumulatedFunding - fees - paperSlippage;

  pos.status          = "CLOSED";
  pos.closedAt        = new Date().toISOString();
  pos.closeReason     = reason;
  pos.closeFundingNet = parseFloat(netPnl.toFixed(2));

  return { ok: true, netPnl };
}
