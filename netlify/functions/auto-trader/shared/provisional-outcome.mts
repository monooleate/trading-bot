// netlify/functions/auto-trader/shared/provisional-outcome.mts
//
// Provisional win/loss for a still-pending Polymarket paper position — shared
// by every UMA-resolved bot (crypto, weather, sports).
//
// A "pending" position is past its endDate but Gamma hasn't reported a final
// resolution yet (UMA propose → dispute → finalize window). The OUTCOME is
// usually already decided though: a settled market prices the winning outcome
// at ≈1 and the loser at ≈0 well before UMA finalises. We read the CURRENT
// Polymarket market prices (REAL `outcomePrices` from Gamma — NOT a
// simulation) WITHOUT the `&closed=true` filter, so open-but-decided markets
// still return data, and map exactly like the resolvers do:
//
//   outcomePrices[0] = YES price (0..1).
//   YES ≥ 0.9 → YES outcome winning  → a YES position WON,  a NO position LOST.
//   YES ≤ 0.1 → NO  outcome winning  → a NO  position WON,  a YES position LOST.
//   in-between → not yet determinable ("pending").
//
// This is the same data source the bots use for ACTUAL settlement (since the
// 2026-05-10 simV3 fix, paper PnL == live PnL — real Polymarket resolution
// only). The badge just reads it EARLY. Cached 90s per conditionId so frequent
// status polls don't hammer Gamma.

import { getStore } from "@netlify/blobs";
import { GAMMA_API } from "./config.mts";

export type ProvisionalOutcome = "won" | "lost" | "pending";

const PROVISIONAL_TTL_MS = 90_000;
const STORE_NAME = "provisional-outcome";

// Pure classifier (unit-tested) — maps a YES price + position side to a
// provisional outcome. outcomePrices[0] = YES price (the resolver's mapping):
//   YES ≥ 0.9 → YES outcome winning ; YES ≤ 0.1 → NO outcome winning.
export function classifyProvisional(
  yes: number | null | undefined,
  direction: string,
): ProvisionalOutcome {
  if (yes == null || !Number.isFinite(yes)) return "pending";
  const dir = String(direction).toUpperCase();
  if (yes >= 0.9) return dir === "YES" ? "won" : "lost";
  if (yes <= 0.1) return dir === "NO"  ? "won" : "lost";
  return "pending";
}

async function fetchYesPrice(conditionId: string): Promise<number | null> {
  try {
    const url = `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    const arr = Array.isArray(data) ? data : ((data as any)?.data ?? []);
    const m = arr[0];
    if (!m) return null;
    const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (Array.isArray(op) && op.length >= 1) {
      const y = parseFloat(String(op[0]));
      return Number.isFinite(y) ? y : null;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Provisional outcome for one pending position.
 * @param conditionId Polymarket market conditionId (null/undefined → "pending")
 * @param direction   the position's side ("YES" | "NO")
 */
export async function probeProvisionalOutcome(
  conditionId: string | null | undefined,
  direction: string,
): Promise<ProvisionalOutcome> {
  if (!conditionId) return "pending";
  let yes: number | null = null;
  try {
    const store  = getStore(STORE_NAME);
    const cached = await store.getWithMetadata(conditionId);
    if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < PROVISIONAL_TTL_MS) {
      const v = parseFloat(cached.data as string);
      yes = Number.isFinite(v) ? v : null;
    } else {
      yes = await fetchYesPrice(conditionId);
      if (yes != null) await store.set(conditionId, String(yes), { metadata: { ts: Date.now() } });
    }
  } catch {
    yes = await fetchYesPrice(conditionId).catch(() => null);
  }
  return classifyProvisional(yes, direction);
}
