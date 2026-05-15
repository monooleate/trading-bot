// netlify/functions/auto-trader/shared/topup-action.test.mts
//
// Sprint 42B (2026-05-15) regression guard for the topup action — non-
// destructive bankroll injection. Pinned contract:
//   - bankrollStart and bankrollCurrent BOTH grow by `amount`
//   - closedTrades, tradeCount, sessionPnL, sessionLoss, openPositions,
//     startedAt, simVersion ALL unchanged
//   - HL-specific fields (consecutiveLosses, pausedUntil) ALSO unchanged
//
// Run: npx tsx netlify/functions/auto-trader/shared/topup-action.test.mts

import { topupSession }   from "../crypto/session-manager.mts";
import { topupHlSession } from "../hyperliquid/session-manager.mts";
import type { SessionState } from "./types.mts";
import type { HlSessionState } from "../hyperliquid/types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── topupSession (crypto / weather — shared session-manager) ─────────────
{
  const t = "topupSession[crypto]";

  // Realistic pre-topup state: 7 closed trades, 2 open positions, session in
  // mid-loss (mirrors today's 2026-05-15 paper state).
  const before: SessionState = {
    startedAt:        "2026-05-12T17:38:37.460Z",
    bankrollStart:    250,
    bankrollCurrent:  237,        // 250 + closedPnL 21.96 − openStakes 34.96
    sessionPnL:       21.96,
    sessionLoss:      70.04,
    tradeCount:       7,
    openPositions:    [
      { market: "bitcoin-above-78k-on-may-15", direction: "NO" as const, predictedProb: 0.4609 } as any,
      { market: "bitcoin-up-or-down-on-may-15-2026", direction: "YES" as const, predictedProb: 0.4762 } as any,
    ],
    closedTrades:     Array.from({ length: 7 }, (_, i) => ({ market: `m${i}`, pnl: i * 5 - 10 } as any)),
    paperMode:        true,
    stopped:          false,
    stoppedReason:    null,
    simVersion:       3,
    calibrationAlertSentAt: null,
  };

  const after = topupSession(before, 100);

  // Both bankroll fields must grow by exactly the amount.
  expect(after.bankrollStart   === 350, t, `bankrollStart: 250 + 100 = 350, got ${after.bankrollStart}`);
  expect(after.bankrollCurrent === 337, t, `bankrollCurrent: 237 + 100 = 337, got ${after.bankrollCurrent}`);

  // Everything else preserved.
  expect(after.sessionPnL    === 21.96, t, `sessionPnL unchanged, got ${after.sessionPnL}`);
  expect(after.sessionLoss   === 70.04, t, `sessionLoss unchanged, got ${after.sessionLoss}`);
  expect(after.tradeCount    === 7,     t, `tradeCount unchanged, got ${after.tradeCount}`);
  expect(after.closedTrades.length === 7, t, `closedTrades unchanged, got length ${after.closedTrades.length}`);
  expect(after.openPositions.length === 2, t, `openPositions unchanged, got length ${after.openPositions.length}`);
  expect(after.startedAt     === "2026-05-12T17:38:37.460Z", t, `startedAt unchanged, got ${after.startedAt}`);
  expect(after.paperMode     === true,  t, `paperMode unchanged, got ${after.paperMode}`);
  expect(after.simVersion    === 3,     t, `simVersion unchanged, got ${after.simVersion}`);
  expect(after.stopped       === false, t, `stopped unchanged, got ${after.stopped}`);
  expect(after.stoppedReason === null,  t, `stoppedReason unchanged, got ${after.stoppedReason}`);
}

// ── topupSession with stopped session ────────────────────────────────────
// The stopped flag should NOT be cleared by topup (use `resume` for that).
// Operator workflow: topup while stopped is valid — they may want to
// inspect, top up, THEN resume.
{
  const t = "topupSession[stopped-not-cleared]";
  const stopped: SessionState = {
    startedAt: "x", bankrollStart: 250, bankrollCurrent: 10,
    sessionPnL: -240, sessionLoss: 240, tradeCount: 5,
    openPositions: [], closedTrades: [], paperMode: true,
    stopped: true, stoppedReason: "Session loss limit reached", simVersion: 3,
  };
  const after = topupSession(stopped, 200);
  expect(after.bankrollCurrent === 210, t, `bankroll 10 + 200 = 210, got ${after.bankrollCurrent}`);
  expect(after.stopped === true, t, "stopped flag MUST remain true after topup");
  expect(after.stoppedReason === "Session loss limit reached", t, "stoppedReason MUST remain");
}

// ── topupHlSession ──────────────────────────────────────────────────────
{
  const t = "topupHlSession";

  const before: HlSessionState = {
    startedAt:         "2026-05-13T00:00:00Z",
    paperMode:         true,
    bankrollStart:     200,
    bankrollCurrent:   199.44,
    sessionPnL:        -0.56,
    sessionLoss:       0.56,
    tradeCount:        4,
    openPositions:     [],
    closedTrades:      Array.from({ length: 4 }, (_, i) => ({ coin: "BTC", pnl: i * 2 - 3 } as any)),
    consecutiveLosses: 3,
    pausedUntil:       "2026-05-15T13:00:00Z",
    stopped:           false,
    stoppedReason:     null,
    simVersion:        2,
  };

  const after = topupHlSession(before, 50);

  // Bankroll grows.
  expect(after.bankrollStart   === 250,    t, `bankrollStart: 200 + 50 = 250, got ${after.bankrollStart}`);
  expect(Math.abs(after.bankrollCurrent - 249.44) < 1e-9, t, `bankrollCurrent: 199.44 + 50 = 249.44, got ${after.bankrollCurrent}`);

  // HL-specific fields preserved.
  expect(after.consecutiveLosses === 3, t, `consecutiveLosses unchanged, got ${after.consecutiveLosses}`);
  expect(after.pausedUntil === "2026-05-15T13:00:00Z", t, `pausedUntil unchanged, got ${after.pausedUntil}`);

  // Standard fields preserved.
  expect(after.sessionPnL   === -0.56, t, `sessionPnL unchanged, got ${after.sessionPnL}`);
  expect(after.tradeCount   === 4,     t, `tradeCount unchanged, got ${after.tradeCount}`);
  expect(after.closedTrades.length === 4, t, `closedTrades unchanged, got length ${after.closedTrades.length}`);
  expect(after.startedAt    === "2026-05-13T00:00:00Z", t, `startedAt unchanged, got ${after.startedAt}`);
}

// ── Idempotency check: 2× topup(50) === 1× topup(100) ────────────────────
{
  const t = "topupSession[additive]";
  const start: SessionState = {
    startedAt: "x", bankrollStart: 250, bankrollCurrent: 237,
    sessionPnL: 0, sessionLoss: 0, tradeCount: 0,
    openPositions: [], closedTrades: [], paperMode: true,
    stopped: false, stoppedReason: null, simVersion: 3,
  };
  const twice = topupSession(topupSession(start, 50), 50);
  const once  = topupSession(start, 100);
  expect(twice.bankrollStart   === once.bankrollStart,   t, `twice 50 = once 100 for bankrollStart`);
  expect(twice.bankrollCurrent === once.bankrollCurrent, t, `twice 50 = once 100 for bankrollCurrent`);
}

// ── Decimal amount support (cents-level topup) ───────────────────────────
{
  const t = "topupSession[decimal]";
  const start: SessionState = {
    startedAt: "x", bankrollStart: 250, bankrollCurrent: 237,
    sessionPnL: 0, sessionLoss: 0, tradeCount: 0,
    openPositions: [], closedTrades: [], paperMode: true,
    stopped: false, stoppedReason: null, simVersion: 3,
  };
  const after = topupSession(start, 12.50);
  expect(Math.abs(after.bankrollStart   - 262.50) < 1e-9, t, `bankrollStart 250 + 12.50, got ${after.bankrollStart}`);
  expect(Math.abs(after.bankrollCurrent - 249.50) < 1e-9, t, `bankrollCurrent 237 + 12.50, got ${after.bankrollCurrent}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("topup-action.test.mts") || entry.endsWith("topup-action.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("topup-action.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`topup-action.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
