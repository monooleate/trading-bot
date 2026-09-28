// packages/core/src/executable-edge.mts
//
// Executable-edge gate (B75). Pure, zero I/O.
//
// WHY: the decision engines compute the edge against the Gamma quote
// (`outcomePrices`), which is a mid/last price, not a price anyone will sell
// at. The depth-aware fill model then walks the REAL ask book and finds the
// true cost. Measured live 2026-09-28 (14 days of crypto logs): 68 trade
// decisions, 68 rejected fills, and in 14 of the last 20 the book VWAP sat
// more than 10¢ above the quote (0.22 → 0.37, 0.50 → 0.65). A "15–20% edge"
// computed on the quote was mostly the spread.
//
// This module re-prices the chosen side at the simulated VWAP for the order
// size the engine actually wants, BEFORE the order is placed:
//
//     executableEdge = P(side) − VWAP − exitFee
//
// (the entry slippage is already inside the VWAP, so only the exit fee is
// charged — the same accounting the paper resolver uses when the fill model is
// ON, `settlementFeePctFillModel`). The trade is allowed only if that edge
// still clears the engine's own edge threshold AND the fill clears the
// exchange's minimum order size. Both failure modes get an explicit, loggable
// reason instead of the old catch-all "paper fill below min size / invalid /
// implausible vs quote".

/** Polymarket CLOB minimum order size, in shares (the fill model's default). */
export const POLYMARKET_MIN_ORDER_SHARES = 5;

export interface ExecutableEdgeInput {
  /** Model probability of YES for this market/bucket. */
  predProbYes: number;
  /** Side the engine chose. */
  direction: "YES" | "NO";
  /** The quote the decision was made on, for the chosen side (display/log only). */
  quotedSidePrice: number;
  /** Simulated fill for the intended order (from the depth-fill model). */
  fill: {
    ok: boolean;
    filledShares: number;
    filledUsdc: number;
    vwap: number;
  };
  /** USDC the engine intended to spend. */
  requestedUsdc: number;
  /** Exit-only fee charged at settlement (fraction, e.g. 0.015). */
  exitFeePct: number;
  /** The engine's own net-edge threshold (fraction, e.g. 0.15). */
  edgeThreshold: number;
  /** Minimum fillable shares. Default {@link POLYMARKET_MIN_ORDER_SHARES}. */
  minShares?: number;
}

export type ExecutableEdgeFailure = "no_fill" | "below_min_size" | "edge_below_threshold";

export interface ExecutableEdgeResult {
  ok: boolean;
  failure: ExecutableEdgeFailure | null;
  /** Model probability of the chosen side. */
  pSide: number;
  vwap: number;
  /** P(side) − VWAP − exitFee. NaN when there is no fill. */
  executableEdge: number;
  /** VWAP − quote for the chosen side (the spread/slippage the quote hid). */
  slippage: number;
  filledShares: number;
  fillFraction: number;
  reason: string;
}

function pct(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

export function evaluateExecutableEdge(input: ExecutableEdgeInput): ExecutableEdgeResult {
  const minShares = input.minShares ?? POLYMARKET_MIN_ORDER_SHARES;
  const pSide = input.direction === "YES" ? input.predProbYes : 1 - input.predProbYes;
  const { fill } = input;
  const fillFraction =
    input.requestedUsdc > 0 && Number.isFinite(fill.filledUsdc)
      ? Math.max(0, Math.min(1, fill.filledUsdc / input.requestedUsdc))
      : 0;

  const validVwap = fill.ok && Number.isFinite(fill.vwap) && fill.vwap > 0 && fill.vwap < 1;
  if (!validVwap || !(fill.filledShares > 0)) {
    return {
      ok: false,
      failure: "no_fill",
      pSide,
      vwap: NaN,
      executableEdge: NaN,
      slippage: NaN,
      filledShares: 0,
      fillFraction: 0,
      reason: "Executable edge: no fillable depth on the book for this side",
    };
  }

  const executableEdge = pSide - fill.vwap - input.exitFeePct;
  const slippage = fill.vwap - input.quotedSidePrice;
  const base = {
    pSide,
    vwap: fill.vwap,
    executableEdge,
    slippage,
    filledShares: fill.filledShares,
    fillFraction,
  };

  if (fill.filledShares < minShares - 1e-9) {
    return {
      ...base,
      ok: false,
      failure: "below_min_size",
      reason:
        `Order below exchange minimum: ${fill.filledShares.toFixed(2)} shares < ${minShares} ` +
        `($${input.requestedUsdc.toFixed(2)} @ VWAP ${fill.vwap.toFixed(3)})`,
    };
  }

  if (!(executableEdge >= input.edgeThreshold)) {
    return {
      ...base,
      ok: false,
      failure: "edge_below_threshold",
      reason:
        `Executable edge ${pct(executableEdge)} < threshold ${(input.edgeThreshold * 100).toFixed(1)}% ` +
        `(P(${input.direction}) ${pSide.toFixed(3)} − VWAP ${fill.vwap.toFixed(3)} ` +
        `− exit fee ${(input.exitFeePct * 100).toFixed(1)}%; quote ${input.quotedSidePrice.toFixed(3)}, ` +
        `slippage ${pct(slippage)})`,
    };
  }

  return {
    ...base,
    ok: true,
    failure: null,
    reason:
      `Executable edge ${pct(executableEdge)} ≥ ${(input.edgeThreshold * 100).toFixed(1)}% ` +
      `at VWAP ${fill.vwap.toFixed(3)} (quote ${input.quotedSidePrice.toFixed(3)})`,
  };
}
