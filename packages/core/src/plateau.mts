// packages/core/src/plateau.mts
//
// Regularization discipline: plateau-not-peak selection + ensemble-over-configs —
// model-discovery-training §3.A / #7 (sprints.md B50). Pure, portable (zero I/O).
//
// WHY: the dead-knob audit found the ~96-knob surface is fully wired — nothing to
// delete. The real regularization lever is DISCIPLINE, not deletion: when a knob
// IS swept (via #4 per-config attribution), pick the value in the middle of a
// broad flat region where neighbours also score well — NOT an isolated peak. A
// plateau is insensitive to small parameter changes → robust out-of-sample; an
// isolated peak is the overfitting signature. Even better, ENSEMBLE over the
// plateau (weight configs by score) instead of committing to one, which strictly
// reduces selection variance. These are the tools for the few knobs worth tuning;
// the long tail stays at theory-grounded fixed defaults (see math/34).

export interface Candidate {
  value: number;   // the swept knob value
  score: number;   // performance (HIGHER = better, e.g. Brier skill)
  n?: number;      // sample size behind the score (optional; for the caller)
}

export interface PlateauResult {
  value: number;         // the recommended (plateau-center) value
  score: number;         // score at the recommended value
  peakValue: number;     // the single best-scoring value (for contrast)
  peakScore: number;
  plateauWidth: number;  // # contiguous near-best candidates the plateau spans
  isPeak: boolean;       // true ⇒ the best is an ISOLATED spike (width 1) — fragile
  detail: string;
}

/**
 * Select the plateau center: the middle value of the WIDEST contiguous run (by
 * value) of candidates whose score is within `tol` of the best. `tol` defaults to
 * 10% of the observed score range (or an absolute floor for flat ranges). Prefers
 * a broad flat region over an isolated peak. Pure.
 */
export function selectPlateau(candidates: Candidate[], opts: { tol?: number } = {}): PlateauResult | null {
  const clean = (candidates ?? []).filter((c) => Number.isFinite(c?.value) && Number.isFinite(c?.score));
  if (clean.length === 0) return null;
  const sorted = clean.slice().sort((a, b) => a.value - b.value);

  const scores = sorted.map((c) => c.score);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const peak = sorted.reduce((best, c) => (c.score > best.score ? c : best), sorted[0]);

  if (sorted.length === 1) {
    return {
      value: sorted[0].value, score: sorted[0].score,
      peakValue: peak.value, peakScore: peak.score,
      plateauWidth: 1, isPeak: true, detail: "single candidate",
    };
  }

  const tol = opts.tol ?? Math.max(1e-9, 0.1 * (maxScore - minScore));
  const threshold = maxScore - tol;
  const near = sorted.map((c) => c.score >= threshold);

  // Longest contiguous run of `near`.
  let bestStart = 0, bestLen = 0, curStart = 0, curLen = 0;
  for (let i = 0; i < near.length; i++) {
    if (near[i]) {
      if (curLen === 0) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curLen = 0;
    }
  }
  const mid = sorted[bestStart + Math.floor((bestLen - 1) / 2)];
  const isPeak = bestLen <= 1;
  return {
    value: mid.value, score: mid.score,
    peakValue: peak.value, peakScore: peak.score,
    plateauWidth: bestLen,
    isPeak,
    detail: isPeak
      ? `best score is an isolated spike (plateau width ${bestLen}) — fragile; widen the sweep or keep the default`
      : `plateau of ${bestLen} near-best values; center ${mid.value} chosen over the peak ${peak.value}`,
  };
}

/**
 * Ensemble weights over candidates: softmax of (score / temperature), normalised.
 * Higher score → higher weight; larger temperature → flatter (more equal) weights.
 * Averaging configs by these weights is strictly more robust than selecting one.
 * Pure. Returns weights aligned to the input order, summing to 1.
 */
export function ensembleWeights(candidates: Candidate[], temperature = 1): number[] {
  const clean = (candidates ?? []).map((c) => (Number.isFinite(c?.score) ? c.score : -Infinity));
  const n = clean.length;
  if (n === 0) return [];
  const T = temperature > 0 ? temperature : 1;
  const max = Math.max(...clean.filter((x) => Number.isFinite(x)));
  if (!Number.isFinite(max)) return clean.map(() => 1 / n);
  const exps = clean.map((s) => (Number.isFinite(s) ? Math.exp((s - max) / T) : 0));
  const sum = exps.reduce((a, b) => a + b, 0);
  return sum > 0 ? exps.map((e) => e / sum) : clean.map(() => 1 / n);
}
