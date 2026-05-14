// src/components/shared/marketLinks.ts
//
// Centralised URL builders for "open this trade on the venue" deep-links.
// One source of truth shared across the 5 trader pages (crypto / weather /
// HL Perp / F-Arb / sports) + edge tracker, so a Polymarket slug → URL
// formatting change is a one-file edit.
//
// All helpers return `null` when input is missing or invalid so the caller
// can `?.` straight into the `link` prop on a row without conditional
// branches.

const POLYMARKET_ORIGIN = "https://polymarket.com";
const HL_MAINNET_ORIGIN = "https://app.hyperliquid.xyz";
const HL_TESTNET_ORIGIN = "https://app.hyperliquid-testnet.xyz";

/** Polymarket event page (negRisk groups: weather buckets, BTC-above-K
 *  threshold lineups, sports markets). The slug works for both event-level
 *  and standalone-market pages — Polymarket aliases them. */
export function polymarketEventUrl(slug: string | null | undefined): string | null {
  if (!slug || typeof slug !== "string") return null;
  const clean = slug.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  return `${POLYMARKET_ORIGIN}/event/${encodeURIComponent(clean)}`;
}

/** Polymarket market page (for individual sub-markets when we want to
 *  deep-link past the event view — e.g. a specific weather bucket). Falls
 *  back to event URL when only an event slug is available. */
export function polymarketMarketUrl(slug: string | null | undefined): string | null {
  if (!slug || typeof slug !== "string") return null;
  const clean = slug.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  return `${POLYMARKET_ORIGIN}/market/${encodeURIComponent(clean)}`;
}

/** Hyperliquid app perp-trade page. Paper-mode positions route to the
 *  testnet UI; live positions to mainnet. Coin symbol is upper-cased. */
export function hyperliquidTradeUrl(
  coin: string | null | undefined,
  paperMode: boolean = false,
): string | null {
  if (!coin || typeof coin !== "string") return null;
  const sym = coin.trim().toUpperCase();
  if (!sym) return null;
  const origin = paperMode ? HL_TESTNET_ORIGIN : HL_MAINNET_ORIGIN;
  return `${origin}/trade/${encodeURIComponent(sym)}`;
}
