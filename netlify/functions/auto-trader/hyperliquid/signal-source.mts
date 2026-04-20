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
import type { SignalBreakdown } from "../shared/types.mts";
import type { HlCoin, HlDirection } from "./types.mts";

const TIMEOUT = 8000;

// Polymarket slug keyword per coin (matches "bitcoin-up-or-down-…" pattern)
const COIN_KEYWORDS: Record<HlCoin, string[]> = {
  BTC:  ["bitcoin-up-or-down", "btc-up-or-down", "bitcoin"],
  ETH:  ["ethereum-up-or-down", "eth-up-or-down", "ethereum"],
  SOL:  ["solana-up-or-down", "sol-up-or-down", "solana"],
  XRP:  ["xrp-up-or-down", "xrp"],
  DOGE: ["dogecoin", "doge"],
  AVAX: ["avalanche", "avax"],
};

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
  timestamp:     string;
}

async function findCoinMarketSlug(coin: HlCoin): Promise<string | null> {
  try {
    const r = await fetch(`${FN}/polymarket-proxy?limit=80`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) return null;
    const d = await r.json() as any;
    const markets: any[] = Array.isArray(d?.markets) ? d.markets : [];
    const keywords = COIN_KEYWORDS[coin] || [];
    for (const kw of keywords) {
      const match = markets.find(m =>
        (m.slug || "").toLowerCase().includes(kw) ||
        (m.question || "").toLowerCase().includes(kw.replace(/-/g, " ")),
      );
      if (match?.slug) return match.slug;
    }
    return null;
  } catch {
    return null;
  }
}

export async function getHlSignalForCoin(coin: HlCoin): Promise<HlSignalResult | null> {
  const slug = await findCoinMarketSlug(coin);
  if (!slug) return null;

  try {
    const r = await fetch(
      `${FN}/signal-combiner?slug=${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(TIMEOUT) },
    );
    if (!r.ok) return null;
    const d = await r.json() as any;
    if (!d?.ok) return null;

    const finalProb: number = d.combined_probability ?? 0.5;
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
      },
      marketSlug:     slug,
      marketPrice:    d.market?.yes_price ?? 0.5,
      resolutionCategory: d.resolution_risk?.category,
      timestamp:      d.fetched_at || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
