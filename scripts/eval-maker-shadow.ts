#!/usr/bin/env bun
// B77 — read-out of the shadow maker orders.
//
// Answers, per ladder rung (target edge): how often does a resting limit fill,
// how fast, and — once the markets resolve — are the FILLS profitable and do
// they avoid adverse selection? It is the evidence B77b (actually resting paper
// orders) waits on. Read-only; run ON THE BOX:
//
//   docker exec edgecalc-workers bun scripts/eval-maker-shadow.ts [--json]
//
// Reading it:
//   · fill rate is a LOWER bound — the model only sees the book once per tick and
//     credits a fill at the limit, never at a better ask (see @core/maker-shadow.mts).
//   · the independent unit is the MARKET, not the order: the rungs of one ladder
//     are the same bet, so the return CI is over per-market means.
//   · adverse gap < 0 means the orders that filled did WORSE against the model
//     than the ones that never filled — the signature of being picked off.
//   · a verdict needs ≥ 30 resolved-filled MARKETS; below that it says INSUFFICIENT
//     and nothing else. That is by design: this stream is slow (a handful of
//     eligible markets a week) and a small sample must not read like a finding.

import { pool } from "@core/db.ts";
import { setBlobsDb } from "@core/blobs-compat.ts";
import { loadShadowOrders } from "@worker/pillars/shared/maker-shadow-store.mts";
import { summarizeShadow } from "@core/maker-shadow.mts";

setBlobsDb(await pool());
const json = process.argv.includes("--json");

const orders = await loadShadowOrders();
const rows = summarizeShadow(orders);

if (json) {
  console.log(JSON.stringify({ orders: orders.length, rows }, null, 2));
  process.exit(0);
}

const pct = (x: number | null, d = 1) => (x === null ? "  —  " : `${(x * 100).toFixed(d)}%`);
if (orders.length === 0) {
  console.log("[eval-maker-shadow] no shadow orders yet.");
  console.log("  Orders appear when a crypto THRESHOLD decision fails only on price (Net edge / Kelly minimum, or the");
  console.log("  book-VWAP edge gate) and the book has room below the ask. That is a handful of markets a week.");
  process.exit(0);
}

const markets = new Set(orders.map((o) => o.slug)).size;
const t = orders.map((o) => o.placedAt).sort((a, b) => a - b);
const days = (t[t.length - 1] - t[0]) / 86_400_000;
const active = orders.filter((o) => o.status === "pending").length;
console.log(`orders=${orders.length} · markets=${markets} · active=${active} · span=${days.toFixed(1)} d · ${new Date(t[0]).toISOString().slice(0, 10)} → ${new Date(t[t.length - 1]).toISOString().slice(0, 10)}`);
console.log(`resolved orders=${orders.filter((o) => o.outcomeYes !== undefined).length}\n`);

console.log("target  placed filled  fill rate [90% CI]      median  resolved-filled mkts  modeled  realised return/$ [90% CI]      hit filled/unfilled  adverse  verdict");
for (const r of rows) {
  const ci = r.returnCI90 ? `[${pct(r.returnCI90[0])}, ${pct(r.returnCI90[1])}]` : "      —      ";
  console.log(
    `${pct(r.targetEdge, 0).padStart(5)}  ${String(r.placed).padStart(6)} ${String(r.filled).padStart(6)}  ` +
    `${pct(r.fillRate).padStart(6)} [${pct(r.fillRateCI[0], 0)}, ${pct(r.fillRateCI[1], 0)}]`.padEnd(24) +
    `${r.medianMinutesToFill === null ? "  —  " : `${r.medianMinutesToFill.toFixed(0)}m`.padStart(6)}  ` +
    `${String(r.resolvedFilled).padStart(6)} ${String(r.markets).padStart(5)}  ` +
    `${pct(r.meanModeledEdge).padStart(7)}  ${pct(r.meanReturnPerUsd).padStart(8)} ${ci.padEnd(22)}  ` +
    `${pct(r.hitRateFilled, 0)}/${pct(r.hitRateUnfilled, 0)}`.padEnd(20) +
    `${r.adverseGap === null ? "  —  " : pct(r.adverseGap)}  ${r.verdict}`,
  );
}

const promising = rows.filter((r) => r.verdict === "PROMISING");
console.log(
  promising.length
    ? `\n→ PROMISING at target edge ${promising.map((r) => pct(r.targetEdge, 0)).join(", ")}: B77b (resting paper orders) is worth building for those rungs.`
    : rows.every((r) => r.verdict === "INSUFFICIENT")
      ? "\n→ INSUFFICIENT everywhere — keep collecting. No decision is supported yet."
      : "\n→ No rung is PROMISING: do not build B77b on this evidence.",
);
process.exit(0);
