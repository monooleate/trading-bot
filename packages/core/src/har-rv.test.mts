// netlify/functions/auto-trader/shared/har-rv.test.mts
//
// Regression guard for the #5 HAR-RV volatility engine (pure vol-math).
// Lives under auto-trader/shared/ (never deploys as its own function) and
// imports the REAL module — it's dependency-free, so this pins shipped code.
//
// Run: npx tsx netlify/functions/auto-trader/shared/har-rv.test.mts

import {
  rogersSatchellVar,
  yangZhangVariance,
  harRvSigma,
  type OHLC,
} from "./har-rv.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;
const bar = (open: number, high: number, low: number, close: number): OHLC => ({ open, high, low, close });
const ANNUAL = Math.sqrt(365);

// ── Rogers–Satchell single-bar variance ─────────────────────────────────────
{
  const t = "rogers-satchell";
  // O=100 H=105 L=95 C=102 → RS ≈ 0.005061 (hand-computed).
  const rs = rogersSatchellVar(bar(100, 105, 95, 102));
  expect(approx(rs, 0.005061, 5e-5), t, `RS ≈ 0.005061, got ${rs.toFixed(6)}`);
  // Flat bar (no range) → 0.
  expect(rogersSatchellVar(bar(100, 100, 100, 100)) === 0, t, "flat bar → 0 variance");
  // Invalid (non-positive) → NaN.
  expect(Number.isNaN(rogersSatchellVar(bar(0, 1, 1, 1))), t, "non-positive → NaN");
}

// ── harRvSigma: constant-vol series → σ = √RS·√365, components equal ─────────
{
  const t = "har-constant";
  const bars = Array.from({ length: 25 }, () => bar(100, 103, 97, 101));
  const r = harRvSigma(bars);
  expect(r.ok === true && r.nBars === 25, t, `ok + nBars=25, got ok=${r.ok} n=${r.nBars}`);
  // RS of {100,103,97,101} ≈ 0.0018099 → σ_daily ≈ 0.042543 → σ_annual ≈ 0.8128.
  expect(approx(r.sigmaAnnual, 0.8128, 5e-3), t, `σ_annual ≈ 0.813, got ${r.sigmaAnnual.toFixed(4)}`);
  // Identical bars → all HAR horizons equal.
  expect(approx(r.components.daily, r.components.monthly, 1e-6) && approx(r.components.weekly, r.components.daily, 1e-6),
    t, `components equal, got ${JSON.stringify(r.components)}`);
  // Annualization ratio.
  expect(approx(r.sigmaAnnual / r.sigmaDaily, ANNUAL, 1e-6), t, "σ_annual = σ_daily·√365");
}

// ── harRvSigma: recent vol spike → daily component > monthly ─────────────────
{
  const t = "har-persistence";
  const calm = bar(100, 101, 99, 100);
  const wild = bar(100, 106, 94, 100);
  const bars = [
    ...Array.from({ length: 22 }, () => calm),
    ...Array.from({ length: 5 }, () => wild),
  ];
  const r = harRvSigma(bars);
  expect(r.ok, t, "ok on mixed series");
  // Latest week is all-wild; the 22-day window is mostly calm → daily >> monthly.
  expect(r.components.daily > r.components.monthly, t,
    `daily(${r.components.daily.toFixed(3)}) > monthly(${r.components.monthly.toFixed(3)})`);
  // HAR forecast sits between the calm and wild extremes.
  expect(r.sigmaAnnual > r.components.monthly * 0.9 && r.sigmaAnnual < r.components.daily, t,
    `HAR σ between horizons, got ${r.sigmaAnnual.toFixed(3)}`);
}

// ── harRvSigma: guards ──────────────────────────────────────────────────────
{
  const t = "har-guards";
  expect(harRvSigma([]).ok === false, t, "empty → not ok");
  expect(harRvSigma([bar(100, 101, 99, 100)]).ok === false, t, "1 bar → not ok (need ≥2)");
  // Weight override: all weight on the daily horizon → σ tracks the latest day.
  const bars = [bar(100, 101, 99, 100), bar(100, 101, 99, 100), bar(100, 108, 92, 100)];
  const dOnly = harRvSigma(bars, { d: 1, w: 0, m: 0 });
  expect(approx(dOnly.sigmaAnnual, dOnly.components.daily, 1e-6), t, "d-only weight → σ == daily component");
}

// ── yangZhangVariance ───────────────────────────────────────────────────────
{
  const t = "yang-zhang";
  expect(Number.isNaN(yangZhangVariance([bar(100, 101, 99, 100), bar(100, 101, 99, 100)])), t, "<3 bars → NaN");
  // Crypto-like (open == prev close → ~no overnight gap): positive, finite.
  const bars = [
    bar(100, 103, 98, 101), bar(101, 104, 100, 102),
    bar(102, 103, 99, 100), bar(100, 105, 99, 104), bar(104, 106, 102, 103),
  ];
  const yz = yangZhangVariance(bars);
  expect(Number.isFinite(yz) && yz > 0, t, `YZ finite & positive, got ${yz}`);
  // Annualized YZ σ lands in a sane BTC-ish band.
  const sigmaAnnual = Math.sqrt(yz) * ANNUAL;
  expect(sigmaAnnual > 0.05 && sigmaAnnual < 3, t, `YZ σ_annual sane, got ${sigmaAnnual.toFixed(3)}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("har-rv.test.mts") || entry.endsWith("har-rv.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("har-rv.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`har-rv.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
