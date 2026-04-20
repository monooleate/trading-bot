// netlify/functions/auto-trader/hyperliquid/config.mts
// Hyperliquid execution config.

import type { HlCoin, HlTraderConfig } from "./types.mts";

// Asset index in Hyperliquid's universe (verifiable via info.meta())
// Keep in sync with https://api.hyperliquid.xyz/info meta() response.
export const ASSET_INDEX: Record<HlCoin, number> = {
  BTC:  0,
  ETH:  1,
  SOL:  2,
  XRP:  3,
  DOGE: 5,
  AVAX: 6,
};

// Hyperliquid REST endpoints
export const HL_MAINNET = "https://api.hyperliquid.xyz";
export const HL_TESTNET = "https://api.hyperliquid-testnet.xyz";

export function hlBaseUrl(paperMode: boolean): string {
  return paperMode ? HL_TESTNET : HL_MAINNET;
}

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
  };
}
