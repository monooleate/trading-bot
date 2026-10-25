// packages/core/src/fx-backtest.test.mts
//
// Regression guard for the B80 FX backtest primitives: the no-lookahead
// contract (weights from day t earn day t+1; Spartan fills at the next open),
// cost / carry / swap-markup accounting, and the conservative stop-first rule.
// Pure, no I/O.
//
// Run: npx tsx packages/core/src/fx-backtest.test.mts

import {
  ema,
  atr,
  crossSectionalWeights,
  runPortfolio,
  scaleToVol,
  simulateSpartan,
  returnStats,
  DAYS_PER_YEAR,
  type Bar,
  type SpartanParams,
} from "./fx-backtest.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ── indicators ───────────────────────────────────────────────────────────────
{
  const t = "indicators";
  const e = ema([1, 1, 1, 4], 3); // α = 0.5
  expect(approx(e[3], 2.5), t, `ema last = 2.5, got ${e[3]}`);
  const a = atr([2, 3, 4], [1, 2, 3], [1.5, 2.5, 3.5], 2);
  expect(Number.isNaN(a[0]) && approx(a[1], 1.25) && approx(a[2], 1.5), t, `atr = [NaN,1.25,1.5], got ${a}`);
}

// ── cross-sectional weights ─────────────────────────────────────────────────
{
  const t = "xs-weights";
  const w = crossSectionalWeights([3, NaN, 1, 2, 5], 1);
  expect(w[4] === 1 && w[2] === -1 && w[0] === 0 && w[1] === 0, t, `top/bottom wrong: ${w}`);
  const z = crossSectionalWeights([3, NaN, 1, 2, 5], 3);
  expect(z.every((x) => x === 0), t, `fewer than 2k valid scores must give zeros: ${z}`);
}

// ── portfolio timing: weights from day t earn day t+1, cost charged on t+1 ──
{
  const t = "portfolio-timing";
  const { ret, turnover } = runPortfolio({
    spotRet: [[0], [0.01], [-0.02], [0.03]],
    carry: [[0], [0], [0], [0]],
    rebalance: [true, false, false, false],
    decide: () => [1],
    costs: { tradeCost: [0.001], swapMarkup: 0 },
  });
  expect(approx(ret[0], 0), t, `day 0 must not earn the new weight: ${ret[0]}`);
  expect(approx(ret[1], 0.009), t, `day 1 = +1% − 0.1% cost, got ${ret[1]}`);
  expect(approx(ret[2], -0.02) && approx(ret[3], 0.03), t, `days 2–3 = spot: ${ret}`);
  expect(approx(turnover, 1), t, `turnover 1, got ${turnover}`);
}

// ── no-lookahead control: a decider using data ≤ d cannot see day d+1 ───────
{
  const t = "no-lookahead";
  const D = 50;
  const spot = Array.from({ length: D }, (_, d) => [d === 0 ? 0 : (d % 2 ? 0.01 : -0.01)]);
  const base = { spotRet: spot, carry: spot.map(() => [0]), rebalance: spot.map(() => true),
    costs: { tradeCost: [0], swapMarkup: 0 } };
  // Momentum on an alternating series: always wrong if the engine is honest.
  const honest = runPortfolio({ ...base, decide: (d) => [Math.sign(spot[d][0])] });
  // Positive control: peeking at tomorrow is what wins.
  const peek = runPortfolio({ ...base, decide: (d) => [d + 1 < D ? Math.sign(spot[d + 1][0]) : 0] });
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  expect(sum(honest.ret) < -0.4, t, `honest momentum must lose on alternation, got ${sum(honest.ret)}`);
  expect(sum(peek.ret) > 0.4, t, `peeking control must win, got ${sum(peek.ret)}`);
}

// ── carry accrual and swap markup ───────────────────────────────────────────
{
  const t = "carry-markup";
  const { ret } = runPortfolio({
    spotRet: [[0], [0], [0]],
    carry: [[0.0252], [0.0252], [0.0252]],
    rebalance: [true, false, false],
    decide: () => [-1],
    costs: { tradeCost: [0], swapMarkup: 0.0126 },
  });
  // Short pays the differential AND the markup.
  expect(approx(ret[1], -(0.0252 + 0.0126) / DAYS_PER_YEAR), t, `short carry day = −(2.52%+1.26%)/252, got ${ret[1]}`);
}

// ── ex-ante vol scaling ─────────────────────────────────────────────────────
{
  const t = "scale-to-vol";
  const r = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.01 : -0.01));
  const s = scaleToVol(r, 0.1, 10);
  expect(s.slice(0, 10).every((x) => x === 0), t, `zero before a full lookback`);
  const lev = s[10] / r[10];
  expect(lev > 0 && lev < 1, t, `16% vol series scaled down toward 10%, got lev ${lev}`);
}

// ── Spartan ─────────────────────────────────────────────────────────────────
const P: SpartanParams = { emaLen: 5, slopeLag: 2, atrLen: 3, stopAtr: 0, rr: 2, riskPerTrade: 0.01, maxNotional: 100 };
function rising(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 1 + 0.001 * i;
    return { open: c - 0.0003, high: c + 0.0005, low: c - 0.0005, close: c };
  });
}
/** Bar 20 dips its wick through the EMA and closes green above it → long signal. */
function withSignal(n = 40): Bar[] {
  const b = rising(n);
  const c19 = b[19].close;
  b[20] = { open: c19, high: c19 + 0.0015, low: c19 - 0.05, close: c19 + 0.001 };
  return b;
}
const zeroCarry = (n: number) => new Array(n).fill(0);

{
  const t = "spartan-target";
  const b = withSignal();
  const entry = b[21].open;
  const stop = b[20].low;
  const target = entry + 2 * (entry - stop);
  b[21] = { open: entry, high: target + 0.01, low: entry - 0.0005, close: entry + 0.001 };
  const { ret, trades } = simulateSpartan(b, zeroCarry(b.length), 0.0001, 0, P);
  const tr = trades[0];
  expect(tr !== undefined && tr.signalDay === 20 && tr.exitDay === 21, t, `signal 20, exit 21: ${JSON.stringify(tr)}`);
  expect(tr !== undefined && approx(tr.r, 2, 1e-9), t, `target = +2R, got ${tr?.r}`);
  const notional = Math.min(0.01 / ((entry - stop) / entry), 100);
  expect(approx(ret[21], notional * (target / entry - 1) - 2 * notional * 0.0001), t,
    `day-21 pnl = notional·move − 2 sides of cost, got ${ret[21]}`);
  expect(ret.slice(0, 21).every((x) => x === 0), t, `nothing before the next-open fill`);
}

{
  const t = "spartan-stop-first";
  const b = withSignal();
  const entry = b[21].open;
  b[21] = { open: entry, high: entry + 1, low: b[20].low - 0.01, close: entry };
  const { trades } = simulateSpartan(b, zeroCarry(b.length), 0, 0, P);
  expect(trades[0] !== undefined && approx(trades[0].r, -1), t, `both touched → stop (−1R), got ${trades[0]?.r}`);
}

{
  const t = "spartan-gap";
  const b = withSignal();
  const entry = b[21].open;
  const stop = b[20].low;
  b[21] = { open: entry, high: entry + 0.001, low: entry - 0.001, close: entry };
  b[22] = { open: stop - 0.02, high: stop - 0.01, low: stop - 0.03, close: stop - 0.02 };
  const { trades } = simulateSpartan(b, zeroCarry(b.length), 0, 0, P);
  expect(trades[0] !== undefined && trades[0].exitDay === 22 && trades[0].exit === stop - 0.02 && trades[0].r < -1, t,
    `a gap through the stop fills at the open (< −1R): ${JSON.stringify(trades[0])}`);
}

// ── stats ───────────────────────────────────────────────────────────────────
{
  const t = "stats";
  const s = returnStats([0.01, -0.03, 0.01, 0.02]);
  expect(approx(s.maxDD, 0.03), t, `maxDD 3%, got ${s.maxDD}`);
  expect(approx(s.annReturn, 0.0025 * DAYS_PER_YEAR), t, `annualised mean, got ${s.annReturn}`);
}

const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("fx-backtest.test.mts") || entry.endsWith("fx-backtest.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("fx-backtest.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`fx-backtest.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
