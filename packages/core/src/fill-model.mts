// packages/core/src/fill-model.mts
//
// Depth-aware fill model — model-discovery-expansion §4.A / sprints.md B49 #1.
// Pure, portable (zero I/O). The book FETCH lives in the worker execution layer;
// this module only does the math, so it is unit-testable and reused by every
// Polymarket-fill bot (crypto, weather, sports).
//
// WHY: the paper engine currently books `filledShares = sizeUSDC / price` at the
// full requested size, at the displayed price, with NO depth check
// (crypto/execution.mts placeBuyOrder paper branch). On a 5¢ longshot a $200
// order becomes 4000 shares regardless of whether the book holds them; at
// settlement those phantom shares are paid $1 each → the documented +157%-type
// paper-PnL inflation on thin/tail markets. The rigorous Polymarket data
// (arXiv 2606.04217) shows the tail is *overpriced* (negative realized return)
// AND thinnest (Gini 0.970 — one maker can be 84% of depth and pull on adverse
// flow), so a full-size touch fill is doubly wrong. This module walks the real
// ask book, caps participation per level, books partial fills, and never credits
// the unfillable remainder. When no book is available it degrades to a
// square-root market-impact haircut instead of a free full fill.
//
// A BUY consumes the ASK side (lowest price first). Sizes are in SHARES
// (Polymarket CLOB `/book` returns `{price, size}` with size = shares at that
// level). Requested quantity is a USDC notional (the bots size in dollars).

export interface BookLevel {
  price: number; // price per share, (0,1) for a Polymarket outcome token
  size: number;  // shares available at this level
}

export interface DepthFillOpts {
  /** Fraction of each level's visible size we allow ourselves to take
   *  (adverse-selection / thin-book realism). Default 0.20. */
  participationCap?: number;
  /** Hard cap on how many levels to walk (safety against pathological books). */
  maxLevels?: number;
}

export interface DepthFillResult {
  ok: boolean;
  /** Shares actually filled after the depth walk + participation cap. */
  filledShares: number;
  /** USDC actually spent (Σ shares_i · price_i). ≤ requestedUsdc. */
  filledUsdc: number;
  /** Volume-weighted average fill price (filledUsdc / filledShares), NaN if none. */
  vwap: number;
  /** filledUsdc / requestedUsdc ∈ [0,1] — how much of the order the book absorbed. */
  fillFraction: number;
  /** True when the book could not absorb the full requested notional. */
  partial: boolean;
  /** Number of ask levels consumed (for transparency/logging). */
  levelsConsumed: number;
  detail?: string;
}

const EPS = 1e-9;

/**
 * Walk the ask book for a BUY, capping participation per level, and return the
 * realistic fill. Pure. `asks` may be in any order — sorted ascending by price
 * internally (best = lowest ask). Levels with non-positive/NaN price or size are
 * skipped. Returns ok=false only when NOTHING can fill (empty/invalid book or
 * non-positive request), so the caller can fall back to the square-root haircut.
 */
export function simulateDepthFill(
  asks: BookLevel[],
  requestedUsdc: number,
  opts: DepthFillOpts = {},
): DepthFillResult {
  const cap = clamp(opts.participationCap ?? 0.2, EPS, 1);
  const maxLevels = opts.maxLevels ?? 500;

  const none: DepthFillResult = {
    ok: false, filledShares: 0, filledUsdc: 0, vwap: NaN,
    fillFraction: 0, partial: true, levelsConsumed: 0,
  };
  if (!(requestedUsdc > 0)) return { ...none, detail: "non-positive requestedUsdc" };

  const levels = (asks ?? [])
    .filter((l) => l && l.price > 0 && l.price < 1 + EPS && l.size > 0 && Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => a.price - b.price)
    .slice(0, maxLevels);
  if (levels.length === 0) return { ...none, detail: "empty/invalid ask book" };

  let filledShares = 0;
  let filledUsdc = 0;
  let remaining = requestedUsdc;
  let levelsConsumed = 0;

  for (const lvl of levels) {
    if (remaining <= EPS) break;
    const takeableShares = lvl.size * cap;          // participation cap per level
    const costFull = takeableShares * lvl.price;
    levelsConsumed++;
    if (costFull <= remaining + EPS) {
      // Consume the whole (capped) level.
      filledShares += takeableShares;
      filledUsdc += costFull;
      remaining -= costFull;
    } else {
      // Partially consume this level: spend exactly the remaining notional.
      const partialShares = remaining / lvl.price;   // ≤ takeableShares by construction
      filledShares += partialShares;
      filledUsdc += remaining;
      remaining = 0;
      break;
    }
  }

  if (!(filledShares > 0)) return { ...none, detail: "no fillable depth within cap" };

  const vwap = filledUsdc / filledShares;
  const fillFraction = clamp(filledUsdc / requestedUsdc, 0, 1);
  return {
    ok: true,
    filledShares,
    filledUsdc,
    vwap,
    fillFraction,
    partial: filledUsdc < requestedUsdc - 1e-6,
    levelsConsumed,
  };
}

/**
 * Square-root market-impact fractional price move (Almgren/Gatheral):
 *   I(Q) = Y · σ · √(Q / V)
 * Q, V in the same unit (shares or notional); σ the horizon vol; Y ≈ 1.
 * Returns a non-negative fractional impact (e.g. 0.03 = +3% on the ref price).
 * Fallback for a BUY fill when the book snapshot is unavailable — apply on the
 * ADVERSE side (raise the buy price) so the fallback is never optimistic. Pure.
 */
export function sqrtLawImpact(sigma: number, qty: number, adv: number, y = 1): number {
  if (!(sigma > 0 && qty > 0 && adv > 0 && y > 0)) return 0;
  return y * sigma * Math.sqrt(qty / adv);
}

/**
 * Build a conservative fallback fill when no order book is available: apply a
 * square-root impact haircut to the reference (already tick-worse) buy price and
 * assume the full notional fills at that worse VWAP. If σ/ADV are unknown, pass a
 * flat `flatHaircut` (e.g. 0.02) instead — never a free full fill at ref price.
 * Pure.
 */
export function fallbackFill(
  referencePrice: number,
  requestedUsdc: number,
  haircut: number,
): DepthFillResult {
  const none: DepthFillResult = {
    ok: false, filledShares: 0, filledUsdc: 0, vwap: NaN,
    fillFraction: 0, partial: true, levelsConsumed: 0,
  };
  if (!(referencePrice > 0 && requestedUsdc > 0)) return { ...none, detail: "invalid fallback input" };
  const vwap = Math.min(0.999, referencePrice * (1 + Math.max(0, haircut)));
  const filledShares = requestedUsdc / vwap;
  return {
    ok: true,
    filledShares,
    filledUsdc: requestedUsdc,
    vwap,
    fillFraction: 1,
    partial: false,
    levelsConsumed: 0,
    detail: "sqrt-law/flat fallback (no book)",
  };
}

// ─── Tick / min-size validity (T5 helpers) ──────────────────────────────────

/**
 * Polymarket tick size tightens at the extremes. The exact grid is per-market
 * (read from `/tick-size`); this returns the DEFAULT grid used when the API
 * value is unavailable: 0.001 below 0.04 / above 0.96, else 0.01. Conservative
 * (finer grid at the tails → fewer rejected fills). Pure.
 */
export function defaultTickForPrice(price: number): number {
  if (price < 0.04 || price > 0.96) return 0.001;
  return 0.01;
}

/** Snap a price DOWN to the nearest tick (BUY side — never round the price up
 *  into a level that doesn't exist). Pure. */
export function snapDownToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  return Math.floor((price + EPS) / tick) * tick;
}

/** True when a price sits on the market's tick grid within tolerance. Used to
 *  validate the LIMIT price we would post (the fill VWAP is an average of
 *  on-grid levels and is legitimately allowed between ticks). Pure. */
export function isPriceOnTick(price: number, tick: number): boolean {
  if (!(tick > 0)) return true;
  const rem = Math.abs(price / tick - Math.round(price / tick));
  return rem <= 1e-3;
}

/** A fill is valid if it clears the market's min order size (in shares) and the
 *  VWAP is a sane outcome-token price in (0,1). The tick-grid check applies to
 *  the posted limit price via {@link isPriceOnTick}, not to the VWAP. Pure. */
export function isFillValid(
  filledShares: number,
  vwap: number,
  minOrderSizeShares: number,
): boolean {
  if (!(filledShares >= minOrderSizeShares - EPS)) return false;
  if (!(vwap > 0 && vwap < 1)) return false;
  return true;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
