import { FN } from "../shared/config.mts";
import type { AggregatedSignal, SignalBreakdown } from "../shared/types.mts";

const TIMEOUT = 8000;

// ─── P1.3: Binance order-book imbalance helper ──────────────────────
// Pulls top-10 bid/ask depth and compares cumulative size. Used by the
// decision-engine as a convergence filter alongside the combined signal.
//
// Cached in-memory per process for 30s — Netlify Function cold starts
// reset this, so worst case we hit the public REST endpoint once per
// trader cron tick (every 3 min).

interface ObCache {
  ts: number;
  ratio: number;
}
const OB_CACHE = new Map<string, ObCache>();
const OB_TTL_MS = 30_000;

export async function fetchOrderBookImbalance(symbol: string = "BTCUSDT"): Promise<number | null> {
  const cached = OB_CACHE.get(symbol);
  if (cached && Date.now() - cached.ts < OB_TTL_MS) return cached.ratio;
  try {
    const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const bids = (j.bids || []).slice(0, 10);
    const asks = (j.asks || []).slice(0, 10);
    if (!bids.length || !asks.length) return null;
    const bidDepth = bids.reduce((s: number, [, q]: [string, string]) => s + parseFloat(q), 0);
    const askDepth = asks.reduce((s: number, [, q]: [string, string]) => s + parseFloat(q), 0);
    if (askDepth <= 0) return null;
    const ratio = bidDepth / askDepth;
    OB_CACHE.set(symbol, { ts: Date.now(), ratio });
    return ratio;
  } catch {
    return null;
  }
}

export function classifyImbalance(
  ratio: number | null,
  upThreshold: number,
  downThreshold: number,
): "UP" | "DOWN" | "NEUTRAL" {
  if (ratio === null || !Number.isFinite(ratio)) return "NEUTRAL";
  if (ratio >= upThreshold) return "UP";
  if (ratio <= downThreshold) return "DOWN";
  return "NEUTRAL";
}

/**
 * Fetch all EdgeCalc signals for a given market slug in parallel.
 * Uses the existing Netlify Function endpoints (signal-combiner).
 * Falls back to individual signal endpoints if combiner fails.
 */
export async function aggregateSignals(
  slug: string,
  obThresholds?: { up: number; down: number },
): Promise<AggregatedSignal> {
  const obRatioPromise = fetchOrderBookImbalance("BTCUSDT");

  // Primary: use signal-combiner which already aggregates everything
  let result: AggregatedSignal | null = null;
  try {
    const url = `${FN}/signal-combiner?slug=${encodeURIComponent(slug)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const data = await res.json();

    if (data.ok) {
      result = {
        finalProb: data.combined_probability ?? 0.5,
        kellyFraction: data.kelly?.quarter ?? 0,
        signalBreakdown: extractBreakdown(data.raw_signals),
        activeSignals: data.active_signals ?? 0,
        timestamp: data.fetched_at ?? new Date().toISOString(),
      };
    }
  } catch (err) {
    console.error("[signal-aggregator] combiner failed, falling back:", err);
  }

  if (!result) result = await fetchIndividualSignals(slug);

  // P1.3: enrich with order-book imbalance
  const ratio = await obRatioPromise;
  const up = obThresholds?.up ?? 1.8;
  const down = obThresholds?.down ?? 0.55;
  result.obImbalance =
    ratio === null
      ? null
      : { ratio: parseFloat(ratio.toFixed(3)), direction: classifyImbalance(ratio, up, down) };
  return result;
}

function extractBreakdown(rawSignals: any): SignalBreakdown {
  if (!rawSignals || typeof rawSignals !== "object") {
    return {
      funding_rate: null,
      orderflow: null,
      vol_divergence: null,
      apex_consensus: null,
      cond_prob: null,
    };
  }
  return {
    funding_rate: rawSignals.funding_rate ?? null,
    orderflow: rawSignals.orderflow ?? null,
    vol_divergence: rawSignals.vol_divergence ?? null,
    apex_consensus: rawSignals.apex_consensus ?? null,
    cond_prob: rawSignals.cond_prob ?? null,
  };
}

// ─── Fallback: individual signal fetching ─────────────────

async function safeFetch(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const data = await res.json();
    return data.ok ? data : null;
  } catch {
    return null;
  }
}

async function fetchIndividualSignals(
  slug: string,
): Promise<AggregatedSignal> {
  const [vol, flow, apex, cond, fund] = await Promise.all([
    safeFetch(`${FN}/vol-divergence?slug=${slug}`),
    safeFetch(`${FN}/orderflow-analysis?slug=${slug}`),
    safeFetch(`${FN}/apex-wallets?mode=consensus`),
    safeFetch(`${FN}/cond-prob-matrix?slug=${slug}`),
    safeFetch(`${FN}/funding-rates`),
  ]);

  const breakdown: SignalBreakdown = {
    vol_divergence: vol?.signal_score ?? null,
    orderflow: flow?.signal_score ?? null,
    apex_consensus: apex?.signal_score ?? null,
    cond_prob: cond?.signal_score ?? null,
    funding_rate: fund?.signal_score ?? null,
  };

  // Simple IC-weighted combination (mirrors signal-combiner logic)
  const IC: Record<keyof SignalBreakdown, number> = {
    vol_divergence: 0.06,
    orderflow: 0.09,
    apex_consensus: 0.08,
    cond_prob: 0.07,
    funding_rate: 0.05,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  let active = 0;

  for (const [key, ic] of Object.entries(IC)) {
    const val = breakdown[key as keyof SignalBreakdown];
    if (val !== null && val !== undefined) {
      weightedSum += val * ic;
      totalWeight += ic;
      active++;
    }
  }

  const combined = totalWeight > 0 ? weightedSum / totalWeight : 0.5;

  // Quarter-Kelly
  const edge = Math.abs(combined - 0.5);
  const b = combined > 0.5 ? 1 : 1; // binary market, payout = 1:b
  const p = combined;
  const q = 1 - p;
  const kellyFull = Math.max(0, (p * b - q) / b);
  const kellyQ = kellyFull * 0.25;

  return {
    finalProb: combined,
    kellyFraction: kellyQ,
    signalBreakdown: breakdown,
    activeSignals: active,
    timestamp: new Date().toISOString(),
  };
}
