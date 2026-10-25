#!/usr/bin/env bun
// B80 — do documented FX risk premia (carry / time-series momentum / value)
// and a mechanised "Spartan" EMA-36 pullback rule survive realistic retail
// costs, out of sample (2013+, after publication)?
//
// Pre-registered in internal-docs/roadmap/sprints.md B80 BEFORE the first run:
// fixed parameters, N = 6 trials (SWITCH added 2026-10-25), verdict on 2013+ only. Do not tune here — a
// changed parameter is a new trial and must be counted in the DSR.
//
// Data (public, no keys):
//   · FRED H.10 daily noon rates, 9 G10 currencies vs USD (1999–);
//   · OECD 3-month interbank rates via FRED (monthly; DECISIONS see the
//     previous month's value, the ACCRUED carry uses the current month's);
//   · Yahoo daily OHLC for the Spartan rule (2004–).
//
// Run LOCALLY:  npx tsx scripts/eval-fx-premia.mts
// Read-only, writes nothing. Touches no box, no DB.

import {
  crossSectionalWeights,
  runPortfolio,
  scaleToVol,
  simulateSpartan,
  returnStats,
  SPARTAN_DEFAULTS,
  type Bar,
  type FxCosts,
} from "@core/fx-backtest.mts";
import { probabilisticSharpe, deflatedSharpe } from "@core/sharpe-robust.mts";

// ── universe ────────────────────────────────────────────────────────────────
const CCY = ["EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK"] as const;
type Ccy = (typeof CCY)[number] | "USD";
const FRED_FX: Record<string, { id: string; usdPerFc: boolean }> = {
  EUR: { id: "DEXUSEU", usdPerFc: true }, JPY: { id: "DEXJPUS", usdPerFc: false },
  GBP: { id: "DEXUSUK", usdPerFc: true }, CHF: { id: "DEXSZUS", usdPerFc: false },
  CAD: { id: "DEXCAUS", usdPerFc: false }, AUD: { id: "DEXUSAL", usdPerFc: true },
  NZD: { id: "DEXUSNZ", usdPerFc: true }, SEK: { id: "DEXSDUS", usdPerFc: false },
  NOK: { id: "DEXNOUS", usdPerFc: false },
};
const OECD_CODE: Record<Ccy, string> = {
  USD: "US", EUR: "EZ", JPY: "JP", GBP: "GB", CHF: "CH", CAD: "CA", AUD: "AU", NZD: "NZ", SEK: "SE", NOK: "NO",
};
// Pre-registered cost per side (half-spread + slippage).
const BASE_COST: Record<string, number> = {
  EUR: 1e-4, JPY: 1e-4, GBP: 1e-4, CHF: 1e-4, CAD: 1e-4, AUD: 1e-4, NZD: 2e-4, SEK: 5e-4, NOK: 5e-4,
};
const BASE_MARKUP = 0.01;
const YAHOO: Array<{ sym: string; base: Ccy; quote: Ccy }> = [
  { sym: "EURUSD=X", base: "EUR", quote: "USD" }, { sym: "JPY=X", base: "USD", quote: "JPY" },
  { sym: "GBPUSD=X", base: "GBP", quote: "USD" }, { sym: "CHF=X", base: "USD", quote: "CHF" },
  { sym: "CAD=X", base: "USD", quote: "CAD" }, { sym: "AUDUSD=X", base: "AUD", quote: "USD" },
  { sym: "NZDUSD=X", base: "NZD", quote: "USD" }, { sym: "SEK=X", base: "USD", quote: "SEK" },
  { sym: "NOK=X", base: "USD", quote: "NOK" },
];
const EVAL_START = "2004-01-01";
const OOS_START = "2013-01-01";
const N_TRIALS = 6; // 5 pre-registered 2026-10-24 + SWITCH 2026-10-25
const SWITCH_COST = 4e-4;

// ── fetch ───────────────────────────────────────────────────────────────────
async function fredSeries(id: string): Promise<Map<string, number>> {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
  if (!res.ok) throw new Error(`FRED ${id}: HTTP ${res.status}`);
  const out = new Map<string, number>();
  for (const line of (await res.text()).trim().split("\n").slice(1)) {
    const [date, v] = line.split(",");
    const x = Number(v);
    if (date && v && v !== "." && Number.isFinite(x) && x !== 0) out.set(date, x);
  }
  return out;
}

async function yahooBars(sym: string): Promise<{ dates: string[]; bars: Bar[] }> {
  // `range=max` silently downgrades to MONTHLY bars — an explicit window keeps them daily.
  const now = Math.floor(Date.now() / 1000);
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=0&period2=${now}&interval=1d`,
    { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${sym}: HTTP ${res.status}`);
  const j = await res.json() as any;
  const r = j.chart.result[0];
  const q = r.indicators.quote[0];
  const off = r.meta.gmtoffset ?? 0;
  const dates: string[] = [];
  const bars: Bar[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if (![o, h, l, c].every((x) => typeof x === "number" && x > 0)) continue;
    const date = new Date((r.timestamp[i] + off) * 1000).toISOString().slice(0, 10);
    if (dates.length && dates[dates.length - 1] === date) continue;
    // Yahoo FX bars occasionally carry a high/low inside the body — widen to the body.
    dates.push(date);
    bars.push({ open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c });
  }
  const gaps = dates.slice(1).map((dt, i) => (Date.parse(dt) - Date.parse(dates[i])) / 86_400_000).sort((a, b) => a - b);
  const medianGap = gaps[gaps.length >> 1];
  if (!(medianGap <= 3)) throw new Error(`Yahoo ${sym}: not daily bars (median gap ${medianGap} days)`);
  return { dates, bars };
}

/** Monthly rate (percent) → value for a YYYY-MM key, forward-filled; NaN before the series starts. */
function monthlyLookup(series: Map<string, number>): (ym: string) => number {
  const keys = [...series.keys()].sort();
  const vals = keys.map((k) => series.get(k)!);
  const yms = keys.map((k) => k.slice(0, 7));
  return (ym: string) => {
    let lo = 0, hi = yms.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (yms[m] <= ym) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? NaN : vals[ans];
  };
}
const prevMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

// ── main ────────────────────────────────────────────────────────────────────
console.log("B80 — FX premia + Spartan, offline. Downloading FRED + Yahoo …");
const fxRaw = await Promise.all(CCY.map((c) => fredSeries(FRED_FX[c].id)));
const rateFns = new Map<Ccy, (ym: string) => number>();
for (const c of [...CCY, "USD"] as Ccy[]) rateFns.set(c, monthlyLookup(await fredSeries(`IR3TIB01${OECD_CODE[c]}M156N`)));
const rate = (c: Ccy, ym: string) => rateFns.get(c)!(ym) / 100;

// Date axis: every FRED business day where EUR quotes; other gaps → 0 return.
const dates = [...fxRaw[0].keys()].sort();
const D = dates.length;
const A = CCY.length;
const price: number[][] = dates.map(() => new Array(A).fill(NaN));
CCY.forEach((c, i) => {
  let last = NaN;
  dates.forEach((dt, d) => {
    const v = fxRaw[i].get(dt);
    if (v !== undefined) last = FRED_FX[c].usdPerFc ? v : 1 / v;
    price[d][i] = last;
  });
});
const spotRet = price.map((row, d) => row.map((p, i) => (d === 0 ? 0 : p / price[d - 1][i] - 1)));
const carryAccrued = dates.map((dt) => CCY.map((c) => rate(c, dt.slice(0, 7)) - rate("USD", dt.slice(0, 7))));
const isMonthEnd = dates.map((dt, d) => d === D - 1 || dates[d + 1].slice(0, 7) !== dt.slice(0, 7));
const excessRet = spotRet.map((row, d) => row.map((s, i) => s + (Number.isFinite(carryAccrued[d][i]) ? carryAccrued[d][i] : 0) / 252));

function costs(costMult: number, markup: number): FxCosts {
  return { tradeCost: CCY.map((c) => BASE_COST[c] * costMult), swapMarkup: markup };
}

// Decision-time carry score: previous month's rate (USD included as the 10th "asset" = cash).
function carryWeights(d: number): number[] {
  const ym = prevMonth(dates[d].slice(0, 7));
  const scores = [...CCY.map((c) => rate(c, ym)), rate("USD", ym)];
  return crossSectionalWeights(scores, 3).slice(0, A);
}
function tsmomWeights(d: number): number[] {
  if (d < 252) return new Array(A).fill(0);
  return CCY.map((_, i) => {
    let cum = 0;
    for (let j = d - 251; j <= d; j++) cum += excessRet[j][i];
    let m = 0;
    for (let j = d - 59; j <= d; j++) m += spotRet[j][i];
    m /= 60;
    let v = 0;
    for (let j = d - 59; j <= d; j++) v += (spotRet[j][i] - m) ** 2;
    const vol = Math.sqrt(v / 59) * Math.sqrt(252);
    return vol > 0 ? Math.sign(cum) * (0.10 / vol) / A : 0;
  });
}
function valueWeights(d: number): number[] {
  if (d < 1260) return new Array(A).fill(0);
  const scores = [...CCY.map((_, i) => -Math.log(price[d][i] / price[d - 1260][i])), 0];
  return crossSectionalWeights(scores, 3).slice(0, A);
}

function runPremia(costMult: number, markup: number) {
  const base = { spotRet, carry: carryAccrued, rebalance: isMonthEnd, costs: costs(costMult, markup) };
  const carry = runPortfolio({ ...base, decide: carryWeights });
  const tsmom = runPortfolio({ ...base, decide: tsmomWeights });
  const value = runPortfolio({ ...base, decide: valueWeights });
  const legs = [carry.ret, tsmom.ret, value.ret].map((r) => scaleToVol(r, 0.10, 252));
  const combo = legs[0].map((_, d) => (legs[0][d] + legs[1][d] + legs[2][d]) / 3);
  // SWITCH (6th trial): next month runs the leg with the best trailing 252-day
  // return; cash when even the best is ≤ 0; each switch costs SWITCH_COST.
  const sw = new Array(D).fill(0);
  let cur = -1;
  let pending = 0;
  for (let d = 0; d < D; d++) {
    sw[d] = (cur >= 0 ? legs[cur][d] : 0) - pending;
    pending = 0;
    if (!isMonthEnd[d] || d < 504) continue;
    const trailing = legs.map((l) => { let s = 0; for (let j = d - 251; j <= d; j++) s += l[j]; return s; });
    const best = trailing.indexOf(Math.max(...trailing));
    const next = trailing[best] > 0 ? best : -1;
    if (next !== cur) pending = SWITCH_COST * costMult;
    cur = next;
  }
  return {
    series: { CARRY: carry.ret, TSMOM: tsmom.ret, VALUE: value.ret, COMBO: combo, SWITCH: sw } as Record<string, number[]>,
    turnover: { CARRY: carry.turnover, TSMOM: tsmom.turnover, VALUE: value.turnover } as Record<string, number>,
  };
}

// Spartan: per-pair simulation on Yahoo bars, summed on the FRED date axis.
const yahoo = await Promise.all(YAHOO.map((y) => yahooBars(y.sym)));
const dateIdx = new Map(dates.map((dt, d) => [dt, d]));
function runSpartan(costMult: number, markup: number) {
  const ret = new Array(D).fill(0);
  const trades: Array<{ pair: string; r: number; date: string }> = [];
  YAHOO.forEach((y, k) => {
    const { dates: yd, bars } = yahoo[k];
    const carryAnn = yd.map((dt) => {
      const ym = dt.slice(0, 7);
      return rate(y.base, ym) - rate(y.quote, ym);
    });
    const fc = y.base === "USD" ? y.quote : y.base;
    const sim = simulateSpartan(bars, carryAnn, BASE_COST[fc] * costMult, markup, SPARTAN_DEFAULTS);
    yd.forEach((dt, j) => {
      // Yahoo days FRED does not quote (rare) roll onto the next FRED day.
      let d = dateIdx.get(dt);
      if (d === undefined) {
        const next = dates.findIndex((x) => x > dt);
        if (next < 0) return;
        d = next;
      }
      ret[d] += sim.ret[j];
    });
    for (const t of sim.trades) trades.push({ pair: y.sym, r: t.r, date: yd[t.signalDay] });
  });
  return { ret, trades };
}

// ── report ──────────────────────────────────────────────────────────────────
const slice = (r: number[], from: string, to = "9999") => r.filter((_, d) => dates[d] >= from && dates[d] < to);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const f2 = (x: number) => x.toFixed(2);

const basePremia = runPremia(1, BASE_MARKUP);
const baseSpartan = runSpartan(1, BASE_MARKUP);
const all: Record<string, number[]> = { ...basePremia.series, SPARTAN: baseSpartan.ret };
const names = Object.keys(all);

console.log(`\nAdat: ${dates[0]} … ${dates[D - 1]} (FRED, ${D} nap); Yahoo-tól ${yahoo.map((y) => y.dates[0]).sort()[0]}`);
console.log(`Alap-költség: oldalanként 1–5 bp, swap-felár ${pct(BASE_MARKUP)}/év a bruttó kitettségen\n`);
console.log("Stratégia  Időszak        Hozam/év  Vol/év  Sharpe  MaxDD@10%vol  PSR(>0)");
const oosSr: Record<string, ReturnType<typeof returnStats>> = {};
for (const n of names) {
  for (const [label, from, to] of [["2004–2012", EVAL_START, OOS_START], ["2013– (OOS)", OOS_START, "9999"]] as const) {
    const s = returnStats(slice(all[n], from, to));
    const ddAt10 = s.annVol > 0 ? s.maxDD * 0.10 / s.annVol : 0;
    const psr = probabilisticSharpe(s.srPeriod, s.n, s.skew, s.kurt);
    if (from === OOS_START) oosSr[n] = s;
    console.log(`${n.padEnd(10)} ${label.padEnd(14)} ${pct(s.annReturn).padStart(8)} ${pct(s.annVol).padStart(7)} ${f2(s.sharpe).padStart(7)} ${pct(ddAt10).padStart(13)} ${f2(psr).padStart(8)}`);
  }
}

// Deflated Sharpe across the N = 5 pre-registered trials, OOS only.
const srs = names.map((n) => oosSr[n].srPeriod);
const mSr = srs.reduce((s, x) => s + x, 0) / srs.length;
const sdSr = Math.sqrt(srs.reduce((s, x) => s + (x - mSr) ** 2, 0) / (srs.length - 1));
console.log(`\nÍtélet (2013–, alap-költség, N=${N_TRIALS} trial; PASS: DSR ≥ 0,95 · ÍGÉRETES: Sharpe ≥ 0,3 és PSR ≥ 0,90):`);
for (const n of names) {
  const s = oosSr[n];
  const psr = probabilisticSharpe(s.srPeriod, s.n, s.skew, s.kurt);
  const dsr = deflatedSharpe(s.srPeriod, s.n, s.skew, s.kurt, N_TRIALS, sdSr);
  const verdict = dsr >= 0.95 ? "PASS" : (s.sharpe >= 0.3 && psr >= 0.9 ? "ÍGÉRETES" : "FAIL");
  console.log(`  ${n.padEnd(8)} Sharpe ${f2(s.sharpe).padStart(5)}  PSR ${f2(psr)}  DSR ${f2(dsr)}  → ${verdict}`);
}

// Controls — a harness is only believable if it can say both "nothing" and "something".
{
  const noCost = { spotRet, carry: carryAccrued, rebalance: isMonthEnd, costs: costs(0, 0) };
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const randomSr = Array.from({ length: 200 }, () =>
    returnStats(slice(runPortfolio({ ...noCost, decide: () => crossSectionalWeights(CCY.map(() => rand()), 3) }).ret, OOS_START)).sharpe);
  const rMean = randomSr.reduce((s, x) => s + x, 0) / randomSr.length;
  const rSd = Math.sqrt(randomSr.reduce((s, x) => s + (x - rMean) ** 2, 0) / (randomSr.length - 1));
  // Positive control: the sign of the NEXT month's excess return (lookahead on purpose).
  const peek = runPortfolio({ ...noCost, decide: (d) => CCY.map((_, i) => {
    let cum = 0;
    for (let j = d + 1; j < Math.min(D, d + 22); j++) cum += excessRet[j][i];
    return Math.sign(cum) / A;
  }) });
  const gross = runPremia(0, 0).series;
  console.log(`\nKontrollok (költség nélkül, Sharpe):`);
  console.log(`  negatív — 200 véletlen top-3/bottom-3, 2013–:   átlag ${f2(rMean)} ± ${f2(rSd)}  (≈ 0 várt; a ± a szerencse-sáv)`);
  console.log(`  pozitív — a következő havi hozam előjele, 2013–: ${f2(returnStats(slice(peek.ret, OOS_START)).sharpe)}  (≫ 1 várt)`);
  console.log(`  irodalom-horgony — bruttó CARRY / TSMOM, 2004–2012: ${f2(returnStats(slice(gross.CARRY, EVAL_START, OOS_START)).sharpe)} / ${f2(returnStats(slice(gross.TSMOM, EVAL_START, OOS_START)).sharpe)}`);
}

// Cost sensitivity (OOS Sharpe).
const MARKUPS = [0, 0.005, 0.01, 0.02, 0.03];
const MULTS = [0, 1, 2];
console.log(`\nKöltség-érzékenység — 2013– Sharpe (sor: költség-szorzó; oszlop: swap-felár/év)`);
for (const n of names) {
  console.log(`  ${n}`);
  console.log(`    ${"".padEnd(6)}${MARKUPS.map((m) => pct(m).padStart(7)).join("")}`);
  for (const k of MULTS) {
    const row = MARKUPS.map((m) => {
      const r = n === "SPARTAN" ? runSpartan(k, m).ret : runPremia(k, m).series[n];
      return f2(returnStats(slice(r, OOS_START)).sharpe).padStart(7);
    });
    console.log(`    ×${String(k).padEnd(5)}${row.join("")}`);
  }
}

// Spartan trade anatomy.
const oosTrades = baseSpartan.trades.filter((t) => t.date >= OOS_START && Number.isFinite(t.r));
const wins = oosTrades.filter((t) => t.r > 0).length;
const avgR = oosTrades.reduce((s, t) => s + t.r, 0) / Math.max(1, oosTrades.length);
console.log(`\nSPARTAN 2013–: ${oosTrades.length} trade, találati arány ${pct(wins / Math.max(1, oosTrades.length))}, átlag ${f2(avgR)}R (ár, költség előtt; 2R célnál a nullpont 33,3%)`);
const yearsOos = returnStats(slice(all.CARRY, OOS_START)).n / 252;
console.log(`Forgalom/év (bruttó súly-változás): ${Object.entries(basePremia.turnover).map(([k, v]) => `${k} ${(v / (D / 252)).toFixed(1)}`).join(" · ")} (OOS ≈ ${yearsOos.toFixed(1)} év)`);
