// services/worker/src/pillars/shared/clob-book.mts
//
// Keyless CLOB order-book fetch for the paper fill model (B49 #1 / T3). The
// live execution path uses the authenticated ClobClient; the paper path needs
// the book WITHOUT credentials, so this hits the public REST endpoint directly
// (same pattern the signal-combiner orderflow signal uses). Exception-safe:
// returns null on any failure so the caller falls back to the sqrt-law haircut.

import { CLOB_API } from "./config.mts";
import type { BookLevel } from "@core/fill-model.mts";

export interface ClobBook {
  asks: BookLevel[];
  bids: BookLevel[];
}

/**
 * Fetch the public CLOB order book for a token id. Returns parsed ask/bid
 * levels ({price, size} in shares) or null on any error/empty book. 5s timeout.
 */
export async function fetchClobBook(tokenId: string): Promise<ClobBook | null> {
  if (!tokenId) return null;
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`, {
      headers: { Accept: "application/json", "User-Agent": "EdgeCalc-FillModel/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as any;
    const parse = (arr: any): BookLevel[] =>
      Array.isArray(arr)
        ? arr
            .map((l: any) => ({ price: parseFloat(l?.price), size: parseFloat(l?.size) }))
            .filter((l: BookLevel) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
        : [];
    const asks = parse(raw?.asks);
    const bids = parse(raw?.bids);
    if (asks.length === 0 && bids.length === 0) return null;
    return { asks, bids };
  } catch {
    return null;
  }
}
