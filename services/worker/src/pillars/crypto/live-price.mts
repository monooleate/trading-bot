// Lightweight Polymarket CLOB midpoint fetcher used by the live early-exit
// loop. Kept separate from execution.mts so it can run without initialising
// the signed clob-client (no POLY_PRIVATE_KEY required for read endpoints).
//
// Returns null when the CLOB endpoint is unreachable or returns a malformed
// payload — callers should treat null as "skip this exit check this tick"
// rather than synthesising a price.

import { CLOB_API } from "../shared/config.mts";

export async function fetchYesMidpoint(yesTokenId: string): Promise<number | null> {
  if (!yesTokenId) return null;
  try {
    const res = await fetch(`${CLOB_API}/midpoint?token_id=${encodeURIComponent(yesTokenId)}`, {
      headers: { Accept: "application/json", "User-Agent": "EdgeCalc-LivePrice/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const mid = parseFloat(data?.mid);
    if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) return null;
    return mid;
  } catch {
    return null;
  }
}
