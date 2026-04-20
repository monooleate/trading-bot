// netlify/functions/auto-trader/hyperliquid/volatility-gate.mts
// 12-candle (1h) realised-volatility gate.
// Blocks entries when the underlying is too volatile to trust the edge.

import type { HlCoin } from "./types.mts";

const BINANCE_SYMBOL: Record<HlCoin, string> = {
  BTC:  "BTCUSDT",
  ETH:  "ETHUSDT",
  SOL:  "SOLUSDT",
  XRP:  "XRPUSDT",
  DOGE: "DOGEUSDT",
  AVAX: "AVAXUSDT",
};

export interface VolGateResult {
  pass:   boolean;
  rv:     number;         // annualised %
  reason: string;
}

async function fetchKlineCloses(coin: HlCoin, candleCount: number): Promise<number[]> {
  const sym = BINANCE_SYMBOL[coin];
  if (!sym) return [];

  // Try Binance futures first, fall back to spot, then CryptoCompare.
  try {
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&limit=${candleCount}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (r.ok) {
      const k = await r.json() as any[][];
      return k.map(c => parseFloat(c[4]));
    }
  } catch {}

  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=${candleCount}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (r.ok) {
      const k = await r.json() as any[][];
      return k.map(c => parseFloat(c[4]));
    }
  } catch {}

  // CryptoCompare fallback (hourly)
  try {
    const r = await fetch(
      `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${coin}&tsym=USD&limit=${candleCount}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (r.ok) {
      const d = await r.json() as any;
      return (d?.Data?.Data || []).map((c: any) => parseFloat(c.close));
    }
  } catch {}

  return [];
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

/**
 * Annualised realised volatility from the last N hourly candles.
 * RV = σ(log returns) × √(hours per year) × 100
 */
export async function volatilityGate(
  coin: HlCoin,
  rvThresholdPct: number,
  candleCount: number = 12,
): Promise<VolGateResult> {
  const closes = await fetchKlineCloses(coin, candleCount);
  if (closes.length < 3) {
    // Fail open: if we can't fetch data, don't block (caller logs this)
    return { pass: true, rv: 0, reason: "vol data unavailable – gate skipped" };
  }
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev > 0) returns.push(Math.log(closes[i] / prev));
  }
  const rv = stddev(returns) * Math.sqrt(24 * 365) * 100;

  if (rv > rvThresholdPct) {
    return { pass: false, rv, reason: `RV ${rv.toFixed(0)}% > ${rvThresholdPct}% threshold` };
  }
  return { pass: true, rv, reason: "OK" };
}
