import type { TraderConfig, PolymarketConfig } from "./types.mts";

// ─── API endpoints ────────────────────────────────────────

export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";
export const DATA_API = "https://data-api.polymarket.com";

// EdgeCalc backend (self, Netlify Functions)
export const EDGECALC_BASE = process.env.URL || "http://localhost:8888";
export const FN = `${EDGECALC_BASE}/.netlify/functions`;

// ─── Signal IC weights (from signal-combiner) ─────────────

export const IC_WEIGHTS = {
  vol_divergence: 0.06,
  orderflow: 0.09,
  apex_consensus: 0.08,
  cond_prob: 0.07,
  funding_rate: 0.05,
} as const;

// ─── Trader config from env ───────────────────────────────

export function getTraderConfig(): TraderConfig {
  return {
    paperMode: process.env.PAPER_MODE !== "false",
    edgeThreshold: parseFloat(process.env.EDGE_THRESHOLD_CRYPTO || "0.15"),
    maxKellyFraction: parseFloat(process.env.MAX_KELLY_FRACTION || "0.20"),
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || "300", 10),
    sessionLossLimit: parseFloat(process.env.SESSION_LOSS_LIMIT || "20"),
    minOpenInterest: 500,
    roundtripFeePct: 0.036, // 1.8% entry + 1.8% exit
  };
}

// ─── Polymarket credentials from env ──────────────────────

export function getPolymarketConfig(): PolymarketConfig {
  const privateKey = process.env.POLY_PRIVATE_KEY || "";
  if (!privateKey && process.env.PAPER_MODE === "false") {
    throw new Error("POLY_PRIVATE_KEY required for live trading");
  }
  return {
    privateKey,
    funderAddress: process.env.POLY_FUNDER_ADDRESS || "",
    signatureType: parseInt(process.env.POLY_SIGNATURE_TYPE || "1", 10),
  };
}

// ─── Telegram config ──────────────────────────────────────

export function getTelegramConfig() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
  };
}

// ─── Rate limits ──────────────────────────────────────────

export const RATE_LIMITS = {
  gammaApi: 10,   // req/sec
  clobApi: 100,   // req/sec
  wsPerMarket: 1, // 1 connection per market
} as const;

// ─── CORS headers (reusable) ──────────────────────────────

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
} as const;
