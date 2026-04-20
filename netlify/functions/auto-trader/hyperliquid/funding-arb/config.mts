// netlify/functions/auto-trader/hyperliquid/funding-arb/config.mts
import type { FrArbConfig } from "./types.mts";

export function getFrArbConfig(): FrArbConfig {
  return {
    paperMode:           process.env.HL_PAPER_MODE !== "false",
    minSpreadHourly:     parseFloat(process.env.FR_MIN_SPREAD_HOURLY      || "0.0001"),   // 0.01%/h
    minOpenInterestUSD:  parseFloat(process.env.FR_MIN_OPEN_INTEREST      || "5000000"),  // $5M
    maxArbPositions:     parseInt  (process.env.FR_MAX_ARB_POSITIONS      || "3", 10),
    maxCapitalPct:       parseFloat(process.env.FR_MAX_CAPITAL_PCT        || "0.40"),
    minPositionUSDC:     parseFloat(process.env.FR_MIN_POSITION_USDC      || "50"),
    maxHoldDays:         parseFloat(process.env.FR_MAX_HOLD_DAYS          || "14"),
    minSpreadToClose:    parseFloat(process.env.FR_MIN_SPREAD_TO_CLOSE    || "0.00005"),
    feeRoundtripHl:      parseFloat(process.env.FR_FEE_ROUNDTRIP_HL       || "0.0009"),   // 0.045% × 2
    feeRoundtripBinance: parseFloat(process.env.FR_FEE_ROUNDTRIP_BINANCE  || "0.002"),    // 0.1%  × 2
  };
}
