// netlify/functions/auto-trader/hyperliquid/funding-arb/config.mts
import type { FrArbConfig } from "./types.mts";

export function getFrArbConfig(): FrArbConfig {
  return {
    paperMode:           process.env.HL_PAPER_MODE !== "false",
    // 2026-06-04 recalibration: the old 0.0001/h floor demanded an ~88%/yr
    // cross-venue spread, which the HL↔Binance funding gap basically never
    // reaches (live spreads run 3.6–31%/yr). At 0.29% roundtrip fees + 14d
    // max-hold the true break-even is ~7.5%/yr, so 0.00002/h (≈17.5%/yr)
    // clears fees with margin while still letting real opportunities through.
    minSpreadHourly:     parseFloat(process.env.FR_MIN_SPREAD_HOURLY      || "0.00002"),  // 0.002%/h ≈ 17.5%/yr
    minOpenInterestUSD:  parseFloat(process.env.FR_MIN_OPEN_INTEREST      || "5000000"),  // $5M
    maxArbPositions:     parseInt  (process.env.FR_MAX_ARB_POSITIONS      || "3", 10),
    maxCapitalPct:       parseFloat(process.env.FR_MAX_CAPITAL_PCT        || "0.40"),
    // 2026-06-04: lowered $50→$25. With a $200 bankroll + 40% cap the first
    // position sized at headroom×0.5 = $40, which never cleared a $50 floor
    // → the bot was structurally unable to open ANY position. $25 (plus the
    // bump-to-min sizing in index.mts) lets a small bankroll trade and allows
    // finer multi-position granularity.
    minPositionUSDC:     parseFloat(process.env.FR_MIN_POSITION_USDC      || "25"),
    maxHoldDays:         parseFloat(process.env.FR_MAX_HOLD_DAYS          || "14"),
    minSpreadToClose:    parseFloat(process.env.FR_MIN_SPREAD_TO_CLOSE    || "0.00005"),
    feeRoundtripHl:      parseFloat(process.env.FR_FEE_ROUNDTRIP_HL       || "0.0009"),   // 0.045% × 2
    feeRoundtripBinance: parseFloat(process.env.FR_FEE_ROUNDTRIP_BINANCE  || "0.002"),    // 0.1%  × 2
    // 2026-06-04: tightened 0.5%/h → 0.05%/h. The old 0.5%/h cap (4380%/yr)
    // let a 2952%/yr feed glitch (BTC 0.337%/h on 06-04 06:42 UTC) pass
    // straight through to sizing. 0.05%/h (438%/yr) still sits ~14× above the
    // widest real spread observed (SOL ~31%/yr) but rejects the glitch class.
    maxSpreadHourly:     parseFloat(process.env.FR_MAX_SPREAD_HOURLY      || "0.0005"),   // 0.05%/h sanity cap
  };
}

/**
 * Effective config = env defaults merged with runtime Blobs overrides.
 * Mirrors getEffectiveHlConfig — Settings-tab tunable knobs override the
 * env defaults so the operator can adjust the spread/OI/hold-days floors
 * without redeploys.
 */
export async function getEffectiveFrArbConfig(): Promise<FrArbConfig> {
  const env = getFrArbConfig();
  try {
    const mod: any = await import("../../../trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    return {
      ...env,
      minSpreadHourly:    ov.frMinSpreadHourly    ?? env.minSpreadHourly,
      minOpenInterestUSD: ov.frMinOpenInterestUSD ?? env.minOpenInterestUSD,
      maxHoldDays:        ov.frMaxHoldDays        ?? env.maxHoldDays,
      maxCapitalPct:      ov.frMaxCapitalPct      ?? env.maxCapitalPct,
      maxArbPositions:    ov.frMaxOpenPositions   ?? env.maxArbPositions,
      maxSpreadHourly:    ov.frMaxSpreadHourly    ?? env.maxSpreadHourly,
    };
  } catch {
    return env;
  }
}
