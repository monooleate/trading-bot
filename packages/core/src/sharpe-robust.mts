// packages/core/src/sharpe-robust.mts
//
// Robust Sharpe statistics — model-discovery-expansion §4.B (B49 #3). Pure,
// portable (zero I/O). Bailey & López de Prado, "The Sharpe Ratio Efficient
// Frontier" (deflated-sharpe PDF).
//
// WHY: this system validates on a forward paper track record, not a backtest.
// Its overfitting risk is the NUMBER OF KNOB CONFIGS tried against one growing
// record (the changelog shows dozens), and its edge often "sits on 4 longshots"
// (n small, fat-tailed). A raw Sharpe over-states significance in exactly those
// conditions. These forward-native tools fix that:
//   • PSR  — probability the true Sharpe > a benchmark, correcting for sample
//            length + skew + kurtosis (punishes a Sharpe resting on few fat wins).
//   • MinTRL — the number of trades needed for the Sharpe to be significant at
//            a confidence level → the principled paper→live gate (replaces an
//            arbitrary "50 trades").
//   • DSR  — PSR against the Sharpe you'd expect from luck as the best of N
//            trials → deflates the edge by how much config-hunting you did.
//
// SR here is the PER-TRADE Sharpe (mean/std of per-trade returns), and n = the
// number of trades — consistent with the existing bootstrapSharpeCi. Kurtosis is
// RAW (normal = 3), matching the (γ₄−1)/4 term in the LdP formulas.

const GAMMA = 0.5772156649015329; // Euler–Mascheroni

// ─── Standard normal CDF (Abramowitz–Stegun 7.1.26 erf) ─────────────────────
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ─── Inverse standard normal CDF (Acklam's algorithm, ~1e-9 accuracy) ───────
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

// ─── Sample moments (method of moments; population variance for consistency) ──
function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** Sample skewness (m3 / s³, population std). Returns 0 for n<3 or zero variance. Pure. */
export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = meanOf(xs);
  const m2 = xs.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  const m3 = xs.reduce((s, x) => s + (x - m) ** 3, 0) / n;
  const s = Math.sqrt(m2);
  return s > 0 ? m3 / (s * s * s) : 0;
}

/** Sample RAW kurtosis (m4 / s⁴; normal = 3). Returns 3 for n<4 or zero variance. Pure. */
export function kurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 3;
  const m = meanOf(xs);
  const m2 = xs.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  const m4 = xs.reduce((s, x) => s + (x - m) ** 4, 0) / n;
  return m2 > 0 ? m4 / (m2 * m2) : 3;
}

/** Denominator of the PSR z-stat: 1 − skew·SR + ((kurt−1)/4)·SR². Floored to avoid
 *  a non-positive radicand on pathological samples. Pure. */
function psrVarianceTerm(sr: number, skew: number, kurt: number): number {
  return Math.max(1e-9, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr);
}

/**
 * Probabilistic Sharpe Ratio: P(true SR > srBenchmark) given a per-trade SR over
 * n trades with the sample skew/kurtosis. Returns a probability in [0,1], or NaN
 * for n<2. Pure.
 *   PSR = Φ[ (SR − SR*)·√(n−1) / √(1 − skew·SR + ((kurt−1)/4)·SR²) ]
 */
export function probabilisticSharpe(
  sr: number, n: number, skew: number, kurt: number, srBenchmark = 0,
): number {
  if (!(n >= 2) || !Number.isFinite(sr)) return NaN;
  const z = (sr - srBenchmark) * Math.sqrt(n - 1) / Math.sqrt(psrVarianceTerm(sr, skew, kurt));
  return normalCdf(z);
}

/**
 * Minimum Track Record Length: trades needed for the per-trade SR to be
 * significant above srBenchmark at `confidence`. Returns Infinity when SR ≤
 * benchmark (a losing/flat record can never become significant). Pure.
 *   MinTRL = 1 + [1 − skew·SR + ((kurt−1)/4)·SR²]·( z_conf / (SR − SR*) )²
 */
export function minTrackRecordLength(
  sr: number, skew: number, kurt: number, srBenchmark = 0, confidence = 0.95,
): number {
  const diff = sr - srBenchmark;
  if (!(diff > 1e-9)) return Infinity;
  const z = normalInv(confidence);
  return 1 + psrVarianceTerm(sr, skew, kurt) * (z * z) / (diff * diff);
}

/**
 * Expected maximum Sharpe from N independent trials under the null (luck):
 *   E[max SR_N] ≈ σ_SR · [ (1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)) ]
 * σ_SR = std of the Sharpe ratios across the trials you ran. Pure.
 */
export function expectedMaxSharpe(nTrials: number, sdSharpe: number): number {
  if (!(nTrials > 1) || !(sdSharpe > 0)) return 0;
  const a = normalInv(1 - 1 / nTrials);
  const b = normalInv(1 - 1 / (nTrials * Math.E));
  return sdSharpe * ((1 - GAMMA) * a + GAMMA * b);
}

/**
 * Deflated Sharpe Ratio: PSR against the luck-implied best-of-N-trials benchmark.
 * If σ_SR is unknown, a conservative fallback uses a fraction of |SR| as the
 * cross-trial spread. Returns a probability in [0,1]. Pure.
 */
export function deflatedSharpe(
  sr: number, n: number, skew: number, kurt: number,
  nTrials: number, sdSharpe: number,
): number {
  const srStar = expectedMaxSharpe(nTrials, sdSharpe);
  return probabilisticSharpe(sr, n, skew, kurt, srStar);
}
