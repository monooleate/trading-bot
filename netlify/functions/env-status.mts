// netlify/functions/env-status.mts
// GET /.netlify/functions/env-status
//
// Returns only env-var NAMES + a boolean isSet. Never the value, never a
// hash, never a length — so this endpoint is safe to call without auth.
// The home page uses it to render green/red status pills and warn when
// a live-trading capability has missing prerequisites.

import type { Context } from "@netlify/functions";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

interface EnvVarSpec {
  name: string;
  category: "auth" | "polymarket" | "bybit" | "binance" | "hyperliquid" | "weather" | "telegram" | "llm" | "trader";
  required_for: string[];   // capability names
  description: string;
}

const ENV_VARS: EnvVarSpec[] = [
  // Auth (gates the Settings UI + Trading panel)
  { name: "JWT_SECRET",            category: "auth",       required_for: ["settings", "manual-trading", "auto-claim"], description: "JWT signing secret (32+ chars)" },
  { name: "AUTH_PASSWORD_HASH",    category: "auth",       required_for: ["settings", "manual-trading", "auto-claim"], description: "SHA-256 of dashboard password" },

  // Polymarket
  { name: "POLY_PRIVATE_KEY",      category: "polymarket", required_for: ["live-crypto-auto"],                          description: "Polygon hot wallet private key (LIVE auto-trader only)" },
  { name: "POLY_FUNDER_ADDRESS",   category: "polymarket", required_for: ["live-crypto-auto"],                          description: "Polymarket proxy wallet address" },
  { name: "POLY_SIGNATURE_TYPE",   category: "polymarket", required_for: ["live-crypto-auto"],                          description: "Polymarket signature type (default 1)" },
  { name: "POLYMARKET_PROXY_ADDRESS", category: "polymarket", required_for: ["auto-claim"],                             description: "Wallet address for Auto-Claim scanner" },

  // Bybit
  { name: "BYBIT_API_KEY",         category: "bybit",      required_for: ["bybit-manual"],                              description: "Bybit Futures API key" },
  { name: "BYBIT_API_SECRET",      category: "bybit",      required_for: ["bybit-manual"],                              description: "Bybit Futures API secret" },

  // Binance
  { name: "BINANCE_API_KEY",       category: "binance",    required_for: ["binance-manual"],                            description: "Binance Futures API key" },
  { name: "BINANCE_API_SECRET",    category: "binance",    required_for: ["binance-manual"],                            description: "Binance Futures API secret" },

  // Hyperliquid
  { name: "HL_PRIVATE_KEY",        category: "hyperliquid", required_for: ["live-hyperliquid"],                          description: "Hyperliquid wallet private key (LIVE only)" },
  { name: "HL_TESTNET",            category: "hyperliquid", required_for: ["hyperliquid-paper"],                         description: "Hyperliquid testnet flag (recommended true)" },

  // Telegram
  { name: "TELEGRAM_BOT_TOKEN",    category: "telegram",   required_for: ["telegram-alerts"],                           description: "Telegram bot token (push alerts)" },
  { name: "TELEGRAM_CHAT_ID",      category: "telegram",   required_for: ["telegram-alerts"],                           description: "Telegram chat ID for alerts" },

  // LLM
  { name: "ANTHROPIC_API_KEY",     category: "llm",        required_for: ["llm-dependency", "resolution-risk-claude"],   description: "Claude API key (LLM dependency, resolution risk)" },

  // Trader tuning
  { name: "PAPER_MODE",            category: "trader",     required_for: [],                                            description: "Auto-trader paper/live flag (default: paper)" },
  { name: "EDGE_THRESHOLD_CRYPTO", category: "trader",     required_for: [],                                            description: "Net edge threshold (default 0.15)" },
  { name: "MAX_KELLY_FRACTION",    category: "trader",     required_for: [],                                            description: "Kelly fraction cap (default 0.08)" },
  { name: "SESSION_LOSS_LIMIT",    category: "trader",     required_for: [],                                            description: "Session loss limit USD (default 20)" },
];

function isSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0;
}

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405, headers: CORS,
    });
  }

  const status = ENV_VARS.map((v) => ({
    name:         v.name,
    category:     v.category,
    required_for: v.required_for,
    description:  v.description,
    set:          isSet(v.name),
  }));

  // Capability summary: which features are blocked by missing env
  const allCaps = new Set<string>();
  for (const v of ENV_VARS) v.required_for.forEach((c) => allCaps.add(c));

  const capabilities: Record<string, { ok: boolean; missing: string[] }> = {};
  for (const cap of allCaps) {
    const required = ENV_VARS.filter((v) => v.required_for.includes(cap));
    const missing  = required.filter((v) => !isSet(v.name)).map((v) => v.name);
    capabilities[cap] = { ok: missing.length === 0, missing };
  }

  // Special: live-crypto-auto needs PAPER_MODE explicitly = "false"
  capabilities["live-crypto-auto-active"] = {
    ok: process.env.PAPER_MODE === "false" && capabilities["live-crypto-auto"]?.ok === true,
    missing: process.env.PAPER_MODE !== "false"
      ? ["PAPER_MODE=false"]
      : (capabilities["live-crypto-auto"]?.missing ?? []),
  };

  return new Response(
    JSON.stringify({
      ok: true,
      env: status,
      capabilities,
      paperMode: process.env.PAPER_MODE !== "false",
      fetchedAt: new Date().toISOString(),
    }),
    { headers: CORS },
  );
}
