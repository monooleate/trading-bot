// netlify/functions/auto-trader/shared/hl-consec-loss-recovery.test.mts
//
// 2026-05-29 audit regression guard for the HL consecutive-loss DEADLOCK.
//
// Bug: the consecutive-loss circuit-breaker set `pausedUntil` (the cooldown
// window) but never reset `consecutiveLosses`. The decision-engine gate blocks
// on the raw count, which only resets on a WIN — so once the limit was hit the
// bot could never trade again (no trade → no win → count stays ≥ limit). The
// "1h pause" became permanent; the live HL paper bot sat bricked for 12 days
// (consecutiveLosses=5, limit=3).
//
// Two fixes, pinned here:
//   1. clearElapsedConsecutiveLossPause — once the pause window elapses, the
//      slate is wiped (count → 0, pausedUntil → null) so the bot auto-recovers
//      on the next cron tick. An ACTIVE (future) pause must NOT be cleared.
//   2. resumeHlSession — the `resume` action must reset the count too, else it
//      nulls pausedUntil yet leaves the bot blocked by the raw-count gate.
//
// Run: npx tsx netlify/functions/auto-trader/shared/hl-consec-loss-recovery.test.mts

import {
  clearElapsedConsecutiveLossPause,
  resumeHlSession,
} from "../hyperliquid/session-manager.mts";
import type { HlSessionState } from "../hyperliquid/types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

const PAST   = "2026-05-17T04:09:19.905Z"; // long elapsed
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function base(overrides: Partial<HlSessionState>): HlSessionState {
  return {
    startedAt:         "2026-05-10T10:00:15.849Z",
    paperMode:         true,
    bankrollStart:     200,
    bankrollCurrent:   196.45,
    sessionPnL:        -3.55,
    sessionLoss:       5.16,
    tradeCount:        22,
    openPositions:     [],
    closedTrades:      [],
    consecutiveLosses: 5,
    pausedUntil:       PAST,
    stopped:           false,
    stoppedReason:     null,
    simVersion:        2,
    ...overrides,
  } as HlSessionState;
}

// ── 1. The exact live bricked state recovers ─────────────────────────────────
{
  const t = "recovery[bricked-live-state]";
  const { session, cleared } = clearElapsedConsecutiveLossPause(base({}), 3);
  expect(cleared === true, t, "elapsed pause + count≥limit MUST clear");
  expect(session.consecutiveLosses === 0, t, `count → 0, got ${session.consecutiveLosses}`);
  expect(session.pausedUntil === null, t, `pausedUntil → null, got ${session.pausedUntil}`);
  // History + bankroll preserved — recovery is non-destructive.
  expect(session.bankrollCurrent === 196.45, t, "bankroll preserved");
  expect(session.tradeCount === 22, t, "tradeCount preserved");
  expect(session.sessionPnL === -3.55, t, "sessionPnL preserved");
}

// ── 2. An ACTIVE pause must NOT be cleared (cooldown still in effect) ─────────
{
  const t = "recovery[active-pause-held]";
  const { session, cleared } = clearElapsedConsecutiveLossPause(base({ pausedUntil: FUTURE }), 3);
  expect(cleared === false, t, "future pause MUST NOT clear");
  expect(session.consecutiveLosses === 5, t, "count untouched during active pause");
  expect(session.pausedUntil === FUTURE, t, "pausedUntil untouched during active pause");
}

// ── 3. Below the limit → no-op even if pause elapsed ─────────────────────────
{
  const t = "recovery[below-limit-noop]";
  const { session, cleared } = clearElapsedConsecutiveLossPause(base({ consecutiveLosses: 2 }), 3);
  expect(cleared === false, t, "count < limit MUST NOT clear");
  expect(session.consecutiveLosses === 2, t, "count untouched below limit");
}

// ── 4. No pause set → no-op (don't bypass the circuit-breaker) ───────────────
{
  const t = "recovery[no-pause-noop]";
  const { cleared } = clearElapsedConsecutiveLossPause(base({ pausedUntil: null }), 3);
  expect(cleared === false, t, "null pausedUntil MUST NOT clear (no window served)");
}

// ── 5. Idempotent: a cleared session is a no-op on the next call ─────────────
{
  const t = "recovery[idempotent]";
  const once = clearElapsedConsecutiveLossPause(base({}), 3).session;
  const { cleared } = clearElapsedConsecutiveLossPause(once, 3);
  expect(cleared === false, t, "second pass MUST be a no-op");
}

// ── 6. resume resets the counter too (real unbrick) ──────────────────────────
{
  const t = "resume[clears-count]";
  const resumed = resumeHlSession(base({ pausedUntil: FUTURE }));
  expect(resumed.pausedUntil === null, t, "resume nulls pausedUntil");
  expect(resumed.consecutiveLosses === 0, t, `resume MUST reset count, got ${resumed.consecutiveLosses}`);
  // History preserved — resume is not a reset.
  expect(resumed.tradeCount === 22, t, "resume preserves tradeCount");
  expect(resumed.bankrollCurrent === 196.45, t, "resume preserves bankroll");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("hl-consec-loss-recovery.test.mts") || entry.endsWith("hl-consec-loss-recovery.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("hl-consec-loss-recovery.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`hl-consec-loss-recovery.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
