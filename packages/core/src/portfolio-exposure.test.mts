// packages/core/src/portfolio-exposure.test.mts
//
// Regression guard for the crypto-beta exposure cap (model-discovery-expansion
// §4.C / sprints.md B49 #2). Pure, no I/O.
//
// Run: npx tsx packages/core/src/portfolio-exposure.test.mts

import {
  cryptoExposureUsd,
  hlExposureUsd,
  checkBetaCap,
  windowExposureUsd,
  checkResolutionWindowCap,
} from "./portfolio-exposure.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ── 1. crypto exposure = Σ costBasis (ignores non-positive) ──────────────────
{
  const t = "crypto-exposure";
  expect(approx(cryptoExposureUsd([{ costBasis: 20 }, { costBasis: 30 }]), 50), t, "20+30=50");
  expect(approx(cryptoExposureUsd([{ costBasis: 20 }, { costBasis: -5 } as any, { costBasis: 0 }]), 20), t, "ignores ≤0");
  expect(cryptoExposureUsd([]) === 0, t, "empty=0");
}

// ── 2. HL exposure = Σ margin (sizeUSDC / leverage), not notional ─────────────
{
  const t = "hl-exposure";
  // $600 notional @ 3× = $200 margin; $300 @ 1× = $300 → 500
  expect(approx(hlExposureUsd([{ sizeUSDC: 600, leverage: 3 }, { sizeUSDC: 300, leverage: 1 }]), 500), t, "margin sum=500");
  // leverage 0 → treated as 1 (no divide-by-zero)
  expect(approx(hlExposureUsd([{ sizeUSDC: 100, leverage: 0 }]), 100), t, "lev 0 → /1");
  expect(hlExposureUsd([]) === 0, t, "empty=0");
}

// ── 3. cap check: under / at / over ──────────────────────────────────────────
{
  const t = "cap-check";
  // combined bankroll 1000, cap 25% → $250 cap.
  const under = checkBetaCap(100, 100, 1000, 0.25); // projected 200 ≤ 250
  expect(under.allowed === true, t, `under cap allowed (proj ${under.projectedUsd})`);
  expect(approx(under.capUsd, 250), t, `capUsd=250, got ${under.capUsd}`);

  const at = checkBetaCap(150, 100, 1000, 0.25);    // projected 250 == 250
  expect(at.allowed === true, t, "exactly at cap allowed");

  const over = checkBetaCap(200, 100, 1000, 0.25);  // projected 300 > 250
  expect(over.allowed === false, t, `over cap blocked (proj ${over.projectedUsd} > ${over.capUsd})`);
  expect(typeof over.reason === "string" && over.reason.length > 0, t, "reason present when blocked");
  expect(over.utilization > 1, t, `utilization>1 when over, got ${over.utilization}`);
}

// ── 4. fail-open on degenerate input (never brick trading) ───────────────────
{
  const t = "fail-open";
  expect(checkBetaCap(500, 500, 0, 0.25).allowed === true, t, "0 bankroll → allowed (fail-open)");
  expect(checkBetaCap(500, 500, 1000, 0).allowed === true, t, "0 capFraction → allowed (fail-open)");
}

// ── 5. the pathological barbell case the cap is meant to catch ────────────────
{
  const t = "barbell";
  // crypto: 5 slots × 8% of $250 ≈ $100 committed; HL: 3 × ($200×15%) margin ≈ $90.
  // combined bankroll 450, cap 25% → $112.5. Aggregate $190 already blocks a new bet.
  const cryptoUsd = cryptoExposureUsd([{ costBasis: 20 }, { costBasis: 20 }, { costBasis: 20 }, { costBasis: 20 }, { costBasis: 20 }]); // 100
  const hlUsd = hlExposureUsd([{ sizeUSDC: 90, leverage: 3 }, { sizeUSDC: 90, leverage: 3 }, { sizeUSDC: 90, leverage: 3 }]); // 90
  const res = checkBetaCap(cryptoUsd + hlUsd, 15, 450, 0.25); // 190 + 15 vs 112.5
  expect(res.allowed === false, t, `barbell over-exposure blocked (proj ${res.projectedUsd} > ${res.capUsd})`);
}

// ── 6. resolution-window exposure (B38 #3) ───────────────────────────────────
const NOW = Date.parse("2026-10-21T08:00:00Z");
const OCT21 = "2026-10-21T16:00:00Z";
{
  const t = "window-exposure";
  const target = Date.parse(OCT21);
  const pos = [
    { costBasis: 7, endDate: "2026-10-21T16:00:00Z" },   // same print → in
    { costBasis: 5, endDate: "2026-10-22T03:00:00Z" },   // +11h → in (±12h)
    { costBasis: 9, endDate: "2026-10-22T16:00:00Z" },   // +24h → out
    { costBasis: 4, endDate: "2026-10-20T16:00:00Z" },   // already past endDate → out
    { costBasis: 3, endDate: null },                     // unknown → in (conservative)
    { costBasis: 2, endDate: "garbage" },                // unparseable → in
    { costBasis: -1, endDate: OCT21 } as any,            // non-positive ignored
  ];
  expect(approx(windowExposureUsd(pos, target, 12, NOW), 17), t, `7+5+3+2=17, got ${windowExposureUsd(pos, target, 12, NOW)}`);
  expect(approx(windowExposureUsd(pos, target, 1, NOW), 12), t, "±1h → 7+3+2=12");
  expect(windowExposureUsd([], target, 12, NOW) === 0, t, "empty=0");
}

// ── 7. window cap: the 2026-10-21 case (three BTC strikes, one print) ─────────
{
  const t = "window-cap-oct21";
  // crypto bankroll ~$120, cap 12% → $14.40. Two strikes already open ($7.4 + $6.8).
  const open = [{ costBasis: 7.4, endDate: OCT21 }, { costBasis: 6.8, endDate: OCT21 }];
  const third = checkResolutionWindowCap(open, 7.2, OCT21, 120, 0.12, 12, NOW);
  expect(third.allowed === false, t, `third same-day strike blocked (proj ${third.projectedUsd} > ${third.capUsd})`);
  expect(approx(third.currentUsd, 14.2), t, "current = both open strikes");
  expect(typeof third.reason === "string" && third.reason.includes("B38"), t, "reason names B38");
  // the first strike alone fits
  const first = checkResolutionWindowCap([], 7.4, OCT21, 120, 0.12, 12, NOW);
  expect(first.allowed === true, t, "first strike of the day allowed");
  // a different day is a separate window — not blocked by Oct 21 exposure
  const nextDay = checkResolutionWindowCap(open, 7.2, "2026-10-22T16:00:00Z", 120, 0.12, 12, NOW);
  expect(nextDay.allowed === true && nextDay.currentUsd === 0, t, "next-day market has its own window");
  // exactly at the cap is allowed (same epsilon as checkBetaCap)
  const at = checkResolutionWindowCap([{ costBasis: 10, endDate: OCT21 }], 4.4, OCT21, 120, 0.12, 12, NOW);
  expect(at.allowed === true, t, "projected == cap → allowed");
}

// ── 8. window cap fail-open on degenerate input ──────────────────────────────
{
  const t = "window-cap-fail-open";
  const open = [{ costBasis: 500, endDate: OCT21 }];
  expect(checkResolutionWindowCap(open, 50, OCT21, 0, 0.12, 12, NOW).allowed, t, "0 bankroll");
  expect(checkResolutionWindowCap(open, 50, OCT21, 120, 0, 12, NOW).allowed, t, "0 fraction");
  expect(checkResolutionWindowCap(open, 50, OCT21, 120, 0.12, 0, NOW).allowed, t, "0 windowHours");
  expect(checkResolutionWindowCap(open, 50, null, 120, 0.12, 12, NOW).allowed, t, "missing target endDate");
  expect(checkResolutionWindowCap(open, 50, "nope", 120, 0.12, 12, NOW).allowed, t, "unparseable target endDate");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("portfolio-exposure.test.mts") || entry.endsWith("portfolio-exposure.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("portfolio-exposure.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`portfolio-exposure.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
