// netlify/functions/auto-trader/shared/first-passage.mts
//
// First-passage / one-touch pricing + barrier-market routing — model-discovery
// §7 #6. Pure, portable (moves 1:1 to the server).
//
// WHY: Polymarket crypto markets come in two flavours with DIFFERENT math:
//   • "BTC above $K ON <date>"  → TERMINAL digital: P(S_T > K) = N(d₂)  (today).
//   • "BTC reach/hit $K BY <date>" → TOUCH / first-passage: P(price EVER hits K
//     before T). Strictly HIGHER than terminal (it can touch then retrace).
//     Reflection principle: for a driftless barrier, one-touch ≈ 2× terminal.
// Pricing a touch market with N(d₂) understates it by up to ~2× → the bot
// thinks YES is cheaper than it is. #6 routes to the correct formula.
//
// The classifier is deliberately CONSERVATIVE: only explicit touch verbs
// (hit/reach/touch/ever) → "touch"; everything else → "terminal" (the current,
// safe default). The bot's present mix ("up-or-down", "above-Nk-on") has no
// touch verb → classified terminal → zero behaviour change even when enabled.

// ─── Standard normal CDF (self-contained; Abramowitz–Stegun 7.1.26 erf) ─────
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * One-touch (first-passage) probability that a GBM starting at S touches the
 * barrier K at any time before horizon T (years), under risk-neutral log-drift
 * ν = −σ²/2 (r = 0, consistent with the terminal N(d₂)). Handles both an
 * upper barrier (K > S, up-touch) and a lower barrier (K < S, down-touch).
 * Returns a probability in [0,1], or NaN on invalid input. Pure.
 *
 * Barrier in log-space b = ln(K/S). First-passage of a (ν,σ) Brownian motion:
 *   upper (b>0): Φ((νT−b)/s) + e^(2νb/σ²)·Φ((−νT−b)/s)
 *   lower (b<0): Φ((−νT+b)/s) + e^(2νb/σ²)·Φ((νT+b)/s)
 * with s = σ√T. (For an unresolved touch market the spot has not yet crossed
 * K, so b>0 ⟺ up-touch and b<0 ⟺ down-touch.)
 */
export function oneTouchProbability(S: number, K: number, sigmaAnnual: number, T: number): number {
  if (!(S > 0 && K > 0 && sigmaAnnual > 0 && T > 0)) return NaN;
  const b = Math.log(K / S);
  if (b === 0) return 1;                       // already at the barrier → touched
  const nu = -0.5 * sigmaAnnual * sigmaAnnual;  // r = 0 log-drift
  const sig2 = sigmaAnnual * sigmaAnnual;
  const s = sigmaAnnual * Math.sqrt(T);
  const expTerm = Math.exp(2 * nu * b / sig2);  // = S/K when ν = −σ²/2
  let p: number;
  if (b > 0) {
    p = normalCdf((nu * T - b) / s) + expTerm * normalCdf((-nu * T - b) / s);
  } else {
    p = normalCdf((-nu * T + b) / s) + expTerm * normalCdf((nu * T + b) / s);
  }
  return Math.min(1, Math.max(0, p));
}

/**
 * Terminal digital probability P(S_T > K) = N(d₂) (r = 0). Provided so the
 * router and tests can compare one-touch vs terminal from one place; getVolSignal
 * keeps its own inline N(d₂). Pure.
 */
export function terminalAboveProbability(S: number, K: number, sigmaAnnual: number, T: number): number {
  if (!(S > 0 && K > 0 && sigmaAnnual > 0 && T > 0)) return NaN;
  const d2 = (Math.log(S / K) - 0.5 * sigmaAnnual * sigmaAnnual * T) / (sigmaAnnual * Math.sqrt(T));
  return Number.isFinite(d2) ? normalCdf(d2) : NaN;
}

export type BarrierKind = "terminal" | "touch";

/**
 * Classify a market as a terminal ("above K ON date") vs a touch ("reach/hit K
 * BY date") barrier market, from its slug + question. Conservative: only
 * explicit touch verbs flip it to "touch"; everything else stays "terminal".
 * Pure.
 */
export function classifyBarrierMarket(slug?: string | null, question?: string | null): BarrierKind {
  const text = `${slug ?? ""} ${question ?? ""}`.toLowerCase();
  // Explicit first-passage / touch verbs.
  if (/\b(hit|hits|hitting|reach|reaches|reached|reaching|touch|touches|touched|ever)\b/.test(text)) {
    return "touch";
  }
  return "terminal";
}
