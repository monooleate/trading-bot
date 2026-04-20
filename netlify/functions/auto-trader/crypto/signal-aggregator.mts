import { FN } from "../shared/config.mts";
import type { AggregatedSignal, SignalBreakdown } from "../shared/types.mts";

const TIMEOUT = 8000;

/**
 * Fetch all EdgeCalc signals for a given market slug in parallel.
 * Uses the existing Netlify Function endpoints (signal-combiner).
 * Falls back to individual signal endpoints if combiner fails.
 */
export async function aggregateSignals(
  slug: string,
): Promise<AggregatedSignal> {
  // Primary: use signal-combiner which already aggregates everything
  try {
    const url = `${FN}/signal-combiner?slug=${encodeURIComponent(slug)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const data = await res.json();

    if (data.ok) {
      return {
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

  // Fallback: fetch individual signals in parallel
  return fetchIndividualSignals(slug);
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
