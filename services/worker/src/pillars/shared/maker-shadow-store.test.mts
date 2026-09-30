// services/worker/src/pillars/shared/maker-shadow-store.test.mts
//
// Wiring test for the shadow maker recorder (B77): placement, per-tick
// observation and settlement against a STUBBED CLOB book + Gamma, with no
// database. The pure model is pinned in packages/core/src/maker-shadow.test.mts;
// this proves the recorder drives it correctly and never throws into a tick.
//
// Run: npx tsx services/worker/src/pillars/shared/maker-shadow-store.test.mts

import {
  placeShadowLadder,
  processShadowOrders,
  isMakerShadowEligible,
  hasRecentLadder,
  type ShadowPlan,
} from "./maker-shadow-store.mts";
import type { MakerShadowOrder } from "@core/maker-shadow.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── stub network ─────────────────────────────────────────────────────────────
let book: { asks: { price: string; size: string }[]; bids: { price: string; size: string }[] } | null = {
  asks: [{ price: "0.92", size: "500" }, { price: "0.95", size: "800" }],
  bids: [{ price: "0.70", size: "300" }],
};
let gammaYes: 0 | 1 | null = null;
let throwAll = false;
const calls = { book: 0, gamma: 0 };
(globalThis as any).fetch = async (url: string) => {
  if (throwAll) throw new Error("network down");
  const u = String(url);
  if (u.includes("/book")) {
    calls.book++;
    if (!book) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => book };
  }
  if (u.includes("/markets")) {
    calls.gamma++;
    if (gammaYes === null) return { ok: true, json: async () => [{ closed: false, outcomePrices: '["0.5","0.5"]' }] };
    return { ok: true, json: async () => [{ closed: true, outcomePrices: gammaYes === 1 ? '["1","0"]' : '["0","1"]' }] };
  }
  return { ok: false, json: async () => ({}) };
};

const NOW = Date.parse("2026-09-30T12:00:00Z");
const plan = (over: Partial<ShadowPlan> = {}): ShadowPlan => ({
  slug: "bitcoin-above-80k-on-september-30-2026", conditionId: "0xc1", tokenId: "tokYES", direction: "YES",
  endDate: "2026-09-30T20:00:00Z", pYes: 0.95, quotedSidePrice: 0.75, exitFeePct: 0.015, ...over,
});

// ── eligibility: only price-dependent gate failures ─────────────────────────
{
  const t = "eligibility";
  const g = (label: string, passed: boolean) => ({ label, passed });
  expect(isMakerShadowEligible([g("Net edge ≥ küszöb", false), g("Kelly méret ≥ minimum", false), g("Combiner confidence (|p − 0.5|)", true)]), t, "edge + Kelly-minimum failing only → eligible");
  expect(isMakerShadowEligible([g("Net edge ≥ küszöb", false)]), t, "edge alone → eligible");
  expect(!isMakerShadowEligible([g("Net edge ≥ küszöb", false), g("Resolution-risk gate", false)]), t, "a non-price gate also failing → not eligible");
  expect(!isMakerShadowEligible([g("Sanity cap (gross edge ≤ cap)", false)]), t, "the sanity cap (model error) is not a price question");
  expect(!isMakerShadowEligible([g("Net edge ≥ küszöb", true)]), t, "nothing failed → not this hook (the exec-gate branch handles it)");
  expect(!isMakerShadowEligible([]), t, "no gates → not eligible");
}

// ── placement: a ladder, once ────────────────────────────────────────────────
const orders: MakerShadowOrder[] = [];
{
  const t = "place";
  const n = await placeShadowLadder(orders, plan(), NOW);
  expect(n === 3 && orders.length === 3, t, `three rungs placed, got ${n}/${orders.length}`);
  expect(orders.every((o) => o.status === "pending" && o.tokenId === "tokYES"), t, "pending on the chosen token");
  expect(orders.map((o) => o.limit).join() === "0.88,0.83,0.78", t, `limits, got ${orders.map((o) => o.limit).join()}`);
  const before = calls.book;
  expect(await placeShadowLadder(orders, plan(), NOW + 60_000) === 0 && calls.book === before, t, "a live ladder blocks a second one WITHOUT another book fetch");
  expect(hasRecentLadder(orders, plan().slug, "YES", NOW + 3600_000) && !hasRecentLadder(orders, plan().slug, "NO", NOW), t, "recency is per (market, side)");
}

// ── no book → nothing recorded, and not re-fetched every tick ────────────────
{
  const t = "no-book";
  book = null;
  const o2: MakerShadowOrder[] = [];
  const b0 = calls.book;
  expect(await placeShadowLadder(o2, plan({ slug: "other-market" }), NOW) === 0 && o2.length === 0, t, "no book → no orders");
  await placeShadowLadder(o2, plan({ slug: "other-market" }), NOW + 60_000);
  expect(calls.book === b0 + 1, t, `the empty result is cached — one fetch for two attempts, got ${calls.book - b0}`);
  book = { asks: [{ price: "0.92", size: "500" }], bids: [{ price: "0.70", size: "300" }] };
}

// ── observation: fills only on a crossing ask ────────────────────────────────
{
  const t = "observe";
  let r = await processShadowOrders(orders, 0.015, NOW + 180_000);
  expect(r.filled === 0 && r.orders.every((o) => o.status === "pending"), t, "ask 0.92 above every limit: nothing fills");
  expect(r.orders.every((o) => o.checks === 1), t, "…but each order was observed once");
  book = { asks: [{ price: "0.80", size: "50" }], bids: [{ price: "0.70", size: "300" }] };
  r = await processShadowOrders(r.orders, 0.015, NOW + 360_000);
  const byLimit = new Map(r.orders.map((o) => [o.limit, o.status]));
  expect(byLimit.get(0.88) === "filled" && byLimit.get(0.83) === "filled" && byLimit.get(0.78) === "pending", t,
    `an ask of 0.80 fills the 0.88 and 0.83 limits but not 0.78, got ${JSON.stringify([...byLimit])}`);
  expect(r.filled === 2 && r.changed, t, "counts fills");
  orders.splice(0, orders.length, ...r.orders);
}

// ── settlement: every order gets the outcome, filled ones a pnl ──────────────
{
  const t = "settle";
  gammaYes = null;
  let r = await processShadowOrders(orders, 0.015, Date.parse("2026-09-30T21:00:00Z"));
  expect(r.settled === 0, t, "Gamma says unresolved → nothing settled");
  gammaYes = 1;
  const g0 = calls.gamma;
  r = await processShadowOrders(r.orders, 0.015, Date.parse("2026-09-30T21:00:00Z"));
  expect(r.settled === 3 && calls.gamma === g0 + 1, t, `one Gamma lookup settles all 3 orders of the market, got ${r.settled} / ${calls.gamma - g0} lookups`);
  const f = r.orders.filter((o) => o.status === "filled");
  expect(f.length === 2 && f.every((o) => typeof o.pnl === "number" && o.pnl > 0), t, "filled YES orders on a YES resolution book a profit");
  const u = r.orders.filter((o) => o.status !== "filled");
  expect(u.length === 1 && u[0].outcomeYes === 1 && u[0].pnl === undefined, t, "the unfilled order records the outcome and no pnl");
  expect(u[0].status === "expired", t, `a pending order past its expiry is expired, got ${u[0].status}`);
}

// ── resilience: a dead network never throws into the tick ────────────────────
{
  const t = "resilience";
  throwAll = true;
  const o3: MakerShadowOrder[] = [];
  let threw = false;
  try {
    await placeShadowLadder(o3, plan({ slug: "third" }), NOW);
    const r = await processShadowOrders([{ ...orders[0], status: "pending", outcomeYes: undefined, expiresAt: NOW + 1e9 }], 0.015, NOW);
    expect(r.orders.length === 1 && r.orders[0].status === "pending", t, "a failed book fetch leaves the order pending");
  } catch { threw = true; }
  expect(!threw, t, "network failure must not throw");
  throwAll = false;
}

const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("maker-shadow-store.test.mts") || entry.endsWith("maker-shadow-store.test.js");
  } catch { return false; }
})();
if (isMain) {
  if (failures.length === 0) { console.log("maker-shadow-store.test: all checks passed"); process.exit(0); }
  console.log(`maker-shadow-store.test: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
  process.exit(1);
}
export { failures };
