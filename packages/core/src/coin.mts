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

/**
 * Is this a DIRECTIONAL crypto market — one whose YES probability is a genuine
 * P(price goes up) rather than P(price ends above some strike)?
 *
 * Audit P0-3 (2026-09-09). The Hyperliquid pillar converts a Polymarket YES
 * probability into a perp conviction with `edge = |p − 0.5| × 2`. That transform
 * is only meaningful when `p` really is directional. Its market lookup fell back
 * to a bare coin keyword ("bitcoin"), which matched whatever bitcoin market
 * happened to top the volume list — in practice a THRESHOLD market. Live proof:
 * for 2412 consecutive scans the resolved slug was
 * `bitcoin-above-82k-on-september-9-2026` (YES 0.0365, deep OTM), so the
 * combiner's correct answer of p ≈ 0.0156 became a bogus 96.9% "edge" that the
 * 40% sanity cap then blocked. The bot could not place a trade for seven days,
 * and its direction was decided by Polymarket's volume ranking: when an
 * in-the-money strike topped the list instead, p ≈ 0.9995 read as "LONG" — the
 * origin of the documented 22/22 LONG bias (B18).
 *
 * Deliberately strict: a market must both (a) fail the threshold parser and
 * (b) positively look like an up/down market. Anything unrecognised is NOT
 * directional, because the failure mode being fixed is exactly a silent
 * mis-classification. Pure.
 */
export function isDirectionalCryptoMarket(
  slug: string | undefined | null,
  question?: string | undefined | null,
): boolean {
  if (!slug) return false;
  // A parseable strike proves it is a threshold market, whatever else it says.
  if (parseCryptoAboveStrike(slug) !== null) return false;
  const text = `${String(slug)} ${String(question ?? "")}`.toLowerCase();
  // "above"/"below" name a strike even when the strike itself did not parse
  // (unusual formats, non-anchored suffixes) — refuse those too rather than
  // guess.
  if (/\b(above|below|greater than|less than)\b/.test(text)) return false;
  return /up[-\s]?or[-\s]?down|up[-\s]?down|updown/.test(text);
}
