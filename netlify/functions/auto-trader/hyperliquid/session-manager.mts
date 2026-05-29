// netlify/functions/auto-trader/hyperliquid/session-manager.mts
// Netlify Blobs-backed session state. Mirrors the crypto module's pattern but
// carries perp-specific fields (leverage, TP/SL, consecutive-loss counter).

import { getStore } from "@netlify/blobs";
import { HL_PAPER_SIM_VERSION } from "./config.mts";
import type {
  HlSessionState,
  HlPosition,
  HlClosedTrade,
} from "./types.mts";

const STORE      = "hyperliquid-session-v1";
const PAPER_KEY  = "session_paper";
const LIVE_KEY   = "session_live";
const ARCHIVE_PREFIX = "archive_paper_v";
const DEFAULT_BANKROLL = 200;

function storeKey(paperMode: boolean): string {
  return paperMode ? PAPER_KEY : LIVE_KEY;
}

function freshSession(paperMode: boolean, bankroll: number): HlSessionState {
  return {
    startedAt:        new Date().toISOString(),
    paperMode,
    bankrollStart:    bankroll,
    bankrollCurrent:  bankroll,
    sessionPnL:       0,
    sessionLoss:      0,
    tradeCount:       0,
    openPositions:    [],
    closedTrades:     [],
    consecutiveLosses: 0,
    pausedUntil:      null,
    stopped:          false,
    stoppedReason:    null,
    simVersion:       HL_PAPER_SIM_VERSION,
  };
}

export async function loadHlSession(paperMode: boolean, bankroll = DEFAULT_BANKROLL): Promise<HlSessionState> {
  let store: any = null;
  try { store = getStore(STORE); } catch { return freshSession(paperMode, bankroll); }
  try {
    const raw = await store.get(storeKey(paperMode));
    if (raw) {
      const parsed = JSON.parse(raw) as HlSessionState;
      // Backfill any newly-added fields
      if (parsed.consecutiveLosses === undefined) parsed.consecutiveLosses = 0;
      if (parsed.pausedUntil === undefined) parsed.pausedUntil = null;
      // ── Paper sim-version auto-archive ──
      // If the persisted session was written under an older paper PnL
      // semantic (e.g. before TP/SL clamps + funding accrual + paper vol
      // gate), archive it under a versioned key and start fresh. Mirrors
      // the crypto loadSession() pattern. Live sessions never auto-reset
      // (real money is irreversible — the operator must decide).
      const persistedVer = parsed.simVersion ?? 1;
      if (paperMode && persistedVer < HL_PAPER_SIM_VERSION) {
        try {
          await store.set(
            `${ARCHIVE_PREFIX}${persistedVer}_${Date.now()}`,
            JSON.stringify(parsed),
          );
        } catch {}
        const fresh = freshSession(paperMode, bankroll);
        try { await store.set(storeKey(paperMode), JSON.stringify(fresh)); } catch {}
        return fresh;
      }
      if (parsed.simVersion === undefined) parsed.simVersion = HL_PAPER_SIM_VERSION;
      return parsed;
    }
  } catch {}
  return freshSession(paperMode, bankroll);
}

export async function saveHlSession(s: HlSessionState): Promise<void> {
  try {
    const store = getStore(STORE);
    await store.set(storeKey(s.paperMode), JSON.stringify(s));
  } catch {
    // Non-fatal: state rebuilds from next run
  }
}

export function addOpenPosition(s: HlSessionState, pos: HlPosition): HlSessionState {
  return { ...s, openPositions: [...s.openPositions, pos] };
}

export function closePosition(s: HlSessionState, entryOrderId: string, trade: HlClosedTrade): HlSessionState {
  const remaining = s.openPositions.filter(p => p.entryOrderId !== entryOrderId);
  const bankrollCurrent = s.bankrollCurrent + trade.pnlUSDC;
  const sessionPnL      = s.sessionPnL + trade.pnlUSDC;
  const lossDelta       = trade.pnlUSDC < 0 ? -trade.pnlUSDC : 0;
  const sessionLoss     = s.sessionLoss + lossDelta;
  const consecutive     = trade.pnlUSDC < 0 ? s.consecutiveLosses + 1 : 0;

  return {
    ...s,
    openPositions:    remaining,
    closedTrades:     [...s.closedTrades, trade],
    tradeCount:       s.tradeCount + 1,
    bankrollCurrent,
    sessionPnL,
    sessionLoss,
    consecutiveLosses: consecutive,
  };
}

export function applyConsecutiveLossPause(s: HlSessionState, hours: number): HlSessionState {
  const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  return { ...s, pausedUntil: until };
}

// ── Consecutive-loss pause auto-recovery (2026-05-29 audit fix) ──────────────
//
// The consecutive-loss circuit-breaker sets `pausedUntil` (the cooldown
// window) on the limit-hit close, but historically left `consecutiveLosses`
// untouched. The decision-engine's consecutive-loss gate blocks on the RAW
// count — not on whether the pause has elapsed — and the count only resets on
// a WIN. So once a session hit the limit it could never trade again (no trade
// → no win → count stays ≥ limit → permanent block): the intended "1h pause"
// silently became a permanent halt. (Live finding: the HL paper bot sat
// bricked for 12 days with consecutiveLosses=5, limit=3.)
//
// This helper treats an ELAPSED pause as served: once the window passes, wipe
// the slate so the bot resumes with a fresh count. Idempotent — once the count
// is cleared it returns `cleared: false` and a no-op session. Returns the
// (possibly) new session plus a flag so the caller can log the recovery.
export function clearElapsedConsecutiveLossPause(
  s: HlSessionState,
  consecutiveLossLimit: number,
): { session: HlSessionState; cleared: boolean } {
  const pauseElapsed =
    !!s.pausedUntil && new Date(s.pausedUntil).getTime() <= Date.now();
  if (s.consecutiveLosses >= consecutiveLossLimit && pauseElapsed) {
    return { session: { ...s, consecutiveLosses: 0, pausedUntil: null }, cleared: true };
  }
  return { session: s, cleared: false };
}

export function stopHlSession(s: HlSessionState, reason: string): HlSessionState {
  return { ...s, stopped: true, stoppedReason: reason };
}

export function resumeHlSession(s: HlSessionState): HlSessionState {
  // Clearing the pause MUST also reset the consecutive-loss counter. The
  // decision-engine's consecutive-loss gate blocks on the raw count, so a
  // resume that left the count ≥ limit would null `pausedUntil` yet still
  // silently fail to un-block the bot (it would skip every tick with
  // "N consecutive losses — pause required"). Resetting the count here makes
  // `resume` a real, history-preserving unbrick. (2026-05-29 audit.)
  return { ...s, pausedUntil: null, consecutiveLosses: 0 };
}

export function resetHlSession(paperMode: boolean, bankroll = DEFAULT_BANKROLL): HlSessionState {
  return freshSession(paperMode, bankroll);
}

// Sprint 42B (2026-05-15): non-destructive bankroll injection — mirror of
// `topupSession` in crypto/session-manager.mts. Preserves closedTrades,
// tradeCount, sessionPnL, sessionLoss, openPositions, consecutiveLosses,
// pausedUntil, startedAt. Only bankrollStart + bankrollCurrent grow.
//
// Note: F-Arb shares this HL bankroll (the funding-arb capital comes from
// the same HL perp account), so the F-Arb dispatcher delegates its topup
// to this function — there is NO separate `topupArbSession`.
export function topupHlSession(s: HlSessionState, amount: number): HlSessionState {
  return {
    ...s,
    bankrollStart:   s.bankrollStart   + amount,
    bankrollCurrent: s.bankrollCurrent + amount,
  };
}
