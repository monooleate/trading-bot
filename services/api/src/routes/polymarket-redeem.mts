// netlify/functions/polymarket-redeem.mts
//
// Auto-claim helper for Polymarket positions (P1.4).
//
// GET  /.netlify/functions/polymarket-redeem?wallet=0x...
//      → lists redeemable positions for the wallet and sums claimable USDC
// POST /.netlify/functions/polymarket-redeem  { wallet, conditionIds }
//      → returns an execution intent JSON for the local Python redeemer
//
// We stay read-only on the server side on purpose: actually calling
// `redeemPositions(...)` on Polygon needs the funder private key, which
// belongs on the user's machine (mirroring polymarket-trade.mts). The
// dashboard surfaces the redeemable balance and emits an intent file the
// Python script consumes.

import type { Context } from "@netlify/functions";
import { checkAuth } from "./_auth-guard";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const DATA_API = "https://data-api.polymarket.com";

interface DataApiPosition {
  proxyWallet?: string;
  conditionId?: string;
  asset?: string;
  size?: number;
  avgPrice?: number;
  cashPnl?: number;
  realizedPnl?: number;
  curPrice?: number;
  redeemable?: boolean;
  mergeable?: boolean;
  title?: string;
  slug?: string;
  outcome?: string;
  endDate?: string;
}

async function fetchPositions(wallet: string): Promise<DataApiPosition[]> {
  const url = `${DATA_API}/positions?user=${encodeURIComponent(wallet)}&sizeThreshold=0.01&limit=200`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "EdgeCalc-Redeem/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`data-api ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.positions || [];
}

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const auth = await checkAuth(req);
  if (!auth.ok) return auth.error;

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const wallet = url.searchParams.get("wallet");
      if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
        return new Response(JSON.stringify({ ok: false, error: "wallet (0x...) required" }), {
          status: 400, headers: CORS,
        });
      }

      const positions = await fetchPositions(wallet);
      const redeemable = positions
        .filter((p) => p.redeemable === true && (p.size ?? 0) > 0)
        .map((p) => ({
          conditionId: p.conditionId,
          asset: p.asset,
          title: p.title,
          slug: p.slug,
          outcome: p.outcome,
          shares: p.size,
          avgEntry: p.avgPrice,
          curPrice: p.curPrice,
          // Redemption pays $1 per winning share (binary). Use curPrice as
          // a marker for whether this side is actually the winner.
          claimableUSDC: parseFloat(((p.curPrice ?? 0) >= 0.99 ? p.size ?? 0 : 0).toFixed(4)),
          realizedPnl: p.realizedPnl ?? 0,
          cashPnl: p.cashPnl ?? 0,
        }));

      const totalClaimable = redeemable.reduce((s, r) => s + r.claimableUSDC, 0);

      return new Response(
        JSON.stringify({
          ok: true,
          wallet,
          redeemable,
          totalClaimableUSDC: parseFloat(totalClaimable.toFixed(4)),
          fetchedAt: new Date().toISOString(),
        }),
        { headers: CORS },
      );
    }

    if (req.method === "POST") {
      let body: any;
      try { body = await req.json(); }
      catch { return new Response(JSON.stringify({ ok: false, error: "bad_json" }), { status: 400, headers: CORS }); }

      const wallet = body.wallet;
      if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
        return new Response(JSON.stringify({ ok: false, error: "wallet (0x...) required" }), {
          status: 400, headers: CORS,
        });
      }
      const conditionIds: string[] = Array.isArray(body.conditionIds) ? body.conditionIds : [];
      if (!conditionIds.length) {
        return new Response(JSON.stringify({ ok: false, error: "conditionIds[] required" }), {
          status: 400, headers: CORS,
        });
      }

      // Generate the redemption intent — the local Python script consumes
      // this and signs the on-chain redeemPositions(...) tx with the funder
      // key. We never see the key here.
      const intent = {
        kind: "polymarket_redeem_v1",
        wallet,
        conditionIds,
        createdAt: new Date().toISOString(),
        note: "Execute with: python polymarket_trade.py --redeem-intent '<json>'",
      };

      return new Response(JSON.stringify({ ok: true, intent }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405, headers: CORS,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502, headers: CORS,
    });
  }
}
