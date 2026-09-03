// packages/core/src/oi-delta.mts
//
// Open-Interest-change × price signal — model-discovery-expansion §4.D (B49 #5),
// the TOP new uncorrelated signal. Pure, portable (zero I/O; the Binance OI
// fetch + coin parsing live in the combiner's getOiDeltaSignal).
//
// WHY: the existing `orderflow` signal reads PASSIVE top-of-book imbalance
// (resting liquidity). Open interest measures the POSITION LIFECYCLE (contracts
// opened vs closed) — orthogonal information. The classic leverage-flow read is
// the OI-Δ × price quadrant:
//   • price↑ + OI↑  = fresh longs   → trend CONFIRMED (new money in the move)
//   • price↑ + OI↓  = short-covering → weak rally (positions closing, fades)
//   • price↓ + OI↑  = fresh shorts   → down-move CONFIRMED
//   • price↓ + OI↓  = long unwind    → weak sell-off (deleveraging, may bounce)
// So RISING OI confirms/strengthens the recent price move; FALLING OI means the
// move is just position-closing → discount it. Free Binance data, natively
// multi-coin (the cleanest path off the BTC-hardcode — new-strategies #3).
//
// Output is P(up) ∈ [lo,hi] on the SAME target the combiner uses (P(YES/up)).
// Default-OFF at the call site (measure-first): the anti-overfit rule says the
// 8-signal combiner does not grow live until measured, so getOiDeltaSignal
// returns null unless the operator enables it.

export type OiQuadrant =
  | "fresh_longs"      // price↑ OI↑
  | "short_covering"   // price↑ OI↓
  | "fresh_shorts"     // price↓ OI↑
  | "long_unwind"      // price↓ OI↓
  | "neutral";         // negligible price move

/**
 * Classify the OI-Δ × price quadrant. `priceReturn` and `oiChange` are fractional
 * (0.02 = +2%). A price move below `flat` is "neutral" (no directional read). Pure.
 */
export function classifyOiQuadrant(
  priceReturn: number,
  oiChange: number,
  flat = 0.0005,
): OiQuadrant {
  if (!Number.isFinite(priceReturn) || Math.abs(priceReturn) < flat) return "neutral";
  const up = priceReturn > 0;
  const oiUp = oiChange >= 0;
  if (up && oiUp) return "fresh_longs";
  if (up && !oiUp) return "short_covering";
  if (!up && oiUp) return "fresh_shorts";
  return "long_unwind";
}

export interface OiDeltaOpts {
  /** Tilt scale applied to the (capped) price return. Default 8. */
  scale?: number;
  /** Cap on |priceReturn| so a spike doesn't peg the signal. Default 0.05 (5%). */
  prCap?: number;
  /** Multiplier when OI is FALLING (move is position-closing → weak). Default 0.3. */
  confDampen?: number;
  /** Output clamp. Default [0.05, 0.95]. */
  lo?: number;
  hi?: number;
  /** Below this |priceReturn| the signal is neutral (returns 0.5). Default 0.0005. */
  flat?: number;
}

/**
 * P(up) from the OI-Δ × price quadrant. Rising OI confirms the price move
 * (full tilt); falling OI dampens it (the move is unwind, not conviction).
 *   prob = clamp( 0.5 + sign(pr)·min(|pr|,cap)·scale·conf , lo, hi )
 * with conf = 1 when OI rising, `confDampen` when falling. Neutral price move
 * → 0.5. Pure. Returns NaN on invalid input.
 */
export function oiDeltaProb(
  priceReturn: number,
  oiChange: number,
  opts: OiDeltaOpts = {},
): number {
  const scale = opts.scale ?? 8;
  const prCap = opts.prCap ?? 0.05;
  const confDampen = opts.confDampen ?? 0.3;
  const lo = opts.lo ?? 0.05;
  const hi = opts.hi ?? 0.95;
  const flat = opts.flat ?? 0.0005;
  if (!Number.isFinite(priceReturn) || !Number.isFinite(oiChange)) return NaN;
  if (Math.abs(priceReturn) < flat) return 0.5;

  const pr = Math.sign(priceReturn) * Math.min(Math.abs(priceReturn), prCap);
  const conf = oiChange >= 0 ? 1 : confDampen;
  const prob = 0.5 + pr * scale * conf;
  return Math.min(hi, Math.max(lo, prob));
}
