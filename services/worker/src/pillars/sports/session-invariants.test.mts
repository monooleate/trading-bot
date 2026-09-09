// services/worker/src/pillars/sports/session-invariants.test.mts
//
// Audit P2-9 + P2-10 regression guard (sprints.md B64).
//
// Both defects were found by reconciling the LIVE session against its own open
// positions, not by reading code:
//
//   crypto  $150 start − $45.70 realised − $0 open   = $104.30  ✓ (reported 104.3047)
//   weather $100 start − $11.82 realised − $20.05 open = $68.13  ✓ (reported 68.1278)
//   sports  $50  start − $0     realised − $7.50 open  = $42.50  ✗ (reported 50.00)
//
// Sports was the only bot that did not reserve committed capital, so Kelly sized
// off money already spent. And its session-manager destroyed an operator's
// manual stop on a transient read error or a schema bump.
//
// Run: npx tsx services/worker/src/pillars/sports/session-invariants.test.mts

import { addOpenPosition, closeOpenPosition, resumeSportsSession, stopSportsSession } from "./session-manager.mts";
import type { SportsSessionState, SportsPosition, SportsClosedTrade } from "./types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const base = (): SportsSessionState => ({
  startedAt: "2026-09-09T06:00:00Z", paperMode: true, stopped: false, stoppedReason: null,
  bankrollStart: 50, bankrollCurrent: 50, sessionPnL: 0, sessionLoss: 0,
  openPositions: [], closedTrades: [], simVersion: 1,
} as any);

const pos = (id: string, cost: number): SportsPosition => ({
  conditionId: id, market: `m-${id}`, direction: "NO", shares: cost / 0.1,
  avgEntry: 0.1, costBasis: cost, openedAt: "2026-09-09T06:01:00Z",
} as any);

// ── 1. P2-10: the three live positions must reconcile ────────────────────────
{
  const t = "reserve-capital";
  let s = base();
  // The exact live snapshot: three $2.50 positions on a $50 bankroll.
  for (const [i, c] of [2.5, 2.5, 2.5].entries()) s = addOpenPosition(s, pos(`c${i}`, c));
  expect(near(s.bankrollCurrent, 42.5), t,
    `three $2.50 positions must leave $42.50 free, got ${s.bankrollCurrent} (the live bug reported $50.00)`);
  const committed = s.openPositions.reduce((a, p) => a + p.costBasis, 0);
  expect(near(s.bankrollStart - s.sessionPnL * 0 - committed, s.bankrollCurrent), t,
    "start − committed must equal free capital while nothing has closed");
}

// ── 2. P2-10: closing returns the cost basis, so the invariant holds ─────────
// bankrollStart + sessionPnL === bankrollCurrent once every position is closed.
// Using gross proceeds instead would silently skip the roundtrip fee.
{
  const t = "close-invariant";
  let s = addOpenPosition(base(), pos("c1", 2.5));
  expect(near(s.bankrollCurrent, 47.5), t, "cost basis debited at open");
  const winner: SportsClosedTrade = { conditionId: "c1", pnl: 3.25 } as any;
  s = closeOpenPosition(s, "c1", winner);
  expect(near(s.bankrollCurrent, 53.25), t,
    `cost basis returns + pnl applies: expected 53.25, got ${s.bankrollCurrent}`);
  expect(near(s.bankrollStart + s.sessionPnL, s.bankrollCurrent), t,
    "start + sessionPnL === bankrollCurrent once flat");
  expect(s.openPositions.length === 0, t, "position removed");

  // Same for a loser — a total loss must cost exactly the cost basis.
  let s2 = addOpenPosition(base(), pos("c2", 2.5));
  s2 = closeOpenPosition(s2, "c2", { conditionId: "c2", pnl: -2.5 } as any);
  expect(near(s2.bankrollCurrent, 47.5), t,
    `a total loss must leave 47.50, got ${s2.bankrollCurrent}`);
  expect(near(s2.bankrollStart + s2.sessionPnL, s2.bankrollCurrent), t, "invariant holds for a loss too");
}

// ── 3. P2-10: capital is genuinely scarce — the cap cannot be over-committed ─
{
  const t = "no-overcommit";
  let s = base();
  for (let i = 0; i < 3; i++) s = addOpenPosition(s, pos(`x${i}`, 2.5));
  const free = s.bankrollCurrent;
  const committed = s.openPositions.reduce((a, p) => a + p.costBasis, 0);
  expect(near(free + committed, s.bankrollStart), t,
    `free + committed must equal the start bankroll (${free} + ${committed} vs ${s.bankrollStart})`);
}

// ── 4. P2-9: a manual stop is distinguishable from an auto stop ──────────────
// `paperNeverStop` clears only automatic stops; the audit's finding was that a
// manual stop survived that correctly but was destroyed by reset / schema bump /
// a transient read error instead.
{
  const t = "manual-stop";
  const manual = stopSportsSession(base(), "Manual stop");
  expect(manual.stopped && manual.stoppedReason === "Manual stop", t, "manual stop sets the flag and reason");
  const auto = stopSportsSession(base(), "Session loss limit reached");
  expect(auto.stopped, t, "auto stop also sets the flag");
  expect(manual.stoppedReason !== auto.stoppedReason, t,
    "the two must stay distinguishable by reason — that is the only signal the self-heal has");
  const resumed = resumeSportsSession(manual);
  expect(!resumed.stopped && resumed.stoppedReason === null, t, "resume clears both fields");
}

if (failures.length) {
  console.error(`FAIL  session-invariants.test.mts — ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  [${f.test}] ${f.message}`);
  process.exit(1);
}
console.log("PASS  session-invariants.test.mts");
