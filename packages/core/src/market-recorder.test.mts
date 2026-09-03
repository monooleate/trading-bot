// packages/core/src/market-recorder.test.mts
//
// Regression guard for the log-forward recorder pure logic (model-discovery-
// training §3.B / #2, sprints.md B50). Pure, no I/O.
//
// Run: npx tsx packages/core/src/market-recorder.test.mts

import {
  capSnapshots, dueForSnapshot, parseBinanceOiHist, compactBook,
} from "./market-recorder.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── 1. capSnapshots keeps the NEWEST `max` by ts ─────────────────────────────
{
  const t = "cap";
  const recs = [1, 2, 3, 4, 5].map((n) => ({ ts: n, v: n }));
  const capped = capSnapshots(recs, 3);
  expect(capped.length === 3, t, `keeps 3, got ${capped.length}`);
  expect(capped.map((r) => r.ts).join(",") === "3,4,5", t, `drops oldest, got ${capped.map((r) => r.ts)}`);
  // under cap → unchanged reference contents
  expect(capSnapshots(recs, 10).length === 5, t, "under cap keeps all");
  // out-of-order append still drops the oldest
  const messy = [{ ts: 10 }, { ts: 2 }, { ts: 30 }, { ts: 5 }];
  const c2 = capSnapshots(messy, 2);
  expect(c2.map((r) => r.ts).join(",") === "10,30", t, `newest two by ts, got ${c2.map((r) => r.ts)}`);
  expect(capSnapshots(recs, 0).length === 0, t, "cap 0 → empty");
}

// ── 2. dueForSnapshot throttle ───────────────────────────────────────────────
{
  const t = "due";
  expect(dueForSnapshot([], 1000, 500) === true, t, "empty stream is due");
  const recs = [{ ts: 1000 }];
  expect(dueForSnapshot(recs, 1400, 500) === false, t, "within interval → not due");
  expect(dueForSnapshot(recs, 1500, 500) === true, t, "at interval → due");
  expect(dueForSnapshot(recs, 2000, 500) === true, t, "past interval → due");
  // uses the NEWEST record, not the last in array order
  expect(dueForSnapshot([{ ts: 5000 }, { ts: 100 }], 5200, 500) === false, t, "newest wins");
}

// ── 3. parseBinanceOiHist ────────────────────────────────────────────────────
{
  const t = "oi-parse";
  const raw = [
    { sumOpenInterest: "100", sumOpenInterestValue: "5000000", timestamp: 1 },
    { sumOpenInterest: "123.5", sumOpenInterestValue: "6100000", timestamp: 2 },
  ];
  const p = parseBinanceOiHist(raw);
  expect(!!p && p.oi === 123.5 && p.oiValue === 6100000, t, `latest record parsed, got ${JSON.stringify(p)}`);
  expect(parseBinanceOiHist([]) === null, t, "empty → null");
  expect(parseBinanceOiHist(null) === null, t, "null → null");
  expect(parseBinanceOiHist([{ sumOpenInterest: "0", sumOpenInterestValue: "0" }]) === null, t, "zero OI → null");
  // missing value defaults to 0, oi still usable
  const p2 = parseBinanceOiHist([{ sumOpenInterest: "50" }]);
  expect(!!p2 && p2.oi === 50 && p2.oiValue === 0, t, "missing value → 0");
}

// ── 4. compactBook: best-first ordering, topN, filtering ─────────────────────
{
  const t = "book";
  const book = {
    asks: [
      { price: 0.55, size: 100 }, { price: 0.52, size: 50 }, { price: 0.60, size: 10 },
      { price: 0.53, size: 0 },   // zero size → filtered
    ],
    bids: [
      { price: 0.48, size: 20 }, { price: 0.50, size: 80 }, { price: 0.45, size: 5 },
      { price: NaN, size: 10 },   // bad price → filtered
    ],
  };
  const c = compactBook(book, 2);
  // asks ascending (best = lowest price)
  expect(c.asks.length === 2 && c.asks[0][0] === 0.52 && c.asks[1][0] === 0.55, t, `asks best-first topN, got ${JSON.stringify(c.asks)}`);
  // bids descending (best = highest price)
  expect(c.bids.length === 2 && c.bids[0][0] === 0.50 && c.bids[1][0] === 0.48, t, `bids best-first topN, got ${JSON.stringify(c.bids)}`);
  // tuple carries size
  expect(c.asks[0][1] === 50, t, `ask size carried, got ${c.asks[0][1]}`);
  // empty / malformed input → empty sides
  const e = compactBook({ asks: undefined as any, bids: [] });
  expect(e.asks.length === 0 && e.bids.length === 0, t, "malformed → empty");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("market-recorder.test.mts") || entry.endsWith("market-recorder.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("market-recorder.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`market-recorder.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
