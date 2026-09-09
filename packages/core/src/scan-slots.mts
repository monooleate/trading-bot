// packages/core/src/scan-slots.mts
//
// Coin-diversified scan-slot selection for the crypto pillar — B57.
// Pure, zero I/O.
//
// WHY: the runner used to take `markets.slice(0, 3)` — the top three by Gamma's
// 24h volume. Measured 2026-09-09: of 171 live crypto markets, 154 are the
// `above-K` threshold type (bitcoin 77, ethereum 44, solana 33), but BTC owns
// the top FIVE volume slots — ethereum's best ranks #6 and solana does not
// appear in the top 12. So a pure volume cut hands every slot to BTC, and the
// B51 multi-coin work produced exactly 1 ethereum and 0 solana ledger rows in
// its first 26 hours.
//
// Volume ranking is still the right PRIMARY signal — it proxies liquidity,
// which the depth-aware fill model (B49 #1) depends on. This only reserves a
// minimum number of slots per coin so a high-volume coin cannot starve the
// others, then fills whatever is left strictly by volume.
//
// Deliberately NOT an "opportunity score": inventing an unvalidated ranking
// heuristic is precisely what the B56 measurement warned against (a plausible
// combiner "cleanup" measured WORSE). Reserving slots is a coverage decision,
// not a new alpha claim.

export interface ScanCandidate {
  slug: string;
  /** Base coin ("BTC" / "ETH" / "SOL"). Missing/blank groups under "" and is
   *  treated as one more coin, so non-tagged markets still get a fair share. */
  coin?: string;
}

export interface ScanSlotOptions {
  /** Total slots per tick. */
  windowSize: number;
  /** Slots reserved for each coin that has any candidate (before volume fill). */
  minPerCoin?: number;
}

const coinOf = (m: ScanCandidate) => (m?.coin ?? "").toUpperCase();

/**
 * Pick the scan slots from a volume-DESCENDING candidate list.
 *
 * Order of business:
 *   1. reserve up to `minPerCoin` slots for each coin, taking that coin's
 *      highest-volume markets first, visiting coins in the order they appear
 *      (i.e. by their best market's volume — so BTC is served first);
 *   2. fill any remaining slots strictly by volume from what is left.
 *
 * The result is returned in the input's volume order, so downstream code that
 * assumes "best first" is unaffected. With a single coin present, or
 * `minPerCoin` 0, this is exactly `slice(0, windowSize)` — the legacy
 * behaviour. Pure; never throws; never returns duplicates.
 */
export function selectScanSlots<T extends ScanCandidate>(
  markets: T[],
  { windowSize, minPerCoin = 1 }: ScanSlotOptions,
): T[] {
  const list = Array.isArray(markets) ? markets.filter((m) => m && typeof m.slug === "string") : [];
  const size = Math.max(0, Math.floor(windowSize));
  if (size === 0 || list.length === 0) return [];
  if (list.length <= size) return list.slice();

  const reserve = Math.max(0, Math.floor(minPerCoin));
  const picked = new Set<string>();

  if (reserve > 0) {
    // Coins in order of first appearance = order of their best market's volume.
    const byCoin = new Map<string, T[]>();
    for (const m of list) {
      const c = coinOf(m);
      const arr = byCoin.get(c);
      if (arr) arr.push(m);
      else byCoin.set(c, [m]);
    }
    // Round-robin so that with more coins than slots, each still gets its first
    // pick before any coin takes a second — otherwise BTC would consume the
    // whole reserve at minPerCoin > 1.
    for (let round = 0; round < reserve && picked.size < size; round++) {
      for (const [, ms] of byCoin) {
        if (picked.size >= size) break;
        const next = ms[round];
        if (next) picked.add(next.slug);
      }
    }
  }

  // Fill the remainder strictly by volume.
  for (const m of list) {
    if (picked.size >= size) break;
    picked.add(m.slug);
  }

  return list.filter((m) => picked.has(m.slug));
}
