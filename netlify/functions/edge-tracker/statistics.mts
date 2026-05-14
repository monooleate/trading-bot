import type { ClosedTrade, SignalBreakdown } from "../auto-trader/shared/types.mts";

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
  maxDrawdown: number;           // absolute USD
  maxDrawdownPct: number;
  kellyOptimal: number;
  kellyUsed: number;              // estimated from avg position size
  kellyEfficiency: number;
  calibrationDeviation: number;   // avg |predicted - actual| over buckets
  isWellCalibrated: boolean;
}

export function computeSummary(trades: ClosedTrade[], initialBankroll: number = 150): SummaryStats {
  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, totalPnlPct: 0, avgPnlPerTrade: 0, avgEdgeAtEntry: 0,
      sharpeRatio: 0, maxDrawdown: 0, maxDrawdownPct: 0,
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

  // Max drawdown
  let peak = 0;
  let maxDD = 0;
  let cum = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  // Kelly estimation
  const winPnls = trades.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const lossPnls = trades.filter((t) => t.pnl <= 0).map((t) => Math.abs(t.pnl));
  const avgWin = mean(winPnls);
  const avgLoss = mean(lossPnls);
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
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxDrawdownPct: Math.round((maxDD / initialBankroll) * 1000) / 10,
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
}

export function computeCumulativePnl(trades: ClosedTrade[]): CumulativePoint[] {
  const points: CumulativePoint[] = [];
  let actualCum = 0;
  let randomCum = 0;
  let evCum = 0;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    actualCum += t.pnl;

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
