// netlify/functions/auto-trader/shared/paper-never-stop.test.mts
//
// Regression guards for the paper "never stop" safety valve (2026-09-01).
//
//   1. isAutoStopReason() classifies AUTOMATIC stop reasons (session loss
//      limit / calibration noise / consecutive loss) as clearable, but a
//      MANUAL stop ("Manual stop") as NOT clearable — the whole point of the
//      "only auto-stops" scope so an operator halt (e.g. sports, no live edge)
//      stays down while crypto/HL self-heal.
//
//   2. The self-heal predicate (paperMode && paperNeverStop && stopped &&
//      isAutoStopReason) fires exactly on the paper + auto-stop combination
//      and never in live mode nor on a manual stop.
//
//   3. The resume helpers the valve calls (resumeSession / resumeHlSession)
//      unbrick history-preservingly (sessionLoss → 0, counters cleared, trade
//      history intact) — the crypto +$445 / $1162-gross-loss live pathology.
//
// Run: npx tsx netlify/functions/auto-trader/shared/paper-never-stop.test.mts

import { isAutoStopReason, PAPER_NEVER_STOP_DEFAULT } from "./paper-never-stop.mts";
import { resumeSession }   from "../crypto/session-manager.mts";
import { resumeHlSession } from "../hyperliquid/session-manager.mts";
import type { SessionState } from "@core/types.mts";
import type { HlSessionState } from "../hyperliquid/types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── 1. isAutoStopReason classification ──────────────────────────────────────
{
  const t = "isAutoStopReason";
  // Automatic reasons → clearable.
  expect(isAutoStopReason("Session loss limit reached") === true, t, "crypto/HL loss-limit reason must be auto");
  expect(isAutoStopReason("Session loss limit hit: -$50.00") === true, t, "sports loss-limit reason must be auto");
  expect(isAutoStopReason("Calibration noise: need more trades") === true, t, "calibration-noise reason must be auto");
  expect(isAutoStopReason("5 consecutive losses — pause required") === true, t, "consecutive-loss reason must be auto");
  // Manual stop → NOT clearable (preserved).
  expect(isAutoStopReason("Manual stop") === false, t, "'Manual stop' must be preserved (not auto)");
  // Degenerate inputs → not auto.
  expect(isAutoStopReason(null) === false, t, "null reason must not be auto");
  expect(isAutoStopReason(undefined) === false, t, "undefined reason must not be auto");
  expect(isAutoStopReason("") === false, t, "empty reason must not be auto");
}

// ── 2. Default is ON ────────────────────────────────────────────────────────
{
  const t = "default";
  expect(PAPER_NEVER_STOP_DEFAULT === true, t, "valve must default ON");
}

// ── 3. Self-heal predicate (the runner's guard condition) ───────────────────
// Mirrors the exact condition used in every runner:
//   config.paperMode && paperNeverStop && session.stopped && isAutoStopReason(reason)
function shouldSelfHeal(paperMode: boolean, paperNeverStop: boolean, stopped: boolean, reason: string | null): boolean {
  return paperMode && paperNeverStop && stopped && isAutoStopReason(reason);
}
{
  const t = "selfHeal.predicate";
  // Paper + valve ON + auto-stop → heal.
  expect(shouldSelfHeal(true,  true,  true,  "Session loss limit reached") === true,  t, "paper+on+auto must heal");
  // Live mode → never heal (real stops stay).
  expect(shouldSelfHeal(false, true,  true,  "Session loss limit reached") === false, t, "live must never heal");
  // Valve OFF → normal stop behavior.
  expect(shouldSelfHeal(true,  false, true,  "Session loss limit reached") === false, t, "valve OFF must not heal");
  // Manual stop → preserved even in paper with valve on.
  expect(shouldSelfHeal(true,  true,  true,  "Manual stop") === false, t, "manual stop must be preserved");
  // Not stopped → nothing to heal.
  expect(shouldSelfHeal(true,  true,  false, null) === false, t, "not-stopped must be a no-op");
}

// ── 4. resumeSession unbricks history-preservingly (crypto live pathology) ──
{
  const t = "selfHeal.resumeSession[crypto]";
  // The exact live state on 2026-09-01: +$445 net, stopped on the loss limit
  // because the GROSS loss ($1162) crossed the $1000 knob max.
  const stopped: SessionState = {
    startedAt:        "2026-06-13T22:29:31Z",
    bankrollStart:    350,
    bankrollCurrent:  743.97,
    sessionPnL:       445.09,
    sessionLoss:      1162.31,
    tradeCount:       72,
    openPositions:    [],
    closedTrades:     Array.from({ length: 72 }, (_, i) => ({ market: `m${i}`, pnl: 0 } as any)),
    paperMode:        true,
    stopped:          true,
    stoppedReason:    "Session loss limit reached",
    simVersion:       3,
    calibrationAlertSentAt: "2026-07-23T00:00:00Z",
  };
  const after = resumeSession(stopped);
  expect(after.stopped === false, t, "self-heal must clear stopped");
  expect(after.sessionLoss === 0, t, `gross-loss odometer must reset (was 1162.31), got ${after.sessionLoss}`);
  expect(after.sessionPnL === 445.09, t, "net PnL preserved");
  expect(after.closedTrades.length === 72, t, "trade history preserved");
}

// ── 5. resumeHlSession clears pause + odometer ──────────────────────────────
{
  const t = "selfHeal.resumeHlSession";
  const stopped = {
    stopped: true,
    stoppedReason: "Session loss limit reached",
    sessionLoss: 75.5,
    consecutiveLosses: 5,
    pausedUntil: "2026-09-01T20:00:00Z",
    closedTrades: Array.from({ length: 378 }, () => ({} as any)),
    bankrollCurrent: 185.05,
  } as unknown as HlSessionState;
  const healed = { ...resumeHlSession(stopped), stopped: false, stoppedReason: null };
  expect(healed.stopped === false, t, "stopped cleared");
  expect(healed.sessionLoss === 0, t, `sessionLoss reset, got ${healed.sessionLoss}`);
  expect(healed.consecutiveLosses === 0, t, "consecutive-loss counter cleared");
  expect(healed.pausedUntil === null, t, "pause cleared");
  expect(healed.closedTrades.length === 378, t, "trade history preserved");
}

// ─── CLI report ─────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("paper-never-stop.test.mts") || entry.endsWith("paper-never-stop.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("paper-never-stop.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`paper-never-stop.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
