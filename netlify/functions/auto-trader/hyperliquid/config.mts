// netlify/functions/auto-trader/hyperliquid/config.mts
// Hyperliquid execution config.

import type { HlCoin, HlTraderConfig } from "./types.mts";

// NOTE: Hyperliquid asset indices are NOT stable. As HL adds and delists
// coins the universe[] array's order can shift relative to old positions
// — and at this date BTC=0/ETH=1 are the only "obvious" mappings; SOL is
// at index 5 (not 2), DOGE at 12 (not 5), XRP at 25 (not 3). The
// authoritative source is the `meta` endpoint's `universe[].name` array.
//
// All call sites resolve the index via `lookupAssetIndex(coin)` (defined
// in hl-client.mts) which caches the universe per cold start. We keep an
// emergency static fallback ONLY for the two indices we can be reasonably
// certain about so the bot still resolves SOMETHING if `meta` is briefly
// unreachable; the dynamic lookup is preferred everywhere.
export const STATIC_ASSET_INDEX_FALLBACK: Partial<Record<HlCoin, number>> = {
  BTC: 0,
  ETH: 1,
};

// Hyperliquid REST endpoints
export const HL_MAINNET = "https://api.hyperliquid.xyz";
export const HL_TESTNET = "https://api.hyperliquid-testnet.xyz";

export function hlBaseUrl(paperMode: boolean): string {
  return paperMode ? HL_TESTNET : HL_MAINNET;
}

// Bump on every breaking paper-semantic change. v2 (2026-05-10):
//   - TP/SL price-distance clamps via tpPctMax / slPctMax
//   - Paper-side volatility gate (parity with live)
//   - Paper PnL accrues HL hourly funding (parity with live)
// Old v1 sessions auto-archive on load (see session-manager loadHlSession).
export const HL_PAPER_SIM_VERSION = 2;

// ─── Trader config ──────────────────────────────────────────────────────────
export function getHlConfig(): HlTraderConfig {
  return {
    paperMode:          process.env.HL_PAPER_MODE !== "false",
    maxLeverage:        parseFloat(process.env.HL_MAX_LEVERAGE         || "3"),
    maxPctBankroll:     parseFloat(process.env.HL_MAX_PCT_BANKROLL     || "0.15"),
    edgeThresholdPaper: parseFloat(process.env.HL_EDGE_THRESHOLD_PAPER || "0.12"),
    edgeThresholdLive:  parseFloat(process.env.HL_EDGE_THRESHOLD_LIVE  || "0.18"),
    sessionLossLimit:   parseFloat(process.env.HL_SESSION_LOSS_LIMIT   || "50"),
    cooldownSeconds:    parseInt  (process.env.HL_COOLDOWN_SECONDS     || "300", 10),
    maxOpenPositions:   parseInt  (process.env.HL_MAX_OPEN_POSITIONS   || "3", 10),
    consecutiveLossPauseHours: parseFloat(process.env.HL_CONSEC_LOSS_PAUSE_HOURS || "1"),
    consecutiveLossLimit:      parseInt  (process.env.HL_CONSEC_LOSS_LIMIT       || "3", 10),
    volGateRvPct:       parseFloat(process.env.HL_VOL_GATE_RV_PCT      || "120"),
    roundtripFeePct:    parseFloat(process.env.HL_ROUNDTRIP_FEE_PCT    || "0.0007"),
    tpPctMax:           parseFloat(process.env.HL_TP_PCT_MAX           || "0.02"),
    slPctMax:           parseFloat(process.env.HL_SL_PCT_MAX           || "0.01"),
    minActiveSignals:   parseInt  (process.env.HL_MIN_ACTIVE_SIGNALS   || "3", 10),
    maxEdgeCap:               parseFloat(process.env.HL_MAX_EDGE_CAP                || "0.40"),
    watchExtremeEdgeThreshold: parseFloat(process.env.HL_WATCH_EXTREME_EDGE_THRESHOLD || "0.20"),
    paperSimVersion:    HL_PAPER_SIM_VERSION,
  };
}

/**
 * Effective config = env defaults merged with runtime Blobs overrides.
 * Mirrors getEffectiveWeatherConfig: lazy import to break circular deps,
 * env-only fallback on any read error so the trader keeps running.
 */
export async function getEffectiveHlConfig(): Promise<HlTraderConfig> {
  const env = getHlConfig();
  try {
    const mod: any = await import("../../trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    return {
      ...env,
      maxLeverage:               ov.hlMaxLeverage             ?? env.maxLeverage,
      edgeThresholdPaper:        ov.hlEdgeThresholdPaper      ?? env.edgeThresholdPaper,
      edgeThresholdLive:         ov.hlEdgeThresholdLive       ?? env.edgeThresholdLive,
      sessionLossLimit:          ov.hlSessionLossLimit        ?? env.sessionLossLimit,
      cooldownSeconds:           ov.hlCooldownSeconds         ?? env.cooldownSeconds,
      maxOpenPositions:          ov.hlMaxOpenPositions        ?? env.maxOpenPositions,
      consecutiveLossLimit:      ov.hlConsecutiveLossLimit    ?? env.consecutiveLossLimit,
      volGateRvPct:              ov.hlVolGateRvPct            ?? env.volGateRvPct,
      minActiveSignals:          ov.hlMinActiveSignals        ?? env.minActiveSignals,
      maxEdgeCap:                ov.hlMaxEdgeCap                ?? env.maxEdgeCap,
      watchExtremeEdgeThreshold: ov.hlWatchExtremeEdgeThreshold ?? env.watchExtremeEdgeThreshold,
    };
  } catch {
    return env;
  }
}
