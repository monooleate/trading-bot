// packages/core/src/devig-eval.test.mts
//
// Regression guard for the offline de-vig validation harness (model-discovery-
// training §3.C / #5 sports, sprints.md B50). Pure, no I/O.
//
// Run: npx tsx packages/core/src/devig-eval.test.mts

import { parseFootballData, scoreDevigMethods, type DevigRecord } from "./devig-eval.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── 1. parseFootballData: closing-odds preference + FTR mapping ──────────────
{
  const t = "parse";
  const csv = [
    "Div,HomeTeam,AwayTeam,FTR,PSH,PSD,PSA,PSCH,PSCD,PSCA",
    "E0,Arsenal,Chelsea,H,2.0,3.4,3.8,1.90,3.50,4.20",   // uses PSC* (closing)
    "E0,Spurs,Leeds,A,1.5,4.0,7.0,1.55,4.10,6.50",
    "E0,Bad,Row,X,1.9,3.5,4.2,1.9,3.5,4.2",              // FTR=X → skipped
    "E0,NoOdds,Row,D,,,,,,",                             // no odds → skipped
  ].join("\n");
  const recs = parseFootballData(csv);
  expect(recs.length === 2, t, `2 valid rows, got ${recs.length}`);
  // first row uses PSC* closing odds, outcome H → index 0
  expect(recs[0].odds[0] === 1.90 && recs[0].outcome === 0, t, `closing odds + H→0, got ${JSON.stringify(recs[0])}`);
  expect(recs[1].outcome === 2, t, `A→2, got ${recs[1].outcome}`);
}

// ── 2. fallback to PS* when PSC* absent ──────────────────────────────────────
{
  const t = "fallback";
  const csv = [
    "FTR,PSH,PSD,PSA",
    "H,2.0,3.4,3.8",
  ].join("\n");
  const recs = parseFootballData(csv);
  expect(recs.length === 1 && recs[0].odds[0] === 2.0, t, `PS* fallback, got ${JSON.stringify(recs[0])}`);
}

// ── 3. scoreDevigMethods: all methods scored, sorted by Brier ────────────────
{
  const t = "score";
  // Build records where the FAVORITE wins most of the time → a de-vig that
  // pulls longshots down (Shin/power) should calibrate at least as well.
  const recs: DevigRecord[] = [];
  for (let i = 0; i < 50; i++) recs.push({ odds: [1.5, 4.0, 7.0], outcome: 0 });  // heavy fav wins
  for (let i = 0; i < 10; i++) recs.push({ odds: [1.5, 4.0, 7.0], outcome: 2 });  // longshot sometimes
  const rows = scoreDevigMethods(recs);
  expect(rows.length === 3, t, `3 methods, got ${rows.length}`);
  expect(rows.every((r) => r.n === 60), t, "all 60 records scored per method");
  expect(rows.every((r) => Number.isFinite(r.brier) && Number.isFinite(r.logLoss)), t, "finite scores");
  // sorted ascending by Brier (best first)
  expect(rows[0].brier <= rows[rows.length - 1].brier, t, "sorted by Brier asc");
}

// ── 4. 2-way records work too (binary market) ────────────────────────────────
{
  const t = "twoway";
  const recs: DevigRecord[] = [
    { odds: [1.8, 2.1], outcome: 0 }, { odds: [1.8, 2.1], outcome: 1 }, { odds: [2.5, 1.55], outcome: 1 },
  ];
  const rows = scoreDevigMethods(recs, ["multiplicative", "shin"]);
  expect(rows.length === 2 && rows.every((r) => r.n === 3), t, "2-way scored");
}

// ── 5. degenerate / empty ────────────────────────────────────────────────────
{
  const t = "empty";
  expect(parseFootballData("").length === 0, t, "empty csv → []");
  expect(parseFootballData("FTR\nH").length === 0, t, "no odds cols → []");
  const rows = scoreDevigMethods([]);
  expect(rows.every((r) => r.n === 0 && !Number.isFinite(r.brier)), t, "no records → NaN scores, n=0");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("devig-eval.test.mts") || entry.endsWith("devig-eval.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("devig-eval.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`devig-eval.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
