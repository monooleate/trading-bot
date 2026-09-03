#!/usr/bin/env bun
// B50 #5 (sports) — offline de-vig validation on real Pinnacle CLOSING lines.
//
// Fetches historical results + Pinnacle closing odds from football-data.co.uk
// (free, keyless) and scores multiplicative / power / Shin de-vig on a
// strictly-proper metric (multiclass Brier + log-loss) against realised outcomes.
// The measure-first evidence for whether Shin is the best-calibrated method on
// OUR data before `sportsUsePinnacle` is trusted. Pure analysis — no DB, prints a
// table, writes nothing. Zero trading impact.
//
// Run (anywhere with network):  bun scripts/eval-devig.ts [season...]
//   season = football-data code like 2324 (2023/24). Default: last 3 seasons.
// Leagues default to the top-5 + English 2nd tier; override via LEAGUES env
//   (comma list of football-data div codes, e.g. E0,SP1,D1,I1,F1).

import { parseFootballData, scoreDevigMethods, type DevigRecord } from "@core/devig-eval.mts";

const LEAGUES = (process.env.LEAGUES ?? "E0,E1,SP1,D1,I1,F1").split(",").map((s) => s.trim()).filter(Boolean);
const seasons = process.argv.slice(2).filter((s) => /^\d{4}$/.test(s));
const SEASONS = seasons.length ? seasons : ["2223", "2324", "2425"];

async function fetchCsv(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "EdgeCalc-DevigEval/1.0" }, signal: AbortSignal.timeout(20_000) });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

const all: DevigRecord[] = [];
const perLeague = new Map<string, DevigRecord[]>();

for (const season of SEASONS) {
  for (const div of LEAGUES) {
    const url = `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`;
    const csv = await fetchCsv(url);
    if (!csv) { console.log(`  · ${season}/${div}: (unavailable)`); continue; }
    const recs = parseFootballData(csv);
    console.log(`  · ${season}/${div}: ${recs.length} matches`);
    all.push(...recs);
    perLeague.set(div, [...(perLeague.get(div) ?? []), ...recs]);
  }
}

const fmt = (rows: ReturnType<typeof scoreDevigMethods>) =>
  rows.map((r) => `${r.method.padEnd(15)} n=${String(r.n).padStart(5)}  Brier=${r.brier}  logLoss=${r.logLoss}`).join("\n    ");

console.log(`\n=== Aggregate (${all.length} matches, ${SEASONS.join("/")}, ${LEAGUES.join(",")}) ===`);
console.log("    " + fmt(scoreDevigMethods(all)));

console.log(`\n=== Per league ===`);
for (const [div, recs] of perLeague) {
  console.log(`  ${div} (${recs.length}):`);
  console.log("    " + fmt(scoreDevigMethods(recs)));
}

console.log(`\nLowest Brier = best-calibrated de-vig on real Pinnacle closing lines.`);
console.log(`Note: Pinnacle closes are near-efficient, so the gap is small by design (the edge`);
console.log(`is the LAG between the Pinnacle truth and the slower Polymarket price, not the de-vig).`);
process.exit(0);
