// netlify/functions/auto-trader/shared/devig.mts
//
// Bookmaker de-vigging — model-discovery §7 #9 (sports fair-value fix, B37).
// Pure, portable.
//
// WHY: the sports bot's "fair value" is FABRICATED — it shrinks the Polymarket
// price toward 0.5 (`predicted = 0.5 + (yp−0.5)·f`). That is circular (betting
// against the market using the market's own price) → no real edge source
// (~10% WR, evGap −$2677). The fix: use PINNACLE sharp closing odds as the fair
// value. Pinnacle is the sharpest book (low margin, high limits) → the de-facto
// market truth. But raw odds embed the VIG (margin): the raw implied
// probabilities q_i = 1/odds_i sum to > 1 (the overround). De-vigging removes
// the margin to recover the true probabilities that sum to 1.
//
// Methods:
//   • Multiplicative (proportional): p_i = q_i / Σq_j. Standard, robust baseline.
//   • Power: find k with Σ q_i^k = 1, then p_i = q_i^k. Corrects favorite-longshot
//     bias (longshots over-bet → their true prob is lower than implied) better
//     than multiplicative.
//   • Shin (insider-trading model) is the theoretical best for FLB but needs an
//     iterative solve — a follow-up; power captures most of the benefit.

/** Raw implied probabilities q_i = 1/odds_i from decimal odds. NaN for odds ≤ 1. */
export function impliedFromDecimal(odds: number[]): number[] {
  return odds.map((o) => (Number.isFinite(o) && o > 1 ? 1 / o : NaN));
}

/** Overround (booksum) Σ 1/odds_i — > 1 when the book carries a positive margin. */
export function overround(odds: number[]): number {
  return impliedFromDecimal(odds).reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
}

/**
 * Multiplicative (proportional) de-vig: p_i = q_i / Σq_j. Returns fair
 * probabilities summing to 1 (NaN entries dropped from the sum). Pure.
 */
export function devigMultiplicative(odds: number[]): number[] {
  const q = impliedFromDecimal(odds);
  const sum = q.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
  if (!(sum > 0)) return odds.map(() => NaN);
  return q.map((x) => (Number.isFinite(x) ? x / sum : NaN));
}

/**
 * Power de-vig: solve Σ q_i^k = 1 (bisection on k), then p_i = q_i^k. Corrects
 * favorite-longshot bias. Falls back to multiplicative when the book has no
 * positive margin (overround ≤ 1) or fewer than 2 valid legs. Pure.
 */
export function devigPower(odds: number[]): number[] {
  const q = impliedFromDecimal(odds);
  const valid = q.filter((x) => Number.isFinite(x)) as number[];
  const or = valid.reduce((s, x) => s + x, 0);
  if (valid.length < 2 || or <= 1) return devigMultiplicative(odds);
  // f(k) = Σ q_i^k − 1 is decreasing in k (each q_i < 1); f(1) = overround−1 > 0.
  const f = (k: number) => valid.reduce((s, x) => s + Math.pow(x, k), 0) - 1;
  let lo = 1, hi = 1;
  while (f(hi) > 0 && hi < 1e6) hi *= 2;     // expand until f(hi) < 0
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  return q.map((x) => (Number.isFinite(x) ? Math.pow(x, k) : NaN));
}

export type DevigMethod = "multiplicative" | "power";

/**
 * Fair YES probability for a binary (2-way) market from the two decimal odds,
 * de-vigged. `oddsYes` / `oddsNo` are the sharp book's decimal odds for the YES
 * and NO outcomes. Returns the de-vigged P(YES) in (0,1), or NaN on bad input.
 * Pure.
 */
export function twoWayFairYes(
  oddsYes: number,
  oddsNo: number,
  method: DevigMethod = "multiplicative",
): number {
  if (!(oddsYes > 1) || !(oddsNo > 1)) return NaN;
  const p = method === "power"
    ? devigPower([oddsYes, oddsNo])
    : devigMultiplicative([oddsYes, oddsNo]);
  return Number.isFinite(p[0]) ? p[0] : NaN;
}

/**
 * Fair YES probability from AMERICAN odds (e.g. −150 / +130). Converts to
 * decimal then de-vigs. Convenience for feeds that quote American. Pure.
 */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return NaN;
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}
