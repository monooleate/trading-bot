// netlify/functions/auto-trader/shared/prediction-ledger.test.mts
//
// Pure-logic regression guard for the prediction ledger (model-discovery §2
// data foundation). Lives under auto-trader/shared/ so a *.test.mts never
// deploys as its own (illegal-named) Netlify function.
//
// Imports the REAL module. `prediction-ledger.mts` statically imports
// @netlify/blobs, but the pure functions under test never call getStore, and
// the blobs package imports cleanly under tsx — so this pins the shipped code.
//
// Run: npx tsx netlify/functions/auto-trader/shared/prediction-ledger.test.mts

import {
  buildIncoming,
  upsertRecords,
  capRecords,
  yesOutcomeFromClosedTrade,
  fillOutcomesFromClosedTrades,
  computeLedgerStats,
  type PredictionRecord,
} from "./prediction-ledger.mts";
import { ledgerPointsFromRecords } from "./walk-forward.mts";
import { computeConfigAttribution } from "./config-fingerprint.mts";
import { banditArmsFromRecords } from "./thompson.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── buildIncoming: maps results + conditionId, drops forecast-less rows ─────
{
  const t = "buildIncoming";
  const results = [
    { market: "btc-above-80k", action: "position_opened", predictedProb: 0.62, marketPrice: 0.50, edge: 0.12, direction: "YES", endDate: "2026-01-02T00:00:00Z", signalBreakdown: { orderflow: 0.6 } },
    { market: "btc-above-82k", action: "skip", reason: "Net edge too low", predictedProb: 0.44, marketPrice: 0.40, direction: "YES", endDate: "2026-01-02T00:00:00Z" },
    { market: "btc-broken", action: "error", error: "boom" }, // no predictedProb → dropped
  ];
  const markets = [
    { slug: "btc-above-80k", conditionId: "0xAAA" },
    { slug: "btc-above-82k", conditionId: "0xBBB" },
  ];
  const inc = buildIncoming(results, markets, "2026-01-01T00:00:00Z");
  expect(inc.length === 2, t, `2 forecast rows (error dropped), got ${inc.length}`);
  const opened = inc.find((i) => i.slug === "btc-above-80k")!;
  expect(opened.taken === true, t, "position_opened → taken=true");
  expect(opened.conditionId === "0xAAA", t, `conditionId mapped, got ${opened.conditionId}`);
  const skipped = inc.find((i) => i.slug === "btc-above-82k")!;
  expect(skipped.taken === false, t, "skip → taken=false");
  expect(skipped.skipReason === "Net edge too low", t, `skipReason captured, got ${skipped.skipReason}`);
  expect(Math.abs(skipped.edge - 0.04) < 1e-9, t, `edge derived when absent, got ${skipped.edge}`);
}

// ── upsertRecords: append new, update existing, bump scans, latch taken ─────
{
  const t = "upsertRecords";
  const inc1 = buildIncoming(
    [{ market: "m1", action: "skip", reason: "r", predictedProb: 0.55, marketPrice: 0.50, direction: "YES", endDate: "2026-01-02T00:00:00Z" }],
    [{ slug: "m1", conditionId: "0x1" }],
    "2026-01-01T00:00:00Z",
  );
  const after1 = upsertRecords([], inc1, "crypto");
  expect(after1.length === 1 && after1[0].scans === 1, t, `new record scans=1, got ${after1[0]?.scans}`);
  expect(after1[0].taken === false, t, "first scan not taken");

  // Second tick: same market, now TAKEN, new prob.
  const inc2 = buildIncoming(
    [{ market: "m1", action: "position_opened", predictedProb: 0.61, marketPrice: 0.50, direction: "YES", endDate: "2026-01-02T00:00:00Z" }],
    [{ slug: "m1", conditionId: "0x1" }],
    "2026-01-01T00:03:00Z",
  );
  const after2 = upsertRecords(after1, inc2, "crypto");
  expect(after2.length === 1, t, `still one record, got ${after2.length}`);
  expect(after2[0].scans === 2, t, `scans bumped to 2, got ${after2[0].scans}`);
  expect(after2[0].firstTs === "2026-01-01T00:00:00Z", t, "firstTs preserved");
  expect(after2[0].ts === "2026-01-01T00:03:00Z", t, "ts updated to latest");
  expect(Math.abs(after2[0].predictedProb - 0.61) < 1e-9, t, "latest prediction wins");
  expect(after2[0].taken === true, t, "taken latched true once opened");

  // Third tick: back to skip — taken must STAY true.
  const inc3 = buildIncoming(
    [{ market: "m1", action: "skip", reason: "cooldown", predictedProb: 0.58, marketPrice: 0.50, direction: "YES", endDate: "2026-01-02T00:00:00Z" }],
    [{ slug: "m1", conditionId: "0x1" }],
    "2026-01-01T00:06:00Z",
  );
  const after3 = upsertRecords(after2, inc3, "crypto");
  expect(after3[0].taken === true, t, "taken stays true after later skip");
  expect(after3[0].scans === 3, t, `scans=3, got ${after3[0].scans}`);
}

// ── capRecords: keep most-recent N by firstTs ───────────────────────────────
{
  const t = "capRecords";
  const mk = (slug: string, firstTs: string): PredictionRecord => ({
    slug, category: "c", firstTs, ts: firstTs, conditionId: null, endDate: null,
    predictedProb: 0.5, marketPrice: 0.5, edge: 0, direction: "YES", taken: false,
    lastAction: "skip", skipReason: null, signalBreakdown: null, scans: 1,
    outcome: null, resolvedAt: null,
  });
  const recs = [
    mk("old", "2026-01-01T00:00:00Z"),
    mk("mid", "2026-01-02T00:00:00Z"),
    mk("new", "2026-01-03T00:00:00Z"),
  ];
  const capped = capRecords(recs, 2);
  expect(capped.length === 2, t, `capped to 2, got ${capped.length}`);
  expect(capped.some((r) => r.slug === "new") && capped.some((r) => r.slug === "mid"), t, "kept newest two");
  expect(!capped.some((r) => r.slug === "old"), t, "dropped oldest");
  expect(capRecords(recs, 5).length === 3, t, "under cap → unchanged");
}

// ── yesOutcomeFromClosedTrade: direction-agnostic YES-resolution ────────────
{
  const t = "yesOutcome";
  expect(yesOutcomeFromClosedTrade({ direction: "YES", pnl: 5 }) === 1, t, "YES win → 1");
  expect(yesOutcomeFromClosedTrade({ direction: "YES", pnl: -5 }) === 0, t, "YES loss → 0");
  expect(yesOutcomeFromClosedTrade({ direction: "NO", pnl: 5 }) === 0, t, "NO win → YES 0");
  expect(yesOutcomeFromClosedTrade({ direction: "NO", pnl: -5 }) === 1, t, "NO loss → YES 1");
  expect(yesOutcomeFromClosedTrade({ direction: "LONG", pnl: 3 }) === 1, t, "LONG win → 1");
  expect(yesOutcomeFromClosedTrade({ direction: "SHORT", pnl: 3 }) === 0, t, "SHORT win → 0");
  expect(yesOutcomeFromClosedTrade({ direction: "YES", pnl: 0 }) === null, t, "pnl 0 → null");
}

// ── fillOutcomesFromClosedTrades: fills taken records, no overwrite ─────────
{
  const t = "fillOutcomes";
  const base: PredictionRecord = {
    slug: "m1", category: "crypto", firstTs: "t0", ts: "t1", conditionId: "0x1",
    endDate: "2026-01-02T00:00:00Z", predictedProb: 0.6, marketPrice: 0.5, edge: 0.1,
    direction: "YES", taken: true, lastAction: "position_opened", skipReason: null,
    signalBreakdown: null, scans: 2, outcome: null, resolvedAt: null,
  };
  const filled = fillOutcomesFromClosedTrades(
    [base, { ...base, slug: "m2", outcome: 1 }],   // m2 already resolved → must not change
    [{ market: "m1", direction: "YES", pnl: 4, closedAt: "2026-01-02T01:00:00Z" }],
    "now",
  );
  const m1 = filled.find((r) => r.slug === "m1")!;
  expect(m1.outcome === 1, t, `m1 filled from closed trade → 1, got ${m1.outcome}`);
  expect(m1.resolvedAt === "2026-01-02T01:00:00Z", t, "resolvedAt from closedAt");
  const m2 = filled.find((r) => r.slug === "m2")!;
  expect(m2.outcome === 1, t, "pre-resolved m2 untouched");
}

// ── computeLedgerStats: unbiased add-on = skipped-resolved ──────────────────
{
  const t = "stats";
  const mk = (slug: string, taken: boolean, outcome: number | null): PredictionRecord => ({
    slug, category: "crypto", firstTs: "2026-01-01T00:00:00Z", ts: "2026-01-01T00:00:00Z",
    conditionId: null, endDate: null, predictedProb: 0.5, marketPrice: 0.5, edge: 0,
    direction: "YES", taken, lastAction: "skip", skipReason: null, signalBreakdown: null,
    scans: 1, outcome, resolvedAt: outcome === null ? null : "r",
  });
  const s = computeLedgerStats("crypto", [
    mk("a", true, 1),     // taken + resolved
    mk("b", false, 0),    // skipped + resolved  ← the unbiased add-on
    mk("c", false, null), // skipped + unresolved
  ]);
  expect(s.total === 3, t, `total 3, got ${s.total}`);
  expect(s.resolved === 2, t, `resolved 2, got ${s.resolved}`);
  expect(s.taken === 1, t, `taken 1, got ${s.taken}`);
  expect(s.skippedResolved === 1, t, `skippedResolved 1, got ${s.skippedResolved}`);
}

// ── bot-shape tolerance: HL `coin`/`pnlUSDC`, weather `traded` action ───────
{
  const t = "bot-shapes";
  // HL rows key on `coin`, no conditionId; weather taken action = "traded".
  const inc = buildIncoming(
    [
      { coin: "BTC", action: "position_opened", predictedProb: 0.58, marketPrice: 0.5, direction: "LONG", edge: 0.16 },
      { market: "hongkong-29c", action: "traded", predictedProb: 0.07, marketPrice: 0.05, direction: "YES", conditionId: "0xW", endDate: "2026-01-02T00:00:00Z" },
      { coin: "ETH", action: "skip", reason: "cooldown" }, // no predictedProb → dropped
    ],
    [],
    "2026-01-01T00:00:00Z",
  );
  expect(inc.length === 2, t, `2 rows (no-prob skip dropped), got ${inc.length}`);
  const btc = inc.find((i) => i.slug === "BTC")!;
  expect(btc && btc.taken === true, t, "HL coin row taken (position_opened)");
  const wx = inc.find((i) => i.slug === "hongkong-29c")!;
  expect(wx.taken === true, t, "weather 'traded' action → taken");
  expect(wx.conditionId === "0xW", t, `weather row conditionId used, got ${wx.conditionId}`);

  // HL closed trades store pnlUSDC + coin.
  expect(yesOutcomeFromClosedTrade({ direction: "LONG", pnlUSDC: 12 }) === 1, t, "HL LONG win via pnlUSDC → 1");
  expect(yesOutcomeFromClosedTrade({ direction: "SHORT", pnlUSDC: -3 }) === 1, t, "HL SHORT loss via pnlUSDC → YES 1");
  const rec = upsertRecords([], inc, "hyperliquid").filter((r) => r.slug === "BTC");
  const filled = fillOutcomesFromClosedTrades(rec, [{ coin: "BTC", direction: "LONG", pnlUSDC: 9, closedAt: "z" }], "now");
  expect(filled[0].outcome === 1, t, `HL outcome filled by coin, got ${filled[0].outcome}`);
}

// ── sports ledger contract (B50 #9 fix): skip rows carry P(YES)+endDate ─────
// Regression guard for the audit finding that sports scan rows lacked
// predictedProb (→ dropped) and endDate (→ reconcile permanently inert). A
// sports skip row shaped as sports/index.mts now emits it must survive
// buildIncoming AND be reconcile-eligible (endDate present, conditionId mapped,
// predictedProb = model P(YES), direction-agnostic).
{
  const t = "sports-ledger";
  const yesProb = Math.max(0, Math.min(1, 0.5 + (0.30 - 0.5) * 0.55)); // yesPrice 0.30 → 0.39
  const inc = buildIncoming(
    [
      { market: "lakers-vs-celtics", league: "NBA", action: "skip", reason: "Net edge too low",
        predictedProb: yesProb, marketPrice: 0.30, endDate: "2026-02-01T00:00:00Z" },
      { market: "psg-vs-city", league: "UCL", action: "traded", direction: "NO",
        predictedProb: 0.61, marketPrice: 0.55, endDate: "2026-02-02T00:00:00Z", edge: 0.06 },
    ],
    [
      { slug: "lakers-vs-celtics", conditionId: "0xSPORTS1" },
      { slug: "psg-vs-city", conditionId: "0xSPORTS2" },
    ],
    "2026-01-15T00:00:00Z",
  );
  expect(inc.length === 2, t, `both sports rows survive (skip NOT dropped), got ${inc.length}`);
  const skip = inc.find((i) => i.slug === "lakers-vs-celtics")!;
  expect(skip.taken === false, t, "sports skip → taken=false");
  expect(skip.endDate === "2026-02-01T00:00:00Z", t, `skip endDate present (reconcile-eligible), got ${skip.endDate}`);
  expect(skip.conditionId === "0xSPORTS1", t, `skip conditionId mapped, got ${skip.conditionId}`);
  expect(Number.isFinite(skip.predictedProb) && skip.predictedProb > 0 && skip.predictedProb < 1, t, `skip predictedProb is finite P(YES), got ${skip.predictedProb}`);
  // Reconcile filter mirror: outcome null + conditionId + past-endDate ⇒ eligible.
  const rec = upsertRecords([], inc, "sports").find((r) => r.slug === "lakers-vs-celtics")!;
  const eligible = rec.outcome === null && !!rec.conditionId && !!rec.endDate && new Date(rec.endDate).getTime() < Date.now();
  expect(eligible, t, "sports skip record is reconcile-eligible after a past endDate");
}


// ── B53: the first-sighting tuple is write-once ─────────────────────────────
//
// Regression guard for the measured 2026-09-08 defect: `predictedProb` /
// `marketPrice` / `configHash` were refreshed on every rescan, so a resolved
// row carried the LAST scan's values. Market prices converge to the outcome
// near expiry, so scoring the model against that price flattered the market
// (17 of 43 resolved weather rows held a stored price > 0.98, 94% of which
// resolved YES) and a config change re-labelled every still-open market
// (3 pre-flip rows vs 214 post-flip → no A/B possible).
{
  const t = "B53 first-sighting latch";
  const mk = (prob: number, price: number, ts: string, cfg: string) =>
    buildIncoming(
      [{ market: "m1", action: "skip", reason: "r", predictedProb: prob, marketPrice: price, direction: "YES", endDate: "2026-01-09T00:00:00Z" }],
      [{ slug: "m1", conditionId: "0x1" }],
      ts, cfg,
    );

  const a = upsertRecords([], mk(0.30, 0.25, "2026-01-01T00:00:00Z", "cfgA"), "crypto");
  expect(a[0].firstPredictedProb === 0.30, t, `first prob latched, got ${a[0].firstPredictedProb}`);
  expect(a[0].firstMarketPrice === 0.25, t, `first price latched, got ${a[0].firstMarketPrice}`);
  expect(a[0].firstConfigHash === "cfgA", t, `first config latched, got ${a[0].firstConfigHash}`);

  // Rescans under a NEW config, price converging toward a YES resolution.
  let rec = a;
  for (const [p, m, ts] of [[0.42, 0.60, "2026-01-05T00:00:00Z"], [0.55, 0.99, "2026-01-08T23:00:00Z"]] as const) {
    rec = upsertRecords(rec, mk(p, m, ts, "cfgB"), "crypto");
  }
  expect(rec[0].scans === 3, t, `scans=3, got ${rec[0].scans}`);
  expect(rec[0].predictedProb === 0.55 && rec[0].marketPrice === 0.99, t, "latest fields still refresh (UI needs them)");
  expect(rec[0].configHash === "cfgB", t, "latest config still refreshes");
  expect(rec[0].firstPredictedProb === 0.30, t, `first prob UNCHANGED, got ${rec[0].firstPredictedProb}`);
  expect(rec[0].firstMarketPrice === 0.25, t, `first price UNCHANGED (not the 0.99 near-expiry price), got ${rec[0].firstMarketPrice}`);
  expect(rec[0].firstConfigHash === "cfgA", t, `first config UNCHANGED (no re-labelling), got ${rec[0].firstConfigHash}`);

  // A pre-B53 record (no first-tuple) back-fills from the values it still
  // holds — the OLDEST available — and stops moving from then on.
  const legacy: PredictionRecord = {
    slug: "m2", category: "crypto", firstTs: "2026-01-01T00:00:00Z", ts: "2026-01-02T00:00:00Z",
    conditionId: "0x2", endDate: "2026-01-09T00:00:00Z",
    predictedProb: 0.20, marketPrice: 0.22, edge: 0.02, direction: "YES",
    taken: false, lastAction: "skip", skipReason: null, signalBreakdown: null,
    scans: 4, outcome: null, resolvedAt: null, configHash: "cfgOld",
  };
  const legacyInc = buildIncoming(
    [{ market: "m2", action: "skip", reason: "r", predictedProb: 0.9, marketPrice: 0.97, direction: "YES", endDate: "2026-01-09T00:00:00Z" }],
    [{ slug: "m2", conditionId: "0x2" }],
    "2026-01-08T00:00:00Z", "cfgNew",
  );
  const back = upsertRecords([legacy], legacyInc, "crypto");
  expect(back[0].firstPredictedProb === 0.20, t, `legacy back-fill uses the PRE-refresh prob, got ${back[0].firstPredictedProb}`);
  expect(back[0].firstMarketPrice === 0.22, t, `legacy back-fill uses the PRE-refresh price, got ${back[0].firstMarketPrice}`);
  expect(back[0].firstConfigHash === "cfgOld", t, `legacy back-fill uses the PRE-refresh config, got ${back[0].firstConfigHash}`);
  const again = upsertRecords(back, buildIncoming(
    [{ market: "m2", action: "skip", reason: "r", predictedProb: 0.95, marketPrice: 0.99, direction: "YES", endDate: "2026-01-09T00:00:00Z" }],
    [{ slug: "m2", conditionId: "0x2" }], "2026-01-08T12:00:00Z", "cfgNewer",
  ), "crypto");
  expect(again[0].firstMarketPrice === 0.22, t, "back-filled first-tuple is then immutable");

  // The consumers must read the first-tuple. This is the whole point: with the
  // last-scan price (0.99) the market looks near-perfect on a YES outcome; with
  // the first-sighting price (0.25) the model (0.30) is the better forecast.
  const resolved = [{ ...rec[0], outcome: 1, resolvedAt: "2026-01-09T00:00:00Z" }];
  const pts = ledgerPointsFromRecords(resolved);
  expect(pts.length === 1, t, `one scorable point, got ${pts.length}`);
  expect(pts[0].marketPrice === 0.25, t, `walk-forward uses the first price, got ${pts[0].marketPrice}`);
  expect(pts[0].predictedProb === 0.30, t, `walk-forward uses the first prob, got ${pts[0].predictedProb}`);

  const attr = computeConfigAttribution(resolved as any[]);
  expect(attr.length === 1 && attr[0].configHash === "cfgA", t,
    `attribution credits the config that MADE the forecast, got ${attr.map((a) => a.configHash).join(",")}`);
  expect(attr[0].brierSkill > 0, t, `model beats the first-sighting price here, got skill ${attr[0].brierSkill}`);

  const arms = banditArmsFromRecords(resolved as any[]);
  expect(arms.length === 1 && arms[0].arm === "cfgA", t,
    `bandit arm keyed on the first config, got ${arms.map((a) => a.arm).join(",")}`);
  expect(arms[0].rewards[0]?.reward === 1, t, "reward: the model beat the first-sighting price");

  // Pre-B53 rows keep working on the latest fields (no data loss, no crash).
  const preB53 = [{
    slug: "old", outcome: 1, resolvedAt: "2026-01-09T00:00:00Z",
    predictedProb: 0.4, marketPrice: 0.5, configHash: "legacy",
  }];
  const oldPts = ledgerPointsFromRecords(preB53 as any[]);
  expect(oldPts.length === 1 && oldPts[0].marketPrice === 0.5, t, "pre-B53 rows fall back to the latest fields");
  expect(computeConfigAttribution(preB53 as any[])[0]?.configHash === "legacy", t, "pre-B53 attribution falls back");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("prediction-ledger.test.mts") || entry.endsWith("prediction-ledger.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("prediction-ledger.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`prediction-ledger.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
