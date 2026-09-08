import { GAMMA_API } from "../shared/config.mts";
import type { MarketInfo } from "@core/types.mts";
import { coinFromText } from "@core/coin.mts";

/**
 * Find active crypto Up/Down + above-K markets on Polymarket via Gamma API.
 * Targets short-duration (5m, 15m) + daily binary markets.
 *
 * B51 (multi-coin): was BTC-only (keyword `bitcoin`/`btc`). Now admits any
 * coin in the CRYPTO_COINS allowlist (default BTC,ETH,SOL) via the shared
 * `coinFromText` detector, and tags each MarketInfo with its `coin` base so
 * the downstream signal path (aggregator OB imbalance, combiner per-coin
 * fetches) can price the right underlying. All BTC behaviour is unchanged
 * when the allowlist is left at its default (BTC is always included).
 */

const UPDOWN_KEYWORDS = ["up", "down", "above", "below"];

// Coin allowlist — comma-separated base symbols (e.g. "BTC,ETH,SOL"). A market
// whose detected coin is not in the set is skipped. Default admits the three
// coins with a full combiner signal path (Binance klines + funding + OI).
const CRYPTO_COINS = new Set(
  (process.env.CRYPTO_COINS || "BTC,ETH,SOL")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

interface GammaMarket {
  question?: string;
  title?: string;
  slug?: string;
  conditionId?: string;
  questionID?: string;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
  volume24hr?: string;
  volume?: string;
  liquidityNum?: string;
  liquidity?: string;
  outcomePrices?: string | number[];
  tokens?: { outcome: string; token_id: string }[];
  clobTokenIds?: string | string[];
}

interface GammaEvent {
  slug?: string;
  title?: string;
  tags?: any[];
  markets?: GammaMarket[];
}

// Identify an allowed-coin up/down/above/below market. Returns the coin base
// (e.g. "BTC") when the text names a coin in the allowlist AND carries a
// directional/threshold keyword; null otherwise. Checks slug + question so
// slugs like "eth-updown-4h-…" (no coin word in the title) still match.
function detectCryptoUpDown(question: string, slug: string): string | null {
  const text = `${slug} ${question}`.toLowerCase();
  const coin = coinFromText(text);
  if (!coin || !CRYPTO_COINS.has(coin.base)) return null;
  const hasUpDown = UPDOWN_KEYWORDS.some((kw) => text.includes(kw));
  return hasUpDown ? coin.base : null;
}

function parseTokenIds(m: GammaMarket): [string, string] | null {
  if (m.tokens && Array.isArray(m.tokens) && m.tokens.length >= 2) {
    const yes = m.tokens.find((t) => t.outcome === "Yes" || t.outcome === "YES");
    const no = m.tokens.find((t) => t.outcome === "No" || t.outcome === "NO");
    if (yes && no) return [yes.token_id, no.token_id];
    return [m.tokens[0].token_id, m.tokens[1].token_id];
  }
  if (m.clobTokenIds) {
    const ids =
      typeof m.clobTokenIds === "string"
        ? JSON.parse(m.clobTokenIds)
        : m.clobTokenIds;
    if (Array.isArray(ids) && ids.length >= 2) return [ids[0], ids[1]];
  }
  return null;
}

// Detect short-market duration from the question text (e.g. "BTC up in 5
// minutes"). Returns null when the question gives no duration hint, in which
// case the entry-window/hold-to-end filters are skipped for that market.
function parseDurationMs(question: string): number | null {
  const q = question.toLowerCase();
  const re = /(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h)\b/;
  const match = q.match(re);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2];
  if (unit.startsWith("s")) return n * 1000;
  if (unit.startsWith("h")) return n * 60 * 60 * 1000;
  return n * 60 * 1000; // minutes
}

function parseYesPrice(m: GammaMarket): number {
  try {
    const op =
      typeof m.outcomePrices === "string"
        ? JSON.parse(m.outcomePrices)
        : m.outcomePrices;
    if (Array.isArray(op) && op.length >= 1) return parseFloat(op[0]);
  } catch {}
  return 0.5;
}

// Deep-OTM / deep-ITM filter band. Markets where the YES mid-price is below
// MIN_PRICE or above 1-MIN_PRICE are skipped: at $0.01 the ask side is so
// thin that paper-mode "instant fills" don't reflect any liquidity that
// would exist in production, which was the root cause of the 141 trades at
// $0.01 entry described in paper-pnl-analysis.md.
const MIN_PRICE_BAND = parseFloat(process.env.BTC_MIN_PRICE_BAND || "0.10");

// Polymarket Gamma `tag_id` for the crypto vertical (verified empirically:
// `tag=crypto` is silently ignored by the API and returns NBA/NFL events; the
// documented filter is `tag_id`). Override-able if Polymarket renumbers tags.
const CRYPTO_TAG_ID = parseInt(process.env.POLYMARKET_CRYPTO_TAG_ID || "21", 10);

export async function findBtcMarkets(
  minOpenInterest: number = 500,
  minPriceBand: number = MIN_PRICE_BAND,
  // Open-position slugs that should bypass the OI / price-band filters.
  // Without this, a market whose price moved deep-OTM/deep-ITM after the
  // bot entered is silently dropped from the scan list — the Why? panel's
  // Live-Gates section then sees no scan-result match for the open
  // position and renders "no recent scan data". We always want to evaluate
  // gates for open positions so the operator can see "would I open this
  // right now?", regardless of where the price drifted.
  includeSlugs: string[] = [],
): Promise<MarketInfo[]> {
  const includeSet = new Set(includeSlugs);
  // Fetch crypto events from Gamma API. Note: `tag` (string) is NOT a valid
  // Gamma filter — it returns 200 OK but ignores the param, mixing in NBA/NFL
  // events. The documented param is `tag_id` (numeric). `closed=false` is
  // also pinned defensively even though it is the default.
  const url = `${GAMMA_API}/events?tag_id=${CRYPTO_TAG_ID}&active=true&closed=false&limit=30&order=volume24hr&ascending=false`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "EdgeCalc-AutoTrader/1.0" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);

  const events: GammaEvent[] = await res.json().then((d: any) =>
    Array.isArray(d) ? d : [],
  );

  const results: MarketInfo[] = [];
  const upperBand = 1 - minPriceBand;

  for (const evt of events) {
    for (const m of evt.markets || []) {
      const question = m.question || m.title || evt.title || "";
      const coin = detectCryptoUpDown(question, m.slug || "");
      if (!coin) continue;

      // Skip closed/expired
      if (m.closed === true) continue;
      if (m.endDate) {
        const end = new Date(m.endDate).getTime();
        if (end < Date.now()) continue;
      }

      // Parse token IDs
      const tokenIds = parseTokenIds(m);
      if (!tokenIds) continue;

      const isIncluded = includeSet.has(m.slug || "");

      // Check open interest / liquidity. Bypassed for open-position slugs.
      const oi = parseFloat(m.liquidityNum || m.liquidity || "0");
      if (oi < minOpenInterest && !isIncluded) continue;

      const yesPrice = parseYesPrice(m);

      // Skip deep-OTM (yes ≤ 0.10) or deep-ITM (yes ≥ 0.90) markets. These
      // are dominated by 1-2 share market-maker quotes; "fills" at the
      // top-of-book are unrealistic and inflate paper PnL.
      // Bypassed for open-position slugs so the Why? Live-Gates panel
      // always has fresh gate data for an already-open position.
      if ((yesPrice < minPriceBand || yesPrice > upperBand) && !isIncluded) continue;

      const vol24h = parseFloat(m.volume24hr || m.volume || "0");

      const durationMs = parseDurationMs(question);
      const endTs = m.endDate ? new Date(m.endDate).getTime() : NaN;
      const openedAtEstimate =
        durationMs && Number.isFinite(endTs)
          ? new Date(endTs - durationMs).toISOString()
          : undefined;

      results.push({
        slug: m.slug || "",
        conditionId: m.conditionId || "",
        questionId: m.questionID || "",
        title: question,
        clobTokenIds: tokenIds,
        currentPrice: yesPrice,
        openInterest: oi,
        volume24h: vol24h,
        endDate: m.endDate || "",
        active: true,
        coin,
        durationMs: durationMs ?? undefined,
        openedAtEstimate,
      });
    }
  }

  // Sort by volume, highest first
  results.sort((a, b) => b.volume24h - a.volume24h);

  return results;
}
