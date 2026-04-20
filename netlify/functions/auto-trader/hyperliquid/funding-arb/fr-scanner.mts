// netlify/functions/auto-trader/hyperliquid/funding-arb/fr-scanner.mts
// Pulls funding rates from:
//   - Hyperliquid  → `metaAndAssetCtxs` (includes funding + OI per coin)
//   - Binance      → `premiumIndex`      (lastFundingRate = per 8h window)
//
// Both are normalised to an hourly rate so spreads are directly comparable.

import { hlInfoPost } from "../hl-client.mts";
import { ASSET_INDEX } from "../config.mts";
import type { HlCoin } from "../types.mts";
import type { FundingData } from "./types.mts";

const BINANCE_SYMBOL: Record<HlCoin, string> = {
  BTC:  "BTCUSDT",
  ETH:  "ETHUSDT",
  SOL:  "SOLUSDT",
  XRP:  "XRPUSDT",
  DOGE: "DOGEUSDT",
  AVAX: "AVAXUSDT",
};

// ─── HL: metaAndAssetCtxs → FundingData[] ──────────────────────────────────
export async function getHlFundings(coins: HlCoin[], paperMode: boolean): Promise<Map<HlCoin, Partial<FundingData>>> {
  const out = new Map<HlCoin, Partial<FundingData>>();
  try {
    const resp = await hlInfoPost(paperMode, { type: "metaAndAssetCtxs" }, 6000);
    if (!Array.isArray(resp) || resp.length < 2) return out;
    const meta = resp[0];
    const ctxs = resp[1];
    if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return out;

    const wantedIdx: Record<number, HlCoin> = {};
    for (const c of coins) {
      const idx = ASSET_INDEX[c];
      if (typeof idx === "number") wantedIdx[idx] = c;
    }

    for (let i = 0; i < meta.universe.length; i++) {
      const coin = wantedIdx[i];
      if (!coin) continue;
      const ctx = ctxs[i] || {};
      const hlFundingHourly = parseFloat(ctx.funding || "0");
      const markPrice       = parseFloat(ctx.markPx  || "0");
      const oiCoins         = parseFloat(ctx.openInterest || "0");

      out.set(coin, {
        coin,
        hlFundingHourly,
        hlFundingAnnualized: hlFundingHourly * 8760 * 100,
        openInterestUSD:     oiCoins * markPrice,
        markPrice,
      });
    }
  } catch {}
  return out;
}

// ─── Binance: premiumIndex → hourly rate ──────────────────────────────────
export async function getBinanceFundingHourly(coin: HlCoin): Promise<number | null> {
  const sym = BINANCE_SYMBOL[coin];
  if (!sym) return null;
  try {
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!r.ok) return null;
    const d = await r.json() as any;
    const rate8h = parseFloat(d?.lastFundingRate || "0");
    return rate8h / 8;   // per hour
  } catch {
    return null;
  }
}

// ─── Combined scan ─────────────────────────────────────────────────────────
export async function scanFundings(coins: HlCoin[], paperMode: boolean): Promise<FundingData[]> {
  const [hlMap, binanceRates] = await Promise.all([
    getHlFundings(coins, paperMode),
    Promise.all(coins.map(c => getBinanceFundingHourly(c))),
  ]);

  const fetchedAt = new Date().toISOString();
  const out: FundingData[] = [];
  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i];
    const hl   = hlMap.get(coin);
    const bin  = binanceRates[i] ?? 0;
    if (!hl || hl.markPrice == null || !hl.hlFundingHourly == null) continue;
    out.push({
      coin,
      hlFundingHourly:     hl.hlFundingHourly ?? 0,
      hlFundingAnnualized: hl.hlFundingAnnualized ?? 0,
      binanceFundingHourly: bin,
      openInterestUSD:     hl.openInterestUSD ?? 0,
      markPrice:           hl.markPrice ?? 0,
      fetchedAt,
    });
  }
  return out;
}
