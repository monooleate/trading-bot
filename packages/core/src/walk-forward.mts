// packages/core/src/walk-forward.mts
//
// Walk-forward scoring harness over the prediction ledger —
// model-discovery-expansion §4.B (B49 #4). Pure, portable (zero I/O). The
// Hetzner-free, backtest-engine-free version of B11.
//
// WHY: the system validates on a forward record, and #3 (PSR/MinTRL/DSR) judges
// the Sharpe. But the sharper question for a forecasting bot is: **do the
// model's probabilities beat the MARKET PRICE, out-of-sample, consistently over
// time?** The prediction ledger is the right substrate — it logs P(YES) for
// EVERY scanned market (taken + skipped → unbiased) with the realised YES
// outcome and a resolution timestamp. This harness sorts resolved predictions by
// resolution time, splits them into chronological (walk-forward) blocks, and per
// block computes proper scores for the model vs the market baseline:
//   • Brier skill = 1 − Brier(model)/Brier(market)   (>0 ⇒ model beats price)
//   • log-loss (model vs market)
// Pooled numbers hide regime decay; per-block numbers reveal whether the edge
// holds across time or sits in one lucky window. Scoring only — no fitting, so
// no train/test leakage; a single time-ordered pass with a market baseline is
// the correct, honest measurement.
//
// Correlation caveat (surfaced, not silently ignored): crypto markets resolving
// the same day (a BTC strike ladder) or weather buckets for the same city/day
// are highly correlated — one move counts many times. We report `maxDayShare`
// and `effectiveDays` so a block dominated by one correlated cluster is visible.
// (A full purge/de-correlation is a follow-up; per the research the purge
// mainly matters for calibration FITTING, not pure per-block scoring.)

export interface LedgerPoint {
  predictedProb: number;   // model P(YES) at the latest pre-resolution scan
  marketPrice: number;     // market P(YES) baseline at the same scan
  outcome: number;         // realised YES resolution, 0 or 1
  resolvedAtMs: number;    // resolution time (for chronological ordering)
  slug: string;
}

export interface WfBlock {
  index: number;
  n: number;
  startTs: string;
  endTs: string;
  brierModel: number;
  brierMarket: number;
  brierSkill: number;      // 1 − brierModel/brierMarket  (>0 ⇒ model beats market)
  logLossModel: number;
  logLossMarket: number;
  avgPredicted: number;
  avgOutcome: number;
}

export interface WalkForwardResult {
  nResolved: number;
  nBlocks: number;
  blocks: WfBlock[];
  overall: {
    brierModel: number;
    brierMarket: number;
    brierSkill: number;
    logLossModel: number;
    logLossMarket: number;
  };
  blocksPositiveSkill: number;   // # blocks with brierSkill > 0
  consistency: number;           // blocksPositiveSkill / nBlocks
  effectiveDays: number;         // distinct resolution days (correlation proxy)
  maxDayShare: number;           // largest single-day share of n (1 ⇒ all one cluster)
  detail?: string;
}

const EPS = 1e-6;

const brier = (p: number, y: number) => (p - y) * (p - y);
const logLoss = (p: number, y: number) => {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/**
 * Extract scorable points from prediction-ledger records: resolved (outcome
 * 0/1), finite model/market probs in [0,1], parseable resolution time. Pure.
 */
export function ledgerPointsFromRecords(
  records: Array<{
    predictedProb?: unknown; marketPrice?: unknown; outcome?: unknown;
    resolvedAt?: unknown; endDate?: unknown; slug?: unknown;
  }>,
): LedgerPoint[] {
  const out: LedgerPoint[] = [];
  for (const r of records ?? []) {
    if (r.outcome === null || r.outcome === undefined) continue; // unresolved (Number(null)===0 would slip through)
    const y = Number(r.outcome);
    if (y !== 0 && y !== 1) continue;
    const p = Number(r.predictedProb);
    const m = Number(r.marketPrice);
    if (!Number.isFinite(p) || p < 0 || p > 1) continue;
    if (!Number.isFinite(m) || m <= 0 || m >= 1) continue; // market price must be a usable baseline
    const t = Date.parse(String(r.resolvedAt ?? r.endDate ?? ""));
    if (!Number.isFinite(t)) continue;
    out.push({ predictedProb: p, marketPrice: m, outcome: y, resolvedAtMs: t, slug: String(r.slug ?? "") });
  }
  return out;
}

function scoreSet(points: LedgerPoint[]): {
  brierModel: number; brierMarket: number; brierSkill: number;
  logLossModel: number; logLossMarket: number; avgPredicted: number; avgOutcome: number;
} {
  const bm = mean(points.map((p) => brier(p.predictedProb, p.outcome)));
  const bk = mean(points.map((p) => brier(p.marketPrice, p.outcome)));
  const lm = mean(points.map((p) => logLoss(p.predictedProb, p.outcome)));
  const lk = mean(points.map((p) => logLoss(p.marketPrice, p.outcome)));
  const skill = bk > EPS ? 1 - bm / bk : (bm <= EPS ? 0 : -1);
  return {
    brierModel: bm, brierMarket: bk, brierSkill: skill,
    logLossModel: lm, logLossMarket: lk,
    avgPredicted: mean(points.map((p) => p.predictedProb)),
    avgOutcome: mean(points.map((p) => p.outcome)),
  };
}

const dayOf = (ms: number) => Math.floor(ms / 86_400_000);
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Walk-forward scoring over resolved ledger points. Sorts by resolution time,
 * splits into `blockCount` contiguous chronological blocks, and scores the model
 * vs the market baseline per block + pooled. Pure.
 *
 * `blockCount` is the target; it shrinks to the number of points when data is
 * scarce so every block is non-empty. Fewer than 2 valid points → empty result.
 */
export function computeWalkForward(
  points: LedgerPoint[],
  opts: { blockCount?: number } = {},
): WalkForwardResult {
  const valid = (points ?? [])
    .filter((p) => Number.isFinite(p.resolvedAtMs))
    .slice()
    .sort((a, b) => a.resolvedAtMs - b.resolvedAtMs);

  const empty: WalkForwardResult = {
    nResolved: valid.length, nBlocks: 0, blocks: [],
    overall: { brierModel: NaN, brierMarket: NaN, brierSkill: NaN, logLossModel: NaN, logLossMarket: NaN },
    blocksPositiveSkill: 0, consistency: 0, effectiveDays: 0, maxDayShare: 0,
  };
  if (valid.length < 2) return { ...empty, detail: "need ≥2 resolved predictions" };

  const targetBlocks = Math.max(1, Math.min(opts.blockCount ?? 5, valid.length));
  const size = Math.ceil(valid.length / targetBlocks);
  const blocks: WfBlock[] = [];
  for (let i = 0; i < valid.length; i += size) {
    const chunk = valid.slice(i, i + size);
    if (chunk.length === 0) continue;
    const s = scoreSet(chunk);
    blocks.push({
      index: blocks.length,
      n: chunk.length,
      startTs: iso(chunk[0].resolvedAtMs),
      endTs: iso(chunk[chunk.length - 1].resolvedAtMs),
      ...s,
    });
  }

  const overall = scoreSet(valid);
  const blocksPositiveSkill = blocks.filter((b) => b.brierSkill > 0).length;

  // Correlation caveat: distinct resolution days + largest single-day share.
  const dayCounts = new Map<number, number>();
  for (const p of valid) dayCounts.set(dayOf(p.resolvedAtMs), (dayCounts.get(dayOf(p.resolvedAtMs)) ?? 0) + 1);
  const effectiveDays = dayCounts.size;
  const maxDayShare = Math.max(...dayCounts.values()) / valid.length;

  return {
    nResolved: valid.length,
    nBlocks: blocks.length,
    blocks,
    overall: {
      brierModel: overall.brierModel,
      brierMarket: overall.brierMarket,
      brierSkill: overall.brierSkill,
      logLossModel: overall.logLossModel,
      logLossMarket: overall.logLossMarket,
    },
    blocksPositiveSkill,
    consistency: blocks.length ? blocksPositiveSkill / blocks.length : 0,
    effectiveDays,
    maxDayShare,
  };
}
