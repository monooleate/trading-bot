// packages/core/src/portfolio-exposure.mts
//
// Portfolio-level crypto-beta exposure cap — model-discovery-expansion §4.C
// (B49 #2). Pure, portable (zero I/O). The cross-bot session LOAD lives in the
// worker (shared/portfolio-exposure.mts); this module only does the math.
//
// WHY: each bot sizes independently with ¼-Kelly + an 8% cap and its own
// bankroll, blind to the others. But crypto (BTC-threshold) and HL-perp
// (BTC/ETH/SOL directional) are BOTH crypto-beta — so six "independent"
// 8%-capped bets can collectively be one large correlated BTC position that no
// per-bot view can see (the barbell finding: a single BTC move hits crypto
// longs AND HL longs together). The portfolio agent's #1 point. This module
// caps the AGGREGATE directional crypto capital committed across those two bots.
//
// SCOPE: crypto + HL directional only. Funding-arb is EXCLUDED — it is
// delta-neutral (HL short + Binance long), so its directional beta ≈ 0; its
// capital is committed but hedged against the "one BTC move" risk. Weather is
// not crypto. Exposure is measured as CAPITAL COMMITTED (comparable across the
// two bots), NOT levered notional:
//   • crypto binary position → costBasis (USD at risk)
//   • HL perp position       → margin = sizeUSDC / leverage (capital committed)
// so the cap reads as "fraction of combined (crypto+HL) bankroll tied up in
// crypto-directional bets", matching the 8%×N-slots framing of the discovery.

export interface CryptoPosLike { costBasis: number; }
export interface HlPosLike { sizeUSDC: number; leverage: number; }

/** Σ costBasis over crypto binary positions (USD capital at risk). Pure. */
export function cryptoExposureUsd(positions: CryptoPosLike[]): number {
  return (positions ?? []).reduce((s, p) => s + (p?.costBasis > 0 ? p.costBasis : 0), 0);
}

/** Σ margin over HL perp positions (= sizeUSDC / leverage, capital committed).
 *  Uses margin, not levered notional, so it is commensurate with crypto
 *  costBasis under one bankroll-fraction cap. Pure. */
export function hlExposureUsd(positions: HlPosLike[]): number {
  return (positions ?? []).reduce((s, p) => {
    if (!(p?.sizeUSDC > 0)) return s;
    const lev = p.leverage > 0 ? p.leverage : 1;
    return s + p.sizeUSDC / lev;
  }, 0);
}

export interface BetaCapCheck {
  allowed: boolean;
  capUsd: number;
  currentUsd: number;
  prospectiveUsd: number;
  projectedUsd: number;   // current + prospective
  utilization: number;    // projected / capUsd (∞-safe)
  reason?: string;
}

/**
 * Decide whether adding `prospectiveUsd` of new crypto-directional capital
 * keeps the aggregate (crypto + HL) committed capital within
 * `capFraction × combinedBankrollUsd`. Pure.
 *
 * Fail-open on a non-positive bankroll or non-positive capFraction (returns
 * allowed=true) — a risk cap must never brick trading on a degenerate input;
 * the caller gates activation on the `enabled` flag separately.
 */
export function checkBetaCap(
  currentExposureUsd: number,
  prospectiveUsd: number,
  combinedBankrollUsd: number,
  capFraction: number,
): BetaCapCheck {
  const current = Math.max(0, currentExposureUsd || 0);
  const prospective = Math.max(0, prospectiveUsd || 0);
  const projected = current + prospective;

  if (!(combinedBankrollUsd > 0) || !(capFraction > 0)) {
    return { allowed: true, capUsd: Infinity, currentUsd: current, prospectiveUsd: prospective, projectedUsd: projected, utilization: 0 };
  }

  const capUsd = capFraction * combinedBankrollUsd;
  const allowed = projected <= capUsd + 1e-6;
  const utilization = capUsd > 0 ? projected / capUsd : Infinity;
  return {
    allowed,
    capUsd,
    currentUsd: current,
    prospectiveUsd: prospective,
    projectedUsd: projected,
    utilization,
    reason: allowed
      ? undefined
      : `crypto-beta exposure cap: $${projected.toFixed(0)} projected > $${capUsd.toFixed(0)} cap ` +
        `(${(capFraction * 100).toFixed(0)}% of $${combinedBankrollUsd.toFixed(0)} combined bankroll; ` +
        `current $${current.toFixed(0)} + new $${prospective.toFixed(0)})`,
  };
}
