// netlify/functions/auto-trader/shared/cross-position-gates.mts
//
// Cross-market consistency primitives. Each of the 5 bots adds a
// per-bot gate to its decision-engine that compares the candidate trade
// against ALREADY-OPEN positions on the same session — so we don't open
// pairs that lose together by construction (e.g. NO @ 78K + YES @ 80K
// where the model's own probs are non-monotonic).
//
// Spec: cross-position-consistency gate — 2026-05-14 session.
//
// Only parsers + a couple of utility predicates live here; the gate
// objects themselves are built inline in each bot so the labels/hints
// can speak the bot's vocabulary (slug vs coin vs event).

/** Parse a Polymarket "BTC above K" slug. Returns { K, closingKey }. */
export function parseBtcAboveSlug(
  slug: string | undefined | null,
): { K: number; closingKey: string } | null {
  if (!slug) return null;
  // Tolerant pattern:
  //   bitcoin-above-78k-on-may-14
  //   btc-above-100k-on-2026-05-14
  //   will-bitcoin-be-above-80k-on-may-9
  const m = String(slug).toLowerCase().match(
    /(?:bitcoin|btc)-(?:be-)?above-(\d+(?:\.\d+)?)k(?:-on-(.+?))?$/,
  );
  if (!m) return null;
  const K = parseFloat(m[1]);
  if (!Number.isFinite(K)) return null;
  return { K, closingKey: m[2] || "" };
}

/**
 * Threshold monotonicity check between a candidate trade and one existing
 * position on the same (closingKey) group.
 *
 * Contract: for two BTC-above-Kx markets resolving at the same time,
 *   P(>K1) ≥ P(>K2)  ⟺  K1 ≤ K2.
 *
 * The bot's effective long-/short-side belief on a market is its
 * predictedProb-for-YES (regardless of which side it took). So:
 *   K_new > K_existing  ⇒  predNew  ≤ predExisting
 *   K_new < K_existing  ⇒  predNew  ≥ predExisting
 *
 * Returns the violating existing pair (so the caller can format a hint)
 * or null when consistent.
 */
export interface MonotonicityCandidate {
  K: number;
  closingKey: string;
  predictedYesProb: number;
}

export interface MonotonicityExisting {
  K: number;
  closingKey: string;
  predictedYesProb: number;
  slug: string;
}

export function findMonotonicityViolation(
  cand: MonotonicityCandidate,
  existing: MonotonicityExisting[],
): MonotonicityExisting | null {
  const EPS = 1e-6;
  for (const e of existing) {
    if (e.closingKey !== cand.closingKey) continue;
    if (cand.K === e.K) continue; // same K is not a monotonicity question
    if (cand.K > e.K && cand.predictedYesProb > e.predictedYesProb + EPS) return e;
    if (cand.K < e.K && cand.predictedYesProb < e.predictedYesProb - EPS) return e;
  }
  return null;
}
