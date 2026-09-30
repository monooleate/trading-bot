// packages/core/src/maker-shadow.test.mts
//
// Regression guard for the shadow maker orders (B77). Pure, no I/O.
// Run: npx tsx packages/core/src/maker-shadow.test.mts

import {
  planMakerLadder,
  observeShadowOrder,
  settleShadowOrder,
  capShadowOrders,
  summarizeShadow,
  defaultTick,
  type MakerShadowOrder,
  type PlanInput,
} from "./maker-shadow.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const NOW = Date.parse("2026-09-30T12:00:00Z");
const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
  slug: "bitcoin-above-80k-on-september-30-2026", conditionId: "0xc", tokenId: "tokYES", direction: "YES",
  endDate: "2026-09-30T20:00:00Z", pYes: 0.95, quotedSidePrice: 0.75, book: { bestBid: 0.70, bestAsk: 0.92 },
  exitFeePct: 0.015, ladder: [0.05, 0.10, 0.15], notionalUsdc: 10, ttlMs: 2 * 3600_000, now: NOW, ...over,
});

// ── ladder prices ────────────────────────────────────────────────────────────
{
  const t = "ladder";
  const o = planMakerLadder(plan());
  expect(o.length === 3, t, `three rungs, got ${o.length}`);
  // maxPrice = 0.95 − e − 0.015 → 0.885 / 0.835 / 0.785, all under ask − tick (0.91) → snapped down.
  expect(o.map((x) => x.limit).join() === "0.88,0.83,0.78", t, `limits, got ${o.map((x) => x.limit).join()}`);
  expect(approx(o[0].effectiveEdge, 0.95 - 0.88 - 0.015), t, `effective edge of rung 1, got ${o[0].effectiveEdge}`);
  expect(o.every((x) => x.effectiveEdge >= x.targetEdge - 1e-9), t, "snapping down never LOWERS the edge below its target");
  expect(approx(o[0].shares, 10 / 0.88, 1e-4), t, `shares = notional / limit, got ${o[0].shares}`);
  expect(o.every((x) => x.status === "pending" && x.checks === 0), t, "starts pending");
  expect(defaultTick(0.02) === 0.001 && defaultTick(0.5) === 0.01 && defaultTick(0.98) === 0.001, t, "tick grid");
}

// ── NO side prices the NO token ──────────────────────────────────────────────
{
  const t = "no-side";
  const o = planMakerLadder(plan({ direction: "NO", tokenId: "tokNO", pYes: 0.10, book: { bestBid: 0.40, bestAsk: 0.60 } }));
  // pSide = 0.90; maxPrice 0.835 / 0.785 / 0.735 — the first two are ≥ the 0.60 ask → marketable, skipped.
  expect(o.length === 3 === false, t, "marketable rungs are not recorded");
  expect(o.length === 0, t, `all rungs marketable at ask 0.60, got ${o.length}`);
  const o2 = planMakerLadder(plan({ direction: "NO", tokenId: "tokNO", pYes: 0.10, book: { bestBid: 0.40, bestAsk: 0.95 } }));
  expect(o2.length === 3 && o2[0].tokenId === "tokNO" && approx(o2[0].pSide, 0.90), t, "NO side: pSide = 1 − pYes on the NO token");
}

// ── marketable rungs are skipped, duplicates collapse ───────────────────────
{
  const t = "marketable-and-dupes";
  const o = planMakerLadder(plan({ book: { bestBid: 0.70, bestAsk: 0.80 } }));
  expect(o.length === 1 && o[0].targetEdge === 0.15 && o[0].limit === 0.78, t,
    `only the 15% rung is below a 0.80 ask, got ${JSON.stringify(o.map((x) => [x.targetEdge, x.limit]))}`);
  // Two rungs whose max prices both sit above ask − tick snap to the same limit → one order.
  const d = planMakerLadder(plan({ pYes: 0.96, ladder: [0.05, 0.055], book: { bestBid: 0.7, bestAsk: 0.90 } }));
  expect(d.length === 1 && d[0].limit === 0.89, t, `duplicate limits collapse, got ${JSON.stringify(d.map((x) => x.limit))}`);
  expect(planMakerLadder(plan({ pYes: 0.06 })).length === 0, t, "the edge cannot be met even at a zero price → no orders");
  expect(planMakerLadder(plan({ pYes: 0.05 })).length === 0, t, "a side the model disfavours gets no order");
}

// ── expiry: ttl, and the market end minus 10 minutes ────────────────────────
{
  const t = "expiry";
  const a = planMakerLadder(plan())[0];
  expect(a.expiresAt === NOW + 2 * 3600_000, t, "ttl applies when the market ends later");
  const b = planMakerLadder(plan({ endDate: "2026-09-30T12:50:00Z" }))[0];
  expect(b.expiresAt === Date.parse("2026-09-30T12:40:00Z"), t, `capped at end − 10 min, got ${new Date(b.expiresAt).toISOString()}`);
  expect(planMakerLadder(plan({ endDate: "2026-09-30T12:05:00Z" })).length === 0, t, "a market ending in <10 min gets no order");
}

// ── fills: trade-through only, at the LIMIT, never after expiry ─────────────
{
  const t = "fill";
  const o = planMakerLadder(plan())[0];             // limit 0.88
  const still = observeShadowOrder(o, 0.90, NOW + 180_000);
  expect(still.status === "pending" && still.checks === 1, t, "ask above the limit: no fill, one check");
  const touch = observeShadowOrder(still, 0.88, NOW + 360_000);
  expect(touch.status === "filled" && touch.filledAt === NOW + 360_000, t, "ask AT the limit fills (a seller is willing at our price)");
  const through = observeShadowOrder(still, 0.60, NOW + 360_000);
  expect(through.status === "filled" && through.fillAsk === 0.60 && through.limit === 0.88, t, "a much lower ask fills, but the order keeps ITS limit price");
  expect(observeShadowOrder(o, null, NOW + 60_000).status === "pending", t, "no visible ask: aged, not filled");
  // Positive control for the expiry rule: the SAME crossing ask fills before expiry and not after.
  const late = observeShadowOrder(o, 0.60, o.expiresAt + 1);
  expect(late.status === "expired" && late.filledAt === undefined, t, "a late observation cannot manufacture a fill");
  expect(observeShadowOrder(o, 0.60, o.expiresAt).status === "filled", t, "…while the same ask AT expiry still fills");
  expect(observeShadowOrder(touch, 0.50, NOW + 999_000) === touch, t, "terminal orders are untouched");
}

// ── settlement: mirrors the paper resolver's fee ────────────────────────────
{
  const t = "settle";
  const filled = (dir: "YES" | "NO", limit: number): MakerShadowOrder => ({
    ...planMakerLadder(plan({ direction: dir, pYes: dir === "YES" ? 0.95 : 0.05, book: { bestBid: 0.5, bestAsk: 0.99 } }))[0],
    limit, shares: 10 / limit, status: "filled",
  });
  const win = settleShadowOrder(filled("YES", 0.80), 1, 0.015, NOW);
  expect(approx(win.pnl!, 12.5 - 10 - 12.5 * 0.015), t, `YES win pnl, got ${win.pnl}`);
  const loss = settleShadowOrder(filled("YES", 0.80), 0, 0.015, NOW);
  expect(approx(loss.pnl!, -10 - 10 * 0.015), t, `YES loss pnl, got ${loss.pnl}`);
  const noWin = settleShadowOrder(filled("NO", 0.80), 0, 0.015, NOW);
  expect(approx(noWin.pnl!, 12.5 - 10 - 12.5 * 0.015), t, `NO wins when YES resolves 0, got ${noWin.pnl}`);
  const unfilled = settleShadowOrder(planMakerLadder(plan())[0], 1, 0.015, NOW);
  expect(unfilled.pnl === undefined && unfilled.outcomeYes === 1, t, "an unfilled order records the outcome and books no pnl");
}

// ── cap keeps the newest ─────────────────────────────────────────────────────
{
  const t = "cap";
  const os = [1, 2, 3, 4].map((i) => ({ ...planMakerLadder(plan({ now: NOW + i * 1000 }))[0] }));
  const kept = capShadowOrders(os, 2);
  expect(kept.length === 2 && kept.every((o) => o.placedAt >= NOW + 3000), t, "newest two kept");
}

// ── summary: clustering, verdict rules, adverse selection ───────────────────
{
  const t = "summary";
  const base = planMakerLadder(plan({ ladder: [0.10] }))[0];   // limit 0.83
  const mk = (slug: string, status: MakerShadowOrder["status"], won: boolean, pSide = 0.95): MakerShadowOrder => {
    const o: MakerShadowOrder = { ...base, id: slug + status + won, slug, status, pSide, direction: "YES" };
    if (status === "filled") o.filledAt = base.placedAt + 600_000;
    return settleShadowOrder(o, won ? 1 : 0, 0.015, NOW + 1);
  };
  const marketsOf = (n: number, wins: number, status: MakerShadowOrder["status"] = "filled") =>
    Array.from({ length: n }, (_, i) => mk(`m${i}`, status, i < wins));

  const good = summarizeShadow(marketsOf(40, 38))[0];
  expect(good.verdict === "PROMISING" && good.markets === 40 && good.meanReturnPerUsd! > 0.05, t,
    `38/40 wins at 0.83 is PROMISING, got ${good.verdict} ${good.meanReturnPerUsd}`);
  expect(good.fillRate === 1 && good.resolvedFilled === 40, t, "fill rate and counts");

  const bad = summarizeShadow(marketsOf(40, 20))[0];
  expect(bad.verdict === "NO_EDGE" && bad.meanReturnPerUsd! < 0, t, `coin-flip wins at 0.83 lose money, got ${bad.verdict}`);

  const thin = summarizeShadow(marketsOf(10, 10))[0];
  expect(thin.verdict === "INSUFFICIENT", t, "10 winning markets are still INSUFFICIENT — never a verdict on a small sample");

  // The independent unit is the market: 5 orders on ONE market are one cluster.
  const one = summarizeShadow(Array.from({ length: 5 }, (_, i) => ({ ...mk("same", "filled", true), id: "s" + i })))[0];
  expect(one.markets === 1 && one.resolvedFilled === 5 && one.verdict === "INSUFFICIENT", t, "many orders on one market count as one market");

  // Adverse selection: filled orders do WORSE vs the model than unfilled ones, even though the return CI is positive.
  const filled = marketsOf(200, 180, "filled");                                   // hit 0.90 vs pSide 0.95
  const unfilled = Array.from({ length: 200 }, (_, i) => mk(`u${i}`, "expired", true, 0.90));   // hit 1.0 vs 0.90
  const adv = summarizeShadow([...filled, ...unfilled])[0];
  expect(adv.returnCI90![0] > 0, t, `precondition: the return CI alone is positive, got ${adv.returnCI90}`);
  expect(adv.adverseGap! < -0.10 && adv.verdict === "NO_EDGE", t,
    `adverse-selection gap must veto, got gap ${adv.adverseGap} verdict ${adv.verdict}`);
  const clean = summarizeShadow([...filled])[0];
  expect(clean.verdict === "PROMISING", t, "positive control: the same filled orders WITHOUT the better unfilled ones are PROMISING");

  const rate = summarizeShadow([...marketsOf(3, 3), ...marketsOf(7, 0, "expired")])[0];
  expect(approx(rate.fillRate, 0.3) && rate.fillRateCI[0] < 0.3 && rate.fillRateCI[1] > 0.3, t, "Wilson interval brackets the rate");
  expect(rate.medianMinutesToFill === 10, t, `median minutes to fill, got ${rate.medianMinutesToFill}`);
}

const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("maker-shadow.test.mts") || entry.endsWith("maker-shadow.test.js");
  } catch { return false; }
})();
if (isMain) {
  if (failures.length === 0) { console.log("maker-shadow.test: all checks passed"); process.exit(0); }
  console.log(`maker-shadow.test: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
  process.exit(1);
}
export { failures };
