// packages/core/src/har-fit.mts
//
// HAR-RV coefficient fitting — model-discovery-training §3.C / #5 (crypto domain,
// sprints.md B50). Pure, portable (zero I/O). The fetch + report live in a script
// (scripts/fit-har.ts); this is the pure OLS + Corsi HAR fit + OOS evaluation.
//
// WHY: harRvSigma (forecasting #5) blends the 1/5/22-day realized-variance
// components with EQUAL weights (1/3 each) — its header notes fitted Corsi
// coefficients are a data follow-up "they need a long RV series to fit without
// overfitting." This is that follow-up: fit the HAR regression
//   RV_t = c + βD·RV_{t-1} + βW·RV^(5)_{t-1} + βM·RV^(22)_{t-1}
// (Corsi 2009) on a long historical RV series, and VALIDATE out-of-sample that
// the fitted weights forecast next-day RV better than equal weights and a random
// walk. Measure-first: this reports the fit + OOS comparison; wiring the fitted
// coefficients into the live vol path is a separate, gated follow-up.

/** Solve (XᵀX) β = Xᵀy by Gaussian elimination with partial pivoting. Returns the
 *  coefficient vector, or null if singular. `X` rows are feature vectors. Pure. */
export function olsFit(X: number[][], y: number[]): number[] | null {
  const n = X.length;
  if (n === 0 || X[0].length === 0 || y.length !== n) return null;
  const k = X[0].length;
  // Normal equations: A = XᵀX (k×k), b = Xᵀy (k).
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let r = 0; r < n; r++) {
    const xr = X[r];
    for (let i = 0; i < k; i++) {
      b[i] += xr[i] * y[r];
      for (let j = 0; j < k; j++) A[i][j] += xr[i] * xr[j];
    }
  }
  // Solve A β = b (augmented, partial pivot).
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= k; j++) M[col][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= k; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[k]);
}

export interface HarCoefficients {
  c: number; betaD: number; betaW: number; betaM: number;
  n: number;          // training rows
  r2: number;         // in-sample R²
  fitted: boolean;
}

const meanTailAt = (rv: number[], end: number, k: number): number => {
  const lo = Math.max(0, end - k + 1);
  let s = 0;
  for (let i = lo; i <= end; i++) s += rv[i];
  return s / (end - lo + 1);
};

/**
 * Build HAR design rows from a realized-variance series and fit the Corsi
 * coefficients by OLS. Needs ≥ `minRows` usable (t≥22) rows; below that returns
 * fitted=false. Pure & deterministic.
 */
export function fitHarWeights(rv: number[], opts: { minRows?: number } = {}): HarCoefficients {
  const minRows = opts.minRows ?? 30;
  const clean = (rv ?? []).filter((v) => Number.isFinite(v) && v >= 0);
  const N = clean.length;
  const dud: HarCoefficients = { c: 0, betaD: 1 / 3, betaW: 1 / 3, betaM: 1 / 3, n: 0, r2: 0, fitted: false };
  if (N < 22 + minRows) return dud;

  const X: number[][] = [], y: number[] = [];
  for (let t = 22; t < N; t++) {
    X.push([1, clean[t - 1], meanTailAt(clean, t - 1, 5), meanTailAt(clean, t - 1, 22)]);
    y.push(clean[t]);
  }
  const beta = olsFit(X, y);
  if (!beta) return dud;
  const [c, betaD, betaW, betaM] = beta;

  // In-sample R².
  const yBar = y.reduce((s, v) => s + v, 0) / y.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < y.length; i++) {
    const pred = c + betaD * X[i][1] + betaW * X[i][2] + betaM * X[i][3];
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - yBar) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { c, betaD, betaW, betaM, n: y.length, r2, fitted: true };
}

export interface HarForecastEval {
  n: number;          // out-of-sample test points
  fittedMse: number;  // MSE of the fitted-Corsi HAR
  equalMse: number;   // MSE of equal-weight HAR (the current harRvSigma behaviour)
  rwMse: number;      // MSE of the random walk (predict RV_t = RV_{t-1})
  fittedBeatsEqual: boolean;
  fittedBeatsRw: boolean;
}

/**
 * Walk-forward-ish OOS evaluation: fit on the first `trainFrac` of the RV series,
 * then predict next-day RV on the held-out tail with the fitted-Corsi, equal-
 * weight, and random-walk forecasts. Lower MSE = better. Pure.
 */
export function evaluateHarForecast(
  rv: number[], opts: { trainFrac?: number } = {},
): HarForecastEval {
  const trainFrac = opts.trainFrac ?? 0.7;
  const clean = (rv ?? []).filter((v) => Number.isFinite(v) && v >= 0);
  const N = clean.length;
  const empty: HarForecastEval = { n: 0, fittedMse: NaN, equalMse: NaN, rwMse: NaN, fittedBeatsEqual: false, fittedBeatsRw: false };
  if (N < 22 + 40) return empty;

  const split = Math.max(22 + 10, Math.floor(N * trainFrac));
  const fit = fitHarWeights(clean.slice(0, split), { minRows: 10 });
  if (!fit.fitted) return empty;

  let fSum = 0, eSum = 0, rSum = 0, n = 0;
  for (let t = split; t < N; t++) {
    const rvD = clean[t - 1];
    const rvW = meanTailAt(clean, t - 1, 5);
    const rvM = meanTailAt(clean, t - 1, 22);
    const actual = clean[t];
    const fitted = fit.c + fit.betaD * rvD + fit.betaW * rvW + fit.betaM * rvM;
    const equal = (rvD + rvW + rvM) / 3;
    fSum += (fitted - actual) ** 2;
    eSum += (equal - actual) ** 2;
    rSum += (rvD - actual) ** 2;
    n++;
  }
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const fittedMse = fSum / n, equalMse = eSum / n, rwMse = rSum / n;
  return {
    n, fittedMse: r6(fittedMse), equalMse: r6(equalMse), rwMse: r6(rwMse),
    fittedBeatsEqual: fittedMse < equalMse, fittedBeatsRw: fittedMse < rwMse,
  };
}
