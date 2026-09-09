// netlify/functions/auto-trader/sports/session-manager.mts
//
// Per-bot Blobs session storage. Same pattern as crypto/weather/HL —
// each bot has its own `auto-trader-session-sports` store key, paper
// and live separated by suffix.

import { getStore } from "@netlify/blobs";
import type { SportsSessionState, SportsPosition, SportsClosedTrade } from "./types.mts";
import { SPORTS_DEFAULT_BANKROLL, SPORTS_SIM_VERSION } from "./config.mts";

import { isAutoStopReason } from "../shared/paper-never-stop.mts";

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
        // Audit P2-9: a schema bump must not silently restart a bot the operator
        // deliberately stopped. Carry a MANUAL stop across the migration — an
        // auto-stop (loss limit, consecutive losses) is correctly cleared,
        // since the new sim version invalidates the odometer that produced it.
        if (parsed.stopped && !isAutoStopReason(parsed.stoppedReason)) {
          fresh.stopped = true;
          fresh.stoppedReason = parsed.stoppedReason;
        }
        await store.set(key, JSON.stringify(fresh)).catch(() => {});
        return fresh;
      }
      return parsed;
    }
  } catch {
    // Audit P2-9: do NOT persist a fresh session here. This catch fires on a
    // transient read failure or a malformed payload — and the old code answered
    // by WRITING a brand-new, un-stopped session over the top, destroying an
    // operator's manual stop (and the bankroll, and the trade history) on what
    // may have been a one-tick blip. Hand back a fresh object so the caller can
    // proceed, but leave the stored value alone so the next successful read
    // recovers it. Nothing downstream distinguishes "fresh" from "restored", so
    // this is safe; only the write was ever load-bearing.
    return freshSession(paperMode, bankroll);
  }
  // No stored session at all (genuinely first run) — persist the fresh one.
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

// Non-destructive bankroll injection (2026-05-29) — mirror of crypto/HL/F-Arb
// topup. Preserves closedTrades, sessionPnL, sessionLoss, openPositions,
// stopped state — only the bankroll grows.
export function topupSportsSession(s: SportsSessionState, amount: number): SportsSessionState {
  return {
    ...s,
    bankrollStart:   parseFloat((s.bankrollStart   + amount).toFixed(4)),
    bankrollCurrent: parseFloat((s.bankrollCurrent + amount).toFixed(4)),
  };
}

export function addOpenPosition(s: SportsSessionState, p: SportsPosition): SportsSessionState {
  // Audit P2-10: reserve the committed capital, exactly as crypto does
  // (crypto/session-manager.mts `addOpenPosition`). Sports was the only bot
  // that did not, so `bankrollCurrent` reported free capital that was already
  // spent — measured live: $50.00 shown with $7.50 committed across three open
  // positions, a 15% overstatement at the 3-position cap. Kelly sizes off that
  // number, so every position after the first was sized against money the bot
  // did not have. Crypto and weather both reconcile to the cent; only sports
  // did not.
  return {
    ...s,
    openPositions: [...s.openPositions, p],
    bankrollCurrent: parseFloat((s.bankrollCurrent - (p.costBasis || 0)).toFixed(4)),
  };
}

export function closeOpenPosition(
  s: SportsSessionState,
  conditionId: string,
  trade: SportsClosedTrade,
): SportsSessionState {
  const remaining = s.openPositions.filter((p) => p.conditionId !== conditionId);
  const sessionPnL = s.sessionPnL + trade.pnl;
  const sessionLoss = trade.pnl < 0 ? s.sessionLoss + Math.abs(trade.pnl) : s.sessionLoss;
  // P2-10: the cost basis debited at open now "returns", and the net pnl applies
  // on top — keeping `bankrollStart + sessionPnL === bankrollCurrent` once every
  // position is closed. Same arithmetic as crypto's closePosition (see the 2026-
  // 05-11 audit note there about using pnl + costBasis rather than gross
  // proceeds, which would silently skip the roundtrip fee).
  const closedPos = s.openPositions.find((p) => p.conditionId === conditionId);
  const bankrollCurrent = s.bankrollCurrent + trade.pnl + (closedPos?.costBasis || 0);
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
