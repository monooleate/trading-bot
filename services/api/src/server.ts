// services/api/src/server.ts
//
// The Bun HTTP entrypoint for the read/API + signal endpoints. The existing
// route handlers are already Web-Fetch (Request)→Response functions (they were
// Netlify functions), so we dispatch to them by name — no framework, no
// per-handler rewrite. Caddy proxies trade.<domain> → this server.
//
// Path forms accepted (both map to the same handlers):
//   /.netlify/functions/<name>   (what the current frontend calls — no churn)
//   /api/<name>                  (target-arch alias)
//
// State flows through the Blobs compat facade → Postgres (setBlobsDb(pool)).

import { resolve, sep } from "node:path";
import { pool } from "@core/db.ts";
import { setBlobsDb } from "@core/blobs-compat.ts";
import { loadEnv } from "@core/env.ts";

import apexWallets from "./routes/apex-wallets.mts";
import auth from "./routes/auth.mts";
import autoTraderApi from "./routes/auto-trader-api.mts";
import binancePrice from "./routes/binance-price.mts";
import binanceTrade from "./routes/binance-trade.mts";
import bybitTrade from "./routes/bybit-trade.mts";
import condProbMatrix from "./routes/cond-prob-matrix.mts";
import edgeTracker from "./routes/edge-tracker.mts";
import envStatus from "./routes/env-status.mts";
import fundingRates from "./routes/funding-rates.mts";
import llmDependency from "./routes/llm-dependency.mts";
import multiStatus from "./routes/multi-status.mts";
import orderflowAnalysis from "./routes/orderflow-analysis.mts";
import pairCostArb from "./routes/pair-cost-arb.mts";
import polymarketProxy from "./routes/polymarket-proxy.mts";
import polymarketRedeem from "./routes/polymarket-redeem.mts";
import polymarketTrade from "./routes/polymarket-trade.mts";
import recommendationsApi from "./routes/recommendations-api.mts";
import resolutionRisk from "./routes/resolution-risk.mts";
import signalCombiner from "./routes/signal-combiner.mts";
import tradeLogger from "./routes/trade-logger.mts";
import traderSettings from "./routes/trader-settings.mts";
import userSettings from "./routes/user-settings.mts";
import volDivergence from "./routes/vol-divergence.mts";
import vwapArb from "./routes/vwap-arb.mts";

type Handler = (req: Request, ctx: any) => Response | Promise<Response>;

const ROUTES: Record<string, Handler> = {
  "apex-wallets": apexWallets,
  "auth": auth,
  "auto-trader-api": autoTraderApi,
  "binance-price": binancePrice,
  "binance-trade": binanceTrade,
  "bybit-trade": bybitTrade,
  "cond-prob-matrix": condProbMatrix,
  "edge-tracker": edgeTracker,
  "env-status": envStatus,
  "funding-rates": fundingRates,
  "llm-dependency": llmDependency,
  "multi-status": multiStatus,
  "orderflow-analysis": orderflowAnalysis,
  "pair-cost-arb": pairCostArb,
  "polymarket-proxy": polymarketProxy,
  "polymarket-redeem": polymarketRedeem,
  "polymarket-trade": polymarketTrade,
  "recommendations-api": recommendationsApi,
  "resolution-risk": resolutionRisk,
  "signal-combiner": signalCombiner,
  "trade-logger": tradeLogger,
  "trader-settings": traderSettings,
  "user-settings": userSettings,
  "vol-divergence": volDivergence,
  "vwap-arb": vwapArb,
};

function routeName(pathname: string): string | null {
  for (const prefix of ["/.netlify/functions/", "/api/"]) {
    if (pathname.startsWith(prefix)) return pathname.slice(prefix.length).split("/")[0];
  }
  return null;
}

// Static frontend (Astro build) served for every non-API path, so the whole
// site lives behind one origin (Caddy → edgecalc-api). Keeps the frontend in
// the edgecalc project — the umami caddy needs no dist mount, only the
// reverse_proxy block. WEB_DIST is baked into the api image (see Dockerfile).
const WEB_DIST = (typeof process !== "undefined" && process.env.WEB_DIST) || "/app/dist";
const WEB_ROOT = resolve(WEB_DIST);

// Resolve a request path under WEB_ROOT, returning null if it escapes it
// (explicit path-traversal containment — audit P3 regression guard).
function containedPath(rel: string): string | null {
  const full = resolve(WEB_ROOT, "." + rel);
  return full === WEB_ROOT || full.startsWith(WEB_ROOT + sep) ? full : null;
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const b = Bun as any;
  if (!b?.file) return null;
  const clean = pathname.replace(/\/+$/, "");
  const candidates = [
    pathname === "/" ? "/index.html" : pathname,   // exact asset (e.g. /_astro/x.js)
    `${clean}/index.html`,                          // Astro dir route (/tools → /tools/index.html)
    `${clean}.html`,
  ];
  for (const c of candidates) {
    const full = containedPath(c);
    if (!full) continue;
    const f = b.file(full);
    if (await f.exists()) return new Response(f);
  }
  const idx = b.file(resolve(WEB_ROOT, "index.html"));   // SPA-ish fallback
  if (await idx.exists()) return new Response(idx, { headers: { "Content-Type": "text/html" } });
  return null;
}

export async function fetchHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health" || url.pathname === "/api/health") {
    return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  // Hide the whole site from search + AI crawlers (defense-in-depth; Caddy also
  // sets X-Robots-Tag + blocks AI user-agents at the edge).
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      status: 200, headers: { "Content-Type": "text/plain", "X-Robots-Tag": "noindex, nofollow" },
    });
  }
  const name = routeName(url.pathname);
  const handler = name ? ROUTES[name] : undefined;
  if (handler) {
    try {
      return await handler(req, {});
    } catch (err: any) {
      // Log details server-side; return a generic message (audit P3 — don't
      // echo internal/library error text to the client).
      console.error(`[api] handler error on ${url.pathname}:`, err?.message ?? err);
      return new Response(JSON.stringify({ ok: false, error: "internal error" }), {
        status: 502, headers: { "Content-Type": "application/json" },
      });
    }
  }
  // Not an API path → serve the static frontend.
  const isApiPath = url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/functions/");
  if (!isApiPath && req.method === "GET") {
    const asset = await serveStatic(url.pathname);
    if (asset) return asset;
  }
  return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
    status: 404, headers: { "Content-Type": "application/json" },
  });
}

// Bun runtime global (no @types/bun needed for tsc).
declare const Bun: { serve(opts: { port: number; fetch: (req: Request) => Response | Promise<Response> }): unknown; file(path: string): { exists(): Promise<boolean> } } | undefined;

async function main() {
  const env = loadEnv();
  setBlobsDb(await pool());
  const port = env.PORT ?? 7000;
  if (typeof Bun === "undefined") {
    throw new Error("services/api/src/server.ts must run under Bun (Bun.serve). Use the api Dockerfile.");
  }
  Bun.serve({ port, fetch: fetchHandler });
  console.log(`[api] listening on :${port}`);
}

main().catch((e) => { console.error("[api] fatal:", e); process.exit(1); });
