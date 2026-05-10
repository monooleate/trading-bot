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
    totalFundingToday:    { date: today(), amount: 0 },
    stopped:              false,
    stoppedReason:        null,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Backwards-compat: older blobs stored totalFundingToday as a "YYYY-MM-DD:N"
// string. Coerce to the typed shape on load so the rest of the codebase
// only ever sees the object form.
function migrateTodayShape(raw: any): { date: string; amount: number } {
  if (raw && typeof raw === "object" && typeof raw.date === "string") {
    return { date: raw.date, amount: Number(raw.amount) || 0 };
  }
  if (typeof raw === "string") {
    const idx = raw.indexOf(":");
    if (idx > 0) {
      const date = raw.slice(0, idx);
      const amount = parseFloat(raw.slice(idx + 1)) || 0;
      return { date, amount };
    }
  }
  return { date: today(), amount: 0 };
}

export async function loadArbSession(paperMode: boolean): Promise<ArbSessionState> {
  let store: any = null;
  try { store = getStore(STORE); } catch { return fresh(paperMode); }
  try {
    const raw = await store.get(keyOf(paperMode));
    if (raw) {
      const parsed = JSON.parse(raw) as ArbSessionState;
      parsed.totalFundingToday = migrateTodayShape(parsed.totalFundingToday as any);
      return parsed;
    }
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
 * rate × CURRENT POSITION VALUE × hours. (The Binance funding number is
 * only used at scan time to gate viability: avoid trading when HL pays
 * similarly to Binance futures, since the spread to a hedged position is
 * the relevant benchmark there.) The previous version used
 * `p.entrySpread`, which both (a) double-counted Binance funding as a
 * cost on the spot leg and (b) froze the rate at entry time even when HL
 * funding decayed.
 *
 * Real HL funding is paid on `position_size_in_coins × current_mark_price
 * × rate`, NOT on the dollar notional at entry. When the underlying drifts
 * 5–10% during the hold, fixing the notional at entry biases accumulated
 * funding by the same percentage. We now mark-to-market by passing
 * `currentHlByCoin` carrying both the latest hourly rate AND the latest
 * markPrice; accrual uses `sizeCoins × markPrice` for the per-hour
 * notional so paper PnL tracks what live HL would have actually paid.
 *
 * Backwards compatible: if the snapshot is missing or the price/rate is
 * not finite, accrual falls back to entry-time inputs (older deterministic
 * behavior). The previous `Map<string, number>` rate-only signature is
 * also still accepted so existing callers keep working until they migrate.
 */
export interface AccrueSnapshot {
  rate: number;
  markPrice: number;
}
export function accrueFunding(
  s: ArbSessionState,
  now: Date = new Date(),
  currentHlByCoin?: Map<string, number | AccrueSnapshot>,
): ArbSessionState {
  const nowMs = now.getTime();
  const todayStr = today();
  // Roll over the daily total when the UTC date changes. The typed object
  // makes this a single string compare instead of the previous prefix slice.
  let todayTotal = s.totalFundingToday.date === todayStr
    ? s.totalFundingToday.amount
    : 0;
  let allTimeDelta = 0;

  const positions = s.positions.map(p => {
    if (p.status !== "OPEN") return p;
    const lastMs = new Date(p.lastFundingUpdateAt).getTime();
    const hours  = Math.max(0, (nowMs - lastMs) / 3_600_000);
    if (hours <= 0) return p;

    const observed = currentHlByCoin?.get(p.coin);
    let hourlyRate: number;
    let markPrice: number;
    if (typeof observed === "number") {
      // Legacy rate-only snapshot — fall back to entry mark for the notional.
      hourlyRate = Number.isFinite(observed) ? observed : p.entryHlFunding;
      markPrice  = p.hlEntryPrice;
    } else if (observed && typeof observed === "object") {
      hourlyRate = Number.isFinite(observed.rate)      ? observed.rate      : p.entryHlFunding;
      markPrice  = Number.isFinite(observed.markPrice) ? observed.markPrice : p.hlEntryPrice;
    } else {
      hourlyRate = p.entryHlFunding;
      markPrice  = p.hlEntryPrice;
    }
    // Mark-to-market notional: position_size_in_coins × current_mark_price.
    // The SHORT receives funding when rate > 0 (sign flows naturally — a
    // negative rate flips accrual into a payout, exactly what the tracker
    // should reflect).
    const notional = Math.abs(p.sizeCoins) * markPrice;
    const delta    = notional * hourlyRate * hours;
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
    totalFundingToday:   { date: todayStr, amount: parseFloat(todayTotal.toFixed(4)) },
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
