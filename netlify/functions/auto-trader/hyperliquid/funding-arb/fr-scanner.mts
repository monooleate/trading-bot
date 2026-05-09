// netlify/functions/auto-trader/hyperliquid/funding-arb/fr-scanner.mts
//
// Pulls funding rates from:
//   - Hyperliquid → `metaAndAssetCtxs`. Per the official docs
//     (info-endpoint/perpetuals) this returns a [meta, ctxs] tuple where
//     ctxs[i].funding is the HOURLY rate as a decimal STRING (e.g.
//     "0.0000125" = 0.00125%/h). HL pays funding every hour.
//   - Binance USDT-M → `premiumIndex` for the per-symbol last funding rate
//     (lastFundingRate is the rate for the LAST completed period, not the
//     hourly rate). The period is 8h by default but Binance has rolled
//     several majors (BTC/ETH/SOL/etc.) onto a 4h cycle since 2023, so we
//     query `/fapi/v1/fundingInfo` once per cold-start to pick up
//     non-default intervals and divide by the actual `fundingIntervalHours`
//     instead of a blind `/8`. Without this the scanner under-reports the
//     hourly Binance rate by 2× on 4h symbols, biasing the spread upward
//     and triggering bogus arb entries.
//
// Both rates are normalised to an HOURLY decimal so spreads are directly
// comparable.

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
      const hlFundingHourly = parseFloat(ctx.funding ?? "0");
      const markPrice       = parseFloat(ctx.markPx  ?? "0");
      // Per docs `openInterest` is in COIN UNITS (not USD). Multiply by
      // markPx to express it as USD notional, which is what the viability
      // gate compares against `minOpenInterestUSD`.
      const oiCoins         = parseFloat(ctx.openInterest ?? "0");

      if (!Number.isFinite(markPrice) || markPrice <= 0)        continue;
      if (!Number.isFinite(hlFundingHourly))                    continue;
      if (!Number.isFinite(oiCoins) || oiCoins < 0)             continue;

      out.set(coin, {
        coin,
        hlFundingHourly,
        // 8760 hours per year × 100 = annualised %. Sign preserved.
        hlFundingAnnualized: hlFundingHourly * 8760 * 100,
        openInterestUSD:     oiCoins * markPrice,
        markPrice,
      });
    }
  } catch {}
  return out;
}

// ─── Binance funding interval cache ────────────────────────────────────────
//
// Per the Binance docs (`/fapi/v1/fundingInfo`), the response only lists
// symbols with non-default intervals — anything missing is the 8h default.
// We cache a 6h TTL so we don't hammer the endpoint on every scanner run.
interface FundingIntervalCache {
  fetchedAt: number;
  intervals: Map<string, number>; // symbol → hours
}
let fundingIntervalCache: FundingIntervalCache | null = null;
const FUNDING_INTERVAL_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FUNDING_HOURS   = 8;

async function getBinanceFundingIntervalHours(symbol: string): Promise<number> {
  const now = Date.now();
  if (!fundingIntervalCache || now - fundingIntervalCache.fetchedAt > FUNDING_INTERVAL_TTL_MS) {
    const fresh: Map<string, number> = new Map();
    try {
      const r = await fetch(
        "https://fapi.binance.com/fapi/v1/fundingInfo",
        { signal: AbortSignal.timeout(5000) },
      );
      if (r.ok) {
        const arr = await r.json() as any[];
        if (Array.isArray(arr)) {
          for (const row of arr) {
            const sym = row?.symbol;
            const hrs = Number(row?.fundingIntervalHours);
            if (typeof sym === "string" && Number.isFinite(hrs) && hrs > 0) {
              fresh.set(sym, hrs);
            }
          }
        }
      }
    } catch {
      // On failure keep whatever we already had (or fall through to default).
    }
    fundingIntervalCache = { fetchedAt: now, intervals: fresh };
  }
  return fundingIntervalCache.intervals.get(symbol) ?? DEFAULT_FUNDING_HOURS;
}

// ─── Binance: premiumIndex → hourly rate ──────────────────────────────────
//
// `lastFundingRate` is the rate paid at the LAST funding cycle (not hourly).
// Convert to hourly by dividing by the symbol-specific interval.
export async function getBinanceFundingHourly(coin: HlCoin): Promise<number | null> {
  const sym = BINANCE_SYMBOL[coin];
  if (!sym) return null;
  try {
    const [r, intervalHours] = await Promise.all([
      fetch(
        `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`,
        { signal: AbortSignal.timeout(5000) },
      ),
      getBinanceFundingIntervalHours(sym),
    ]);
    if (!r.ok) return null;
    const d = await r.json() as any;
    const ratePerCycle = parseFloat(d?.lastFundingRate ?? "0");
    if (!Number.isFinite(ratePerCycle))      return null;
    if (!Number.isFinite(intervalHours) ||
        intervalHours <= 0)                  return null;
    return ratePerCycle / intervalHours;
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
    if (!hl) continue;
    if (!Number.isFinite(hl.markPrice) || (hl.markPrice ?? 0) <= 0)        continue;
    if (!Number.isFinite(hl.hlFundingHourly))                              continue;
    const bin = binanceRates[i];
    // Treat a missing Binance rate as 0 — we still want to surface the
    // HL-only carry; the viability gate will reject if the spread isn't
    // wide enough on its own.
    const binanceFundingHourly = Number.isFinite(bin) ? (bin as number) : 0;
    out.push({
      coin,
      hlFundingHourly:     hl.hlFundingHourly!,
      hlFundingAnnualized: hl.hlFundingAnnualized ?? 0,
      binanceFundingHourly,
      openInterestUSD:     hl.openInterestUSD ?? 0,
      markPrice:           hl.markPrice!,
      fetchedAt,
    });
  }
  return out;
}
