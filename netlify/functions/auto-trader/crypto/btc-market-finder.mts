import { GAMMA_API } from "../shared/config.mts";
import type { MarketInfo } from "../shared/types.mts";

/**
 * Find active BTC Up/Down markets on Polymarket via Gamma API.
 * Targets short-duration (5m, 15m) binary markets.
 */

const BTC_KEYWORDS = ["btc", "bitcoin"];
const UPDOWN_KEYWORDS = ["up", "down", "above", "below"];

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

function isBtcUpDown(question: string): boolean {
  const q = question.toLowerCase();
  const hasBtc = BTC_KEYWORDS.some((kw) => q.includes(kw));
  const hasUpDown = UPDOWN_KEYWORDS.some((kw) => q.includes(kw));
  return hasBtc && hasUpDown;
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

export async function findBtcMarkets(
  minOpenInterest: number = 500,
): Promise<MarketInfo[]> {
  // Fetch crypto events from Gamma API
  const url = `${GAMMA_API}/events?tag=crypto&limit=30&order=volume24hr&ascending=false&active=true`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "EdgeCalc-AutoTrader/1.0" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);

  const events: GammaEvent[] = await res.json().then((d: any) =>
    Array.isArray(d) ? d : [],
  );

  const results: MarketInfo[] = [];

  for (const evt of events) {
    for (const m of evt.markets || []) {
      const question = m.question || m.title || evt.title || "";
      if (!isBtcUpDown(question)) continue;

      // Skip closed/expired
      if (m.closed === true) continue;
      if (m.endDate) {
        const end = new Date(m.endDate).getTime();
        if (end < Date.now()) continue;
      }

      // Parse token IDs
      const tokenIds = parseTokenIds(m);
      if (!tokenIds) continue;

      // Check open interest / liquidity
      const oi = parseFloat(m.liquidityNum || m.liquidity || "0");
      if (oi < minOpenInterest) continue;

      const yesPrice = parseYesPrice(m);
      const vol24h = parseFloat(m.volume24hr || m.volume || "0");

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
      });
    }
  }

  // Sort by volume, highest first
  results.sort((a, b) => b.volume24h - a.volume24h);

  return results;
}
