// netlify/functions/auto-trader/hyperliquid/funding-arb/fr-session.mts
// Separate Netlify Blobs store for arb sessions (independent of the
// directional Hyperliquid session — a stopped arb session mustn't block
// directional entries and vice versa).

import { getStore } from "@netlify/blobs";
import type { ArbSessionState, ArbPosition } from "./types.mts";

const STORE     = "hyperliquid-arb-session-v1";
const PAPER_KEY = "arb_paper";
const LIVE_KEY  = "arb_live";

function keyOf(paperMode: boolean): string {
  return paperMode ? PAPER_KEY : LIVE_KEY;
}

function fresh(paperMode: boolean): ArbSessionState {
  return {
    startedAt:            new Date().toISOString(),
    paperMode,
    positions:            [],
    totalFundingAllTime:  0,
    totalFundingToday:    `${today()}:0`,
    stopped:              false,
    stoppedReason:        null,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadArbSession(paperMode: boolean): Promise<ArbSessionState> {
  let store: any = null;
  try { store = getStore(STORE); } catch { return fresh(paperMode); }
  try {
    const raw = await store.get(keyOf(paperMode));
    if (raw) return JSON.parse(raw) as ArbSessionState;
  } catch {}
  return fresh(paperMode);
}

export async function saveArbSession(s: ArbSessionState): Promise<void> {
  try {
    const store = getStore(STORE);
    await store.set(keyOf(s.paperMode), JSON.stringify(s));
  } catch {}
}

export function addArbPosition(s: ArbSessionState, pos: ArbPosition): ArbSessionState {
  return { ...s, positions: [...s.positions, pos] };
}

/**
 * Accrue funding on all open positions since their last update.
 *
 * We are SHORT the HL perp + LONG Binance SPOT — Binance spot pays NO
 * funding, so the income on the carry is purely the HL hourly funding
 * rate × notional × hours. (The Binance funding number is only used at
 * scan time to gate viability: avoid trading when HL pays similarly to
 * Binance futures, since the spread to a hedged position is the relevant
 * benchmark there.) The previous version used `p.entrySpread`, which both
 * (a) double-counted Binance funding as a cost on the spot leg and
 * (b) froze the rate at entry time even when HL funding decayed.
 *
 * If a fresh HL funding rate is supplied via `currentHlFundingByCoin`, we
 * accrue at the latest observed rate (paper realism). When called without
 * a snapshot we fall back to `entryHlFunding` so older positions still
 * accrue something deterministic between cron ticks.
 */
export function accrueFunding(
  s: ArbSessionState,
  now: Date = new Date(),
  currentHlFundingByCoin?: Map<string, number>,
): ArbSessionState {
  const nowMs = now.getTime();
  const todayStr = today();
  let todayTotal = s.totalFundingToday.startsWith(todayStr + ":")
    ? parseFloat(s.totalFundingToday.slice(todayStr.length + 1)) || 0
    : 0;
  let allTimeDelta = 0;

  const positions = s.positions.map(p => {
    if (p.status !== "OPEN") return p;
    const lastMs = new Date(p.lastFundingUpdateAt).getTime();
    const hours  = Math.max(0, (nowMs - lastMs) / 3_600_000);
    if (hours <= 0) return p;

    const observed = currentHlFundingByCoin?.get(p.coin);
    const hourlyRate = Number.isFinite(observed)
      ? (observed as number)
      : p.entryHlFunding;
    // SHORT pays funding when the rate is positive. Sign flows naturally:
    // if HL funding flips negative, the SHORT pays out and accrual goes
    // negative — exactly what we want the tracker to reflect.
    const delta = p.sizeUSDC * hourlyRate * hours;
    todayTotal += delta;
    allTimeDelta += delta;
    return {
      ...p,
      accumulatedFunding: parseFloat((p.accumulatedFunding + delta).toFixed(4)),
      lastFundingUpdateAt: now.toISOString(),
    };
  });

  return {
    ...s,
    positions,
    totalFundingAllTime: parseFloat((s.totalFundingAllTime + allTimeDelta).toFixed(4)),
    totalFundingToday:   `${todayStr}:${todayTotal.toFixed(4)}`,
  };
}

export function replacePosition(s: ArbSessionState, updated: ArbPosition): ArbSessionState {
  return {
    ...s,
    positions: s.positions.map(p => p.id === updated.id ? updated : p),
  };
}

export function openArbPositions(s: ArbSessionState): ArbPosition[] {
  return s.positions.filter(p => p.status === "OPEN");
}

export function deployedCapital(s: ArbSessionState): number {
  return openArbPositions(s).reduce((sum, p) => sum + p.sizeUSDC, 0);
}

export function stopArbSession(s: ArbSessionState, reason: string): ArbSessionState {
  return { ...s, stopped: true, stoppedReason: reason };
}

export function resumeArbSession(s: ArbSessionState): ArbSessionState {
  return { ...s, stopped: false, stoppedReason: null };
}

export function resetArbSession(paperMode: boolean): ArbSessionState {
  return fresh(paperMode);
}
