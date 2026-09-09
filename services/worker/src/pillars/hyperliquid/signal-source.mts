// netlify/functions/auto-trader/hyperliquid/signal-source.mts
// Pulls the EdgeCalc signal-combiner for a Hyperliquid-tradable coin
// and converts its binary-market probability into a perp LONG/SHORT signal.
//
// Strategy: find the top-volume "BTC Up/Down" (or ETH/SOL etc.) market on
// Polymarket, run it through the signal-combiner, then:
//   - prob > 0.5 → bullish → LONG
//   - prob < 0.5 → bearish → SHORT
// |prob - 0.5| × 2 is the implied directional edge.

import { FN } from "../shared/config.mts";
import { coinFromText, isDirectionalCryptoMarket } from "@core/coin.mts";
import { findBtcMarkets } from "../crypto/btc-market-finder.mts";
import type { SignalBreakdown } from "@core/types.mts";
import type { HlCoin, HlDirection } from "./types.mts";

const TIMEOUT = 8000;

// NOTE (audit P0-3, 2026-09-09): the previous per-coin keyword list ended in a
// BARE COIN NAME ("bitcoin", "ethereum", …) as a last-resort fallback. Because
// the lookup returned the first substring match from a generic top-volume list,
// that fallback silently resolved to whatever bitcoin market happened to rank
// highest — in practice a THRESHOLD market, not an up/down one. Coin identity is
// now taken from @core/coin.mts and the directional test is explicit, so there is
// no keyword list left to drift.

export interface HlSignalResult {
  coin:          HlCoin;
  direction:     HlDirection;
  finalProb:     number;           // 0-1 (YES prob from combiner)
  edge:          number;           // directional edge — |prob-0.5|×2, floor at 0
  kellyFraction: number;           // raw kelly from combiner (pre-quarter)
  activeSignals: number;
  signalBreakdown: SignalBreakdown;
  marketSlug:    string;
  marketPrice:   number;
  resolutionCategory?: "LOW" | "MEDIUM" | "HIGH" | "SKIP";
  // Combiner's own action verdict — "BUY YES" / "BUY NO" / "WAIT" / "WATCH"
  // / "SKIP". Used by the HL trust-gate to filter trades the combiner
  // itself flagged as low-conviction (WATCH) but where edge is extreme.
  combinerRecommendation?: string;
  timestamp:     string;
}

/**
 * Find the highest-volume DIRECTIONAL (up-or-down) Polymarket market for a coin.
 *
 * Two things changed here in audit P0-3:
 *
 *  1. UNIVERSE. This used to read `polymarket-proxy?limit=80`, which is the
 *     global top-N events by 24h volume across every vertical — so a busy sports
 *     week could push every crypto up/down market out of view. It now uses the
 *     crypto-tagged Gamma query the crypto pillar already relies on, which is
 *     where `bitcoin-up-or-down-on-…` actually lives. (Measured 2026-09-09: the
 *     80-item proxy list contained five bitcoin markets, ALL of them thresholds,
 *     and no ethereum or solana market at all — which is why only BTC ever
 *     produced a signal.)
 *
 *  2. TYPE SAFETY. The result must pass `isDirectionalCryptoMarket`. A threshold
 *     market's P(YES) is not a directional probability, and feeding one into
 *     `|p − 0.5| × 2` manufactures an edge out of moneyness.
 *
 * Returns null when no directional market exists for the coin. That is a correct
 * outcome, not a failure: it is strictly better for the bot to stand down than to
 * trade a category error.
 */
async function findCoinMarketSlug(coin: HlCoin): Promise<string | null> {
  try {
    // Price band 0 — an up/down market sits near 0.5 anyway, and we must not
    // inherit the crypto pillar's deep-OTM filter, which is there to protect
    // *binary* fills rather than a perp signal.
    const markets = await findBtcMarkets(0, 0);
    const candidates = markets
      .filter((m) => {
        const base = (m as any).coin ?? coinFromText(`${m.slug} ${(m as any).question ?? ""}`)?.base;
        return base === coin && isDirectionalCryptoMarket(m.slug, (m as any).question);
      });
    // findBtcMarkets already returns volume-descending, so the first hit is the
    // most liquid directional market for this coin.
    return candidates[0]?.slug ?? null;
  } catch {
    return null;
  }
}

export async function getHlSignalForCoin(coin: HlCoin): Promise<HlSignalResult | null> {
  const slug = await findCoinMarketSlug(coin);
  if (!slug) return null;
  // Defence in depth. The lookup above already filters, but the whole P0-3 bug
  // was a threshold probability reaching the directional transform below without
  // anyone noticing for seven days. Re-check at the point of use so a future
  // change to the lookup cannot silently reintroduce it.
  if (!isDirectionalCryptoMarket(slug)) return null;

  try {
    // `&category=hyperliquid` opts this call into the realized-IC blend
    // path when Settings → Signal calibration → "Use realized IC" is ON.
    // Without the toggle the combiner uses static priors as before.
    const r = await fetch(
      `${FN}/signal-combiner?slug=${encodeURIComponent(slug)}&category=hyperliquid`,
      { signal: AbortSignal.timeout(TIMEOUT) },
    );
    if (!r.ok) return null;
    const d = await r.json() as any;
    if (!d?.ok) return null;

    const finalProb: number = d.combined_probability ?? 0.5;
    // Valid ONLY because `slug` is guaranteed directional above: for an up/down
    // market P(YES) really is P(price rises), so |p − 0.5| × 2 is a conviction.
    // On a threshold market the same expression measures moneyness, not edge.
    const edgeRaw   = Math.abs(finalProb - 0.5) * 2;   // 0 at 0.5, 1 at extremes
    const direction: HlDirection = finalProb >= 0.5 ? "LONG" : "SHORT";

    return {
      coin,
      direction,
      finalProb,
      edge:           edgeRaw,
      kellyFraction:  d.kelly?.full ?? 0,
      activeSignals:  d.active_signals ?? 0,
      signalBreakdown: {
        funding_rate:   d.raw_signals?.funding_rate   ?? null,
        orderflow:      d.raw_signals?.orderflow      ?? null,
        vol_divergence: d.raw_signals?.vol_divergence ?? null,
        apex_consensus: d.raw_signals?.apex_consensus ?? null,
        cond_prob:      d.raw_signals?.cond_prob      ?? null,
        momentum:       d.raw_signals?.momentum       ?? null,
        contrarian:     d.raw_signals?.contrarian     ?? null,
        pairs_spread:   d.raw_signals?.pairs_spread   ?? null,
        forecast_edge:  null,                              // weather-only signal
      },
      marketSlug:     slug,
      marketPrice:    d.market?.yes_price ?? 0.5,
      resolutionCategory: d.resolution_risk?.category,
      combinerRecommendation: typeof d.recommendation?.action === "string"
        ? d.recommendation.action
        : undefined,
      timestamp:      d.fetched_at || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
