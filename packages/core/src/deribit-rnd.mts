// netlify/functions/auto-trader/shared/deribit-rnd.mts
//
// Deribit risk-neutral density (Breeden–Litzenberger) — model-discovery §7 #7.
// Pure, portable (moves 1:1 to the server). The heavy SSVI/SABR surface fit is
// a Hetzner follow-up; this ships a robust linear-smile + BL-finite-diff core.
//
// WHY: instead of guessing σ ourselves and pricing P(BTC>K) with N(d₂), read
// the MARKET-implied P(BTC>K) straight off the Deribit BTC option chain (~85%
// of BTC options OI → the reference for BTC implied vol). Breeden–Litzenberger:
//   P_Q(S_T > K) = −e^{rT} ∂C/∂K      (one derivative of the call price)
//   q(K)         =  e^{rT} ∂²C/∂K²    (the full risk-neutral density)
// with r = 0 short-horizon. This is (a) a far better vol/prob estimate than our
// realized vol, and (b) RISK-NEUTRAL — the gap vs the physical Polymarket
// resolution IS the risk-premium / measure-gap (#2 calibration corrects it).
//
// Approach here (robust, sparse-strike-friendly):
//   • Interpolate the implied-vol smile (linear in strike; SSVI is the fitted
//     upgrade) to bracket the Polymarket strike K.
//   • Price BS calls at K±ΔK with each bracket's OWN interpolated IV, then
//     BL finite-difference: P_Q(>K) = −(C(K+Δ) − C(K−Δ)) / (2Δ). Pricing each
//     side with its own smile IV makes it SKEW-AWARE (a flat smile collapses it
//     back to N(d₂), verified in the tests).

import { normalCdf } from "./first-passage.mts";

export interface SmilePoint { strike: number; iv: number; } // iv = annualized (e.g. 0.62)

/**
 * Linear-in-strike interpolation of the implied-vol smile at K, with FLAT
 * extrapolation beyond the listed range (Deribit strikes are discrete/sparse).
 * Drops non-finite / non-positive points. Returns NaN on an empty smile. Pure.
 */
export function impliedVolAt(smile: SmilePoint[], K: number): number {
  const pts = smile
    .filter((p) => Number.isFinite(p.strike) && Number.isFinite(p.iv) && p.iv > 0 && p.strike > 0)
    .sort((a, b) => a.strike - b.strike);
  const n = pts.length;
  if (n === 0) return NaN;
  if (n === 1) return pts[0].iv;
  if (K <= pts[0].strike) return pts[0].iv;
  if (K >= pts[n - 1].strike) return pts[n - 1].iv;
  for (let i = 0; i < n - 1; i++) {
    if (K >= pts[i].strike && K <= pts[i + 1].strike) {
      const w = (K - pts[i].strike) / (pts[i + 1].strike - pts[i].strike);
      return pts[i].iv * (1 - w) + pts[i + 1].iv * w;
    }
  }
  return pts[n - 1].iv;
}

/** Black–Scholes call price, r = 0. Pure. */
export function blackScholesCall(S: number, K: number, sigma: number, T: number): number {
  if (!(S > 0 && K > 0 && sigma > 0 && T > 0)) return NaN;
  const s = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / s;
  const d2 = d1 - s;
  return S * normalCdf(d1) - K * normalCdf(d2);
}

/**
 * Breeden–Litzenberger market-implied risk-neutral P(S_T > K), skew-aware:
 * finite-difference of BS call prices computed with the smile IV interpolated
 * at K±ΔK. r = 0. Returns a probability in [0,1], or NaN if the smile can't
 * price both brackets. Pure.
 *
 * ΔK defaults to 0.5% of K (≥ $1) — small enough for a good derivative, large
 * enough to stay numerically stable against sparse strikes.
 */
export function blDigitalAbove(
  S: number,
  K: number,
  smile: SmilePoint[],
  T: number,
  dKfrac: number = 0.005,
): number {
  if (!(S > 0 && K > 0 && T > 0)) return NaN;
  const dK = Math.max(1, K * dKfrac);
  const sLo = impliedVolAt(smile, K - dK);
  const sHi = impliedVolAt(smile, K + dK);
  if (!(sLo > 0) || !(sHi > 0)) return NaN;
  const cLo = blackScholesCall(S, K - dK, sLo, T);
  const cHi = blackScholesCall(S, K + dK, sHi, T);
  if (!Number.isFinite(cLo) || !Number.isFinite(cHi)) return NaN;
  const prob = -(cHi - cLo) / (2 * dK); // −∂C/∂K = P_Q(S_T > K) at r = 0
  return Math.min(1, Math.max(0, prob));
}
