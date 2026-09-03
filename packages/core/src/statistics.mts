import type { ClosedTrade, SignalBreakdown } from "./types.mts";
import { skewness, kurtosis, probabilisticSharpe, minTrackRecordLength } from "./sharpe-robust.mts";

// Sentinel for a non-computable MinTRL (SR ≤ 0 → the record can never become
// significant). JSON-safe (Infinity serializes to null); the UI renders "∞".
const MINTRL_NEVER = 999999;

// ─── Math helpers ─────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Weighted Pearson correlation. Same contract as `pearsonCorrelation` but
 * each pair (xs[i], ys[i]) is weighted by ws[i]. Used by realized-IC
 * recalibration to apply exponential decay over a trade history (recent
 * trades count more than old ones). Weights of zero / NaN drop the pair.
 *
 * If `ws` is omitted or all-zero, falls back to the unweighted formula
 * (equivalent to ws = [1,1,...]).
 */
export function weightedPearsonCorrelation(
  xs: number[],
  ys: number[],
  ws: number[],
): number {
  if (xs.length !== ys.length || xs.length !== ws.length || xs.length < 2) return 0;
  let sumW = 0;
  let mx = 0;
  let my = 0;
  // First pass: weighted means.
  for (let i = 0; i < xs.length; i++) {
    if (
      !Number.isFinite(xs[i]) || !Number.isFinite(ys[i]) || !Number.isFinite(ws[i]) || ws[i] <= 0
    ) continue;
    sumW += ws[i];
    mx   += ws[i] * xs[i];
    my   += ws[i] * ys[i];
  }
  if (sumW <= 0) return 0;
  mx /= sumW;
  my /= sumW;
  // Second pass: weighted covariance + variances.
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (
      !Number.isFinite(xs[i]) || !Number.isFinite(ys[i]) || !Number.isFinite(ws[i]) || ws[i] <= 0
    ) continue;
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += ws[i] * a * b;
    dx  += ws[i] * a * a;
    dy  += ws[i] * b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

/**
 * Pearson correlation between two numeric arrays.
 * Returns 0 if either array is constant, length mismatches, or fewer than
 * 2 finite pairs remain after dropping NaN/Infinity. Pairs are kept
 * jointly: dropping requires BOTH values to be finite, otherwise the index
 * is excluded from both sides.
 */
export function pearsonCorrelation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  // Drop indexes where either side is non-finite, jointly.
  const fx: number[] = [];
  const fy: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      fx.push(xs[i]); fy.push(ys[i]);
    }
  }
  if (fx.length < 2) return 0;
  const mx = mean(fx);
  const my = mean(fy);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < fx.length; i++) {
    const a = fx[i] - mx;
    const b = fy[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

/**
 * Linear regression: returns { slope, intercept }.
 */
function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  if (xs.length !== ys.length || xs.length < 2) return { slope: 0, intercept: 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: my - slope * mx };
}

// ─── Summary statistics ───────────────────────────────────

export interface SummaryStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalPnlPct: number;           // vs initial bankroll
  avgPnlPerTrade: number;
  avgEdgeAtEntry: number;
  sharpeRatio: number;
  sharpeCiLo: number;             // 95% bootstrap CI lower (200 resamples, deterministic LCG)
  sharpeCiHi: number;             // 95% bootstrap CI upper — wide band on small N flags "not yet meaningful"
  // Robust-Sharpe stats (B49 #3) — fat-tail / small-sample aware.
  returnSkew: number;             // sample skewness of per-trade returns
  returnKurtosis: number;         // sample RAW kurtosis (normal = 3)
  psr: number;                    // Probabilistic Sharpe P(true SR > 0) ∈ [0,1] — fat-tail aware significance
  minTrl: number;                 // Min Track Record Length: trades needed for SR significant at 95% (∞ if SR≤0)
  sortinoRatio: number;           // mean(returns) / std(negative returns) — downside-only Sharpe
  profitFactor: number;           // Σwins / |Σlosses| — capped at 999 when no losses
  expectancy: number;             // p×avgWin − q×avgLoss, in USD per trade
  payoffRatio: number;            // avgWin / avgLoss
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: number;          // signed: +N winning, −N losing, 0 = no trades
  evGap: number;                  // (Σactual − ΣEV) over the full window — leading indicator of edge-decay
  maxDrawdown: number;            // absolute USD
  maxDrawdownPct: number;
  maxDrawdownDuration: number;    // # trades from peak to the trade that broke the prior peak (or current)
  kellyOptimal: number;
  kellyUsed: number;              // estimated from avg position size
  kellyEfficiency: number;
  calibrationDeviation: number;   // avg |predicted - actual| over buckets
  isWellCalibrated: boolean;
}

// Deterministic LCG (Numerical Recipes constants). Used by the bootstrap CI
// so a given trade list always produces the same CI band — avoids the chart
// jittering on every panel refresh. Seeded from totalPnl + trade count, both
// of which change exactly when new trades land.
function lcgFactory(seed: number): () => number {
  let state = (Math.floor(seed * 1e6) | 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    // map to [0, 1)
    return ((state >>> 0) / 0x100000000);
  };
}

/**
 * Bootstrap percentile CI for the Sharpe ratio over the given per-trade
 * returns. Returns [lo, hi] at the requested confidence (default 95%).
 * Uses `samples` resamples with replacement; default 200 is a good
 * speed/accuracy trade-off for the panel (sub-millisecond at N=200 trades).
 *
 * Deterministic for a given returns array — seeded LCG, see `lcgFactory`.
 * Returns [0, 0] when fewer than 3 returns (CI undefined).
 */
function bootstrapSharpeCi(
  returns: number[],
  samples: number = 200,
  confidence: number = 0.95,
): [number, number] {
  const n = returns.length;
  if (n < 3) return [0, 0];
  const rfPerTrade = 0.05 / 365;
  const seed = returns.reduce((s, r) => s + r, 0) + n * 0.001;
  const rand = lcgFactory(seed);
  const sharpes: number[] = [];
  for (let k = 0; k < samples; k++) {
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const r = returns[Math.floor(rand() * n)];
      sum += r;
      sumSq += r * r;
    }
    const m = sum / n;
    const variance = sumSq / n - m * m;
    const sd = variance > 0 ? Math.sqrt(variance * n / (n - 1)) : 0;
    sharpes.push(sd > 0 ? (m - rfPerTrade) / sd : 0);
  }
  sharpes.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  const lo = sharpes[Math.floor(tail * samples)];
  const hi = sharpes[Math.min(samples - 1, Math.floor((1 - tail) * samples))];
  return [lo, hi];
}

/**
 * Longest run of `predicate(t) === true` plus the signed current streak.
 * `current` is positive when the last trade matched the predicate, negative
 * when the opposite, zero when no trades. Used to compute win/loss streaks
 * from the same trade list in a single pass.
 */
function streakStats(
  trades: ClosedTrade[],
  isWin: (t: ClosedTrade) => boolean,
): { longestWin: number; longestLoss: number; current: number } {
  let longestWin = 0;
  let longestLoss = 0;
  let runWin = 0;
  let runLoss = 0;
  for (const t of trades) {
    if (isWin(t)) {
      runWin += 1;
      runLoss = 0;
      if (runWin > longestWin) longestWin = runWin;
    } else {
      runLoss += 1;
      runWin = 0;
      if (runLoss > longestLoss) longestLoss = runLoss;
    }
  }
  const current = runWin > 0 ? runWin : -runLoss;
  return { longestWin, longestLoss, current };
}

/**
 * Per-trade EV using the same direction-aware binary payout model as
 * `computeCumulativePnl`. Returns 0 for non-binary venues (HL perp) where we
 * collapse EV → actual to keep the chart readable — `evGap` correspondingly
 * collapses to 0 for those, which is the right semantic ("no EV-model gap to
 * report").
 */
function tradeEv(t: ClosedTrade): number {
  const isBinary = t.entryPrice >= 0 && t.entryPrice <= 1;
  if (!isBinary || t.predictedProb === undefined) return t.pnl;
  const isYesLike = t.direction === "YES" || (t.direction as any) === "LONG";
  const winProb = isYesLike ? t.predictedProb : 1 - t.predictedProb;
  const winPayoff = t.shares * (1 - t.entryPrice);
  const lossPayoff = -t.shares * t.entryPrice;
  return winProb * winPayoff + (1 - winProb) * lossPayoff;
}

export function computeSummary(trades: ClosedTrade[], initialBankroll: number = 150): SummaryStats {
  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, totalPnlPct: 0, avgPnlPerTrade: 0, avgEdgeAtEntry: 0,
      sharpeRatio: 0, sharpeCiLo: 0, sharpeCiHi: 0,
      returnSkew: 0, returnKurtosis: 3, psr: 0, minTrl: MINTRL_NEVER,
      sortinoRatio: 0,
      profitFactor: 0, expectancy: 0, payoffRatio: 0,
      longestWinStreak: 0, longestLossStreak: 0, currentStreak: 0,
      evGap: 0,
      maxDrawdown: 0, maxDrawdownPct: 0, maxDrawdownDuration: 0,
      kellyOptimal: 0, kellyUsed: 0, kellyEfficiency: 0,
      calibrationDeviation: 0, isWellCalibrated: false,
    };
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl <= 0).length;
  const winRate = wins / trades.length;

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgPnlPerTrade = totalPnl / trades.length;

  const edges = trades.map((t) => t.edgeAtEntry ?? 0).filter((e) => e > 0);
  const avgEdgeAtEntry = mean(edges);

  // Sharpe: use pnlPct (returns per trade)
  const returns = trades.map((t) => t.pnlPct / 100);
  const avgReturn = mean(returns);
  const std = stdDev(returns);
  const rfPerTrade = 0.05 / 365;
  const sharpeRatio = std > 0 ? (avgReturn - rfPerTrade) / std : 0;
  const [sharpeCiLo, sharpeCiHi] = bootstrapSharpeCi(returns, 200, 0.95);

  // Robust-Sharpe stats (B49 #3): fat-tail / small-sample aware significance.
  // Uses the RAW per-trade Sharpe (not the rounded display value) + sample
  // skew/kurtosis of the same per-trade returns.
  const returnSkew = skewness(returns);
  const returnKurtosis = kurtosis(returns);
  const psr = probabilisticSharpe(sharpeRatio, returns.length, returnSkew, returnKurtosis, 0);
  const minTrlRaw = minTrackRecordLength(sharpeRatio, returnSkew, returnKurtosis, 0, 0.95);
  const minTrl = Number.isFinite(minTrlRaw) ? Math.ceil(minTrlRaw) : MINTRL_NEVER;

  // Sortino: downside-only standard deviation. Uses 0 as the MAR
  // (minimum acceptable return) — i.e. the bot's own break-even, not a
  // benchmark return. Returns 0 when no downside observations.
  const downside = returns.filter((r) => r < 0);
  const downsideStd = downside.length >= 2
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : 0;
  const sortinoRatio = downsideStd > 0 ? (avgReturn - rfPerTrade) / downsideStd : 0;

  // Max drawdown — track magnitude AND duration (trades from peak to recovery).
  // Duration semantic: number of trades since the peak that hasn't been
  // re-broken yet. If the bot is currently at a peak, duration = 0.
  let peak = 0;
  let maxDD = 0;
  let cum = 0;
  let peakIdx = 0;
  let maxDDDuration = 0;
  for (let i = 0; i < trades.length; i++) {
    cum += trades[i].pnl;
    if (cum >= peak) {
      peak = cum;
      peakIdx = i;
    }
    const dd = peak - cum;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDDuration = i - peakIdx;
    }
  }

  // Profit factor + expectancy + payoff ratio.
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
  const profitFactor = grossLoss > 0
    ? Math.min(999, grossWin / grossLoss)
    : (grossWin > 0 ? 999 : 0);                    // cap at 999 when no losses to avoid Infinity in UI

  const winPnls = trades.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const lossPnls = trades.filter((t) => t.pnl <= 0).map((t) => Math.abs(t.pnl));
  const avgWin = mean(winPnls);
  const avgLoss = mean(lossPnls);
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 999 : 0);
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  // Streaks (chronological — trades are pre-sorted by caller).
  const { longestWin, longestLoss, current } = streakStats(trades, (t) => t.pnl > 0);

  // EV-gap: cumulative actual vs cumulative EV over the full window. Binary
  // venues only — for HL perp `tradeEv` returns `t.pnl`, so the gap is 0.
  // Positive gap = bot beats its own predicted EV (slippage/luck tailwind);
  // negative gap = under-realizing (slippage/fees/regime drift).
  const evCum = trades.reduce((s, t) => s + tradeEv(t), 0);
  const evGap = totalPnl - evCum;

  // Kelly estimation
  const b = avgLoss > 0 ? avgWin / avgLoss : 1;
  const p = winRate;
  const q = 1 - p;
  const kellyOptimal = b > 0 ? Math.max(0, (p * b - q) / b) : 0;

  // Used Kelly: avg position size / bankroll (approximation)
  const avgSize = mean(trades.map((t) => Math.abs(t.shares * t.entryPrice)));
  const kellyUsed = avgSize / initialBankroll;
  const kellyEfficiency = kellyOptimal > 0 ? kellyUsed / kellyOptimal : 0;

  // Calibration deviation: compute avg across buckets
  const buckets = computeCalibration(trades);
  const validBuckets = buckets.filter((b) => b.tradeCount >= 3);
  const calibrationDeviation = validBuckets.length > 0
    ? mean(validBuckets.map((b) => Math.abs(b.deviation)))
    : 0;
  const isWellCalibrated = calibrationDeviation < 0.07 && validBuckets.length >= 3;

  return {
    totalTrades: trades.length, wins, losses,
    winRate: Math.round(winRate * 1000) / 1000,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalPnlPct: Math.round((totalPnl / initialBankroll) * 1000) / 10,
    avgPnlPerTrade: Math.round(avgPnlPerTrade * 100) / 100,
    avgEdgeAtEntry: Math.round(avgEdgeAtEntry * 1000) / 1000,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    sharpeCiLo:   Math.round(sharpeCiLo * 100) / 100,
    sharpeCiHi:   Math.round(sharpeCiHi * 100) / 100,
    returnSkew:     Math.round(returnSkew * 1000) / 1000,
    returnKurtosis: Math.round(returnKurtosis * 100) / 100,
    psr:            Math.round(psr * 1000) / 1000,
    minTrl,
    sortinoRatio: Math.round(sortinoRatio * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    expectancy:   Math.round(expectancy * 100) / 100,
    payoffRatio:  Math.round(payoffRatio * 100) / 100,
    longestWinStreak:  longestWin,
    longestLossStreak: longestLoss,
    currentStreak:     current,
    evGap:        Math.round(evGap * 100) / 100,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxDrawdownPct: Math.round((maxDD / initialBankroll) * 1000) / 10,
    maxDrawdownDuration: maxDDDuration,
    kellyOptimal: Math.round(kellyOptimal * 1000) / 1000,
    kellyUsed: Math.round(kellyUsed * 1000) / 1000,
    kellyEfficiency: Math.round(kellyEfficiency * 100) / 100,
    calibrationDeviation: Math.round(calibrationDeviation * 1000) / 1000,
    isWellCalibrated,
  };
}

// ─── Cumulative PnL vs baselines ──────────────────────────

export interface CumulativePoint {
  index: number;
  closedAt: string;
  actual: number;
  random: number;       // expected PnL if random 50/50
  ev: number;           // expected value based on edge at entry
  drawdown: number;     // running underwater curve: cum − runningPeak (≤ 0)
  peak: number;         // running peak of actualCum at this index
}

export function computeCumulativePnl(trades: ClosedTrade[]): CumulativePoint[] {
  const points: CumulativePoint[] = [];
  let actualCum = 0;
  let randomCum = 0;
  let evCum = 0;
  let runningPeak = 0;          // running max of actualCum — underwater curve anchor

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    actualCum += t.pnl;
    if (actualCum > runningPeak) runningPeak = actualCum;

    // The random/EV baselines below use the Polymarket-binary payout model
    // (entryPrice ∈ [0,1] is the YES probability, shares × (1−entryPrice)
    // is the win payoff). For directional perp trades (HL) entryPrice is a
    // USD coin price (e.g. 80531) and the formula would blow the chart
    // scale to millions. For perp trades the "random direction" baseline
    // is 0 (a coin-flip directional bet has zero expected return before
    // fees) and we don't have enough info to model EV without knowing
    // typical price-move magnitude, so we collapse EV onto the actual
    // line. This keeps the chart readable for HL while preserving the
    // original Polymarket semantics for crypto / weather / sports.
    const isBinary = t.entryPrice >= 0 && t.entryPrice <= 1;

    if (isBinary) {
      // Random baseline: expected PnL if outcome was 50/50
      // E[pnl] = 0.5 * (1 - entry) * shares + 0.5 * (-entry) * shares
      //       = shares * 0.5 * (1 - 2*entry)
      const costBasis = t.shares * t.entryPrice;
      const randomExpected = t.shares * 0.5 * (1 - 2 * t.entryPrice);
      randomCum += randomExpected;

      // EV baseline: if predicted prob is correct (direction-aware).
      //
      // Fix #F (2026-05-11): the legacy formula used `predictedProb` (which
      // is always the YES probability) directly as the win-probability,
      // ignoring `t.direction`. For NO trades the actual win-probability is
      // `1 - predictedProb` — without this correction the EV baseline
      // chart pointed in the wrong direction for every NO trade, making
      // the trader's signal-fidelity comparison meaningless on mixed sides.
      if (t.predictedProb !== undefined) {
        // SHORT mirrors NO for perp trades expressed in this synthetic
        // binary basis (treated identically by the win-prob inversion).
        const isYesLike = t.direction === "YES" || (t.direction as any) === "LONG";
        const winProb = isYesLike ? t.predictedProb : 1 - t.predictedProb;
        const winPayoff = t.shares * (1 - t.entryPrice);
        const lossPayoff = -costBasis;
        const evExpected = winProb * winPayoff + (1 - winProb) * lossPayoff;
        evCum += evExpected;
      } else {
        evCum += t.pnl; // fall back to actual
      }
    } else {
      // Non-binary venue (HL perp etc.): random ≡ 0 cumulative, EV ≡ actual.
      evCum += t.pnl;
    }

    points.push({
      index: i + 1,
      closedAt: t.closedAt,
      actual: Math.round(actualCum * 100) / 100,
      random: Math.round(randomCum * 100) / 100,
      ev: Math.round(evCum * 100) / 100,
      drawdown: Math.round((actualCum - runningPeak) * 100) / 100, // ≤ 0
      peak: Math.round(runningPeak * 100) / 100,
    });
  }

  return points;
}

// ─── Calibration buckets ──────────────────────────────────

export interface CalibrationBucket {
  probRange: [number, number];
  predictedAvg: number;
  actualWinRate: number;
  tradeCount: number;
  deviation: number;
  isWellCalibrated: boolean;
}

export function computeCalibration(trades: ClosedTrade[]): CalibrationBucket[] {
  const edges = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.0];
  const buckets: CalibrationBucket[] = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    // Filter trades whose EFFECTIVE prob (prob of the direction taken) falls in bucket
    // For YES/LONG trades: predictedProb; for NO/SHORT: 1 - predictedProb
    const isYesLike = (d: any) => d === "YES" || d === "LONG";
    const inBucket = trades.filter((t) => {
      if (t.predictedProb === undefined) return false;
      const p = isYesLike(t.direction) ? t.predictedProb : 1 - t.predictedProb;
      return p >= lo && p < hi;
    });

    if (inBucket.length === 0) {
      buckets.push({
        probRange: [lo, hi],
        predictedAvg: (lo + hi) / 2,
        actualWinRate: 0,
        tradeCount: 0,
        deviation: 0,
        isWellCalibrated: false,
      });
      continue;
    }

    const predictedAvg = mean(inBucket.map((t) => isYesLike(t.direction) ? t.predictedProb! : 1 - t.predictedProb!));
    const actualWinRate = inBucket.filter((t) => t.pnl > 0).length / inBucket.length;
    const deviation = actualWinRate - predictedAvg;

    buckets.push({
      probRange: [lo, hi],
      predictedAvg: Math.round(predictedAvg * 1000) / 1000,
      actualWinRate: Math.round(actualWinRate * 1000) / 1000,
      tradeCount: inBucket.length,
      deviation: Math.round(deviation * 1000) / 1000,
      isWellCalibrated: Math.abs(deviation) < 0.05,
    });
  }

  return buckets;
}

// ─── Proper scoring harness (log-score + Brier-Murphy) ────
// Model-discovery §7 #1. Scores the forecast probability itself, not the
// PnL — PnL is too noisy at n<200 to compare combiner variants, whereas a
// strictly-proper score (Brier / log-loss) rewards calibration + sharpness
// jointly and is the correct selection metric for a Kelly-sized bot (Kelly
// growth ≈ log-score optimisation).
//
// The forecast being scored is the model's P(the trade wins):
//   p_win = isYesLike ? predictedProb : 1 − predictedProb
// against the binary outcome y = (pnl > 0). This works for EVERY category
// that carries `predictedProb` (crypto/weather/HL/sports) — including HL
// perp, where the EV chart collapses but the win-probability forecast is
// still a valid thing to score.
//
// Murphy (a.k.a. Brier) decomposition via K equal-width bins:
//   Brier ≈ Reliability − Resolution + Uncertainty
//     Reliability  = (1/N) Σ n_k (p̄_k − ō_k)²   ← calibration error, ↓ better (0 = perfect)
//     Resolution   = (1/N) Σ n_k (ō_k − ō)²      ← discrimination, ↑ better
//     Uncertainty  = ō(1 − ō)                    ← irreducible base-rate variance
// The identity is exact only for the bin-representative forecast; with
// individual forecasts a small within-bin grouping term remains, reported
// verbatim as `decompositionResidual` (no hand-waving).
//
// Skill scores use the base-rate (climatology) forecast as reference:
//   BrierSkill = 1 − Brier / Uncertainty     (>0 ⇒ beats always-predict-ō)
//   LogSkill   = 1 − LogScore / BaseEntropy   (>0 ⇒ beats always-predict-ō)

export interface ReliabilityBin {
  lo: number;              // bin lower edge on the forecast axis [0,1]
  hi: number;              // bin upper edge
  meanPredicted: number;   // mean forecast P(win) of trades in the bin
  observedFreq: number;    // realised win frequency in the bin
  count: number;           // # trades in the bin
}

export interface ProperScores {
  n: number;                     // # trades scored (those carrying predictedProb)
  baseRate: number;              // ō — realised win frequency of the scored set
  brier: number;                 // mean (p − y)²  ↓ better  (range [0,1])
  logScore: number;              // mean −[y·ln p + (1−y)·ln(1−p)]  ↓ better
  reliability: number;           // calibration error (↓ better; 0 = perfectly calibrated)
  resolution: number;            // discrimination (↑ better)
  uncertainty: number;           // ō(1−ō) — irreducible
  decompositionResidual: number; // brier − (reliability − resolution + uncertainty)
  brierSkillScore: number;       // 1 − brier/uncertainty  (>0 beats base rate)
  logSkillScore: number;         // 1 − logScore/baseEntropy (>0 beats base rate)
  reliabilityBins: ReliabilityBin[];
  binCount: number;
  message: string;
}

const PROPER_SCORE_EPS = 1e-6;   // clip for log-score so a confident-wrong forecast can't blow up to ∞

function isYesLikeDir(d: unknown): boolean {
  return d === "YES" || d === "LONG";
}

/**
 * Extract aligned (forecast P(win), outcome) pairs from closed trades that
 * carry a finite predictedProb. `p_win` is direction-aware (YES/LONG use
 * predictedProb; NO/SHORT use 1−predictedProb); outcome is 1 iff pnl>0.
 * Order is preserved (caller sorts chronologically), so the same pairs feed
 * both the proper-scoring harness (#1) and the walk-forward calibrator (#2).
 * Shared single source of truth for "what forecast are we scoring".
 */
export function extractWinProbPairs(trades: ClosedTrade[]): { ps: number[]; ys: number[] } {
  const ps: number[] = [];
  const ys: number[] = [];
  for (const t of trades) {
    const pp = t.predictedProb;
    if (pp === undefined || pp === null || !Number.isFinite(pp)) continue;
    const pWin = isYesLikeDir(t.direction) ? pp : 1 - pp;
    if (!Number.isFinite(pWin)) continue;
    ps.push(Math.min(1, Math.max(0, pWin)));
    ys.push(t.pnl > 0 ? 1 : 0);
  }
  return { ps, ys };
}

/**
 * Proper-scoring evaluation of the forecast probabilities against realised
 * win/loss outcomes. Pure function; `binCount` controls the reliability
 * diagram / Murphy decomposition granularity (default 10 equal-width bins).
 * Trades without a finite `predictedProb` are skipped (not scored).
 */
export function computeProperScores(
  trades: ClosedTrade[],
  binCount: number = 10,
): ProperScores {
  const bc = Math.max(2, Math.floor(binCount));
  const { ps, ys } = extractWinProbPairs(trades);
  const n = ps.length;

  const empty: ProperScores = {
    n: 0, baseRate: 0, brier: 0, logScore: 0,
    reliability: 0, resolution: 0, uncertainty: 0, decompositionResidual: 0,
    brierSkillScore: 0, logSkillScore: 0,
    reliabilityBins: [], binCount: bc,
    message: "No closed trades carry a predicted probability yet.",
  };
  if (n === 0) return empty;

  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const baseRate = mean(ys);

  // Scalar scores.
  let brierSum = 0;
  let logSum = 0;
  for (let i = 0; i < n; i++) {
    const p = ps[i];
    const y = ys[i];
    brierSum += (p - y) ** 2;
    const pc = Math.min(1 - PROPER_SCORE_EPS, Math.max(PROPER_SCORE_EPS, p));
    logSum += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  const brier = brierSum / n;
  const logScore = logSum / n;
  const uncertainty = baseRate * (1 - baseRate);

  // Binned decomposition + reliability diagram.
  const bins = Array.from({ length: bc }, (_, k) => ({
    pSum: 0, ySum: 0, count: 0, lo: k / bc, hi: (k + 1) / bc,
  }));
  for (let i = 0; i < n; i++) {
    let idx = Math.floor(ps[i] * bc);
    if (idx >= bc) idx = bc - 1;    // p == 1 lands in the last bin
    if (idx < 0) idx = 0;
    bins[idx].pSum += ps[i];
    bins[idx].ySum += ys[i];
    bins[idx].count += 1;
  }
  let reliability = 0;
  let resolution = 0;
  const reliabilityBins: ReliabilityBin[] = [];
  for (const b of bins) {
    if (b.count === 0) continue;
    const pBar = b.pSum / b.count;
    const oBar = b.ySum / b.count;
    reliability += b.count * (pBar - oBar) ** 2;
    resolution += b.count * (oBar - baseRate) ** 2;
    reliabilityBins.push({
      lo: b.lo, hi: b.hi,
      meanPredicted: r4(pBar),
      observedFreq: r4(oBar),
      count: b.count,
    });
  }
  reliability /= n;
  resolution /= n;
  const decompositionResidual = brier - (reliability - resolution + uncertainty);

  const brierSkillScore = uncertainty > 0 ? 1 - brier / uncertainty : 0;
  const brc = Math.min(1 - PROPER_SCORE_EPS, Math.max(PROPER_SCORE_EPS, baseRate));
  const baseEntropy = -(brc * Math.log(brc) + (1 - brc) * Math.log(1 - brc));
  const logSkillScore = baseEntropy > 0 ? 1 - logScore / baseEntropy : 0;

  const skillMsg = brierSkillScore > 0
    ? `Beats the base-rate forecast (Brier skill +${(brierSkillScore * 100).toFixed(1)}%).`
    : `Does NOT beat always-predict-${(baseRate * 100).toFixed(0)}% (Brier skill ${(brierSkillScore * 100).toFixed(1)}%).`;
  const noiseMsg = n < 20 ? " ⚠ n<20 — scores are noisy, treat as indicative only." : "";

  return {
    n,
    baseRate: r4(baseRate),
    brier: r4(brier),
    logScore: r4(logScore),
    reliability: r4(reliability),
    resolution: r4(resolution),
    uncertainty: r4(uncertainty),
    decompositionResidual: r4(decompositionResidual),
    brierSkillScore: r4(brierSkillScore),
    logSkillScore: r4(logSkillScore),
    reliabilityBins,
    binCount: bc,
    message: skillMsg + noiseMsg,
  };
}

// ─── Signal IC (Information Coefficient) ──────────────────

export interface SignalICResult {
  signalName: string;
  ic: number;
  tradeCount: number;
  strength: "strong" | "moderate" | "weak" | "noise";
}

const SIGNAL_NAMES: (keyof SignalBreakdown)[] = [
  "funding_rate", "orderflow", "vol_divergence", "apex_consensus", "cond_prob",
  "momentum", "contrarian", "pairs_spread",
  // Synthetic forecast-edge signal for prediction-driven bots without the
  // 8-signal combiner (weather). Lets the live-readiness IC gate measure
  // forecast skill (edge correlated with win/loss) instead of demanding
  // all 8 trading signals exist for every category.
  "forecast_edge",
];

function classifyIC(ic: number): SignalICResult["strength"] {
  const abs = Math.abs(ic);
  if (abs >= 0.10) return "strong";
  if (abs >= 0.05) return "moderate";
  if (abs >= 0.02) return "weak";
  return "noise";
}

export function computeSignalIC(trades: ClosedTrade[]): SignalICResult[] {
  const withSignals = trades.filter((t) => t.signalBreakdown !== null && t.signalBreakdown !== undefined);
  return SIGNAL_NAMES.map((name) => {
    const scores: number[] = [];
    const outcomes: number[] = [];
    for (const t of withSignals) {
      const val = t.signalBreakdown![name];
      if (val !== null && val !== undefined) {
        scores.push(val);
        outcomes.push(t.pnl > 0 ? 1 : 0);
      }
    }
    const ic = pearsonCorrelation(scores, outcomes);
    return {
      signalName: name,
      ic: Math.round(ic * 1000) / 1000,
      tradeCount: scores.length,
      strength: classifyIC(ic),
    };
  });
}

// ─── Calibration health (signal IC summary) ───────────────
// Used by both the trader cron (to optionally suspend live trading and
// fire a Telegram alert) and the Edge Tracker UI (to render a health
// badge). All thresholds are deliberate and live here so paper-mode
// evaluation matches what the alerting path uses.
//
// 2026-05-11 (Tier 1): Bonferroni-corrected thresholds. Eddig a
// `|IC| ≥ 0.05` küszöb per-signal volt elfogadva mint "good", de 8 signal
// egyszerre tesztelve (`signal_count`) familywise error rate ~33%
// (Pearson SE n=143-on ~0.084 mellett), vagyis hamis bizalom-jel.
//
// A Bonferroni-korrekció: per-signal α = α_familywise / signal_count.
// α_familywise = 0.05 mellett és 8 signal-on per-signal α = 0.00625.
// Pearson SE ≈ (1 - r²) / √(n - 2). Kétoldali z-test:
//   |IC| küszöb ≈ z_{α/2} × SE ≈ z_{0.003125} × 1/√n ≈ 2.73 / √n
// n=143-on → küszöb ≈ 0.228 / √n ≈ 0.082 (good), n=300-on ≈ 0.057.
//
// A konzervatív fix: a `good`/`weak`/`noise` küszöböket adaptívan
// számoljuk a trade-szám és a signal-szám alapján, nem statikus
// 0.05/0.02 számokkal. A live-readiness gate ezáltal **nem fogad el
// véletlen-erős signalt** mint érdemi edge-et.

export interface CalibrationHealth {
  status: "good" | "weak" | "noise" | "insufficient";
  maxAbsIC: number;
  topSignal: string | null;
  tradeCount: number;
  shouldSuspendLive: boolean;
  message: string;
  // Bonferroni-derived thresholds for transparency in UI / logs.
  goodThreshold: number;
  weakThreshold: number;
  signalCount: number;
}

/**
 * Bonferroni-corrected per-signal |IC| threshold.
 *
 * @param n            number of closed trades with signalBreakdown
 * @param signalCount  number of signals tested simultaneously (default 8)
 * @param familywiseAlpha overall false-positive rate to control (default 0.05)
 * @param strengthMultiplier 1.0 = "weak" boundary, 2.0 = "good" boundary
 */
function bonferroniICThreshold(
  n: number,
  signalCount: number = 8,
  familywiseAlpha: number = 0.05,
  strengthMultiplier: number = 1.0,
): number {
  if (n < 4) return 1.0;
  const perSignalAlpha = familywiseAlpha / signalCount;
  // z_{α/2} approximation for two-sided test. Common values:
  //   α=0.05 (no correction) → z ≈ 1.96
  //   α=0.00625 (8-signal Bonferroni) → z ≈ 2.73
  //   α=0.00125 (40-signal) → z ≈ 3.23
  // Used Abramowitz-Stegun-style inverse CDF approximation.
  const z = inverseNormalCdf(1 - perSignalAlpha / 2);
  // Pearson SE under H0 (true r = 0): SE = 1 / sqrt(n - 2)
  const SE = 1 / Math.sqrt(Math.max(1, n - 2));
  return Math.min(1.0, z * SE * strengthMultiplier);
}

/**
 * Inverse standard normal CDF (Beasley-Springer-Moro approximation).
 * Returns z such that Φ(z) = p. Accurate to ~7 decimal places for
 * p ∈ (0.0001, 0.9999), which covers all practical α values.
 */
function inverseNormalCdf(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  // Beasley-Springer-Moro: rational approximation for tails + middle.
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
              138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
              66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996,
             3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

export interface CalibrationHealthOptions {
  /** Familywise false-positive rate for Bonferroni correction. */
  bonferroniAlpha?: number;
  /** Multiplier of SE for the `good` boundary; `weak` is fixed at 1×. */
  bonferroniGoodMultiplier?: number;
}

export function computeCalibrationHealth(
  trades: ClosedTrade[],
  minTrades: number = 30,
  options: CalibrationHealthOptions = {},
): CalibrationHealth {
  const ics = computeSignalIC(trades);
  const tc = trades.length;
  const sortedByAbs = [...ics].sort((a, b) => Math.abs(b.ic) - Math.abs(a.ic));
  const top = sortedByAbs[0];
  const maxAbs = top ? Math.abs(top.ic) : 0;

  // Count signals that actually contributed (have non-zero tradeCount).
  // For categories without all 8 signals (e.g. weather with only
  // `forecast_edge`), use the actual non-empty signal count, not 8.
  const signalCount = Math.max(1, ics.filter((s) => s.tradeCount > 0).length);

  // Bonferroni-corrected thresholds. Defaults match the original Tier 1
  // hardcoded values (familywise α = 0.05, good multiplier = 2.0); the
  // Settings UI now exposes both via `bonferroniAlpha` and
  // `bonferroniGoodMultiplier` knobs.
  const familywiseAlpha = options.bonferroniAlpha ?? 0.05;
  const goodMultiplier = options.bonferroniGoodMultiplier ?? 2.0;
  // `weakThreshold` = 1× SE boundary (the "noise vs weak" line)
  // `goodThreshold` = goodMultiplier × SE boundary (the "weak vs good" line)
  const weakThreshold = bonferroniICThreshold(tc, signalCount, familywiseAlpha, 1.0);
  const goodThreshold = bonferroniICThreshold(tc, signalCount, familywiseAlpha, goodMultiplier);

  if (tc < minTrades) {
    return {
      status: "insufficient",
      maxAbsIC: Math.round(maxAbs * 1000) / 1000,
      topSignal: top?.signalName ?? null,
      tradeCount: tc,
      shouldSuspendLive: false,
      message: `Need ${minTrades - tc} more trades before calibration is meaningful`,
      goodThreshold: Math.round(goodThreshold * 1000) / 1000,
      weakThreshold: Math.round(weakThreshold * 1000) / 1000,
      signalCount,
    };
  }

  let status: CalibrationHealth["status"];
  if (maxAbs >= goodThreshold) status = "good";
  else if (maxAbs >= weakThreshold) status = "weak";
  else status = "noise";

  return {
    status,
    maxAbsIC: Math.round(maxAbs * 1000) / 1000,
    topSignal: top?.signalName ?? null,
    tradeCount: tc,
    shouldSuspendLive: status === "noise",
    message:
      status === "noise"
        ? `All signals are noise (max |IC|=${(maxAbs * 100).toFixed(1)}% < weak threshold ${(weakThreshold * 100).toFixed(1)}% over ${tc} trades, ${signalCount} signals Bonferroni-corrected). Live trading should be suspended.`
        : status === "weak"
        ? `Top signal ${top?.signalName} has weak IC=${(maxAbs * 100).toFixed(1)}% (Bonferroni weak=${(weakThreshold * 100).toFixed(1)}%, good=${(goodThreshold * 100).toFixed(1)}%). Marginal predictive value.`
        : `Top signal ${top?.signalName} has IC=${(maxAbs * 100).toFixed(1)}% > Bonferroni good threshold (${(goodThreshold * 100).toFixed(1)}%) — meaningful predictive value.`,
    goodThreshold: Math.round(goodThreshold * 1000) / 1000,
    weakThreshold: Math.round(weakThreshold * 1000) / 1000,
    signalCount,
  };
}

// ─── Signal collinearity matrix ───────────────────────────
// Grinold-Kahn IR = IC × √N feltételezi a signalok statisztikai
// függetlenségét. Ha 2-3 signal valójában ugyanazt méri (pl. orderflow
// és momentum nagyon korrelálnak), a √N hazudik: a tényleges effektív
// signal-szám alacsonyabb mint a nominális, és a Kelly méret
// mesterségesen overaggressive.
//
// A `computeSignalCollinearity` Pearson-mátrixot ad vissza a signal-
// vektorokra (az adott zárt trade-eken). Output:
//   • matrix[i][j] = corr(signal_i, signal_j) ∈ [-1, 1]
//   • highPairs:    list of (a, b, ρ) where |ρ| > 0.7 (Grinold-Kahn
//                   feltételezés sértve)
//   • effectiveN:   pszeudo-rank a mátrixból (a rangok összege egy
//                   egyszerű proxy az effektív független signalokra)

export interface CollinearityCell {
  signalA: string;
  signalB: string;
  correlation: number;
  pairCount: number;
}

export interface CollinearityResult {
  signals: string[];               // signal names with at least minPair pairs
  matrix: number[][];              // square Pearson matrix, NaN-safe
  highPairs: CollinearityCell[];   // |ρ| > highThreshold, sorted desc
  effectiveSignalCount: number;    // nominal signal count haircut by collinearity
  tradeCount: number;              // # trades that contributed
  message: string;
}

export function computeSignalCollinearity(
  trades: ClosedTrade[],
  minPair: number = 20,           // need at least 20 jointly-observed trades per pair
  highThreshold: number = 0.7,    // |ρ| above which Grinold-Kahn independence breaks
): CollinearityResult {
  const withSignals = trades.filter(
    (t) => t.signalBreakdown !== null && t.signalBreakdown !== undefined,
  );

  // Collect per-signal value vectors aligned to the same trade indexes.
  // Use null where a signal didn't fire on that trade — pearsonCorrelation
  // already drops non-finite pairs jointly.
  const vectors = new Map<string, (number | null)[]>();
  for (const name of SIGNAL_NAMES) {
    vectors.set(
      name,
      withSignals.map((t) => {
        const v = t.signalBreakdown![name];
        return v === null || v === undefined ? null : v;
      }),
    );
  }

  // Filter out signals that don't have at least minPair non-null observations.
  const liveSignals = SIGNAL_NAMES.filter((name) => {
    const vec = vectors.get(name) ?? [];
    return vec.filter((v) => v !== null).length >= minPair;
  });

  // Pearson matrix.
  const matrix: number[][] = [];
  const highPairs: CollinearityCell[] = [];
  for (let i = 0; i < liveSignals.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < liveSignals.length; j++) {
      if (i === j) {
        row.push(1);
        continue;
      }
      const va = vectors.get(liveSignals[i]) ?? [];
      const vb = vectors.get(liveSignals[j]) ?? [];
      // Joint-observation filter: keep only trades where BOTH signals fired.
      const xs: number[] = [];
      const ys: number[] = [];
      for (let k = 0; k < va.length; k++) {
        if (va[k] !== null && vb[k] !== null) {
          xs.push(va[k] as number);
          ys.push(vb[k] as number);
        }
      }
      const rho = xs.length >= 4 ? pearsonCorrelation(xs, ys) : 0;
      row.push(Math.round(rho * 1000) / 1000);
      if (i < j && Math.abs(rho) > highThreshold && xs.length >= minPair) {
        highPairs.push({
          signalA: liveSignals[i],
          signalB: liveSignals[j],
          correlation: Math.round(rho * 1000) / 1000,
          pairCount: xs.length,
        });
      }
    }
    matrix.push(row);
  }

  // Effective signal count proxy: rank of (I + |R|)/2 thresholded.
  // A simple approximation: sum of (1 - max |corr| with previous signals)
  // across signals in order. If a signal has ρ=1 with a prior, it adds 0;
  // if independent, adds 1. Gives a continuous "effective N".
  let effectiveN = 0;
  for (let i = 0; i < liveSignals.length; i++) {
    let maxAbsCorr = 0;
    for (let j = 0; j < i; j++) {
      maxAbsCorr = Math.max(maxAbsCorr, Math.abs(matrix[i][j]));
    }
    effectiveN += Math.max(0, 1 - maxAbsCorr);
  }

  highPairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  const message =
    liveSignals.length === 0
      ? "No signals have ≥20 paired observations; need more trades."
      : highPairs.length === 0
      ? `All ${liveSignals.length} signals independent (max |ρ| < ${highThreshold}). Grinold-Kahn IR=IC×√N valid.`
      : `${highPairs.length} collinear pair${
          highPairs.length === 1 ? "" : "s"
        } found (|ρ| > ${highThreshold}). Effective signal count ≈ ${effectiveN.toFixed(
          2,
        )} vs nominal ${liveSignals.length}. Kelly sizing may be overaggressive.`;

  return {
    signals: liveSignals,
    matrix,
    highPairs,
    effectiveSignalCount: Math.round(effectiveN * 100) / 100,
    tradeCount: withSignals.length,
    message,
  };
}

// ─── Edge decay (weekly buckets) ──────────────────────────

export interface EdgeDecayPoint {
  week: string;        // ISO week e.g. "2026-W14"
  avgEdge: number;
  avgPnl: number;
  tradeCount: number;
}

function isoWeek(d: Date): string {
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  const weekNum = 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

export function computeEdgeDecay(trades: ClosedTrade[]): {
  points: EdgeDecayPoint[];
  slope: number;
  hasDecay: boolean;
} {
  const byWeek = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const w = isoWeek(new Date(t.closedAt));
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w)!.push(t);
  }

  const points: EdgeDecayPoint[] = Array.from(byWeek.entries())
    .map(([week, ts]) => ({
      week,
      avgEdge: Math.round(mean(ts.map((t) => t.edgeAtEntry ?? 0)) * 1000) / 1000,
      avgPnl: Math.round(mean(ts.map((t) => t.pnl)) * 100) / 100,
      tradeCount: ts.length,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));

  if (points.length < 4) return { points, slope: 0, hasDecay: false };

  const xs = points.map((_, i) => i);
  const ys = points.map((p) => p.avgEdge);
  const { slope } = linearRegression(xs, ys);
  const hasDecay = slope < -0.005;

  return { points, slope: Math.round(slope * 10000) / 10000, hasDecay };
}

// ─── Win rate heatmap (hour × category) ───────────────────

export interface HeatmapCell {
  hour: number;
  category: string;
  winRate: number;
  tradeCount: number;
}

export function computeWinRateHeatmap(trades: ClosedTrade[]): HeatmapCell[] {
  const map = new Map<string, { wins: number; total: number }>();

  for (const t of trades) {
    const hour = new Date(t.closedAt).getUTCHours();
    const cat = t.category ?? "unknown";
    const key = `${hour}|${cat}`;
    const e = map.get(key) ?? { wins: 0, total: 0 };
    e.total += 1;
    if (t.pnl > 0) e.wins += 1;
    map.set(key, e);
  }

  const cells: HeatmapCell[] = [];
  for (const [key, e] of map.entries()) {
    const [h, cat] = key.split("|");
    cells.push({
      hour: parseInt(h, 10),
      category: cat,
      winRate: e.total > 0 ? Math.round((e.wins / e.total) * 1000) / 1000 : 0,
      tradeCount: e.total,
    });
  }
  return cells;
}

// ─── PnL distribution (histogram) ─────────────────────────

export interface HistogramBin {
  lo: number;
  hi: number;
  count: number;
}

export function computePnlDistribution(trades: ClosedTrade[], bins: number = 20): HistogramBin[] {
  if (trades.length === 0) return [];
  const pnls = trades.map((t) => t.pnl);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const range = max - min || 1;
  const step = range / bins;

  const histogram: HistogramBin[] = [];
  for (let i = 0; i < bins; i++) {
    const lo = min + i * step;
    const hi = lo + step;
    const count = pnls.filter((p) => p >= lo && (i === bins - 1 ? p <= hi : p < hi)).length;
    histogram.push({
      lo: Math.round(lo * 100) / 100,
      hi: Math.round(hi * 100) / 100,
      count,
    });
  }
  return histogram;
}
