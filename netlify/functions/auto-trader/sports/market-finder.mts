// netlify/functions/auto-trader/sports/market-finder.mts
//
// Polymarket sports market discovery. Pulls active sports events via
// the Gamma API, flattens to per-bucket binary markets, and filters
// for the bot's liquidity + duration thresholds.

import { GAMMA_API } from "../shared/config.mts";
import type { SportsMarket, SportsLeague } from "./types.mts";

const FETCH_TIMEOUT = 8000;

// Question patterns matching mutex tournament/award markets where the
// underlying outcome space is exclusive — only ONE team/player wins the
// championship, MVP, etc. On Polymarket these often appear as ONE event
// per candidate ("Will Arsenal win the 2025-26 EPL?" — 1 market each),
// so the event-level liveCount filter doesn't catch them. The
// contrarian fan-bias fade is invalid here: implied YES prices sum to
// 1.0 across all candidates, and a sub-15¢ YES is a RATIONAL long-tail
// prior, not bias.
const MUTEX_QUESTION_PATTERNS: RegExp[] = [
  /\bwin\s+the\s+\d{4}(?:[-–]\d{2,4})?\b/i,                // "win the 2026" / "win the 2025-26"
  /\bwin\s+the\s+(?:nba|nfl|mlb|nhl|epl|premier\s+league|champions\s+league|world\s+cup|world\s+series|stanley\s+cup|super\s+bowl|nba\s+finals?)\b/i,
  /\bmvp\b/i,                                              // any MVP race
  /\b(?:player|rookie|coach)\s+of\s+the\s+(?:year|month)\b/i,
  /\bchampion(?:ship)?\s+winner\b/i,
  /\bdivision\s+(?:champion|winner)\b/i,
  /\b(?:conference|league)\s+(?:champion|winner)\b/i,
  /\bfinals?\s+(?:winner|champion|mvp)\b/i,
  /\bplayer\s+won\s+the\b/i,
  /\bto\s+win\s+(?:the\s+)?(?:nba|nfl|mlb|nhl|epl|premier|champions|world)/i,
];

export function isMutexQuestion(q: string): boolean {
  return MUTEX_QUESTION_PATTERNS.some((p) => p.test(q));
}

// League detection from question text. Returns "Other" if no match —
// the bot still considers these markets but reports a generic label.
function detectLeague(q: string): SportsLeague {
  const lower = q.toLowerCase();
  if (/\bnba\b|basketball/.test(lower))             return "NBA";
  if (/\bnfl\b|super bowl|american football/.test(lower)) return "NFL";
  if (/\bmlb\b|world series|baseball/.test(lower))  return "MLB";
  if (/\bnhl\b|stanley cup|hockey/.test(lower))     return "NHL";
  if (/premier league|epl\b/.test(lower))            return "EPL";
  if (/champions league|ucl\b/.test(lower))          return "UCL";
  return "Other";
}

interface FinderOptions {
  minVolume24h:   number;
  minHoursToEnd:  number;
  /** Max hours until market end-date — prevents long-dated futures (e.g.
   *  "Who wins the 2026 NBA championship?") from blocking the open-position
   *  slots indefinitely. Settings-tunable. */
  maxHoursToEnd?: number;
  maxMarkets?:    number;          // default 30
  /** Skip events with more than this many sub-markets — these are mutex
   *  multi-outcome events (FIFA WC 32-way winner, NBA Finals 16-way, etc.)
   *  where contrarian fan-bias fade cannot apply (only ONE outcome wins,
   *  so the implied probabilities sum to 1.0 and there's no fan-bias
   *  asymmetry — Switzerland @ 1.2¢ for WC is RATIONAL, not bias). */
  maxMarketsPerEvent?: number;     // default 3
}

export async function findSportsMarkets(opts: FinderOptions): Promise<SportsMarket[]> {
  // Gamma's `tag=sports` is the documented way. Falls back to keyword
  // filtering if the tag returns nothing (Gamma occasionally drops tags
  // on negRisk markets).
  const taggedUrl =
    `${GAMMA_API}/events?tag_slug=sports&closed=false&active=true&limit=80&order=volume24hr&ascending=false`;
  const fallbackUrl =
    `${GAMMA_API}/events?closed=false&active=true&limit=120&order=volume24hr&ascending=false`;

  let events: any[] = [];
  for (const url of [taggedUrl, fallbackUrl]) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "EdgeCalc-Sports/1.0" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) continue;
      const data = await res.json();
      events = Array.isArray(data) ? data : (data?.data ?? []);
      if (events.length > 0) break;
    } catch { /* try next */ }
  }
  if (events.length === 0) return [];

  const now = Date.now();
  const minEnd = now + opts.minHoursToEnd * 3_600_000;
  const maxEnd = typeof opts.maxHoursToEnd === "number" && Number.isFinite(opts.maxHoursToEnd)
    ? now + opts.maxHoursToEnd * 3_600_000
    : Number.POSITIVE_INFINITY;
  const out: SportsMarket[] = [];

  for (const evt of events) {
    const eventSlug = String(evt.slug || "");
    const tags: any[] = Array.isArray(evt.tags) ? evt.tags : [];
    const isSportsTagged = tags.some(
      (t) => /^sport/i.test(typeof t === "string" ? t : (t?.slug || t?.label || "")),
    );
    const evtQuestion = String(evt.title || evt.description || "");

    // If the tag filter returned an event without a sports tag (fallback
    // path), check the title heuristically before accepting it.
    if (!isSportsTagged) {
      const looksLikeSports = /\b(nba|nfl|mlb|nhl|premier|champions|fifa|world cup|basketball|football|baseball|hockey|soccer)\b/i
        .test(evtQuestion);
      if (!looksLikeSports) continue;
    }

    const markets: any[] = Array.isArray(evt.markets) ? evt.markets : [];

    // Mutex-events gate (2026-05-11 (k)): skip multi-outcome events
    // where each sub-market is mutually exclusive with the others (only
    // ONE outcome wins). FIFA WC has 32 country-markets; NBA Finals has
    // 16 team-markets. The implied probabilities sum to 1.0 across the
    // group, so individual sub-market YES prices are RATIONAL priors,
    // NOT fan-bias. Buying YES @ 1.2¢ on Switzerland-wins-WC is a
    // long-tail losing bet, not edge.
    //
    // Binary moneyline match events have 1 market; 3-way soccer (home/
    // draw/away) might surface as 1 multi-outcome market or 3 binary —
    // a count of ≤ 3 covers both. Anything above is mutex.
    const liveCount = markets.filter((m: any) =>
      m && m.closed !== true && m.active !== false).length;
    const muxCap = opts.maxMarketsPerEvent ?? 3;
    if (liveCount > muxCap) {
      continue;
    }

    for (const m of markets) {
      if (m.closed === true || m.active === false) continue;

      const question = String(m.question || m.title || evtQuestion);

      // Per-market mutex question filter (2026-05-11 (l)): even if the
      // event has only 1 sub-market, the underlying outcome may be
      // mutex with other separate events — e.g. "Will Arsenal win
      // 2025-26 EPL?" + "Will Man City win 2025-26 EPL?" are two
      // independent events but exclusive outcomes. Block by keyword
      // pattern.
      if (isMutexQuestion(question)) continue;

      // End-date gate: skip markets too close to OR too far from settlement.
      // The min bound avoids last-minute liquidity drops; the max bound
      // prevents long-dated futures (championship winners, season MVP) from
      // hogging the limited open-position slots for weeks.
      const endDate = String(m.endDate || "");
      if (!endDate) continue;
      const endTs = new Date(endDate).getTime();
      if (!Number.isFinite(endTs) || endTs < minEnd) continue;
      if (endTs > maxEnd) continue;

      // Liquidity gate.
      const vol24 = parseFloat(m.volume24hr || m.volume || "0");
      if (!Number.isFinite(vol24) || vol24 < opts.minVolume24h) continue;

      // CLOB token IDs.
      let yesToken = "", noToken = "";
      try {
        const ids = typeof m.clobTokenIds === "string"
          ? JSON.parse(m.clobTokenIds)
          : m.clobTokenIds;
        if (Array.isArray(ids) && ids.length >= 2) {
          yesToken = String(ids[0]);
          noToken  = String(ids[1]);
        }
      } catch { /* skip */ }
      if (!yesToken || !noToken) continue;

      // Outcome prices.
      let yp = 0.5, np = 0.5;
      try {
        const op = typeof m.outcomePrices === "string"
          ? JSON.parse(m.outcomePrices)
          : m.outcomePrices;
        if (Array.isArray(op) && op.length >= 2) {
          yp = parseFloat(String(op[0]));
          np = parseFloat(String(op[1]));
        }
      } catch { /* skip */ }
      if (!Number.isFinite(yp) || !Number.isFinite(np)) continue;
      // Skip already-resolved (price snapped to extremes).
      if (yp <= 0.001 || yp >= 0.999) continue;

      out.push({
        slug:          String(m.slug || ""),
        conditionId:   String(m.conditionId || ""),
        question,
        league:        detectLeague(question),
        yesTokenId:    yesToken,
        noTokenId:     noToken,
        yesPrice:      yp,
        noPrice:       np,
        volume24h:     vol24,
        liquidity:     parseFloat(m.liquidityNum || m.liquidity || "0"),
        endDate,
        eventSlug,
      });
      if (opts.maxMarkets && out.length >= opts.maxMarkets) return out;
    }
  }
  return out;
}
