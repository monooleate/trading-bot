// packages/core/src/coin.mts
//
// Single source of truth for crypto-coin identification + threshold-strike
// parsing across the crypto pillar. Before B51 the coin was BTC-hardcoded in
// ~7 signal-combiner fetches, the market finder keyword, and two duplicated
// strike regexes (signal-combiner `parseThresholdK` + cross-position-gates
// `parseBtcAboveSlug`). This module consolidates all of it so BTC/ETH/SOL/…
// share one detector and one strike parser.
//
// Pure — no network, no Blobs — so worker (finder, aggregator, gates) and api
// (signal-combiner) can both import it, and the test can import it directly.

export interface CoinInfo {
  /** Uppercase base symbol, e.g. "BTC". */
  base: string;
  /** Binance/Bybit perp+spot symbol, e.g. "BTCUSDT". */
  binance: string;
  /** CoinGecko coin id, e.g. "bitcoin". */
  coingecko: string;
  /** CryptoCompare fsym, e.g. "BTC" (usually == base). */
  fsym: string;
  /** Deribit options currency ("BTC" | "ETH"), or null when no option chain
   *  exists — the market-implied (#7 Deribit RND) path is skipped for those. */
  deribit: string | null;
}

const COINS: Record<string, CoinInfo> = {
  BTC:  { base: "BTC",  binance: "BTCUSDT",  coingecko: "bitcoin",     fsym: "BTC",  deribit: "BTC" },
  ETH:  { base: "ETH",  binance: "ETHUSDT",  coingecko: "ethereum",    fsym: "ETH",  deribit: "ETH" },
  SOL:  { base: "SOL",  binance: "SOLUSDT",  coingecko: "solana",      fsym: "SOL",  deribit: null  },
  XRP:  { base: "XRP",  binance: "XRPUSDT",  coingecko: "ripple",      fsym: "XRP",  deribit: null  },
  DOGE: { base: "DOGE", binance: "DOGEUSDT", coingecko: "dogecoin",    fsym: "DOGE", deribit: null  },
  AVAX: { base: "AVAX", binance: "AVAXUSDT", coingecko: "avalanche-2", fsym: "AVAX", deribit: null  },
  BNB:  { base: "BNB",  binance: "BNBUSDT",  coingecko: "binancecoin", fsym: "BNB",  deribit: null  },
};

// slug/question alias → base. Order matters only in that each is a
// word-boundary match, so "eth" won't fire inside "ethereum" incorrectly
// (both map to ETH anyway).
const ALIASES: [RegExp, string][] = [
  [/\b(bitcoin|btc)\b/,    "BTC"],
  [/\b(ethereum|eth)\b/,   "ETH"],
  [/\b(solana|sol)\b/,     "SOL"],
  [/\b(ripple|xrp)\b/,     "XRP"],
  [/\b(dogecoin|doge)\b/,  "DOGE"],
  [/\b(avalanche|avax)\b/, "AVAX"],
  [/\b(bnb)\b/,            "BNB"],
];

/** All coins we know how to price. */
export function knownCoinBases(): string[] {
  return Object.keys(COINS);
}

/** Look up a coin descriptor by base symbol (case-insensitive). */
export function coinByBase(base: string | undefined | null): CoinInfo | null {
  if (!base) return null;
  return COINS[base.toUpperCase()] ?? null;
}

/**
 * Identify the crypto coin referenced by a slug/question string. Returns the
 * full descriptor (Binance/CoinGecko/Deribit ids) or null when no known coin
 * token is present.
 */
export function coinFromText(text: string | undefined | null): CoinInfo | null {
  if (!text) return null;
  const s = text.toLowerCase();
  for (const [re, base] of ALIASES) if (re.test(s)) return COINS[base];
  return null;
}

/**
 * Parse a Polymarket "above" threshold slug into { coin, K, closingKey }.
 *
 * Handles both strike conventions observed on Polymarket:
 *   • BTC  "bitcoin-above-90k-on-…"     → k-suffix means ×1000 → K = 90000
 *   • ETH  "ethereum-above-3000-on-…"   → literal USD          → K = 3000
 *
 * K is always returned in USD (the true resolution strike), so the vol
 * signal's Black-Scholes digital and the cond_prob monotonicity family use
 * the same units. `closingKey` is COIN-SCOPED ("BTC:september-8-2026") so
 * cross-position gates never compare an ETH strike against a BTC strike that
 * happens to resolve on the same date.
 *
 * Returns null for up-or-down / non-threshold / non-coin slugs, and for
 * non-anchored prefixes (e.g. "ratio-bitcoin-above-80k-something").
 */
export function parseCryptoAboveStrike(
  slug: string | undefined | null,
): { coin: string; K: number; closingKey: string } | null {
  if (!slug) return null;
  const s = String(slug).toLowerCase();
  const coin = coinFromText(s);
  if (!coin) return null;
  // Strike anchor: "…above-<N>[k][-on-<date>]" at the END of the slug.
  const m = s.match(/-(?:be-)?above-(\d+(?:\.\d+)?)(k)?(?:-on-(.+?))?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const K = m[2] === "k" ? n * 1000 : n;
  return { coin: coin.base, K, closingKey: `${coin.base}:${m[3] || ""}` };
}
