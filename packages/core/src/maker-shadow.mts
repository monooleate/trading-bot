// packages/core/src/maker-shadow.mts
//
// B77 — SHADOW maker (resting limit) orders. Pure, zero I/O.
//
// WHY: the B75 replay showed the crypto "15–20% edge" was mostly the spread the
// taker pays. A resting buy limit pays no spread — it EARNS the price it sets —
// but whether it ever fills, and whether the fills are the good ones or the
// adverse ones (a seller shows up exactly when the market has moved against
// us), cannot be settled by reasoning: the paper engine has no queue. So this
// module records what WOULD have happened, forward, on our own scans, and
// scores it once the market resolves. Nothing here opens a position or changes
// a decision; the execution path (B77b) waits for this evidence.
//
// THE MODEL (deliberately conservative on fills):
//   · An order is a hypothetical resting BUY at `limit` on the chosen side's
//     token. It is observed once per bot tick (~3 min).
//   · It FILLS when an observation shows best ask ≤ limit: a seller was willing
//     to sell at or below our price, which on a real CLOB matches a resting bid.
//     The fill price is the LIMIT, never the (better) ask — no price-improvement
//     credit. Sellers that appear and vanish between two observations are
//     missed — again the pessimistic side, so the measured fill rate is a lower
//     bound. There is NO queue-position optimism to correct.
//   · Adverse selection is not modelled, it is MEASURED: every order — filled or
//     not — is settled against the market's real resolution, so the eval can
//     compare the outcomes of the orders that filled with those that did not.
//   · One ladder of target edges per opportunity ({5%,10%,15%} by default), so
//     the evidence is a fill-rate-vs-edge CURVE, not a single arbitrary point.
//
// Fee accounting mirrors the paper resolver exactly: entry is the limit price
// (maker: no entry fee), exit fee = max(proceeds, cost) × exitFeePct.

export const SHADOW_EPS = 1e-9;
export const MIN_SHADOW_PRICE = 0.02;

export type ShadowStatus = "pending" | "filled" | "expired";

export interface MakerShadowOrder {
  id: string;
  slug: string;
  conditionId: string | null;
  tokenId: string;
  direction: "YES" | "NO";
  endDate: string | null;
  placedAt: number;            // ms
  expiresAt: number;           // ms
  pYes: number;                // model P(YES) at placement
  pSide: number;               // ... for the chosen side
  quotedSidePrice: number;     // Gamma quote for the chosen side at placement
  bestBid: number | null;      // token book at placement
  bestAsk: number;
  targetEdge: number;          // the ladder rung this order was built for
  effectiveEdge: number;       // pSide − limit − exitFee (≥ targetEdge unless capped)
  limit: number;
  notionalUsdc: number;
  shares: number;              // notional / limit
  status: ShadowStatus;
  checks: number;              // book observations after placement
  lastCheckedAt?: number;
  filledAt?: number;
  fillAsk?: number;            // the ask that crossed us (information only)
  outcomeYes?: 0 | 1;          // market resolution, once known
  resolvedAt?: number;
  pnl?: number;                // filled AND resolved only
}

export interface PlanInput {
  slug: string;
  conditionId: string | null;
  tokenId: string;
  direction: "YES" | "NO";
  endDate: string | null;
  pYes: number;
  quotedSidePrice: number;
  book: { bestBid: number | null; bestAsk: number };
  exitFeePct: number;
  ladder: number[];
  notionalUsdc: number;
  ttlMs: number;
  now: number;
  tick?: number;               // default: Polymarket grid at that price
}

/** Polymarket's default tick: 0.001 at the tails, 0.01 elsewhere. */
export function defaultTick(price: number): number {
  return price < 0.04 || price > 0.96 ? 0.001 : 0.01;
}

function snapDown(price: number, tick: number): number {
  return Math.floor((price + SHADOW_EPS) / tick) * tick;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Build the ladder of shadow limits for one opportunity. For each target edge
 * e the highest price that still leaves that edge is
 *     maxPrice = pSide − e − exitFee,
 * capped one tick below the best ask (at or above the ask the order would be
 * MARKETABLE — a taker, which the taker path already handles — so those rungs
 * are skipped, not recorded). Rungs that snap to the same limit collapse to the
 * first. Pure.
 */
export function planMakerLadder(p: PlanInput): MakerShadowOrder[] {
  const pSide = p.direction === "YES" ? p.pYes : 1 - p.pYes;
  if (!(pSide > 0 && pSide < 1) || !(p.book.bestAsk > 0) || !(p.notionalUsdc > 0)) return [];
  const expiresAt = Math.min(
    p.now + p.ttlMs,
    p.endDate && Number.isFinite(Date.parse(p.endDate)) ? Date.parse(p.endDate) - 10 * 60_000 : Infinity,
  );
  if (!(expiresAt > p.now)) return [];

  const out: MakerShadowOrder[] = [];
  const seen = new Set<number>();
  for (const e of [...p.ladder].sort((a, b) => a - b)) {
    const maxPrice = pSide - e - p.exitFeePct;
    if (!(maxPrice > 0)) continue;
    const tick = p.tick ?? defaultTick(Math.min(maxPrice, p.book.bestAsk));
    // Not marketable: strictly below the best ask.
    if (maxPrice >= p.book.bestAsk - SHADOW_EPS) continue;
    const limit = r6(snapDown(Math.min(maxPrice, p.book.bestAsk - tick), tick));
    if (!(limit >= MIN_SHADOW_PRICE)) continue;
    if (seen.has(limit)) continue;
    seen.add(limit);
    out.push({
      id: `${p.slug}|${p.direction}|${e}|${p.now}`,
      slug: p.slug,
      conditionId: p.conditionId,
      tokenId: p.tokenId,
      direction: p.direction,
      endDate: p.endDate,
      placedAt: p.now,
      expiresAt,
      pYes: p.pYes,
      pSide,
      quotedSidePrice: p.quotedSidePrice,
      bestBid: p.book.bestBid,
      bestAsk: p.book.bestAsk,
      targetEdge: e,
      effectiveEdge: r6(pSide - limit - p.exitFeePct),
      limit,
      notionalUsdc: p.notionalUsdc,
      shares: r6(p.notionalUsdc / limit),
      status: "pending",
      checks: 0,
    });
  }
  return out;
}

/**
 * One book observation of one order. `bestAsk` null = no asks visible (an empty
 * or failed fetch) — the order is neither filled nor expired by it, only aged.
 * A pending order past its expiry is expired WITHOUT looking at the book: a late
 * observation must not manufacture a fill the order could no longer have had.
 * Pure; returns a new object.
 */
export function observeShadowOrder(
  o: MakerShadowOrder,
  bestAsk: number | null,
  now: number,
): MakerShadowOrder {
  if (o.status !== "pending") return o;
  if (now > o.expiresAt) return { ...o, status: "expired", lastCheckedAt: now };
  if (bestAsk !== null && Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk <= o.limit + SHADOW_EPS) {
    return { ...o, status: "filled", filledAt: now, fillAsk: bestAsk, checks: o.checks + 1, lastCheckedAt: now };
  }
  return { ...o, checks: o.checks + 1, lastCheckedAt: now };
}

/**
 * Settle an order against the market's resolution. Every order records the
 * outcome (the adverse-selection comparison needs the UNFILLED ones too); only a
 * filled order books a pnl. Fee as in the paper resolver. Pure.
 */
export function settleShadowOrder(
  o: MakerShadowOrder,
  outcomeYes: 0 | 1,
  exitFeePct: number,
  resolvedAt: number,
): MakerShadowOrder {
  const settled: MakerShadowOrder = { ...o, outcomeYes, resolvedAt };
  if (o.status !== "filled") return settled;
  const sideWon = o.direction === "YES" ? outcomeYes === 1 : outcomeYes === 0;
  const proceeds = sideWon ? o.shares : 0;
  settled.pnl = r6(proceeds - o.notionalUsdc - Math.max(proceeds, o.notionalUsdc) * exitFeePct);
  return settled;
}

/** Keep the most recent `max` orders (resolved history is the asset, so it ages out last). Pure. */
export function capShadowOrders(orders: MakerShadowOrder[], max: number): MakerShadowOrder[] {
  if (orders.length <= max) return orders;
  return [...orders].sort((a, b) => b.placedAt - a.placedAt).slice(0, max);
}

// ─── Summary (the read-out the operator decides B77b on) ────────────────────

export interface ShadowRow {
  targetEdge: number;
  placed: number;
  filled: number;
  fillRate: number;
  fillRateCI: [number, number];          // Wilson 90%
  medianMinutesToFill: number | null;
  resolved: number;                      // orders with a known outcome
  resolvedFilled: number;
  markets: number;                       // distinct markets among resolved fills (the independent unit)
  meanModeledEdge: number | null;        // pSide − limit − fee, resolved fills
  meanReturnPerUsd: number | null;       // realised pnl / notional, market-clustered mean
  returnCI90: [number, number] | null;
  hitRateFilled: number | null;          // P(chosen side won) — filled
  hitRateUnfilled: number | null;        //                     — unfilled
  meanModelHitFilled: number | null;     // mean pSide at placement — filled
  adverseGap: number | null;             // (hitFilled − modelFilled) − (hitUnfilled − modelUnfilled); < 0 = adverse selection
  verdict: "INSUFFICIENT" | "NO_EDGE" | "PROMISING";
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

function wilson(k: number, n: number, z = 1.645): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function median(a: number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Per-ladder-rung read-out. The independent unit is the MARKET, not the order:
 * the rungs of one ladder and the re-placed ladders of one market are the same
 * bet seen several times, so the return CI is taken over per-market means.
 * Verdict: PROMISING needs ≥ `minMarkets` resolved-filled markets AND a positive
 * lower 90% bound on the return AND no adverse-selection gap worse than
 * −`maxAdverse`; fewer markets is INSUFFICIENT, never a verdict. Pure.
 */
export function summarizeShadow(
  orders: readonly MakerShadowOrder[],
  opts: { minMarkets?: number; maxAdverse?: number } = {},
): ShadowRow[] {
  const minMarkets = opts.minMarkets ?? 30;
  const maxAdverse = opts.maxAdverse ?? 0.10;
  const rungs = [...new Set(orders.map((o) => o.targetEdge))].sort((a, b) => a - b);
  return rungs.map((e) => {
    const os = orders.filter((o) => o.targetEdge === e);
    const filled = os.filter((o) => o.status === "filled");
    const resolved = os.filter((o) => o.outcomeYes !== undefined);
    const rf = filled.filter((o) => o.outcomeYes !== undefined && o.pnl !== undefined);
    const won = (o: MakerShadowOrder) => (o.direction === "YES" ? o.outcomeYes === 1 : o.outcomeYes === 0);

    const byMarket = new Map<string, number[]>();
    for (const o of rf) (byMarket.get(o.slug) ?? byMarket.set(o.slug, []).get(o.slug)!).push(o.pnl! / o.notionalUsdc);
    const clusterMeans = [...byMarket.values()].map(mean);
    const m = mean(clusterMeans);
    let ci: [number, number] | null = null;
    if (clusterMeans.length >= 2) {
      const sd = Math.sqrt(clusterMeans.reduce((s, x) => s + (x - m) ** 2, 0) / (clusterMeans.length - 1));
      const se = sd / Math.sqrt(clusterMeans.length);
      ci = [m - 1.645 * se, m + 1.645 * se];
    }

    const resolvedUnfilled = resolved.filter((o) => o.status !== "filled");
    const gap = (set: MakerShadowOrder[]) => (set.length ? mean(set.map((o) => (won(o) ? 1 : 0))) - mean(set.map((o) => o.pSide)) : null);
    const gf = gap(rf), gu = gap(resolvedUnfilled);
    const adverse = gf !== null && gu !== null ? gf - gu : null;

    let verdict: ShadowRow["verdict"] = "INSUFFICIENT";
    if (byMarket.size >= minMarkets) {
      const positive = ci !== null && ci[0] > 0;
      const adverseOk = adverse === null || adverse > -maxAdverse;
      verdict = positive && adverseOk ? "PROMISING" : "NO_EDGE";
    }

    return {
      targetEdge: e,
      placed: os.length,
      filled: filled.length,
      fillRate: os.length ? filled.length / os.length : 0,
      fillRateCI: wilson(filled.length, os.length),
      medianMinutesToFill: median(filled.map((o) => ((o.filledAt ?? o.placedAt) - o.placedAt) / 60_000)),
      resolved: resolved.length,
      resolvedFilled: rf.length,
      markets: byMarket.size,
      meanModeledEdge: rf.length ? mean(rf.map((o) => o.effectiveEdge)) : null,
      meanReturnPerUsd: clusterMeans.length ? m : null,
      returnCI90: ci,
      hitRateFilled: rf.length ? mean(rf.map((o) => (won(o) ? 1 : 0))) : null,
      hitRateUnfilled: resolvedUnfilled.length ? mean(resolvedUnfilled.map((o) => (won(o) ? 1 : 0))) : null,
      meanModelHitFilled: rf.length ? mean(rf.map((o) => o.pSide)) : null,
      adverseGap: adverse,
      verdict,
    };
  });
}
