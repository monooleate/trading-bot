// netlify/functions/auto-trader/sports/session-manager.mts
//
// Per-bot Blobs session storage. Same pattern as crypto/weather/HL —
// each bot has its own `auto-trader-session-sports` store key, paper
// and live separated by suffix.

import { getStore } from "@netlify/blobs";
import type { SportsSessionState, SportsPosition, SportsClosedTrade } from "./types.mts";
import { SPORTS_DEFAULT_BANKROLL, SPORTS_SIM_VERSION } from "./config.mts";

const STORE_NAME = "auto-trader-session-sports";

function sessionKey(paperMode: boolean): string {
  return `session_${paperMode ? "paper" : "live"}`;
}

function freshSession(paperMode: boolean, bankroll: number): SportsSessionState {
  return {
    startedAt:        new Date().toISOString(),
    paperMode,
    stopped:          false,
    stoppedReason:    null,
    bankrollStart:    bankroll,
    bankrollCurrent:  bankroll,
    sessionPnL:       0,
    sessionLoss:      0,
    openPositions:    [],
    closedTrades:     [],
    simVersion:       SPORTS_SIM_VERSION,
  };
}

export async function loadSportsSession(
  paperMode: boolean,
  bankroll: number = SPORTS_DEFAULT_BANKROLL,
): Promise<SportsSessionState> {
  const store = getStore(STORE_NAME);
  const key = sessionKey(paperMode);
  try {
    const raw = await store.get(key);
    if (raw) {
      const parsed = JSON.parse(raw as string) as SportsSessionState;
      // Future simVersion guard — auto-archive on bump (same crypto pattern).
      if ((parsed.simVersion ?? 0) < SPORTS_SIM_VERSION) {
        const archiveKey = `archive_sim_v${parsed.simVersion ?? 0}_${Date.now()}`;
        await store.set(archiveKey, raw).catch(() => {});
        const fresh = freshSession(paperMode, bankroll);
        await store.set(key, JSON.stringify(fresh)).catch(() => {});
        return fresh;
      }
      return parsed;
    }
  } catch { /* fall through to fresh */ }
  const fresh = freshSession(paperMode, bankroll);
  try { await store.set(key, JSON.stringify(fresh)); } catch {}
  return fresh;
}

export async function saveSportsSession(s: SportsSessionState): Promise<void> {
  const store = getStore(STORE_NAME);
  try { await store.set(sessionKey(s.paperMode), JSON.stringify(s)); } catch {}
}

export function resetSportsSession(paperMode: boolean, bankroll: number): SportsSessionState {
  return freshSession(paperMode, bankroll);
}

export function stopSportsSession(s: SportsSessionState, reason: string): SportsSessionState {
  return { ...s, stopped: true, stoppedReason: reason };
}

export function resumeSportsSession(s: SportsSessionState): SportsSessionState {
  return { ...s, stopped: false, stoppedReason: null };
}

export function addOpenPosition(s: SportsSessionState, p: SportsPosition): SportsSessionState {
  return { ...s, openPositions: [...s.openPositions, p] };
}

export function closeOpenPosition(
  s: SportsSessionState,
  conditionId: string,
  trade: SportsClosedTrade,
): SportsSessionState {
  const remaining = s.openPositions.filter((p) => p.conditionId !== conditionId);
  const sessionPnL = s.sessionPnL + trade.pnl;
  const sessionLoss = trade.pnl < 0 ? s.sessionLoss + Math.abs(trade.pnl) : s.sessionLoss;
  const bankrollCurrent = s.bankrollCurrent + trade.pnl;
  return {
    ...s,
    openPositions:    remaining,
    closedTrades:     [...s.closedTrades, trade],
    sessionPnL:       parseFloat(sessionPnL.toFixed(4)),
    sessionLoss:      parseFloat(sessionLoss.toFixed(4)),
    bankrollCurrent:  parseFloat(bankrollCurrent.toFixed(4)),
  };
}

export const SPORTS_STORE_NAME = STORE_NAME;
