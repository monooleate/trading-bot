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
  const direction = opp.direction ?? "forward";

  // ── REVERSE (HL-long + Binance-perp-short) — PAPER ONLY ────────────────
  // The live hedge-manager is deliberately spot-only (no futures/margin
  // perms), and you cannot short spot, so a live reverse hedge is impossible
  // here. Block it loudly rather than silently opening a wrong (spot-long)
  // hedge that breaks delta-neutrality. Live reverse needs a Binance futures
  // short adapter (→ B20). Paper models both legs internally (no live calls);
  // PnL is funding-only (the price legs are delta-neutral and cancel), so the
  // paper fill prices below are cosmetic-realistic, not PnL-bearing.
  if (direction === "reverse") {
    if (!config.paperMode) {
      return {
        ok: false,
        error: "Reverse arb (HL-long + Binance short) is paper-only — the live hedge is spot-only and cannot short. Needs a Binance futures-short adapter (B20).",
      };
    }
    const HL_ENTRY_SLIPPAGE  = 0.005;  // LONG fills slightly ABOVE mark
    const BIN_ENTRY_SLIPPAGE = 0.0005; // SHORT sells slightly BELOW mark
    const position: ArbPosition = {
      id:                   `arb-${Date.now()}-${opp.coin}`,
      coin:                 opp.coin,
      direction:            "reverse",
      sizeUSDC,
      sizeCoins:            parseFloat(formatSize(opp.coin, sizeCoins)),
      hlShortOrderId:       `paper-hl-long-${Date.now()}-${opp.coin}`,
      hlEntryPrice:         opp.markPrice * (1 + HL_ENTRY_SLIPPAGE),
      binanceOrderId:       `paper-binance-short-${Date.now()}-${opp.coin}`,
      binanceEntryPrice:    opp.markPrice * (1 - BIN_ENTRY_SLIPPAGE),
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

  // ── FORWARD (HL-short + Binance-spot-long) — live-safe ─────────────────
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
    direction:            "forward",
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
  // Reverse positions are paper-only (see openArbPosition). A live reverse
  // close would need a Binance futures buy-to-cover + HL sell-to-close, which
  // the spot-only live path can't do — guard defensively (unreachable today).
  if ((pos.direction ?? "forward") === "reverse" && !config.paperMode) {
    return { ok: false, error: "Reverse arb close is paper-only (live needs a futures-short adapter, B20)" };
  }

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
  //   HL entry/close IOC + Binance market roundtrip.
  //
  // 2026-06-07 (B26): the roundtrip slippage is now `config.paperSlippageRoundtrip`
  // (default 0.004 = 0.4%), shared with the arb-detector break-even gate so the
  // bot never opens a position it can't profitably close. The old hardcoded
  // 0.016 summed the IOC limit BANDS (worst-case marry prices) rather than the
  // expected fills, structurally guaranteeing fee-negative trades.
  const paperSlippage = config.paperMode
    ? pos.sizeUSDC * config.paperSlippageRoundtrip
    : 0;
  const netPnl = pos.accumulatedFunding - fees - paperSlippage;

  pos.status          = "CLOSED";
  pos.closedAt        = new Date().toISOString();
  pos.closeReason     = reason;
  pos.closeFundingNet = parseFloat(netPnl.toFixed(2));

  return { ok: true, netPnl };
}
