// netlify/functions/auto-trader-multi-cron.mts
//
// Scheduled cron that fan-outs to every auto-trader category in parallel.
// The original `auto-trader` schedule runs only crypto (the default
// category in its dispatcher), which is why the Hyperliquid + Funding-arb
// sessions had bankroll = $200 / 0 trades on 2026-04-21..05-09 — the cron
// never reached them.
//
// This cron triggers HL (perp) and HL-funding-arb on the same 3-min
// cadence as the crypto cron, by importing the dispatcher directly and
// invoking it with explicit { action: "run", category, layer } payloads.
// Crypto stays on the legacy `auto-trader` cron to avoid double-running it
// during this rollout.
//
// Read-only style: each fan-out call is wrapped in try/catch so a failure
// in one trader never blocks the others.

import type { Context } from "@netlify/functions";
import autoTraderHandler from "./auto-trader/index.mts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

interface FanOutTarget {
  label: string;
  body: { action: "run"; category: string; layer?: string };
}

const TARGETS: FanOutTarget[] = [
  { label: "hyperliquid-perp",  body: { action: "run", category: "hyperliquid", layer: "directional" } },
  { label: "hyperliquid-arb",   body: { action: "run", category: "hyperliquid", layer: "arb" } },
];

async function runOne(target: FanOutTarget, ctx: Context): Promise<{ label: string; ok: boolean; status?: number; error?: string }> {
  try {
    // ?source=cron lets the dispatcher tag the run-state as cron-driven, so
    // the UI pill says "Scanning… (cron)" rather than "(manual)" on tick.
    const req = new Request("https://multi-cron.local/.netlify/functions/auto-trader?source=cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target.body),
    });
    const res = await autoTraderHandler(req, ctx);
    return { label: target.label, ok: res.ok, status: res.status };
  } catch (err: any) {
    return { label: target.label, ok: false, error: err?.message || "unknown" };
  }
}

export default async function handler(req: Request, ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const results = await Promise.all(TARGETS.map((t) => runOne(t, ctx)));
  return new Response(
    JSON.stringify({
      ok: true,
      ranAt: new Date().toISOString(),
      results,
    }, null, 2),
    { status: 200, headers: CORS },
  );
}
