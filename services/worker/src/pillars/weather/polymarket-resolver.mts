// netlify/functions/auto-trader/weather/polymarket-resolver.mts
//
// Polymarket-side settlement check for weather paper positions.
//
// Polymarket is the *authoritative* source for whether our bet would have
// won, because the market's own resolution criteria (which observation,
// which station, dispute handling) decide the payout in a real trade.
//
// When a sub-market settles cleanly:
//   - `closed: true`
//   - `outcomePrices` becomes ["1.0", "0.0"] (YES won) or ["0.0", "1.0"] (NO won)
//   - `umaResolutionStatus: "resolved"` (post-dispute window)
//   - `acceptingOrders: false`
//
// We query the Gamma `/markets/{conditionId}` endpoint per position. If the
// sub-market hasn't settled yet, we return null and let the caller fall
// back to METAR. If it has settled, we return the YES price (0 or 1) so
// the position closes with the exact same PnL as a real bet would have had.
//
// Defensive bar (2026-05-10 (i)):
//   Two paper trades closed with fake "wins" because the resolver accepted
//   a transient `closed=true, op=['0','1']` snapshot before UMA finalised
//   the result. UMA can propose, get disputed, and re-propose with a flipped
//   answer — during the dispute window the market may briefly look "closed".
//   We now require `umaResolutionStatus === "resolved"` as an extra safety
//   gate so we only accept fully-finalised resolutions. Markets in
//   `proposed`/`disputed`/`challenged` states return null → fall back to
//   METAR (more reliable) or wait.

import { GAMMA_API } from "../shared/config.mts";

const TIMEOUT = 8000;

// UMA states we treat as "not yet final". Anything other than these is
// either fully resolved or the field is missing on legacy markets — both
// fall through to the price-based isResolved check below.
const UMA_PENDING_STATES = new Set([
  "proposed",
  "disputed",
  "challenged",
  "settled_pending",   // some Polymarket negRisk markets show this transiently
]);

export interface PolymarketResolution {
  conditionId:     string;
  closed:          boolean;
  yesResolvedPrice: number;        // 0 or 1 once settled
  noResolvedPrice:  number;        // 0 or 1 once settled
  source:          "polymarket";
  fetchedAt:       string;
  resolvedSlug:    string;         // returned market slug — caller verifies it
                                   // matches the position's event slug to defend
                                   // against conditionId-bucket mismatches.
}

/**
 * Fetch the resolution state of a Polymarket sub-market by conditionId.
 * Returns null when the market is not yet settled, when the request fails,
 * or when the response shape is unexpected. Never throws.
 */
export async function fetchPolymarketResolution(
  conditionId: string,
): Promise<PolymarketResolution | null> {
  if (!conditionId) return null;

  // `closed=true` is required: without it Gamma hides resolved markets and
  // the response is `[]` even for legit conditionIds. This was the silent
  // bug in v2 of the crypto paper-resolver too.
  const url = `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}&closed=true`;

  let raw: any;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "EdgeCalc-Weather/1.0" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    raw = await res.json();
  } catch {
    return null;
  }

  // Gamma's /markets endpoint returns either a single object, an array, or a
  // wrapped { data: [...] } depending on filter shape; normalise.
  const arr = Array.isArray(raw) ? raw : (raw?.data ?? raw?.markets ?? []);
  const m = Array.isArray(arr) ? arr[0] : arr;
  if (!m || typeof m !== "object") return null;

  let prices: number[] = [];
  try {
    const op = typeof m.outcomePrices === "string"
      ? JSON.parse(m.outcomePrices)
      : m.outcomePrices;
    if (Array.isArray(op)) prices = op.map((p: any) => parseFloat(p));
  } catch {}

  const yes = prices[0];
  const no  = prices[1];
  if (!Number.isFinite(yes) || !Number.isFinite(no)) return null;

  // ─── UMA finality gate (2026-05-10 (i) defensive fix) ──────────────
  // Even with closed=true, if UMA hasn't reached final "resolved" state we
  // can't trust the prices — they may flip during the dispute window.
  const umaStatus = String(m.umaResolutionStatus || "").toLowerCase();
  if (UMA_PENDING_STATES.has(umaStatus)) {
    console.warn(
      `[polymarket-resolver] skipping ${conditionId.slice(0, 12)}…: ` +
      `closed=true but umaResolutionStatus="${umaStatus}" — waiting for finality`,
    );
    return null;
  }

  // Polymarket sets outcomePrices to a binary {0,1} once a market resolves.
  // 0.001 tolerance matches the crypto paper-resolver's convention and
  // guards against string-parsing artefacts.
  const closed = m.closed === true;
  const isResolved = closed && (yes <= 0.001 || yes >= 0.999);
  if (!isResolved) return null;

  // Snap to clean 0/1 so the position close gets exact PnL.
  const yesSnap = yes >= 0.999 ? 1 : 0;
  const noSnap  = 1 - yesSnap;

  return {
    conditionId,
    closed:           true,
    yesResolvedPrice: yesSnap,
    noResolvedPrice:  noSnap,
    source:           "polymarket",
    fetchedAt:        new Date().toISOString(),
    resolvedSlug:     String(m.slug || ""),
  };
}
