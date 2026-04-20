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
 * Pearson correlation between two numeric arrays.
 * Returns 0 if either array is constant or length mismatch.
 */
export function pearsonCorrelation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
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

    // Random baseline: expected PnL if outcome was 50/50
    // E[pnl] = 0.5 * (1 - entry) * shares + 0.5 * (-entry) * shares
    //       = shares * 0.5 * (1 - 2*entry)
    const costBasis = t.shares * t.entryPrice;
    const randomExpected = t.shares * 0.5 * (1 - 2 * t.entryPrice);
    randomCum += randomExpected;

    // EV baseline: if predicted prob is correct
    if (t.predictedProb !== undefined) {
      const winPayoff = t.shares * (1 - t.entryPrice);
      const lossPayoff = -costBasis;
      const evExpected = t.predictedProb * winPayoff + (1 - t.predictedProb) * lossPayoff;
      evCum += evExpected;
    } else {
      evCum += t.pnl; // fall back to actual
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
    // For YES trades: predictedProb; for NO: 1 - predictedProb
    const inBucket = trades.filter((t) => {
      if (t.predictedProb === undefined) return false;
      const p = t.direction === "YES" ? t.predictedProb : 1 - t.predictedProb;
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

    const predictedAvg = mean(inBucket.map((t) => t.direction === "YES" ? t.predictedProb! : 1 - t.predictedProb!));
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
