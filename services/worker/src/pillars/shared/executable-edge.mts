// services/worker/src/pillars/shared/executable-edge.mts
//
// Runner-side wrapper for the executable-edge gate (B75). Fetches the public
// CLOB ask book for the side the engine chose, simulates the fill for the
// intended order size with the SAME depth model the paper fill uses, and
// re-prices the edge at that VWAP (pure math: @core/executable-edge.mts).
//
// Shared by every Polymarket runner that calls `placeBuyOrder` (crypto +
// weather). It is active exactly when the depth-aware fill model is ON
// (`fillModelEnabled`): with the fill model OFF the paper fill is the legacy
// full fill at the quote, so there is no second price to reconcile.
//
// Fail-safe direction: if the book cannot be fetched, the same sqrt-law/flat
// haircut fallback the fill model would book is used — never the raw quote —
// so the gate can only be as optimistic as the fill that would follow.

import { fetchClobBook } from "./clob-book.mts";
import { simulateDepthFill, fallbackFill } from "@core/fill-model.mts";
import {
  evaluateExecutableEdge,
  POLYMARKET_MIN_ORDER_SHARES,
  type ExecutableEdgeResult,
} from "@core/executable-edge.mts";
import type { DecisionGate, MarketInfo } from "@core/types.mts";

export const EXECUTABLE_EDGE_GATE_LABEL = "Végrehajtható edge (könyv-VWAP)";

export interface ExecutableEdgeCheckOpts {
  participationCap: number;
  exitFeePct: number;
  edgeThreshold: number;
  fallbackHaircut?: number;
  minShares?: number;
}

export interface ExecutableEdgeCheck {
  result: ExecutableEdgeResult;
  gate: DecisionGate;
  bookSource: "book" | "fallback-thin" | "fallback-nobook";
}

export async function checkExecutableEdge(
  market: Pick<MarketInfo, "clobTokenIds">,
  direction: "YES" | "NO",
  predProbYes: number,
  quotedSidePrice: number,
  sizeUSDC: number,
  opts: ExecutableEdgeCheckOpts,
): Promise<ExecutableEdgeCheck> {
  const tokenId = direction === "YES" ? market.clobTokenIds?.[0] : market.clobTokenIds?.[1];
  const book = tokenId ? await fetchClobBook(tokenId) : null;

  let bookSource: ExecutableEdgeCheck["bookSource"] = "book";
  let fill =
    book && book.asks.length > 0
      ? simulateDepthFill(book.asks, sizeUSDC, { participationCap: opts.participationCap })
      : null;
  if (!fill || !fill.ok) {
    bookSource = book ? "fallback-thin" : "fallback-nobook";
    fill = fallbackFill(quotedSidePrice, sizeUSDC, opts.fallbackHaircut ?? 0.02);
  }

  const result = evaluateExecutableEdge({
    predProbYes,
    direction,
    quotedSidePrice,
    fill,
    requestedUsdc: sizeUSDC,
    exitFeePct: opts.exitFeePct,
    edgeThreshold: opts.edgeThreshold,
    minShares: opts.minShares ?? POLYMARKET_MIN_ORDER_SHARES,
  });

  const gate: DecisionGate = {
    label: EXECUTABLE_EDGE_GATE_LABEL,
    passed: result.ok,
    actual: Number.isFinite(result.executableEdge)
      ? `${(result.executableEdge * 100).toFixed(2)}% @ VWAP ${result.vwap.toFixed(3)} ` +
        `(quote ${quotedSidePrice.toFixed(3)}, ${result.filledShares.toFixed(1)} sh, ${bookSource})`
      : `nincs kitölthető mélység (${bookSource})`,
    required:
      `≥ ${(opts.edgeThreshold * 100).toFixed(1)}% és ≥ ${opts.minShares ?? POLYMARKET_MIN_ORDER_SHARES} részvény`,
    hint:
      "Az edge a valódi eladási könyvön, a szándékolt méretre szimulált átlagáron (VWAP) számolva, " +
      "a kilépési díj levonásával. A Gamma-quote közép/utolsó ár — a spreadet elrejti (B75).",
  };

  return { result, gate, bookSource };
}
