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

/**
 * Outcome-overlap (side-bet contradiction) check between a candidate trade
 * and one existing position on the same (closingKey) group.
 *
 * Trigger: 2026-05-15 paper session — model predicted P(>78K)=46.09%,
 * P(>80K)=46.04%, P(>82K)=45.57% (strictly monotone, monotonicity gate
 * passes), yet the bot opened NO @ 78K, NO @ 80K, AND YES @ 82K. NO@80K
 * wins iff BTC ≤ $80K; YES@82K wins iff BTC > $82K. The two winning zones
 * are disjoint, and the $80K < BTC ≤ $82K band is a guaranteed
 * double-loss zone for the pair.
 *
 * Contract: for two BTC-above-Kx markets resolving at the same time,
 *   - YES @ K_hi wins ⇔ BTC > K_hi
 *   - NO  @ K_lo wins ⇔ BTC ≤ K_lo
 * If K_hi > K_lo, both winning conditions cannot be true simultaneously,
 * and the (K_lo, K_hi] band is double-loss.
 *
 * Violation patterns (returns the existing offending position):
 *   - candidate YES @ K_cand AND existing NO @ K_existing with K_cand > K_existing
 *   - candidate NO  @ K_cand AND existing YES @ K_existing with K_cand < K_existing
 *
 * Consistent (returns null):
 *   - same direction on both K's (YES@K_lo + YES@K_hi: both win if BTC > K_hi)
 *   - winning zones overlap (e.g. YES@K_lo + NO@K_hi with K_hi > K_lo:
 *     overlap zone is K_lo < BTC ≤ K_hi where both win)
 *
 * Note: this is structurally distinct from the monotonicity check above.
 * Monotonicity inspects the model's *probabilities* for internal coherence;
 * outcome-overlap inspects the *side bets themselves* for mutually exclusive
 * winning conditions. Both gates fire independently — today's incident
 * cleared monotonicity but tripped outcome-overlap.
 */
export interface OutcomeOverlapCandidate {
  K: number;
  closingKey: string;
  direction: "YES" | "NO";
}

export interface OutcomeOverlapExisting {
  K: number;
  closingKey: string;
  direction: "YES" | "NO";
  slug: string;
}

export function findOutcomeOverlapViolation(
  cand: OutcomeOverlapCandidate,
  existing: OutcomeOverlapExisting[],
): OutcomeOverlapExisting | null {
  for (const e of existing) {
    if (e.closingKey !== cand.closingKey) continue;
    if (cand.K === e.K) continue; // same K + opposite direction is a separate flag elsewhere
    // Pattern A: candidate YES on higher K, existing NO on lower K
    if (cand.direction === "YES" && e.direction === "NO" && cand.K > e.K) return e;
    // Pattern B: candidate NO on lower K, existing YES on higher K
    if (cand.direction === "NO" && e.direction === "YES" && cand.K < e.K) return e;
  }
  return null;
}
