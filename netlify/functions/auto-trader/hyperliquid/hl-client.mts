// netlify/functions/auto-trader/hyperliquid/hl-client.mts
// Minimal HTTP wrapper around Hyperliquid's public REST endpoints.
// For live order placement the @nktkas/hyperliquid SDK is required
// (EIP-712 signing). This module handles all read-only calls that don't
// need a wallet, and defines the adapter interface for live execution.

import { hlBaseUrl, ASSET_INDEX } from "./config.mts";
import type { HlCoin } from "./types.mts";

// ─── READ-ONLY API ─────────────────────────────────────────────────────────
export async function hlInfoPost(paperMode: boolean, body: any, timeoutMs = 6000): Promise<any> {
  const res = await fetch(`${hlBaseUrl(paperMode)}/info`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
  return res.json();
}

/** Current mid prices across all listed perps. */
export async function getAllMids(paperMode: boolean): Promise<Record<string, number>> {
  const data = await hlInfoPost(paperMode, { type: "allMids" });
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(data || {})) {
    const n = parseFloat(v as string);
    if (!isNaN(n)) out[k] = n;
  }
  return out;
}

export async function getCurrentPrice(coin: HlCoin, paperMode: boolean): Promise<number | null> {
  try {
    const mids = await getAllMids(paperMode);
    const p = mids[coin];
    return typeof p === "number" && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Open positions + balances for a wallet address. */
export async function getClearinghouseState(
  address: string,
  paperMode: boolean,
): Promise<any | null> {
  if (!address) return null;
  try {
    return await hlInfoPost(paperMode, { type: "clearinghouseState", user: address });
  } catch {
    return null;
  }
}

// ─── EXECUTION ADAPTER (live-mode only; paper mode sidesteps this) ─────────
// Live order placement requires EIP-712 signing. Rather than reinvent it,
// the live path pulls the @nktkas/hyperliquid SDK lazily — that way paper-
// mode runs have zero external dependencies and the function stays light.

export interface HlOrderParams {
  coin:       HlCoin;
  isBuy:      boolean;
  price:      string;         // formatted to HL tick size
  sizeCoins:  string;         // formatted to asset lot size
  reduceOnly: boolean;
  tif:        "Gtc" | "Ioc" | "Alo";
  triggerPx?: string;         // for SL stop-market
  triggerIsMarket?: boolean;
  tpsl?: "tp" | "sl";
}

export interface HlExecutionAdapter {
  placeOrder(params: HlOrderParams): Promise<{ ok: boolean; orderId?: string; error?: string }>;
  cancelOrder(coin: HlCoin, orderId: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Lazy-load the live adapter. Returns null if the SDK or credentials are
 * unavailable — callers must handle that gracefully (paper-only mode).
 */
export async function tryLoadLiveAdapter(paperMode: boolean): Promise<HlExecutionAdapter | null> {
  if (paperMode) return null;
  const privKey = process.env.HL_PRIVATE_KEY;
  if (!privKey) return null;

  try {
    // Dynamic import so the dep is optional until the user installs it.
    // Intentionally typed as any; the SDK must be added to package.json before live trading.
    const mod: any = await (new Function("return import('@nktkas/hyperliquid')") as any)();
    const { HttpTransport, ExchangeClient } = mod;
    // viem is a peer dep; guard it too.
    const viemAccounts: any = await (new Function("return import('viem/accounts')") as any)();
    const wallet = viemAccounts.privateKeyToAccount(privKey as `0x${string}`);

    const transport = new HttpTransport({ isTestnet: false });
    const exchange  = new ExchangeClient({ transport, wallet });

    return {
      async placeOrder(p: HlOrderParams) {
        try {
          const orderType: any = p.triggerPx && p.triggerIsMarket
            ? { trigger: { triggerPx: p.triggerPx, isMarket: true, tpsl: p.tpsl || "sl" } }
            : { limit: { tif: p.tif } };
          const resp = await exchange.order({
            orders: [{
              a: ASSET_INDEX[p.coin],
              b: p.isBuy,
              p: p.price,
              s: p.sizeCoins,
              r: p.reduceOnly,
              t: orderType,
            }],
            grouping: "na",
          });
          const oid = resp?.response?.data?.statuses?.[0]?.resting?.oid
                   || resp?.response?.data?.statuses?.[0]?.filled?.oid;
          return { ok: true, orderId: oid ? String(oid) : undefined };
        } catch (err: any) {
          return { ok: false, error: err?.message || "order failed" };
        }
      },
      async cancelOrder(coin, orderId) {
        try {
          await exchange.cancel({
            cancels: [{ a: ASSET_INDEX[coin], o: parseInt(orderId, 10) }],
          });
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message || "cancel failed" };
        }
      },
    };
  } catch {
    return null;
  }
}

// ─── Price formatting helpers ──────────────────────────────────────────────
// Hyperliquid enforces per-asset tick and lot sizes.
// BTC: tick 1, lot 0.001. ETH: tick 0.01, lot 0.001. Others: varies.
export function formatPrice(coin: HlCoin, price: number): string {
  const decimals: Record<HlCoin, number> = {
    BTC:  0,  // whole dollars
    ETH:  2,
    SOL:  3,
    XRP:  4,
    DOGE: 5,
    AVAX: 3,
  };
  return price.toFixed(decimals[coin] ?? 2);
}

export function formatSize(coin: HlCoin, size: number): string {
  const decimals: Record<HlCoin, number> = {
    BTC:  4,
    ETH:  3,
    SOL:  2,
    XRP:  1,
    DOGE: 0,
    AVAX: 2,
  };
  return size.toFixed(decimals[coin] ?? 3);
}
