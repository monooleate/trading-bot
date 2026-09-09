// services/worker/src/pillars/shared/signal-calibration-pnl.test.mts
//
// Audit P1-5 regression guard (sprints.md B62).
//
// The live calibration store held, for hyperliquid, EIGHT signals all reading
// exactly `{"ic":0,"n":10}` — while the ten HL trades were 6 wins / 4 losses.
// An IC of precisely 0.0 across eight independent signals is not a measurement,
// it is a broken pipe: HlClosedTrade carries `pnlUSDC` and has no `pnl` field,
// computeRealizedICs scores `t.pnl > 0`, and `undefined > 0` is false — so every
// trade was labelled a loss, the outcome vector was constant, and Pearson's
// denominator was zero.
//
// This pins the MEASUREMENT: real HL-shaped trades with mixed outcomes must
// produce a non-zero IC, and an genuinely unmeasurable case must be flagged
// rather than reported as zero skill.
//
// Run: npx tsx services/worker/src/pillars/shared/signal-calibration-pnl.test.mts

import { computeRealizedICs, effectiveICs, type CalibrationRecord } from "./signal-calibration.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// The ten real HL closed trades (payload.pnlUSDC + closeReason from
// pillar_closed_trade on 2026-09-09), with a momentum score that tracks the
// outcome so a working pipe MUST find correlation.
const HL_PNL = [0.14, 0.05, 0.04, -0.07, -0.02, 0.02, -0.09, 0.01, -0.02, 0.01];
const hlTrades = HL_PNL.map((pnlUSDC, i) => ({
  coin: "BTC",
  direction: pnlUSDC > 0 ? "LONG" : "SHORT",
  pnlUSDC,
  pnlPct: pnlUSDC / 3,
  openedAt: `2026-09-0${(i % 5) + 1}T00:00:00Z`,
  closedAt: `2026-09-0${(i % 5) + 1}T06:00:00Z`,
  signalBreakdown: {
    momentum: pnlUSDC > 0 ? 0.62 + i * 0.001 : 0.38 - i * 0.001,
    orderflow: 0.5 + (i % 3) * 0.02,
    cond_prob: 0.5,
  },
}));

// ── 1. THE BUG: the HL shape must not silently score as all-losses ───────────
{
  const t = "hl-pnl-mapping";
  // What the runner used to hand over: spread only, no `pnl` key.
  const broken = hlTrades.map((t2: any) => ({ ...t2, direction: t2.direction === "SHORT" ? "NO" : "YES" }));
  const brokenIcs = computeRealizedICs(broken as any).momentum!;
  expect(brokenIcs.ic === 0, t,
    "sanity: without a pnl mapping the IC collapses to exactly 0 (this is the bug being fixed)");
  expect(brokenIcs.degenerate === true, t,
    "an unmeasurable IC must now be FLAGGED rather than reported as measured zero skill");

  // What the runner hands over after the fix.
  const fixed = broken.map((t2: any) => ({ ...t2, pnl: Number(t2.pnlUSDC ?? 0) }));
  const fixedIcs = computeRealizedICs(fixed as any).momentum!;
  expect(fixedIcs.n === 10, t, `all ten trades should carry a momentum score, got ${fixedIcs.n}`);
  expect(fixedIcs.degenerate !== true, t, "with a real pnl the measurement is possible");
  expect(Math.abs(fixedIcs.ic) > 0.5, t,
    `momentum tracks the outcome by construction, so IC must be strongly non-zero, got ${fixedIcs.ic}`);
  expect(fixedIcs.ic > 0, t, "and positive, since the score rises with the win");
}

// ── 2. A genuinely constant signal is still measurable-but-zero, not degenerate
// Distinguishing these two matters: cond_prob really is pinned at 0.5 in the
// live crypto breakdowns, and that IS a finding. It must not be conflated with
// a broken pnl mapping.
{
  const t = "constant-signal";
  const fixed = hlTrades.map((t2: any) => ({
    ...t2, direction: "YES", pnl: Number(t2.pnlUSDC ?? 0),
  }));
  const ics = computeRealizedICs(fixed as any).cond_prob!;
  expect(ics.degenerate === true, t,
    "a constant SCORE is also unmeasurable (no variance on the score side) and must be flagged");
  expect(ics.ic === 0, t, "…and reported as 0 rather than NaN");
}

// ── 3. Degenerate records must NOT be blended into the live weights ──────────
// This is the part that would have reached trading: `useRealizedIC` shrinks the
// academic prior toward the realised IC. Blending a zero that only means
// "unmeasurable" would have flattened all eight signals toward nothing.
{
  const t = "no-blend-on-degenerate";
  const priors = { momentum: 0.06, orderflow: 0.09, cond_prob: 0.07 };
  const degenerate: CalibrationRecord = {
    category: "hyperliquid",
    computedAt: "2026-09-09T00:00:00Z",
    sampleSize: 10,
    perSignal: {
      momentum:  { ic: 0, n: 10, degenerate: true },
      orderflow: { ic: 0, n: 10, degenerate: true },
      cond_prob: { ic: 0, n: 10, degenerate: true },
    },
  } as any;
  const blended = effectiveICs(priors, degenerate, 30);
  for (const k of Object.keys(priors) as (keyof typeof priors)[]) {
    expect(blended[k] === priors[k], t,
      `a degenerate record must leave the prior for ${k} untouched (${priors[k]} vs ${blended[k]})`);
  }

  // A real measurement still blends, so the guard cannot be used to ignore
  // genuinely bad signals.
  const measured: CalibrationRecord = {
    ...degenerate,
    perSignal: { momentum: { ic: -0.40, n: 10 }, orderflow: { ic: 0.30, n: 10 }, cond_prob: { ic: 0, n: 10 } },
  } as any;
  const realBlend = effectiveICs(priors, measured, 30);
  expect(realBlend.momentum < priors.momentum, t, "a measured negative IC must pull the prior down");
  expect(realBlend.orderflow > priors.orderflow, t, "a measured positive IC must pull the prior up");
  expect(realBlend.cond_prob < priors.cond_prob, t, "a measured (non-degenerate) zero still shrinks the prior");
}

if (failures.length) {
  console.error(`FAIL  signal-calibration-pnl.test.mts — ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  [${f.test}] ${f.message}`);
  process.exit(1);
}
console.log("PASS  signal-calibration-pnl.test.mts");
