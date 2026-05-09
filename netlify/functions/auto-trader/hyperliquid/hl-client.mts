// netlify/functions/auto-trader/hyperliquid/hl-client.mts
// Minimal HTTP wrapper around Hyperliquid's public REST endpoints.
// For live order placement the @nktkas/hyperliquid SDK is required
// (EIP-712 signing). This module handles all read-only calls that don't
// need a wallet, and defines the adapter interface for live execution.

import { hlBaseUrl, ASSET_INDEX } from "./config.mts";
import type { HlCoin } from "./types.mts";

// ─── READ-ONLY API ─────────────────────────────────────────────────────────
//
// Every HL Info call goes through `hlInfoPost`. Per the official docs
// (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
// all info queries are POST with `Content-Type: application/json`. We add:
//   - one retry on transient network / 5xx failure
//   - explicit non-OK throw with status + body excerpt for diagnostics
//   - JSON parse guard so a stray HTML error page doesn't bubble as a
//     cryptic "unexpected token" downstream
export async function hlInfoPost(
  paperMode: boolean,
  body: any,
  timeoutMs = 6000,
  retries  = 1,
): Promise<any> {
  let lastErr: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${hlBaseUrl(paperMode)}/info`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // 4xx is a permanent error (bad type/param) — don't retry.
        if (res.status >= 400 && res.status < 500) {
          let detail = "";
          try { detail = (await res.text()).slice(0, 200); } catch {}
          throw new Error(`HL info ${res.status} ${detail}`);
        }
        throw new Error(`HL info ${res.status}`);
      }
      try {
        return await res.json();
      } catch (err: any) {
        throw new Error(`HL info bad JSON: ${err?.message ?? "parse failed"}`);
      }
    } catch (err: any) {
      lastErr = err;
      // Throw immediately on permanent errors; retry once for transients.
      if (/^HL info 4\d\d/.test(err?.message ?? "")) throw err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 + 250 * attempt));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("HL info: unknown error");
}

/**
 * Current mid prices across all listed perps. Per the docs values come back
 * as decimal STRINGS (`{ "BTC": "65431.5", ... }`), so we parseFloat each
 * entry and drop anything that doesn't yield a finite positive number.
 */
export async function getAllMids(paperMode: boolean): Promise<Record<string, number>> {
  const data = await hlInfoPost(paperMode, { type: "allMids" });
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) {
    const n = parseFloat(v as string);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

export async function getCurrentPrice(coin: HlCoin, paperMode: boolean): Promise<number | null> {
  try {
    const mids = await getAllMids(paperMode);
    const p = mids[coin];
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * Open positions + balances for a wallet address. Per the docs the body
 * shape is `{ "type": "clearinghouseState", "user": "0x..." }`. Returns the
 * full response object (marginSummary / withdrawable / assetPositions[] /
 * time) or `null` on any fetch failure.
 */
export async function getClearinghouseState(
  address: string,
  paperMode: boolean,
): Promise<any | null> {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
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

// Cached adapter result so we don't pay the dynamic-import cost on every
// order. The cache is per cold-start (Netlify functions are short-lived).
let cachedAdapter: HlExecutionAdapter | null | undefined = undefined;
let cachedAdapterError: string | null = null;

/**
 * Lazy-load the live adapter. Returns null if the SDK or credentials are
 * unavailable — callers must handle that gracefully (paper-only mode).
 *
 * The shape of `exchange.order(...)` matches the official Exchange-endpoint
 * action body documented at
 *   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
 *   { type: "order", orders: [{a,b,p,s,r,t}], grouping: "na"|"normalTpsl"|"positionTpsl" }
 *
 * EIP-712 signing (phantom agent + nonce = ms timestamp) is performed by the
 * @nktkas/hyperliquid SDK internally — we do not roll our own signer.
 */
export async function tryLoadLiveAdapter(paperMode: boolean): Promise<HlExecutionAdapter | null> {
  if (paperMode) return null;
  if (cachedAdapter !== undefined) return cachedAdapter;

  const privKey = process.env.HL_PRIVATE_KEY;
  if (!privKey) {
    cachedAdapter = null;
    cachedAdapterError = "HL_PRIVATE_KEY env var not set";
    return null;
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(privKey)) {
    cachedAdapter = null;
    cachedAdapterError = "HL_PRIVATE_KEY must be 0x-prefixed 32-byte hex";
    return null;
  }

  try {
    // Dynamic import keeps the SDK optional until the user installs it.
    // Wrapped in `new Function` so esbuild doesn't try to resolve it at build time.
    const mod: any = await (new Function("return import('@nktkas/hyperliquid')") as any)();
    const { HttpTransport, ExchangeClient } = mod;
    if (!HttpTransport || !ExchangeClient) {
      throw new Error("@nktkas/hyperliquid: missing HttpTransport / ExchangeClient export");
    }
    const viemAccounts: any = await (new Function("return import('viem/accounts')") as any)();
    if (!viemAccounts?.privateKeyToAccount) {
      throw new Error("viem/accounts: privateKeyToAccount not found");
    }
    const wallet = viemAccounts.privateKeyToAccount(privKey as `0x${string}`);

    // Mainnet is the default — testnet is wired into paperMode upstream.
    const transport = new HttpTransport({ isTestnet: false });
    const exchange  = new ExchangeClient({ transport, wallet });

    const adapter: HlExecutionAdapter = {
      async placeOrder(p: HlOrderParams) {
        try {
          // Per the Exchange-endpoint docs, trigger orders set `t.trigger`
          // and the limit price `p` carries through as the worst-case fill
          // price; for `isMarket: true` HL accepts whatever price ticks
          // through but we still send the trigger price so a partial-fill
          // path doesn't get a stale book.
          const orderType: any = p.triggerPx
            ? {
                trigger: {
                  triggerPx: p.triggerPx,
                  isMarket:  !!p.triggerIsMarket,
                  tpsl:      p.tpsl || "sl",
                },
              }
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
            // For TP/SL legs paired with the entry, "normalTpsl" lets HL
            // bind the trigger to the entry; for standalone entries "na"
            // is the correct grouping. Caller decides via `triggerPx`
            // presence: trigger orders are always reduce-only TP/SL.
            grouping: p.triggerPx ? "positionTpsl" : "na",
          });

          // Bubble up the API-level status if the order was rejected.
          if (resp?.status && resp.status !== "ok") {
            return { ok: false, error: `HL order rejected: ${JSON.stringify(resp).slice(0, 200)}` };
          }
          const status0 = resp?.response?.data?.statuses?.[0];
          if (status0?.error) {
            return { ok: false, error: `HL order error: ${String(status0.error).slice(0, 200)}` };
          }
          const oid = status0?.resting?.oid ?? status0?.filled?.oid;
          if (!oid) {
            return { ok: false, error: `HL order ok but no oid in response: ${JSON.stringify(resp).slice(0, 200)}` };
          }
          return { ok: true, orderId: String(oid) };
        } catch (err: any) {
          return { ok: false, error: err?.message || "order failed" };
        }
      },
      async cancelOrder(coin, orderId) {
        try {
          const oid = parseInt(orderId, 10);
          if (!Number.isFinite(oid)) return { ok: false, error: `bad oid: ${orderId}` };
          const resp: any = await exchange.cancel({
            cancels: [{ a: ASSET_INDEX[coin], o: oid }],
          });
          if (resp?.status && resp.status !== "ok") {
            return { ok: false, error: `HL cancel rejected: ${JSON.stringify(resp).slice(0, 200)}` };
          }
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message || "cancel failed" };
        }
      },
    };

    cachedAdapter = adapter;
    cachedAdapterError = null;
    return adapter;
  } catch (err: any) {
    cachedAdapter = null;
    cachedAdapterError = err?.message || "adapter load failed";
    return null;
  }
}

/** Surfaced for callers that want to explain WHY the live adapter is null. */
export function liveAdapterError(): string | null {
  return cachedAdapterError;
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
