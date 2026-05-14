// auto-trader/shared/signal-calibration.mts
//
// Realized-IC pipeline. Computes per-signal Information Coefficient from the
// closedTrades of a category (crypto / hyperliquid) and persists it to
// Blobs so the signal-combiner can blend it into the static SIGNAL_ICS
// priors via Bayes-shrinkage:
//
//     effective_ic[s] = n_s/(n_s+k) × realized[s] + k/(n_s+k) × prior[s]
//
// where:
//   - n_s   = number of closed trades where signal `s` had a non-null score
//   - k     = `calibrationShrinkageK` (default 30) — how slowly priors fade
//   - realized[s] = Pearson(signal_score, win_outcome) on closedTrades
//   - prior[s]    = SIGNAL_ICS[s] (academic priors hard-coded in
//                   signal-combiner.mts:29)
//
// Why shrinkage and not a hard switchover at N=50?
//   - At N=30 the per-signal IC standard error is ~0.18 (1/√(30-2)), so a
//     "realized IC" of 0.07 may actually be true-zero noise. Shrinking
//     toward the prior bounds the swing.
//   - At N=200 the SE drops to ~0.07, the shrinkage weight drops to 13%,
//     and the combiner is mostly running on realized values.
//   - This is the standard James-Stein flavored estimator for IC
//     calibration in quant land.

import { getStore } from "@netlify/blobs";
import type { ClosedTrade } from "./types.mts";
import { pearsonCorrelation, weightedPearsonCorrelation } from "../../edge-tracker/statistics.mts";

const STORE_NAME = "signal-calibration-v1";

// crypto + hyperliquid use the 8-signal combiner; weather uses a synthetic
// single-signal "forecast_edge" so realized-IC reporting still works.
export type CalibrationCategory = "crypto" | "hyperliquid" | "weather";

// Same set the signal-combiner uses internally (synced with signal-combiner.mts:29).
// `forecast_edge` is included so weather can also persist a (single-signal)
// realized-IC record consumed by the recommendations engine.
const SIGNALS = [
  "funding_rate",
  "orderflow",
  "vol_divergence",
  "apex_consensus",
  "cond_prob",
  "momentum",
  "contrarian",
  "pairs_spread",
  "forecast_edge",
] as const;

type SignalName = (typeof SIGNALS)[number];

export interface SignalCalibration {
  ic: number;          // Pearson(score, win) on closedTrades
  n:  number;          // # closed trades where this signal had a non-null score
}

export interface CalibrationRecord {
  category:    CalibrationCategory;
  computedAt:  string;
  sampleSize:  number;                                    // total closed trades considered
  perSignal:   Partial<Record<SignalName, SignalCalibration>>;
}

// ─── Compute ──────────────────────────────────────────────────────────

export interface RealizedICOptions {
  /**
   * Exponential decay half-life in TRADE count. Recent trades count more
   * than old ones — protects against regime-shift drift (e.g. a strategy
   * that was alpha in low-vol regime becomes noise in high-vol regime).
   *
   * Formula: w_i = 0.5 ^ ((N-1-i) / halfLifeTrades)
   *   where i is the chronological index of trade i (oldest = 0,
   *   newest = N-1). Newest trade always has w=1.
   *
   * Default `null` → uniform weighting (current behavior, equivalent to
   * halfLife → ∞). Common choices:
   *   - 50  → recency half-life of 50 trades (~3-7 days at current cadence)
   *   - 200 → very long decay (~weeks)
   *
   * Below ~20 the weighting becomes too aggressive (almost only the latest
   * 30-40 trades count) and the IC swings on noise.
   */
  halfLifeTrades?: number | null;
}

/**
 * Compute per-signal realized IC from closed trades.
 *
 * Returns ALL signals (with `n: 0, ic: 0` placeholders for signals that
 * never fired), so downstream code can iterate uniformly.
 *
 * When `halfLifeTrades` is set, uses weighted-Pearson with exponential
 * decay (newest trade has weight 1, weight halves every halfLifeTrades).
 * Otherwise uniform unweighted Pearson (matching pre-2026-05-14 behavior).
 */
export function computeRealizedICs(
  trades: ClosedTrade[],
  options: RealizedICOptions = {},
): CalibrationRecord["perSignal"] {
  const out: CalibrationRecord["perSignal"] = {};
  // Chronological sort: oldest first, newest last. closedAt is the natural
  // key; fall back to openedAt for any legacy record missing closedAt.
  const withSignals = trades
    .filter((t) => t.signalBreakdown !== null && t.signalBreakdown !== undefined)
    .slice()
    .sort((a, b) => {
      const ka = new Date(a.closedAt ?? a.openedAt ?? 0).getTime();
      const kb = new Date(b.closedAt ?? b.openedAt ?? 0).getTime();
      return ka - kb;
    });

  const halfLife = options.halfLifeTrades;
  const useDecay = typeof halfLife === "number" && Number.isFinite(halfLife) && halfLife > 0;

  for (const name of SIGNALS) {
    const scores: number[] = [];
    const outcomes: number[] = [];
    const indices: number[] = [];   // chronological index inside withSignals
    for (let i = 0; i < withSignals.length; i++) {
      const t = withSignals[i];
      const v = (t.signalBreakdown as any)?.[name];
      if (typeof v === "number" && Number.isFinite(v)) {
        scores.push(v);
        outcomes.push(t.pnl > 0 ? 1 : 0);
        indices.push(i);
      }
    }
    const n = scores.length;
    if (n < 4) {
      out[name] = { ic: 0, n };
      continue;
    }
    let ic: number;
    if (useDecay) {
      // Reference point: position of the newest signal-bearing trade within
      // withSignals. Weighting decays from there.
      const newestIdx = indices[indices.length - 1];
      const weights = indices.map((idx) => Math.pow(0.5, (newestIdx - idx) / (halfLife as number)));
      ic = weightedPearsonCorrelation(scores, outcomes, weights);
    } else {
      ic = pearsonCorrelation(scores, outcomes);
    }
    out[name] = { ic, n };
  }
  return out;
}

// ─── Persist + load ──────────────────────────────────────────────────

function keyForCategory(category: CalibrationCategory): string {
  return `calibration-${category}-v1`;
}

/**
 * Persist a freshly-computed calibration record to Netlify Blobs.
 * Errors are swallowed so a Blobs hiccup never crashes a cron tick.
 */
export async function persistCalibration(
  category: CalibrationCategory,
  trades: ClosedTrade[],
  options: RealizedICOptions = {},
): Promise<CalibrationRecord> {
  const rec: CalibrationRecord = {
    category,
    computedAt: new Date().toISOString(),
    sampleSize: trades.length,
    perSignal:  computeRealizedICs(trades, options),
  };
  try {
    const store = getStore(STORE_NAME);
    await store.set(keyForCategory(category), JSON.stringify(rec));
  } catch {
    // best-effort: a missing Blobs write doesn't block the cron
  }
  return rec;
}

/**
 * Load the most recent calibration record for a category. Returns null
 * if none has been persisted yet (the signal-combiner falls back to
 * static priors in that case).
 */
export async function loadCalibration(
  category: CalibrationCategory,
): Promise<CalibrationRecord | null> {
  try {
    const store = getStore(STORE_NAME);
    const raw = await store.get(keyForCategory(category));
    if (!raw) return null;
    const parsed = JSON.parse(raw as string) as CalibrationRecord;
    if (!parsed?.perSignal) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Shrinkage blend ─────────────────────────────────────────────────

/**
 * Bayes-shrinkage blend of realized IC with a prior.
 *
 *     effective = n/(n+k) × realized + k/(n+k) × prior
 *
 * Edge cases:
 *   - n == 0: return prior unchanged
 *   - n + k == 0 (defensive): return prior
 *   - non-finite realized: return prior
 */
export function shrinkageBlend(realized: number, prior: number, n: number, k: number): number {
  if (!Number.isFinite(realized)) return prior;
  if (n <= 0) return prior;
  const denom = n + k;
  if (denom <= 0) return prior;
  const wRealized = n / denom;
  const wPrior    = k / denom;
  return wRealized * realized + wPrior * prior;
}

/**
 * Build an "effective IC" map from a calibration record + the static
 * priors + the shrinkage constant. Use this as the per-signal IC in
 * the combiner instead of the raw priors.
 *
 * Signals NOT in the calibration record fall through to the prior.
 */
export function effectiveICs(
  priors: Record<string, number>,
  calibration: CalibrationRecord | null,
  k: number,
): Record<string, number> {
  const out: Record<string, number> = { ...priors };
  if (!calibration) return out;
  for (const [name, prior] of Object.entries(priors)) {
    const cal = (calibration.perSignal as any)[name];
    if (!cal || typeof cal.ic !== "number" || typeof cal.n !== "number") continue;
    out[name] = shrinkageBlend(cal.ic, prior, cal.n, k);
  }
  return out;
}
