// netlify/functions/auto-trader/shared/har-rv.mts
//
// HAR-RV volatility engine — model-discovery §7 #5. A pure, portable vol-math
// module (moves 1:1 to the Hetzner server; the R rugarch RealizedGARCH is the
// heavier B-step counterpart).
//
// WHY: the combiner prices threshold markets P(BTC>K) with a Black-Scholes
// digital N(d₂) that needs σ. Today getVolSignal uses a 20-minute minutely
// realized vol — noisy (20 samples, dominated by the latest minutes) and
// glitch-prone (B21 σ-guard). The research (agent B) found HAR-RV on a
// range-based daily RV systematically beats daily-data GARCH for short-horizon
// crypto: daily realized variance has strong persistence ("long memory"), and
// averaging it over day/week/month horizons (Corsi 2009) yields a far more
// stable, persistence-aware σ — which, since vol_divergence is the K-aware
// anchor for threshold markets, directly improves the threshold probability.
//
// Estimators here:
//   • Rogers–Satchell per-day variance (drift-independent, intraday OHLC only
//     → ideal for 24/7 crypto with no overnight gap).
//   • Yang–Zhang windowed variance (adds overnight + open-close terms; the most
//     efficient range estimator — provided as an alternative/cross-check).
//   • HAR-RV blend: average the daily RV over 1 / 5 / 22-day windows and
//     combine. Equal weights are a robust, UNFIT default appropriate at our
//     sample size; fitted Corsi coefficients (regression on RV history) are a
//     data/Hetzner follow-up (they need a long RV series to fit without
//     overfitting — the same anti-overfit rule as #2/#4).

export interface OHLC { open: number; high: number; low: number; close: number; }

const ANNUALIZE = Math.sqrt(365); // crypto trades 24/7 → 365 trading days

/**
 * Rogers–Satchell single-bar variance from OHLC (drift-independent). Returns
 * the variance of the intraday log-price for that bar. Pure.
 *   RS = ln(H/O)·ln(H/C) + ln(L/O)·ln(L/C)
 */
export function rogersSatchellVar(b: OHLC): number {
  if (!(b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)) return NaN;
  const ho = Math.log(b.high / b.open);
  const hc = Math.log(b.high / b.close);
  const lo = Math.log(b.low / b.open);
  const lc = Math.log(b.low / b.close);
  const rs = ho * hc + lo * lc;
  return rs >= 0 ? rs : 0; // RS is non-negative in theory; clamp tiny fp negatives
}

/**
 * Yang–Zhang realized variance over N daily OHLC bars (per-day variance).
 * YZ = σ²_overnight + k·σ²_open-close + (1−k)·σ²_RS, with
 * k = 0.34 / (1.34 + (m+1)/(m−1)). For 24/7 crypto the overnight
 * (close→open) term is ≈ 0, so YZ ≈ RS-dominated — consistent with the HAR
 * construction below. Needs ≥ 3 bars; returns NaN otherwise. Pure.
 */
export function yangZhangVariance(bars: OHLC[]): number {
  const n = bars.length;
  if (n < 3) return NaN;
  const oc: number[] = []; // overnight: ln(open_t / close_{t-1})
  const co: number[] = []; // open-close: ln(close_t / open_t)
  let rsSum = 0;
  for (let i = 1; i < n; i++) {
    if (!(bars[i].open > 0 && bars[i - 1].close > 0)) return NaN;
    oc.push(Math.log(bars[i].open / bars[i - 1].close));
    co.push(Math.log(bars[i].close / bars[i].open));
    rsSum += rogersSatchellVar(bars[i]);
  }
  const m = n - 1;
  const meanOC = oc.reduce((s, x) => s + x, 0) / m;
  const meanCO = co.reduce((s, x) => s + x, 0) / m;
  const varOC = oc.reduce((s, x) => s + (x - meanOC) ** 2, 0) / (m - 1);
  const varCO = co.reduce((s, x) => s + (x - meanCO) ** 2, 0) / (m - 1);
  const rsMean = rsSum / m;
  const k = 0.34 / (1.34 + (m + 1) / (m - 1));
  const yz = varOC + k * varCO + (1 - k) * rsMean;
  return yz >= 0 ? yz : NaN;
}

export interface HarRvResult {
  ok: boolean;
  sigmaDaily: number;   // forecast daily σ (std of daily log-return)
  sigmaAnnual: number;  // annualized σ (×√365) — the unit getVolSignal consumes
  components: {          // annualized σ of each HAR horizon (for transparency)
    daily: number;
    weekly: number;
    monthly: number;
  };
  nBars: number;
  detail?: string;
}

/**
 * HAR-RV σ forecast from a series of daily OHLC bars (chronological, oldest
 * first). Builds a per-day Rogers–Satchell realized-variance series, then
 * blends the 1-day / 5-day / 22-day averages (Corsi HAR components) with equal
 * weights into a forecast variance → annualized σ.
 *
 * Degrades gracefully when fewer than 22 bars are available (windows clamp to
 * what exists). Needs ≥ 2 bars. Pure.
 */
export function harRvSigma(
  dailyBars: OHLC[],
  weights: { d: number; w: number; m: number } = { d: 1 / 3, w: 1 / 3, m: 1 / 3 },
): HarRvResult {
  const zero: HarRvResult = {
    ok: false, sigmaDaily: NaN, sigmaAnnual: NaN,
    components: { daily: NaN, weekly: NaN, monthly: NaN }, nBars: dailyBars.length,
  };
  if (dailyBars.length < 2) return { ...zero, detail: "need ≥2 daily bars" };

  const rv = dailyBars.map(rogersSatchellVar).filter((v) => Number.isFinite(v));
  const n = rv.length;
  if (n < 2) return { ...zero, detail: "no finite RV bars" };

  const meanTail = (k: number) => {
    const slice = rv.slice(Math.max(0, n - k));
    return slice.reduce((s, x) => s + x, 0) / slice.length;
  };
  const rvD = rv[n - 1];          // latest day
  const rvW = meanTail(5);        // last week
  const rvM = meanTail(22);       // last month

  const wSum = weights.d + weights.w + weights.m || 1;
  const harVar = (weights.d * rvD + weights.w * rvW + weights.m * rvM) / wSum;
  const sigmaDaily = Math.sqrt(Math.max(0, harVar));
  const toAnnual = (v: number) => Math.sqrt(Math.max(0, v)) * ANNUALIZE;

  return {
    ok: Number.isFinite(sigmaDaily) && sigmaDaily > 0,
    sigmaDaily,
    sigmaAnnual: sigmaDaily * ANNUALIZE,
    components: { daily: toAnnual(rvD), weekly: toAnnual(rvW), monthly: toAnnual(rvM) },
    nBars: n,
  };
}
