// packages/core/src/enb.mts
//
// Effective Number of Bets (ENB) diversification monitor — model-discovery-
// expansion §4.C (B49 #9). Pure, portable (zero I/O). Measurement-only.
//
// WHY: the book runs 6 bots but crypto (BTC-threshold), HL-perp (BTC/ETH/SOL) and
// funding-arb are all crypto-beta — so "6 independent bets" may really be ~2-3.
// The single most actionable diagnostic is the ENB: given the strategy-return
// correlation matrix, how many INDEPENDENT bets does the book actually hold?
// ENB = N ⇒ N genuinely independent; ENB → 1 ⇒ everything loads one hidden factor.
// We use the eigenvalue-entropy effective rank (a PCA-based ENB; the discovery
// notes min-torsion is a refinement, PCA effective-rank is the honest first cut).
//
//   eigenvalues λ_i of the correlation matrix (Σλ = N),  p_i = λ_i / N,
//   ENB = exp( −Σ p_i · ln p_i ).
//
// topFactorShare = λ_max / N (fraction of variance in the top PC) — high ⇒
// concentrated (the crypto-beta warning).

/** Pearson correlation of two equal-length series. NaN on <2 points or zero variance. */
export function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return NaN;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return NaN;
  return cov / Math.sqrt(vx * vy);
}

/**
 * N×N Pearson correlation matrix from N aligned return series (each `series[i]`
 * a bot's return array, same length/calendar). Diagonal = 1; a NaN pair
 * (flat/short series) → 0 correlation (treated as uncorrelated). Pure.
 */
export function correlationMatrix(series: number[][]): number[][] {
  const n = series.length;
  const R: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    R[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const r = pearson(series[i], series[j]);
      const v = Number.isFinite(r) ? r : 0;
      R[i][j] = v; R[j][i] = v;
    }
  }
  return R;
}

/**
 * Eigenvalues of a symmetric matrix via cyclic Jacobi rotations (stable for the
 * small N×N here). Returns the diagonal after convergence (unsorted). Pure.
 */
export function jacobiEigenvalues(matrix: number[][]): number[] {
  const n = matrix.length;
  if (n === 0) return [];
  if (n === 1) return [matrix[0][0]];
  const A = matrix.map((r) => r.slice());
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-14) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-18) continue;
        const tau = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(tau * tau + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return A.map((r, i) => r[i]);
}

export interface EnbResult {
  n: number;               // number of strategies
  enb: number;             // effective number of independent bets ∈ [1, n]
  topFactorShare: number;  // λ_max / Σλ (fraction of variance in the top PC)
  eigenvalues: number[];   // sorted descending
}

/**
 * Effective Number of Bets from a correlation matrix via eigenvalue entropy.
 * ENB = exp(−Σ p_i ln p_i), p_i = λ_i / Σλ. n < 2 → enb = n. Pure.
 */
export function effectiveNumberOfBets(corr: number[][]): EnbResult {
  const n = corr.length;
  if (n === 0) return { n: 0, enb: 0, topFactorShare: 0, eigenvalues: [] };
  if (n === 1) return { n: 1, enb: 1, topFactorShare: 1, eigenvalues: [corr[0][0] ?? 1] };

  const eig = jacobiEigenvalues(corr).map((x) => (x > 0 ? x : 0)); // clamp fp negatives
  const sum = eig.reduce((s, x) => s + x, 0);
  const sorted = [...eig].sort((a, b) => b - a);
  if (!(sum > 0)) return { n, enb: 1, topFactorShare: 1, eigenvalues: sorted };

  let entropy = 0;
  for (const l of eig) {
    const p = l / sum;
    if (p > 0) entropy -= p * Math.log(p);
  }
  const enb = Math.exp(entropy);
  return {
    n,
    enb: Math.min(n, Math.max(1, enb)),
    topFactorShare: sorted[0] / sum,
    eigenvalues: sorted,
  };
}
