// netlify/functions/auto-trader/hyperliquid/order-manager.mts
// Entry + TP + SL placement.
// Paper mode: pure simulation, no external calls. State goes to session.
// Live mode: calls the HlExecutionAdapter (lazy-loaded SDK). If the adapter
// is unavailable, we refuse to place the entry rather than guess.

import { tryLoadLiveAdapter, liveAdapterError, formatPrice } from "./hl-client.mts";
import { computeTpSl } from "./kelly-sizer.mts";
import type { HlCoin, HlDirection, HlPosition } from "./types.mts";
import type { EntryDecisionSnapshot } from "../shared/types.mts";

export interface PlaceEntryInput {
  coin:        HlCoin;
  direction:   HlDirection;
  entryPrice:  number;
  sizeCoins:   number;
  sizeCoinsStr: string;
  sizeUSDC:    number;
  leverage:    number;
  edge:        number;
  paperMode:   boolean;
  // TP/SL distance caps so order-manager doesn't have to import the full
  // HlTraderConfig just to pass two numbers.
  tpPctMax?:   number;
  slPctMax?:   number;
  // Signal context that the paper-resolver carries through into the
  // HlClosedTrade so the edge-tracker can correlate predictions with PnL.
  predictedProb?:    number;
  signalBreakdown?:  import("../shared/types.mts").SignalBreakdown;
  entryDecision?:    EntryDecisionSnapshot;
}

export interface PlaceEntryResult {
  ok:       boolean;
  position?: HlPosition;
  error?:   string;
}

export async function placeHlEntry(p: PlaceEntryInput): Promise<PlaceEntryResult> {
  const { tpPrice, slPrice } = computeTpSl({
    entryPrice: p.entryPrice,
    direction:  p.direction,
    edge:       p.edge,
    tpPctMax:   p.tpPctMax,
    slPctMax:   p.slPctMax,
  });

  const pricedEntry = formatPrice(p.coin, p.entryPrice);
  const pricedTp    = formatPrice(p.coin, tpPrice);
  const pricedSl    = formatPrice(p.coin, slPrice);

  // ── Paper mode ─────────────────────────────────────────────────────────
  if (p.paperMode) {
    const position: HlPosition = {
      coin:         p.coin,
      direction:    p.direction,
      entryPrice:   parseFloat(pricedEntry),
      sizeCoins:    p.sizeCoins,
      sizeUSDC:     p.sizeUSDC,
      leverage:     p.leverage,
      openedAt:     new Date().toISOString(),
      entryOrderId: `paper-${Date.now()}-${p.coin}`,
      tpPrice:      parseFloat(pricedTp),
      slPrice:      parseFloat(pricedSl),
      tpOrderId:    `paper-tp-${Date.now()}`,
      slOrderId:    `paper-sl-${Date.now()}`,
      predictedProb:   p.predictedProb,
      edgeAtEntry:     p.edge,
      signalBreakdown: p.signalBreakdown,
      entryDecision:   p.entryDecision,
    };
    return { ok: true, position };
  }

  // ── Live mode ──────────────────────────────────────────────────────────
  const adapter = await tryLoadLiveAdapter(false);
  if (!adapter) {
    const why = liveAdapterError();
    return {
      ok: false,
      error: `Live adapter unavailable${why ? `: ${why}` : ""} — install @nktkas/hyperliquid + viem and set HL_PRIVATE_KEY`,
    };
  }

  const isLong = p.direction === "LONG";

  // 1. Entry
  const entry = await adapter.placeOrder({
    coin:       p.coin,
    isBuy:      isLong,
    price:      pricedEntry,
    sizeCoins:  p.sizeCoinsStr,
    reduceOnly: false,
    tif:        "Gtc",
  });
  if (!entry.ok || !entry.orderId) {
    return { ok: false, error: `Entry failed: ${entry.error || "no orderId"}` };
  }

  // 2. Take-profit (reduce only, limit)
  const tp = await adapter.placeOrder({
    coin:       p.coin,
    isBuy:      !isLong,
    price:      pricedTp,
    sizeCoins:  p.sizeCoinsStr,
    reduceOnly: true,
    tif:        "Gtc",
  });

  // Per the prompt: "TP/SL mindig be van állítva." If TP fails, the
  // upside is uncapped — bail and cancel the entry rather than open a
  // half-protected position. (Previously this branch only logged a
  // warning, leaving entry+SL active without a TP leg — §9.B in
  // CLAUDE.md.)
  if (!tp.ok) {
    await adapter.cancelOrder(p.coin, entry.orderId).catch(() => {});
    return { ok: false, error: `TP placement failed — entry cancelled. TP error: ${tp.error}` };
  }

  // 3. Stop-loss (reduce only, stop-market)
  const sl = await adapter.placeOrder({
    coin:       p.coin,
    isBuy:      !isLong,
    price:      pricedSl,
    sizeCoins:  p.sizeCoinsStr,
    reduceOnly: true,
    tif:        "Gtc",
    triggerPx:  pricedSl,
    triggerIsMarket: true,
    tpsl:       "sl",
  });

  // SL fails: cancel entry + the TP leg that's already resting.
  if (!sl.ok) {
    await adapter.cancelOrder(p.coin, entry.orderId).catch(() => {});
    if (tp.orderId) await adapter.cancelOrder(p.coin, tp.orderId).catch(() => {});
    return { ok: false, error: `SL placement failed — entry cancelled. SL error: ${sl.error}` };
  }

  const position: HlPosition = {
    coin:         p.coin,
    direction:    p.direction,
    entryPrice:   parseFloat(pricedEntry),
    sizeCoins:    p.sizeCoins,
    sizeUSDC:     p.sizeUSDC,
    leverage:     p.leverage,
    openedAt:     new Date().toISOString(),
    entryOrderId: entry.orderId,
    tpPrice:      parseFloat(pricedTp),
    slPrice:      parseFloat(pricedSl),
    tpOrderId:    tp.orderId || null,
    slOrderId:    sl.orderId || null,
    predictedProb:   p.predictedProb,
    edgeAtEntry:     p.edge,
    signalBreakdown: p.signalBreakdown,
    entryDecision:   p.entryDecision,
  };
  return { ok: true, position };
}

