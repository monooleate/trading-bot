import type { TemperatureBucket } from "./market-finder.mts";

// ─── Gaussian primitives ──────────────────────────────────
//
// We compute *interval* probabilities via the Gaussian CDF, not point PDFs.
// The previous (v1) implementation treated every bucket as a single sampled
// point at its parsed centre temperature and normalised across the available
// buckets. That is wrong in two ways:
//
//   • Tail buckets ("84°F or higher", "21°C or below") were collapsed to a
//     point at the threshold — Polymarket's *actual* settlement integrates
//     to ±∞, so internal buckets next to a tail got their probability mass
//     over-counted while the tail was systematically under-weighted.
//   • Non-tail buckets have a real width determined by the next-neighbour
//     midpoints (≈0.55°C for 1°F bins, ≈1.0°C for integer °C bins). Treating
//     each as a point ignores that width, biasing wide buckets downward.
//
// v2 (2026-05-11): every bucket gets a CDF interval [lo, hi] derived from
// its sorted neighbours. Tail buckets extend to ±∞. The resulting masses sum
// to exactly 1 over the bucket lineup, so no normalisation needed.

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26, max abs error 1.5×10⁻⁷
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCDF(x: number, mu: number, sigma: number): number {
  if (!Number.isFinite(x))  return x > 0 ? 1 : 0;
  if (sigma <= 0) return x >= mu ? 1 : 0;
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}

/** Probability of T ∈ [lo, hi] under N(mu, sigma²). lo/hi may be ±Infinity. */
function normalIntervalProb(lo: number, hi: number, mu: number, sigma: number): number {
  const p = normalCDF(hi, mu, sigma) - normalCDF(lo, mu, sigma);
  return Math.max(0, Math.min(1, p));
}

export interface BucketMatch {
  bucket: TemperatureBucket;
  probability: number;       // model probability for this bucket
  edge: number;              // probability − currentPrice (signed)
  allProbs: { label: string; prob: number; price: number; edge: number; lo: number; hi: number }[];
}

// ─── Interval construction ────────────────────────────────
//
// Given the sorted bucket temps, derive each bucket's [lo, hi] range:
//   • idx === 0 and tail === "low"  → (−∞, midpoint to next]
//   • idx === N-1 and tail === "high" → [midpoint to prev, +∞)
//   • idx === 0 (no tail flag) → [tempC[0] − half-step, midpoint to next]
//   • idx === N-1 (no tail flag) → [midpoint to prev, tempC[N-1] + half-step]
//   • internal → [midpoint to prev, midpoint to next]
//
// Half-step uses the nearest-neighbour gap so single-bucket markets degrade
// gracefully (cover ±0.5°C).

interface SortedBucket {
  orig: TemperatureBucket;
  tempC: number;
  tail: "low" | "high" | null;
}

function deriveIntervals(sorted: SortedBucket[]): { lo: number; hi: number }[] {
  const N = sorted.length;
  return sorted.map((b, i) => {
    const prev = i > 0       ? sorted[i - 1].tempC : null;
    const next = i < N - 1   ? sorted[i + 1].tempC : null;

    let lo: number, hi: number;

    if (i === 0) {
      lo = b.tail === "low" ? -Infinity
         : next !== null     ? b.tempC - (next - b.tempC) / 2
                             : b.tempC - 0.5;
    } else {
      lo = (prev! + b.tempC) / 2;
    }

    if (i === N - 1) {
      hi = b.tail === "high" ? Infinity
         : prev !== null      ? b.tempC + (b.tempC - prev) / 2
                              : b.tempC + 0.5;
    } else {
      hi = (b.tempC + next!) / 2;
    }

    return { lo, hi };
  });
}

/**
 * Match a predicted temperature to Polymarket outcome buckets.
 *
 * Uses Gaussian CDF integration over each bucket's natural interval. Tail
 * buckets ("X or higher" / "X or below") extend to ±∞. Returns the bucket
 * with the largest |edge| (= |model_prob − market_price|) since that is the
 * most mispriced opportunity — by design we *want* non-modal bets when the
 * market under-prices them.
 *
 * @param predictedTempC - Our forecast (after METAR correction)
 * @param buckets - The market's outcome buckets (must include parsed tempC + tail)
 * @param sigma - Forecast uncertainty in °C (default 1.0, cloudy: 1.5)
 */
export function matchBucket(
  predictedTempC: number,
  buckets: TemperatureBucket[],
  sigma: number = 1.0,
): BucketMatch | null {
  const validBuckets = buckets.filter((b) => b.tempC !== null);
  if (validBuckets.length === 0) return null;

  // Sort ascending so neighbour-midpoint logic is monotonic.
  const sorted: SortedBucket[] = validBuckets
    .map((b) => ({ orig: b, tempC: b.tempC!, tail: b.tail ?? null }))
    .sort((a, b) => a.tempC - b.tempC);

  const intervals = deriveIntervals(sorted);

  // Mass per bucket via Gaussian CDF on its interval.
  const probs = intervals.map((iv) =>
    normalIntervalProb(iv.lo, iv.hi, predictedTempC, Math.max(sigma, 0.1)),
  );

  // Normalise: in theory the intervals cover (−∞, +∞) when both tails exist
  // and the masses sum to ≈1. If both tails are missing we lose some mass
  // outside the range — normalise to make the surviving buckets a proper
  // probability distribution. Either way this is a no-op when the lineup is
  // tail-complete and σ is sane.
  const total = probs.reduce((s, p) => s + p, 0);
  if (total <= 0) return null;
  const normalized = probs.map((p) => p / total);

  const allProbs = sorted.map((b, i) => ({
    label: b.orig.label,
    prob:  Math.round(normalized[i] * 1000) / 1000,
    price: b.orig.currentPrice,
    edge:  Math.round((normalized[i] - b.orig.currentPrice) * 1000) / 1000,
    lo:    intervals[i].lo,
    hi:    intervals[i].hi,
  }));

  let bestIdx = 0;
  let bestEdge = 0;
  for (let i = 0; i < allProbs.length; i++) {
    const absEdge = Math.abs(allProbs[i].edge);
    if (absEdge > bestEdge) {
      bestEdge = absEdge;
      bestIdx = i;
    }
  }

  return {
    bucket: sorted[bestIdx].orig,
    probability: normalized[bestIdx],
    edge: allProbs[bestIdx].edge,
    allProbs,
  };
}

// ─── Helper exported for the market-disagreement gate ─────────────────────
//
// The market's price vector is itself a probability distribution (subject to
// over-round). The "consensus modal temperature" is the bucket centre of the
// highest-priced bucket — a quick robust read on what the crowd thinks the
// daily max will be. Returns null if the lineup has no parseable buckets.

export function marketConsensusModalTempC(
  buckets: TemperatureBucket[],
): { tempC: number; label: string; price: number } | null {
  let best: TemperatureBucket | null = null;
  for (const b of buckets) {
    if (b.tempC === null) continue;
    if (!Number.isFinite(b.currentPrice)) continue;
    if (!best || b.currentPrice > best.currentPrice) best = b;
  }
  if (!best || best.tempC === null) return null;
  return { tempC: best.tempC, label: best.label, price: best.currentPrice };
}
