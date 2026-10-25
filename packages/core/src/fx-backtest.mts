// packages/core/src/fx-backtest.mts
//
// B80 — offline FX backtest primitives. Pure, zero I/O.
//
//   · runPortfolio  — a daily-marked, periodically rebalanced multi-currency
//     portfolio (carry / time-series momentum / value) with per-asset
//     transaction cost and an annual swap markup on gross exposure.
//   · simulateSpartan — a mechanised "Spartan" EMA-36 pullback-bounce trade
//     simulator on daily OHLC bars (Mermigas' EMA-36 core; the discretionary
//     trend-line / Renko / S-R parts are not mechanisable).
//
// No-lookahead contract (pinned by fx-backtest.test.mts):
//   · weights decided on day t (from data ≤ t) earn the return of day t+1
//     onward; the cost of a weight change is charged on day t+1;
//   · a Spartan signal forms on day t's close and fills at day t+1's open.
//
// Returns are fractions of (non-compounding) equity per day.

import { skewness, kurtosis } from "./sharpe-robust.mts";

export const DAYS_PER_YEAR = 252;

export interface FxCosts {
  /** Cost per side per asset, fraction of notional (half-spread + slippage). */
  tradeCost: number[];
  /** Annual swap markup charged on gross exposure (0.01 = 1%/yr). */
  swapMarkup: number;
}

/** Exponential moving average, seeded with the first value. */
export function ema(xs: number[], n: number): number[] {
  const a = 2 / (n + 1);
  const out: number[] = new Array(xs.length);
  let e = xs[0];
  for (let i = 0; i < xs.length; i++) {
    e = i === 0 ? xs[0] : a * xs[i] + (1 - a) * e;
    out[i] = e;
  }
  return out;
}

/** Average true range (simple mean of the last n true ranges); NaN until n bars. */
export function atr(high: number[], low: number[], close: number[], n: number): number[] {
  const tr = high.map((h, i) => i === 0
    ? h - low[i]
    : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  const out: number[] = new Array(tr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i];
    if (i >= n) sum -= tr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/**
 * Long the top-k scores (+1/k each), short the bottom-k (−1/k each). NaN
 * scores are excluded; with fewer than 2k valid scores every weight is 0.
 */
export function crossSectionalWeights(scores: number[], k: number): number[] {
  const w = new Array(scores.length).fill(0);
  const valid = scores.map((s, i) => ({ s, i })).filter((x) => Number.isFinite(x.s));
  if (valid.length < 2 * k) return w;
  valid.sort((a, b) => b.s - a.s);
  for (let j = 0; j < k; j++) {
    w[valid[j].i] = 1 / k;
    w[valid[valid.length - 1 - j].i] = -1 / k;
  }
  return w;
}

export interface PortfolioInput {
  /** [day][asset] simple return of day d (close d−1 → close d); non-finite = 0. */
  spotRet: number[][];
  /** [day][asset] annual rate differential (fraction) accruing on day d; non-finite = 0. */
  carry: number[][];
  /** Decide new weights on day d's close. */
  rebalance: boolean[];
  /** New weights from data ≤ d; called only on rebalance days. */
  decide: (d: number) => number[];
  costs: FxCosts;
}

export function runPortfolio(inp: PortfolioInput): { ret: number[]; turnover: number } {
  const D = inp.spotRet.length;
  const A = inp.costs.tradeCost.length;
  let w: number[] = new Array(A).fill(0);
  let pendingCost = 0;
  let turnover = 0;
  const ret: number[] = new Array(D).fill(0);
  for (let d = 0; d < D; d++) {
    let r = -pendingCost;
    pendingCost = 0;
    for (let i = 0; i < A; i++) {
      if (w[i] === 0) continue;
      const s = inp.spotRet[d][i];
      const c = inp.carry[d][i];
      r += w[i] * ((Number.isFinite(s) ? s : 0) + (Number.isFinite(c) ? c : 0) / DAYS_PER_YEAR);
      r -= Math.abs(w[i]) * inp.costs.swapMarkup / DAYS_PER_YEAR;
    }
    ret[d] = r;
    if (inp.rebalance[d]) {
      const nw = inp.decide(d);
      for (let i = 0; i < A; i++) {
        const dw = Math.abs((nw[i] ?? 0) - w[i]);
        pendingCost += dw * inp.costs.tradeCost[i];
        turnover += dw;
      }
      w = nw.slice(0, A);
    }
  }
  return { ret, turnover };
}

/**
 * Ex-ante vol targeting: day d is scaled by target / (realised vol of days
 * d−lookback … d−1), capped at maxLev; 0 until a full lookback exists.
 */
export function scaleToVol(ret: number[], target: number, lookback: number, maxLev = 10): number[] {
  const out = new Array(ret.length).fill(0);
  for (let d = lookback; d < ret.length; d++) {
    let m = 0;
    for (let j = d - lookback; j < d; j++) m += ret[j];
    m /= lookback;
    let v = 0;
    for (let j = d - lookback; j < d; j++) v += (ret[j] - m) ** 2;
    const sd = Math.sqrt(v / (lookback - 1)) * Math.sqrt(DAYS_PER_YEAR);
    out[d] = sd > 0 ? ret[d] * Math.min(target / sd, maxLev) : 0;
  }
  return out;
}

// ── Spartan EMA-36 pullback bounce ──────────────────────────────────────────

export interface Bar { open: number; high: number; low: number; close: number; }

export interface SpartanParams {
  emaLen: number;
  slopeLag: number;
  atrLen: number;
  stopAtr: number;
  rr: number;
  riskPerTrade: number;
  maxNotional: number;
}

export const SPARTAN_DEFAULTS: SpartanParams = {
  emaLen: 36, slopeLag: 5, atrLen: 14, stopAtr: 0.25, rr: 2, riskPerTrade: 0.005, maxNotional: 5,
};

export interface SpartanTrade {
  signalDay: number;
  exitDay: number;
  dir: 1 | -1;
  entry: number;
  stop: number;
  target: number;
  exit: number;
  /** Price R-multiple (before costs and carry). */
  r: number;
  notional: number;
}

/** Signal on bar d's close: +1 long, −1 short, 0 none. */
export function spartanSignal(bars: Bar[], e: number[], d: number, p: SpartanParams): 0 | 1 | -1 {
  if (d < p.slopeLag) return 0;
  const b = bars[d];
  if (b.close > e[d] && e[d] > e[d - p.slopeLag] && b.low <= e[d] && b.close > b.open) return 1;
  if (b.close < e[d] && e[d] < e[d - p.slopeLag] && b.high >= e[d] && b.close < b.open) return -1;
  return 0;
}

/**
 * @param carryAnnual per bar: annual base−quote rate differential (fraction)
 * @param cost        cost per side, fraction of notional
 */
export function simulateSpartan(
  bars: Bar[], carryAnnual: number[], cost: number, swapMarkup: number,
  p: SpartanParams = SPARTAN_DEFAULTS,
): { ret: number[]; trades: SpartanTrade[] } {
  const D = bars.length;
  const ret: number[] = new Array(D).fill(0);
  const trades: SpartanTrade[] = [];
  const e = ema(bars.map((b) => b.close), p.emaLen);
  const a = atr(bars.map((b) => b.high), bars.map((b) => b.low), bars.map((b) => b.close), p.atrLen);
  const warmup = Math.max(p.emaLen * 2, p.atrLen) + p.slopeLag;

  let d = warmup;
  while (d < D - 1) {
    const dir = spartanSignal(bars, e, d, p);
    if (dir === 0 || !Number.isFinite(a[d])) { d++; continue; }
    const entry = bars[d + 1].open;
    const stop = dir === 1 ? bars[d].low - p.stopAtr * a[d] : bars[d].high + p.stopAtr * a[d];
    const risk = dir * (entry - stop);
    if (!(risk > 0)) { d++; continue; } // gapped through the stop before entry
    const target = entry + dir * p.rr * risk;
    const notional = Math.min(p.riskPerTrade / (risk / entry), p.maxNotional);

    let exitDay = -1;
    let exit = NaN;
    for (let j = d + 1; j < D; j++) {
      const b = bars[j];
      const prevPx = j === d + 1 ? entry : bars[j - 1].close;
      const gapStop = j > d + 1 && dir * (b.open - stop) <= 0;
      const hitStop = dir === 1 ? b.low <= stop : b.high >= stop;
      const gapTarget = j > d + 1 && dir * (b.open - target) >= 0;
      const hitTarget = dir === 1 ? b.high >= target : b.low <= target;
      let px = b.close;
      if (gapStop) exit = b.open;
      else if (hitStop) exit = stop; // stop first when both are touched
      else if (gapTarget) exit = b.open;
      else if (hitTarget) exit = target;
      else if (j === D - 1) exit = b.close; // mark out at the end of data
      if (Number.isFinite(exit)) { px = exit; exitDay = j; }
      const c = Number.isFinite(carryAnnual[j]) ? carryAnnual[j] : 0;
      ret[j] += dir * notional * (px / prevPx - 1) + notional * (dir * c - swapMarkup) / DAYS_PER_YEAR;
      if (j === d + 1) ret[j] -= notional * cost;
      if (exitDay === j) { ret[j] -= notional * cost; break; }
    }
    trades.push({ signalDay: d, exitDay, dir, entry, stop, target, exit, r: dir * (exit - entry) / risk, notional });
    d = exitDay; // a new signal may form on the exit day's close
  }
  return { ret, trades };
}

// ── Statistics ──────────────────────────────────────────────────────────────

export interface ReturnStats {
  n: number;
  annReturn: number;
  annVol: number;
  sharpe: number;
  /** Per-period (daily) Sharpe — what PSR/DSR take. */
  srPeriod: number;
  skew: number;
  kurt: number;
  /** Max drawdown of the cumulative (non-compounding) return, as a positive fraction. */
  maxDD: number;
}

export function returnStats(ret: number[]): ReturnStats {
  const n = ret.length;
  const mean = n ? ret.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(ret.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  let cum = 0, peak = 0, maxDD = 0;
  for (const r of ret) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }
  const srPeriod = sd > 0 ? mean / sd : 0;
  return {
    n,
    annReturn: mean * DAYS_PER_YEAR,
    annVol: sd * Math.sqrt(DAYS_PER_YEAR),
    sharpe: srPeriod * Math.sqrt(DAYS_PER_YEAR),
    srPeriod,
    skew: n > 2 ? skewness(ret) : 0,
    kurt: n > 3 ? kurtosis(ret) : 3,
    maxDD,
  };
}
