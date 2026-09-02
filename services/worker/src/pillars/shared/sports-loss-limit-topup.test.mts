// netlify/functions/auto-trader/shared/sports-loss-limit-topup.test.mts
//
// Lives under auto-trader/shared/ (NOT top-level) so Netlify never bundles it
// as a serverless function (a "...test" function name is illegal → deploy
// fail). Regression guard for the 2026-05-29 sports changes:
//   1. Session loss limit is OFF by default in PAPER, ON in LIVE.
//   2. The `sportsSessionLossLimitEnabled` override (0/1) wins when set.
//   3. topupSportsSession is additive + non-destructive.
//
// Run: npx tsx netlify/functions/auto-trader/shared/sports-loss-limit-topup.test.mts

import { topupSportsSession } from "../sports/session-manager.mts";
import { getSportsConfig } from "../sports/config.mts";
import type { SportsSessionState } from "../sports/types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
function approx(a: number, b: number, eps = 1e-9): boolean { return Math.abs(a - b) <= eps; }

// ── 1. Paper default: loss limit OFF ────────────────────────────────────────
{
  delete process.env.SPORTS_PAPER_MODE;
  delete process.env.SPORTS_SESSION_LOSS_LIMIT_ENABLED;
  const c = getSportsConfig();
  expect(c.paperMode === true, "paper.default", `expected paperMode true, got ${c.paperMode}`);
  expect(c.sessionLossLimitEnabled === false, "paper.limitOff",
    `paper should default loss-limit OFF, got ${c.sessionLossLimitEnabled}`);
}

// ── 2. Live default: loss limit ON ──────────────────────────────────────────
{
  process.env.SPORTS_PAPER_MODE = "false";
  delete process.env.SPORTS_SESSION_LOSS_LIMIT_ENABLED;
  const c = getSportsConfig();
  expect(c.paperMode === false, "live.mode", `expected paperMode false, got ${c.paperMode}`);
  expect(c.sessionLossLimitEnabled === true, "live.limitOn",
    `live should default loss-limit ON, got ${c.sessionLossLimitEnabled}`);
  delete process.env.SPORTS_PAPER_MODE;
}

// ── 3. Env override wins (paper but forced ON) ──────────────────────────────
{
  delete process.env.SPORTS_PAPER_MODE;                  // paper
  process.env.SPORTS_SESSION_LOSS_LIMIT_ENABLED = "true";
  const c = getSportsConfig();
  expect(c.sessionLossLimitEnabled === true, "override.on",
    `env override should force ON in paper, got ${c.sessionLossLimitEnabled}`);
  delete process.env.SPORTS_SESSION_LOSS_LIMIT_ENABLED;
}

// ── 4. Topup is additive + preserves session state ──────────────────────────
{
  const s: SportsSessionState = {
    startedAt: "2026-05-29T00:00:00Z",
    paperMode: true,
    stopped: false,
    stoppedReason: null,
    bankrollStart: 250,
    bankrollCurrent: 214.93,
    sessionPnL: -35.07,
    sessionLoss: 35.07,
    openPositions: [],
    closedTrades: [{} as any, {} as any, {} as any],   // 3 closed
    simVersion: 3,
  };
  const t = topupSportsSession(s, 50);
  expect(approx(t.bankrollCurrent, 264.93, 1e-4), "topup.current", `214.93 + 50 = 264.93, got ${t.bankrollCurrent}`);
  expect(approx(t.bankrollStart, 300, 1e-4), "topup.start", `250 + 50 = 300, got ${t.bankrollStart}`);
  expect(approx(t.sessionPnL, -35.07, 1e-4), "topup.pnlPreserved", `sessionPnL must be unchanged, got ${t.sessionPnL}`);
  expect(t.closedTrades.length === 3, "topup.tradesPreserved", `closedTrades must be unchanged, got ${t.closedTrades.length}`);
  expect(t.stopped === false, "topup.stoppedPreserved", "stopped flag must be unchanged");
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log("sports-loss-limit-topup.test: all checks passed");
} else {
  console.error(`sports-loss-limit-topup.test: ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.test}: ${f.message}`);
  process.exit(1);
}
