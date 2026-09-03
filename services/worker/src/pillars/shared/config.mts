import type { TraderConfig, PolymarketConfig } from "@core/types.mts";

// ─── API endpoints ────────────────────────────────────────

export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";
export const DATA_API = "https://data-api.polymarket.com";

// EdgeCalc backend base for internal endpoint fetches (signal-combiner,
// polymarket-proxy). In the Docker split these routes live in the `api`
// container, so the worker must point at it via EDGECALC_INTERNAL_URL
// (e.g. http://edgecalc-api:7000). Falls back to the Netlify site URL, then to
// the local `netlify dev` port for standalone dev.
export const EDGECALC_BASE =
  process.env.EDGECALC_INTERNAL_URL || process.env.URL || "http://localhost:8888";
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
    maxKellyFraction: parseFloat(process.env.MAX_KELLY_FRACTION || "0.08"),
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || "300", 10),
    sessionLossLimit: parseFloat(process.env.SESSION_LOSS_LIMIT || "20"),
    minOpenInterest: 500,
    roundtripFeePct: 0.036, // 1.8% entry + 1.8% exit
    settlementFeePctFillModel: parseFloat(process.env.SETTLEMENT_FEE_PCT_FILL_MODEL || "0.015"), // exit-only when fill model ON (entry slippage is explicit in VWAP)
    minPositionSizeUSDC:   parseFloat(process.env.MIN_POSITION_SIZE_USDC   || "0.50"),
    combinerConfidenceMin: parseFloat(process.env.COMBINER_CONFIDENCE_MIN || "0.05"),
    maxOpenPositions:      parseInt(process.env.CRYPTO_MAX_OPEN_POSITIONS  || "5", 10),
    minActiveSignals:      parseInt(process.env.CRYPTO_MIN_ACTIVE_SIGNALS  || "2", 10),
    maxEdgeCap:               parseFloat(process.env.CRYPTO_MAX_EDGE_CAP                || "0.40"),
    watchExtremeEdgeThreshold: parseFloat(process.env.CRYPTO_WATCH_EXTREME_EDGE_THRESHOLD || "0.20"),
    fillModelEnabled:      process.env.FILL_MODEL_ENABLED === "true", // default OFF (measure-first)
    fillParticipationCap:  parseFloat(process.env.FILL_PARTICIPATION_CAP || "0.20"),
  };
}

// ─── BTC short-market exit/entry config (P1.2) ────────────
// Used by auto-trader/crypto/order-lifecycle.mts and decision-engine.mts
// to enforce TP/SL exits and the entry-window filter on BTC 5m/15m markets.

export function getBtcExitConfig() {
  return {
    tpTarget:           parseFloat(process.env.BTC_TP_TARGET || "0.75"),
    slTarget:           parseFloat(process.env.BTC_SL_TARGET || "0.35"),
    entryWindowStartMs: parseInt(process.env.BTC_ENTRY_WINDOW_START_MS || "60000", 10),
    entryWindowEndMs:   parseInt(process.env.BTC_ENTRY_WINDOW_END_MS   || "180000", 10),
    holdToEndCutoffMs:  parseInt(process.env.BTC_HOLD_TO_END_CUTOFF_MS || "60000", 10),
  };
}

// ─── Effective config = env defaults + Blobs runtime overrides ────────
// Lazily imported from trader-settings to avoid a circular import chain at
// module init. Falls back to env defaults on any read error so the trader
// always has a sane config to run on.

export async function getEffectiveTraderConfig(): Promise<TraderConfig> {
  const env = getTraderConfig();
  try {
    const mod: any = await import("@api/routes/trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    return {
      ...env,
      edgeThreshold:         ov.edgeThreshold         ?? env.edgeThreshold,
      maxKellyFraction:      ov.maxKellyFraction      ?? env.maxKellyFraction,
      cooldownSeconds:       ov.cooldownSeconds       ?? env.cooldownSeconds,
      sessionLossLimit:      ov.sessionLossLimit      ?? env.sessionLossLimit,
      minPositionSizeUSDC:   ov.minPositionSizeUSDC   ?? env.minPositionSizeUSDC,
      combinerConfidenceMin: ov.combinerConfidenceMin ?? env.combinerConfidenceMin,
      maxOpenPositions:      ov.cryptoMaxOpenPositions ?? env.maxOpenPositions,
      minActiveSignals:      ov.cryptoMinActiveSignals ?? env.minActiveSignals,
      maxEdgeCap:                ov.cryptoMaxEdgeCap                ?? env.maxEdgeCap,
      watchExtremeEdgeThreshold: ov.cryptoWatchExtremeEdgeThreshold ?? env.watchExtremeEdgeThreshold,
      // fillModelEnabled is a 0/1 knob in SCHEMA → coerce to boolean; absent → env default.
      fillModelEnabled:     ov.fillModelEnabled != null ? ov.fillModelEnabled === 1 : env.fillModelEnabled,
      fillParticipationCap: ov.fillParticipationCap ?? env.fillParticipationCap,
    };
  } catch {
    return env;
  }
}

// Depth-aware paper fill options (B49 #1). Single source for every
// Polymarket-fill runner (crypto + weather). Env default OFF; the `common`
// Blobs knobs `fillModelEnabled` (0/1) + `fillParticipationCap` override.
export async function getEffectiveFillOpts(): Promise<{ enabled: boolean; participationCap: number }> {
  const enabledEnv = process.env.FILL_MODEL_ENABLED === "true";
  const capEnv = parseFloat(process.env.FILL_PARTICIPATION_CAP || "0.20");
  try {
    const mod: any = await import("@api/routes/trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    return {
      enabled: ov.fillModelEnabled != null ? ov.fillModelEnabled === 1 : enabledEnv,
      participationCap: ov.fillParticipationCap ?? capEnv,
    };
  } catch {
    return { enabled: enabledEnv, participationCap: capEnv };
  }
}

// Crypto-beta exposure cap options (B49 #2). Aggregate directional crypto
// capital (crypto + HL) is capped at `fraction × combined bankroll`. Env default
// OFF; the `common` Blobs knobs `betaCapEnabled` (0/1) + `betaCapFraction`
// override. F-arb (delta-neutral) + weather are excluded from the aggregate.
export async function getEffectiveBetaCap(): Promise<{ enabled: boolean; fraction: number }> {
  const enabledEnv = process.env.BETA_CAP_ENABLED === "true";
  const fracEnv = parseFloat(process.env.BETA_CAP_FRACTION || "0.25");
  try {
    const mod: any = await import("@api/routes/trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    return {
      enabled: ov.betaCapEnabled != null ? ov.betaCapEnabled === 1 : enabledEnv,
      fraction: ov.betaCapFraction ?? fracEnv,
    };
  } catch {
    return { enabled: enabledEnv, fraction: fracEnv };
  }
}

export async function getEffectiveBtcExitConfig() {
  const base = getBtcExitConfig();
  try {
    const mod: any = await import("@api/routes/trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    return {
      tpTarget:           ov.btcTpTarget          ?? base.tpTarget,
      slTarget:           ov.btcSlTarget          ?? base.slTarget,
      entryWindowStartMs: ov.btcEntryWindowStartMs ?? base.entryWindowStartMs,
      entryWindowEndMs:   ov.btcEntryWindowEndMs   ?? base.entryWindowEndMs,
      holdToEndCutoffMs:  ov.btcHoldToEndCutoffMs  ?? base.holdToEndCutoffMs,
    };
  } catch {
    return base;
  }
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
