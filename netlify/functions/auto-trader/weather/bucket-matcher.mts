import type { TemperatureBucket } from "./market-finder.mts";

/**
 * Normal PDF (unnormalized, for relative comparison).
 */
function normalPDF(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z);
}

export interface BucketMatch {
  bucket: TemperatureBucket;
  probability: number;       // our predicted prob for this bucket
  edge: number;              // probability - currentPrice
  allProbs: { label: string; prob: number; price: number; edge: number }[];
}

/**
 * Match a predicted temperature to Polymarket outcome buckets.
 *
 * Uses a normal distribution centered on the prediction with
 * configurable uncertainty (sigma). Each bucket gets a probability
 * proportional to the normal PDF at its center temperature.
 *
 * @param predictedTempC - Our forecast (after METAR correction)
 * @param buckets - The market's outcome buckets
 * @param sigma - Forecast uncertainty in °C (default 1.0, cloudy: 1.5)
 */
export function matchBucket(
  predictedTempC: number,
  buckets: TemperatureBucket[],
  sigma: number = 1.0,
): BucketMatch | null {
  // Filter to buckets with parseable temperatures
  const validBuckets = buckets.filter((b) => b.tempC !== null);
  if (validBuckets.length === 0) return null;

  // Calculate probability for each bucket
  const rawProbs = validBuckets.map((b) => normalPDF(predictedTempC, b.tempC!, sigma));
  const total = rawProbs.reduce((s, p) => s + p, 0);

  if (total === 0) return null;

  const normalized = rawProbs.map((p) => p / total);

  // Build full probability map
  const allProbs = validBuckets.map((b, i) => ({
    label: b.label,
    prob: Math.round(normalized[i] * 1000) / 1000,
    price: b.currentPrice,
    edge: Math.round((normalized[i] - b.currentPrice) * 1000) / 1000,
  }));

  // Find best edge (highest |edge|)
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
    bucket: validBuckets[bestIdx],
    probability: normalized[bestIdx],
    edge: allProbs[bestIdx].edge,
    allProbs,
  };
}
