import { getStore } from "@netlify/blobs";
import { log } from "../shared/logger.mts";
import type { SessionState, Position, ClosedTrade } from "../shared/types.mts";

const STORE_KEY = "auto-trader-session";
const LIVE_STORE_KEY = "auto-trader-session-live";

function sessionKey(paperMode: boolean, category?: string): string {
  const base = paperMode ? STORE_KEY : LIVE_STORE_KEY;
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
      // Ensure paperMode matches
      if (parsed.paperMode === paperMode) return parsed;
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
  const remaining = session.openPositions.filter((p) => p.buyOrderId !== buyOrderId);
  const newPnL = session.sessionPnL + trade.pnl;
  const newLoss = trade.pnl < 0
    ? session.sessionLoss + Math.abs(trade.pnl)
    : session.sessionLoss;

  return {
    ...session,
    openPositions: remaining,
    closedTrades: [...session.closedTrades, trade],
    tradeCount: session.tradeCount + 1,
    sessionPnL: newPnL,
    sessionLoss: newLoss,
    bankrollCurrent: session.bankrollCurrent + trade.shares * trade.exitPrice,
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

export function resetSession(bankroll: number, paperMode: boolean): SessionState {
  const session = defaultSession(bankroll, paperMode);
  log("SESSION_START", paperMode, { bankroll });
  return session;
}
