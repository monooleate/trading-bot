// netlify/functions/auto-trader/shared/p0-profitability-fixes.test.mts
//
// Regression guards for the post-2026-07 profitability audit P0 fixes:
//
//   1. resumeSession / resumeHlSession now RESET the monotonic gross-loss
//      odometer (`sessionLoss`) so an explicit operator resume is a real,
//      history-preserving unbrick — a session stopped on "Session loss limit
//      reached" no longer re-stops on the next tick (sessionLoss still ≥ limit,
//      knob max $1000 < the $1033 gross loss that bricked crypto at +$690 net).
//
//   2. signal-combiner combine() clamps the combined probability to (0,1) and
//      guards the weight denominator against sign-cancellation, so enabling
//      realized-IC (which can give a signal a NEGATIVE effective IC) can no
//      longer push `combined` out of [0,1] and corrupt Kelly's `b = 1/p − 1`.
//      The finalization math is MIRRORED here (like signal-combiner-threshold
//      .test.mts mirrors the slug parser) to avoid importing the Netlify-only
//      module; it MUST stay in sync with combine() in signal-combiner.mts.
//
// Run: npx tsx netlify/functions/auto-trader/shared/p0-profitability-fixes.test.mts

import { resumeSession }   from "../crypto/session-manager.mts";
import { resumeHlSession } from "../hyperliquid/session-manager.mts";
import type { SessionState } from "./types.mts";
import type { HlSessionState } from "../hyperliquid/types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── 1a. Crypto resumeSession clears the gross-loss odometer ─────────────────
{
  const t = "resumeSession[crypto]";
  // The exact live pathology: +$690 net but stopped on the loss limit because
  // the GROSS loss ($1033) crossed it. Resume must zero sessionLoss AND keep
  // the 37-trade record + IC calibration.
  const stopped: SessionState = {
    startedAt:        "2026-07-01T00:00:00Z",
    bankrollStart:    350,
    bankrollCurrent:  1040.07,
    sessionPnL:       690.07,
    sessionLoss:      1033.42,
    tradeCount:       37,
    openPositions:    [],
    closedTrades:     Array.from({ length: 37 }, (_, i) => ({ market: `m${i}`, pnl: 0 } as any)),
    paperMode:        true,
    stopped:          true,
    stoppedReason:    "Session loss limit reached",
    simVersion:       3,
    calibrationAlertSentAt: "2026-07-05T00:00:00Z",
  };

  const after = resumeSession(stopped);

  expect(after.sessionLoss === 0, t, `sessionLoss MUST reset to 0 (was 1033.42), got ${after.sessionLoss}`);
  expect(after.stopped === false, t, `stopped MUST clear, got ${after.stopped}`);
  expect(after.stoppedReason === null, t, `stoppedReason MUST clear, got ${after.stoppedReason}`);
  // History + net PnL + bankroll preserved (this is the whole point vs reset).
  expect(after.sessionPnL === 690.07, t, `sessionPnL preserved, got ${after.sessionPnL}`);
  expect(after.tradeCount === 37, t, `tradeCount preserved, got ${after.tradeCount}`);
  expect(after.closedTrades.length === 37, t, `closedTrades preserved, got ${after.closedTrades.length}`);
  expect(after.bankrollCurrent === 1040.07, t, `bankrollCurrent preserved, got ${after.bankrollCurrent}`);
  expect(after.startedAt === "2026-07-01T00:00:00Z", t, `startedAt preserved, got ${after.startedAt}`);
  expect(after.calibrationAlertSentAt === null, t, `calibration alarm re-armed, got ${after.calibrationAlertSentAt}`);
}

// ── 1b. HL resumeHlSession clears sessionLoss + consecutive-loss state ──────
{
  const t = "resumeHlSession";
  const stopped: HlSessionState = {
    startedAt:         "2026-07-01T00:00:00Z",
    paperMode:         true,
    bankrollStart:     200,
    bankrollCurrent:   150,
    sessionPnL:        -50,
    sessionLoss:       80,
    tradeCount:        20,
    openPositions:     [],
    closedTrades:      Array.from({ length: 20 }, (_, i) => ({ coin: "BTC", pnlUSDC: -1 } as any)),
    consecutiveLosses: 5,
    pausedUntil:       "2026-07-01T01:00:00Z",
    stopped:           true,
    stoppedReason:     "Session loss limit reached",
    simVersion:        2,
  };

  const after = resumeHlSession(stopped);

  expect(after.sessionLoss === 0, t, `sessionLoss MUST reset to 0 (was 80), got ${after.sessionLoss}`);
  expect(after.consecutiveLosses === 0, t, `consecutiveLosses MUST reset, got ${after.consecutiveLosses}`);
  expect(after.pausedUntil === null, t, `pausedUntil MUST clear, got ${after.pausedUntil}`);
  // Ledger + history preserved.
  expect(after.sessionPnL === -50, t, `sessionPnL preserved, got ${after.sessionPnL}`);
  expect(after.tradeCount === 20, t, `tradeCount preserved, got ${after.tradeCount}`);
  expect(after.closedTrades.length === 20, t, `closedTrades preserved, got ${after.closedTrades.length}`);
  expect(after.bankrollCurrent === 150, t, `bankrollCurrent preserved, got ${after.bankrollCurrent}`);
}

// ── 2. Combiner finalization: [0,1] clamp + sign-cancellation guard ─────────
// MIRROR of the finalization in signal-combiner.mts combine() (plain
// IC-weighted average + the audit clamp/guard). Keep in sync.
function weightedCombineFinal(
  valid: Record<string, number>,
  icMap: Record<string, number>,
): { raw: number; clamped: number } {
  const names = Object.keys(valid);
  const n = names.length;
  const mean = names.reduce((s, k) => s + valid[k], 0) / n;
  const demeaned: Record<string, number> = {};
  for (const k of names) demeaned[k] = valid[k] - mean;

  let totalW = 0;
  const weights: Record<string, number> = {};
  for (const k of names) {
    const w = icMap[k] * (1 + Math.abs(demeaned[k]) * 0.5);
    weights[k] = w;
    totalW += w;
  }
  if (!Number.isFinite(totalW) || Math.abs(totalW) < 1e-9) {
    for (const k of names) weights[k] = 1 / n;
  } else {
    for (const k of names) weights[k] = weights[k] / totalW;
  }
  let combined = 0;
  for (const k of names) combined += weights[k] * valid[k];
  const clamped = Math.max(1e-4, Math.min(1 - 1e-4, combined));
  return { raw: combined, clamped };
}

// 2a. Positive-only ICs with in-range signals → the clamp is a strict no-op.
{
  const t = "combine.clamp[noop-positive]";
  const { raw, clamped } = weightedCombineFinal(
    { orderflow: 0.6, momentum: 0.65, apex_consensus: 0.58 },
    { orderflow: 0.09, momentum: 0.06, apex_consensus: 0.08 },
  );
  expect(raw > 0 && raw < 1, t, `positive-IC combined should already be in (0,1), got ${raw}`);
  expect(Math.abs(clamped - raw) < 1e-9, t, `clamp must be a no-op on in-range values, raw=${raw} clamped=${clamped}`);
}

// 2b. A NEGATIVE effective IC pushes the raw weighted average OUT of [0,1];
//     the clamp brings it back to a strict open interval.
{
  const t = "combine.clamp[negative-ic-out-of-range]";
  // orderflow strongly positive value + positive IC, a second signal low value
  // + NEGATIVE IC → mixed-sign weights, non-degenerate totalW, raw ≈ 3.7.
  const { raw, clamped } = weightedCombineFinal(
    { orderflow: 0.95, vol_divergence: 0.40 },
    { orderflow: 0.60, vol_divergence: -0.50 },
  );
  expect(raw > 1, t, `fixture must escape [0,1] to exercise the clamp, got raw=${raw}`);
  expect(clamped > 0 && clamped < 1, t, `clamped MUST land in (0,1), got ${clamped}`);
  expect(clamped <= 1 - 1e-4 + 1e-12, t, `clamped must respect the upper bound, got ${clamped}`);
}

// 2c. Sign-cancellation: equal-and-opposite weights collapse totalW ≈ 0 → the
//     guard falls back to equal weights instead of dividing by ~0.
{
  const t = "combine.clamp[totalW-guard]";
  const { raw, clamped } = weightedCombineFinal(
    { a: 0.9, b: 0.1 },
    { a: 0.5, b: -0.5 },   // symmetric values (demeaned ±0.4) → weights +w/−w → totalW 0
  );
  expect(Number.isFinite(raw) && raw > 0 && raw < 1, t, `equal-weight fallback should give a finite in-range value, got ${raw}`);
  expect(clamped > 0 && clamped < 1, t, `guarded combined stays in (0,1), got ${clamped}`);
}

// ─── CLI report ─────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("p0-profitability-fixes.test.mts") || entry.endsWith("p0-profitability-fixes.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("p0-profitability-fixes.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`p0-profitability-fixes.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
