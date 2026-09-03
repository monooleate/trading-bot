// packages/core/src/emos.mts
//
// EMOS / NGR ensemble post-processing — model-discovery-expansion §4.E (B49 #6).
// Pure, portable (zero I/O). Gneiting et al. 2005 (Ensemble Model Output
// Statistics / Non-homogeneous Gaussian Regression).
//
// WHY: the weather bot's direction is genuinely predictive (forecast_edge IC
// ~+0.39) but it LOSES — the textbook signature of ensemble UNDERDISPERSION: the
// raw ensemble spread (σ) is too small, so the bucket-matcher's tail
// probabilities are over-confident and the Kelly sizer overweights the
// most-confident (and most wrong) bets. EMOS corrects this: it maps the raw
// ensemble (mean, spread) to a CALIBRATED predictive Gaussian
//   T ~ N(μ, σ²),  μ = a + b·ensMean,  σ² = c + d·ensVar
// fit on a rolling per-station history of (ensMean, ensVar, realised high). The
// `c` term is a variance FLOOR that inflates σ to match realised error → kills
// the tail over-confidence. The bucket-matcher then reads bucket probs off the
// calibrated N(μ,σ) — same Φ interval math, honest parameters.
//
// Fit method: two-step (OLS for the mean a,b; OLS of squared residuals on ensVar
// for the spread c,d). This is a robust, deterministic simplification of
// Gneiting's minimum-CRPS estimation — it directly matches σ to realised
// dispersion (the underdispersion fix) without a fragile optimiser. Full
// CRPS-minimum estimation is a follow-up. We report raw vs calibrated mean CRPS
// so the improvement is measurable (measure-first).

// ─── Gaussian primitives (self-contained) ────────────────────────────────────
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
export function normalCdf(z: number): number { return 0.5 * (1 + erf(z / Math.SQRT2)); }
export function normalPdf(z: number): number { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }

const INV_SQRT_PI = 1 / Math.sqrt(Math.PI);

/**
 * Closed-form CRPS for a Gaussian forecast N(μ,σ) and observation y (Gneiting
 * 2005 eq.): CRPS = σ·[ z(2Φ(z)−1) + 2φ(z) − 1/√π ], z = (y−μ)/σ. Lower = better.
 * σ ≤ 0 → |y−μ| (degenerate point forecast). Pure.
 */
export function gaussianCrps(mu: number, sigma: number, y: number): number {
  if (!(sigma > 0)) return Math.abs(y - mu);
  const z = (y - mu) / sigma;
  return sigma * (z * (2 * normalCdf(z) - 1) + 2 * normalPdf(z) - INV_SQRT_PI);
}

export interface EmosParams {
  a: number; b: number;   // μ = a + b·ensMean
  c: number; d: number;   // σ² = c + d·ensVar
}

export interface EmosFit extends EmosParams {
  n: number;
  varFloor: number;
  rawCrps: number;         // mean CRPS of the raw ensemble (μ=ensMean, σ=ensStd)
  calibratedCrps: number;  // mean CRPS after EMOS — should be ≤ rawCrps
  fitted: boolean;         // false → identity fallback (too few samples)
}

export interface EmosSample { ensMean: number; ensStd: number; obs: number; }

/** Apply fitted EMOS params to a raw ensemble (mean, std) → calibrated (μ,σ).
 *  σ² = c + d·ensStd², floored at `varFloor`. Pure. */
export function emosApply(p: EmosParams, ensMean: number, ensStd: number, varFloor = 0.25): { mu: number; sigma: number } {
  const mu = p.a + p.b * ensMean;
  const variance = Math.max(varFloor, p.c + p.d * ensStd * ensStd);
  return { mu, sigma: Math.sqrt(variance) };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/**
 * Fit EMOS params from a per-station history of (ensMean, ensStd, obs) via the
 * two-step OLS method. Needs ≥ `minSamples` (default 20); below that returns the
 * identity fallback (a=0,b=1,c=varFloor,d=1, fitted=false) so callers degrade to
 * the raw ensemble. Constrains b∈[0,3], c≥varFloor, d≥0. Pure & deterministic.
 */
export function fitEmos(
  samples: EmosSample[],
  opts: { minSamples?: number; varFloor?: number } = {},
): EmosFit {
  const minSamples = opts.minSamples ?? 20;
  const varFloor = opts.varFloor ?? 0.25;
  const valid = (samples ?? []).filter(
    (s) => Number.isFinite(s.ensMean) && Number.isFinite(s.ensStd) && s.ensStd >= 0 && Number.isFinite(s.obs),
  );
  const n = valid.length;

  // Identity fallback = raw ensemble passthrough (μ=ensMean, σ²=ensVar) with the
  // varFloor applied only in emosApply. c=0 (not varFloor) so σ→ensStd when the
  // raw spread already clears the floor.
  const identity: EmosFit = { a: 0, b: 1, c: 0, d: 1, n, varFloor, rawCrps: NaN, calibratedCrps: NaN, fitted: false };
  if (n < minSamples) return identity;

  const em = valid.map((s) => s.ensMean);
  const ob = valid.map((s) => s.obs);
  const emBar = mean(em), obBar = mean(ob);
  const covEO = mean(valid.map((s) => (s.ensMean - emBar) * (s.obs - obBar)));
  const varE = mean(valid.map((s) => (s.ensMean - emBar) ** 2));

  // Mean: OLS obs ~ a + b·ensMean (bias/regression correction). Guard flat ensMean.
  let b = varE > 1e-9 ? covEO / varE : 1;
  b = Math.min(3, Math.max(0, b));
  let a = obBar - b * emBar;

  // Spread: OLS squared-residual ~ c + d·ensVar (matches σ² to realised error).
  const rsq = valid.map((s) => (s.obs - (a + b * s.ensMean)) ** 2);
  const ev = valid.map((s) => s.ensStd * s.ensStd);
  const evBar = mean(ev), rsqBar = mean(rsq);
  const covVR = mean(valid.map((_, i) => (ev[i] - evBar) * (rsq[i] - rsqBar)));
  const varV = mean(ev.map((x) => (x - evBar) ** 2));
  let d = varV > 1e-9 ? covVR / varV : 0;
  d = Math.max(0, d);
  let c = rsqBar - d * evBar;
  c = Math.max(varFloor, c);

  const params: EmosParams = { a, b, c, d };
  const rawCrps = mean(valid.map((s) => gaussianCrps(s.ensMean, Math.max(1e-6, s.ensStd), s.obs)));
  const calibratedCrps = mean(valid.map((s) => {
    const { mu, sigma } = emosApply(params, s.ensMean, s.ensStd, varFloor);
    return gaussianCrps(mu, sigma, s.obs);
  }));

  return { ...params, n, varFloor, rawCrps, calibratedCrps, fitted: true };
}

/**
 * Rank of an observation among sorted ensemble members (0..n). The building
 * block of a rank / Talagrand histogram: a ∪-shaped histogram diagnoses
 * underdispersion (truth falls outside the ensemble too often). Pure.
 */
export function observationRank(members: number[], obs: number): number {
  let rank = 0;
  for (const m of members) if (Number.isFinite(m) && m < obs) rank++;
  return rank;
}
