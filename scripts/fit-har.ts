#!/usr/bin/env bun
// B50 #5 (crypto) — fit + validate HAR-RV coefficients on real Binance klines.
//
// harRvSigma (forecasting #5) blends the 1/5/22-day realized-variance components
// with EQUAL weights. This fetches a long daily-OHLC history, builds the
// Rogers–Satchell realized-variance series, fits the Corsi HAR regression, and
// reports whether the fitted coefficients forecast next-day RV better than equal
// weights and a random walk — the measure-first evidence for whether to wire the
// fitted coefficients into the live vol path. Pure analysis, no DB, writes
// nothing, prints a table. Zero trading impact.
//
// Run (anywhere with network):  bun scripts/fit-har.ts [COIN...]
//   COIN = base symbol, e.g. BTC ETH SOL. Default: BTC ETH SOL.

import { rogersSatchellVar, type OHLC } from "@core/har-rv.mts";
import { fitHarWeights, evaluateHarForecast } from "@core/har-fit.mts";

const coins = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);
const COINS = coins.length ? coins : ["BTC", "ETH", "SOL"];

async function fetchDailyBars(symbol: string): Promise<OHLC[]> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000`,
      { headers: { "User-Agent": "EdgeCalc-HarFit/1.0" }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) return [];
    const raw = (await res.json()) as any[];
    return (Array.isArray(raw) ? raw : []).map((k) => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
  } catch { return []; }
}

for (const coin of COINS) {
  const bars = await fetchDailyBars(`${coin}USDT`);
  if (bars.length < 100) { console.log(`\n${coin}: only ${bars.length} bars — skipped`); continue; }
  const rv = bars.map(rogersSatchellVar).filter((v) => Number.isFinite(v));
  const fit = fitHarWeights(rv);
  const ev = evaluateHarForecast(rv);

  console.log(`\n=== ${coin}USDT (${rv.length} daily RV points) ===`);
  if (!fit.fitted) { console.log("  not enough data to fit"); continue; }
  console.log(`  Fitted Corsi HAR (RV_t = c + βD·RV_d + βW·RV_w + βM·RV_m):`);
  console.log(`    c=${fit.c.toExponential(3)}  βD=${fit.betaD.toFixed(3)}  βW=${fit.betaW.toFixed(3)}  βM=${fit.betaM.toFixed(3)}  R²=${fit.r2.toFixed(3)}  n=${fit.n}`);
  console.log(`  Out-of-sample next-day RV forecast MSE (n=${ev.n}):`);
  console.log(`    fitted=${ev.fittedMse}   equal-weight=${ev.equalMse}   random-walk=${ev.rwMse}`);
  console.log(`    fitted beats equal-weight: ${ev.fittedBeatsEqual}   beats random-walk: ${ev.fittedBeatsRw}`);
}

console.log(`\nNote: a low R² and a small fitted-vs-equal gap are EXPECTED — daily RV is`);
console.log(`hard to forecast. Wire fitted coefficients into the live vol path only if the`);
console.log(`OOS gap is consistently positive across coins (measure-first; anti-overfit).`);
process.exit(0);
