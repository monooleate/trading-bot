import { getStore } from "@netlify/blobs";
import { log } from "../shared/logger.mts";
import type { SessionState, Position, ClosedTrade } from "../shared/types.mts";

const STORE_KEY = "auto-trader-session";
const LIVE_STORE_KEY = "auto-trader-session-live";

// Bump this every time the paper simulator semantics change. Sessions
// loaded with an older simVersion are auto-archived and reset so the
// stats tab analyses one consistent methodology.
//
// History:
//   v1: halfway-toward-prediction sim (before 2026-05-09). Produced the
//       143-trade / 98.6% WR artefact described in paper-pnl-analysis.md.
//   v2: real Polymarket resolution + finalProb-independent Brownian-bridge
//       fallback. The Gamma URL was missing `&closed=true` so the real-
//       resolution path silently never fired; every close ran through the
//       Brownian sim, which itself instant-triggered on deep-OTM entries
//       (entry yesPrice outside the [SL,TP] band fired on iteration 0).
//       Net: 9-trade artefact with 88.9% WR, all exits clamped to 0.35
//       or 0.75 — none matching real Polymarket outcomes.
//   v3: Polymarket resolution ONLY. No simulator. Positions stay open
//       until Gamma reports outcomePrices ∈ {0,1}. Paper PnL == live PnL.
export const PAPER_SIM_VERSION = 3;
const ARCHIVE_KEY_PREFIX = "auto-trader-session-archive";

function sessionKey(paperMode: boolean, category?: string): string {
  const base = paperMode ? STORE_KEY : LIVE_STORE_KEY;
  return category && category !== "crypto" ? `${base}-${category}` : base;
}

function archiveKey(paperMode: boolean, category: string | undefined, version: number): string {
  const base = `${ARCHIVE_KEY_PREFIX}-${paperMode ? "paper" : "live"}-v${version}`;
  return category && category !== "crypto" ? `${base}-${category}` : base;
}

function defaultSession(bankroll: number, paperMode: boolean): SessionState {
  return {
    startedAt: new Date().toISOString(),
    bankrollStart: bankroll,
    bankrollCurrent: bankroll,
    sessionPnL: 0,
    sessionLoss: 0,
    tradeCount: 0,
    openPositions: [],
    closedTrades: [],
    paperMode,
    stopped: false,
    stoppedReason: null,
    simVersion: PAPER_SIM_VERSION,
    calibrationAlertSentAt: null,
  };
}

// ─── State persistence ────────────────────────────────────

export async function loadSession(
  paperMode: boolean,
  defaultBankroll: number,
  category?: string,
): Promise<SessionState> {
  try {
    const store = getStore("auto-trader-state");
    const raw = await store.get(sessionKey(paperMode, category));
    if (raw) {
      const parsed: SessionState = JSON.parse(raw);
      // Ensure paperMode matches the requested mode.
      if (parsed.paperMode !== paperMode) {
        return defaultSession(defaultBankroll, paperMode);
      }
      // Auto-reset paper sessions written by an older simulator. The old
      // closedTrades are archived (not deleted) for forensic analysis but
      // are NOT loaded into the live session, so edge-tracker shows only
      // post-upgrade trades.
      const v = parsed.simVersion ?? 1;
      if (paperMode && v < PAPER_SIM_VERSION) {
        try {
          await store.set(
            archiveKey(paperMode, category, v),
            JSON.stringify({ archivedAt: new Date().toISOString(), session: parsed }),
          );
        } catch {}
        // Persist the fresh v-current session back to the session key so
        // subsequent loads don't re-archive the same v2 blob on every poll.
        const fresh = defaultSession(defaultBankroll, paperMode);
        try {
          await store.set(sessionKey(paperMode, category), JSON.stringify(fresh));
        } catch {}
        log("SESSION_START", paperMode, {
          reason: "auto_reset_simversion",
          fromVersion: v,
          toVersion: PAPER_SIM_VERSION,
          archivedTradeCount: parsed.closedTrades?.length ?? 0,
        });
        return fresh;
      }
      // Backfill simVersion for sessions written before the field existed.
      if (parsed.simVersion === undefined) {
        return { ...parsed, simVersion: PAPER_SIM_VERSION };
      }
      return parsed;
    }
  } catch {}

  return defaultSession(defaultBankroll, paperMode);
}

export async function saveSession(session: SessionState, category?: string): Promise<void> {
  try {
    const store = getStore("auto-trader-state");
    await store.set(sessionKey(session.paperMode, category), JSON.stringify(session));
  } catch (err) {
    console.error("[session] Failed to save:", err);
  }
}

// ─── Session mutations ────────────────────────────────────

export function addOpenPosition(session: SessionState, position: Position): SessionState {
  return {
    ...session,
    openPositions: [...session.openPositions, position],
    bankrollCurrent: session.bankrollCurrent - position.costBasis,
  };
}

export function closePosition(
  session: SessionState,
  buyOrderId: string,
  trade: ClosedTrade,
): SessionState {
  const closedPos = session.openPositions.find((p) => p.buyOrderId === buyOrderId);
  const remaining = session.openPositions.filter((p) => p.buyOrderId !== buyOrderId);
  const newPnL = session.sessionPnL + trade.pnl;
  const newLoss = trade.pnl < 0
    ? session.sessionLoss + Math.abs(trade.pnl)
    : session.sessionLoss;

  // Bankroll arithmetic (2026-05-11 audit fix #B): the previous formula
  // `bankrollCurrent + shares × exitPrice` returned the GROSS proceeds,
  // which silently bypassed the roundtrip fee the resolver subtracts from
  // `trade.pnl`. Result: bankrollCurrent drifted ~3.6% × notional optimist
  // per trade vs sessionPnL — after 30 trades the discrepancy was several
  // dollars on a $250 paper bankroll. Use `pnl + costBasis` instead: the
  // costBasis "returns" (cancelling the addOpenPosition debit) and the
  // net pnl applies on top, keeping `bankrollStart + sessionPnL ===
  // bankrollCurrent` invariant.
  const costBasis = closedPos?.costBasis ?? 0;
  const bankrollDelta = trade.pnl + costBasis;

  return {
    ...session,
    openPositions: remaining,
    closedTrades: [...session.closedTrades, trade],
    tradeCount: session.tradeCount + 1,
    sessionPnL: newPnL,
    sessionLoss: newLoss,
    bankrollCurrent: session.bankrollCurrent + bankrollDelta,
  };
}

export function stopSession(session: SessionState, reason: string): SessionState {
  log("SESSION_STOP", session.paperMode, {
    reason,
    pnl: session.sessionPnL,
    trades: session.tradeCount,
  });

  return {
    ...session,
    stopped: true,
    stoppedReason: reason,
  };
}

// Clears the manual-stop flag. Mirrors `resumeHlSession` in
// hyperliquid/session-manager.mts so the four bots have identical
// stop/resume semantics. Calibration alarms (set during the previous run)
// are also cleared so a re-armed session can fire its own alert.
export function resumeSession(session: SessionState): SessionState {
  log("SESSION_START", session.paperMode, {
    event: "manual_resume",
    pnl: session.sessionPnL,
    trades: session.tradeCount,
  });
  return {
    ...session,
    stopped: false,
    stoppedReason: null,
    calibrationAlertSentAt: null,
  };
}

export function resetSession(bankroll: number, paperMode: boolean): SessionState {
  const session = defaultSession(bankroll, paperMode);
  log("SESSION_START", paperMode, { bankroll, simVersion: PAPER_SIM_VERSION });
  return session;
}
