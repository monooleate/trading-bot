// packages/core/src/risk-overlay.mts
//
// Vol-target + drawdown kill-switch overlays — model-discovery-expansion §4.C
// (B49 #8). Pure, portable (zero I/O). Robust, near-parameter-free tail control
// that sits ON TOP of the existing ¼-Kelly sizing.
//
// WHY: ¼-Kelly maximises log-growth but is silent on realised volatility and
// drawdown — full Kelly runs ~60% average max-DD; even ¼-Kelly bleeds when a
// bot's realised return vol spikes (regime shift) or a losing streak compounds.
// Two cheap overlays fix the tail:
//   • Vol-target: scale the position by (targetVol / realisedVol), clamped — cut
//     size when realised vol runs hot, restore it when calm. Parameter-light.
//   • Drawdown kill-switch: halt NEW entries once peak-to-current equity drops
//     past a limit (a principled peak-equity stop vs the legacy gross-loss
//     odometer — cf. B33). Existing positions are untouched.
// Both are measure-first / opt-in at the call site (default-OFF knobs).

/**
 * Sample standard deviation of a return series (per-trade or per-period). < 2
 * points → 0 (no dispersion estimate). Pure.
 */
export function realisedVol(returns: number[]): number {
  const xs = (returns ?? []).filter((x) => Number.isFinite(x));
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export interface VolTargetOpts {
  /** Clamp on the multiplier so a tiny realised vol can't explode size. Default 1.5. */
  maxMult?: number;
  /** Floor on the multiplier so size never fully collapses. Default 0.25. */
  minMult?: number;
  /** Realised-vol floor to avoid divide-by-tiny. Default 1e-4. */
  volFloor?: number;
}

/**
 * Vol-target multiplier = clamp(targetVol / realisedVol, minMult, maxMult). When
 * realised vol is unknown (≤ volFloor) or targetVol ≤ 0, returns 1 (no-op). Apply
 * to the ¼-Kelly fraction. Pure.
 */
export function volTargetMultiplier(realisedVolValue: number, targetVol: number, opts: VolTargetOpts = {}): number {
  const maxMult = opts.maxMult ?? 1.5;
  const minMult = opts.minMult ?? 0.25;
  const volFloor = opts.volFloor ?? 1e-4;
  if (!(targetVol > 0) || !(realisedVolValue > volFloor)) return 1;
  const raw = targetVol / realisedVolValue;
  return Math.min(maxMult, Math.max(minMult, raw));
}

export interface DrawdownState {
  kill: boolean;          // true → halt new entries
  ddFraction: number;     // (peak − current) / peak, ≥ 0
  peak: number;
  current: number;
}

/**
 * Peak-to-current drawdown kill-switch. `peakEquity` is the running high-water
 * mark, `currentEquity` the current equity. Kills new entries when the drawdown
 * fraction ≥ `maxDdFraction` (e.g. 0.25 = 25%). Fail-open (kill=false) on a
 * non-positive peak. Pure.
 */
export function drawdownKill(peakEquity: number, currentEquity: number, maxDdFraction: number): DrawdownState {
  const peak = Math.max(peakEquity || 0, currentEquity || 0);
  const current = currentEquity || 0;
  if (!(peak > 0) || !(maxDdFraction > 0)) {
    return { kill: false, ddFraction: 0, peak, current };
  }
  const ddFraction = Math.max(0, (peak - current) / peak);
  return { kill: ddFraction >= maxDdFraction, ddFraction, peak, current };
}
