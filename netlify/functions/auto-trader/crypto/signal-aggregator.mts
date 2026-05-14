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
 * Uses the signal-combiner endpoint (single source of truth).
 *
 * Ha a combiner failel, explicit "no signal" sentinel-t adunk vissza
 * (finalProb=0.5, kelly=0, activeSignals=0). A decision-engine gate-jei
 * (`activeSignals >= 2`, `kellyFraction > 0`) ezt biztosan elutasítják,
 * tehát a bot SKIPPELI a trade-et — pontosan ahogy korábban is, csak
 * most explicit a kód a dead fallback helyett.
 */
export async function aggregateSignals(
  slug: string,
  obThresholds?: { up: number; down: number },
): Promise<AggregatedSignal> {
  const obRatioPromise = fetchOrderBookImbalance("BTCUSDT");

  let result: AggregatedSignal | null = null;
  try {
    // `&category=crypto` opts this call into the realized-IC blend path
    // when Settings → Signal calibration → "Use realized IC" is ON.
    // Without the flag set it has no effect on combiner output.
    const url = `${FN}/signal-combiner?slug=${encodeURIComponent(slug)}&category=crypto`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const data = await res.json();

    if (data.ok) {
      result = {
        finalProb: data.combined_probability ?? 0.5,
        kellyFraction: data.kelly?.quarter ?? 0,
        signalBreakdown: extractBreakdown(data.raw_signals),
        activeSignals: data.active_signals ?? 0,
        timestamp: data.fetched_at ?? new Date().toISOString(),
        // Surface the combiner's own verdict + the resolution-risk
        // helper's flag so the decision-engine can gate on the SAME
        // convergence/risk thresholds the combiner already enforces
        // internally. Pre-2026-05-11 these were silently dropped, so
        // the engine traded on noise-level signals the combiner would
        // have rejected as WAIT/WATCH/SKIP.
        combinerRecommendation: data.recommendation?.action ?? null,
        tradeRecommendedByRisk: typeof data.trade_recommended === "boolean"
          ? data.trade_recommended
          : null,
        adjustedProbability: typeof data.adjusted_probability === "number"
          ? data.adjusted_probability
          : null,
      };
    } else {
      console.warn("[signal-aggregator] combiner returned ok=false for", slug, data?.error || "");
    }
  } catch (err) {
    console.error("[signal-aggregator] combiner fetch failed for", slug, err);
  }

  if (!result) {
    // Combiner failed → no-signal sentinel. Decision-engine gate-jei skip-elnek.
    result = {
      finalProb:       0.5,
      kellyFraction:   0,
      signalBreakdown: emptyBreakdown(),
      activeSignals:   0,
      timestamp:       new Date().toISOString(),
      combinerRecommendation: null,
      tradeRecommendedByRisk: null,
      adjustedProbability:    null,
    };
  }

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

function emptyBreakdown(): SignalBreakdown {
  return {
    funding_rate:   null,
    orderflow:      null,
    vol_divergence: null,
    apex_consensus: null,
    cond_prob:      null,
    momentum:       null,
    contrarian:     null,
    pairs_spread:   null,
    forecast_edge:  null,  // weather-only synthetic signal
  };
}

function extractBreakdown(rawSignals: any): SignalBreakdown {
  if (!rawSignals || typeof rawSignals !== "object") {
    return emptyBreakdown();
  }
  return {
    funding_rate:   rawSignals.funding_rate   ?? null,
    orderflow:      rawSignals.orderflow      ?? null,
    vol_divergence: rawSignals.vol_divergence ?? null,
    apex_consensus: rawSignals.apex_consensus ?? null,
    cond_prob:      rawSignals.cond_prob      ?? null,
    momentum:       rawSignals.momentum       ?? null,
    contrarian:     rawSignals.contrarian     ?? null,
    pairs_spread:   rawSignals.pairs_spread   ?? null,
    forecast_edge:  null,                                // weather-only
  };
}

