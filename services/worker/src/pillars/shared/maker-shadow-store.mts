// services/worker/src/pillars/shared/maker-shadow-store.mts
//
// B77 — persistence + per-tick processing for the SHADOW maker orders
// (@core/maker-shadow.mts holds the pure model and its rationale). Measurement
// only: nothing here opens a position, sizes a trade or changes a decision, and
// every function is best-effort and non-throwing — a shadow failure must never
// touch a tick.
//
// Cost control: per tick at most `MAX_BOOKS` distinct order books are fetched
// (oldest-observed first) and at most `MAX_RESOLUTIONS` Gamma lookups are made,
// so a growing backlog cannot slow the scan. A ladder is placed at most once per
// (market, side) per `LADDER_COOLDOWN_MS`, which also keeps the store small.
//
// Not backfillable: whether a resting order would have filled depends on the
// book over the following minutes, which is gone once the tick has passed
// (same doctrine as the OI / CLOB-book recorders, B50 #2). Default ON.

import { getStore } from "@netlify/blobs";
import { fetchGammaYesResolution } from "@core/prediction-ledger.mts";
import {
  planMakerLadder,
  observeShadowOrder,
  settleShadowOrder,
  capShadowOrders,
  type MakerShadowOrder,
  type PlanInput,
} from "@core/maker-shadow.mts";
import { fetchClobBook } from "./clob-book.mts";
import { log } from "./logger.mts";

const STORE = "maker-shadow";
const KEY = "v1";
export const SHADOW_CAP = 900;
const MAX_BOOKS = 8;
const MAX_RESOLUTIONS = 6;
const RESOLVE_GRACE_MS = 30 * 60_000;         // let UMA settle before asking Gamma
const LADDER_COOLDOWN_MS = 6 * 3600_000;
const NO_ROOM_MS = 30 * 60_000;
// (market, side) pairs where the last attempt found no feasible rung (every rung
// marketable, or no ask) — skip re-fetching the book every 3-minute tick.
const noRoomUntil = new Map<string, number>();

const num = (v: string | undefined, d: number) => {
  const n = v == null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

export interface ShadowSettings {
  ladder: number[];
  ttlMs: number;
  notionalUsdc: number;
}

/** Ladder / TTL / size — env-tunable, defaults match the B77 design. */
export function shadowSettings(): ShadowSettings {
  const ladder = (process.env.MAKER_SHADOW_LADDER ?? "0.05,0.10,0.15")
    .split(",").map((s) => parseFloat(s)).filter((x) => Number.isFinite(x) && x > 0 && x < 0.9);
  return {
    ladder: ladder.length ? ladder : [0.05, 0.10, 0.15],
    ttlMs: num(process.env.MAKER_SHADOW_TTL_MIN, 120) * 60_000,
    notionalUsdc: num(process.env.MAKER_SHADOW_NOTIONAL_USDC, 10),
  };
}

export async function loadShadowOrders(): Promise<MakerShadowOrder[]> {
  try {
    const raw = await getStore(STORE).get(KEY);
    if (!raw) return [];
    const p = JSON.parse(raw as string);
    return Array.isArray(p?.orders) ? (p.orders as MakerShadowOrder[]) : [];
  } catch {
    return [];
  }
}

export async function saveShadowOrders(orders: MakerShadowOrder[]): Promise<void> {
  try {
    await getStore(STORE).set(KEY, JSON.stringify({ orders: capShadowOrders(orders, SHADOW_CAP), savedAt: new Date().toISOString() }));
  } catch { /* best-effort */ }
}

/**
 * The price-DEPENDENT gates. A decision that fails ONLY these would have been a
 * trade at a better price — the maker hypothesis. Anything else failing (model
 * error, resolution risk, confidence, cross-position, sanity cap …) is not a
 * price question and gets no shadow order.
 */
const PRICE_DEPENDENT_GATES = new Set(["Net edge ≥ küszöb", "Kelly méret ≥ minimum"]);

/** True when at least one gate failed and every failed gate is price-dependent. Pure. */
export function isMakerShadowEligible(gates: ReadonlyArray<{ label: string; passed: boolean }>): boolean {
  const failed = gates.filter((g) => !g.passed);
  return failed.length > 0 && failed.every((g) => PRICE_DEPENDENT_GATES.has(g.label));
}

function bestOf(book: { asks: { price: number }[]; bids: { price: number }[] } | null) {
  if (!book || book.asks.length === 0) return null;
  return {
    bestAsk: Math.min(...book.asks.map((l) => l.price)),
    bestBid: book.bids.length ? Math.max(...book.bids.map((l) => l.price)) : null,
  };
}

/** Is there already a live or recent ladder for this (market, side)? Pure. */
export function hasRecentLadder(orders: readonly MakerShadowOrder[], slug: string, direction: "YES" | "NO", now: number): boolean {
  return orders.some((o) => o.slug === slug && o.direction === direction && (o.status === "pending" || now - o.placedAt < LADDER_COOLDOWN_MS));
}

export type ShadowPlan = Omit<PlanInput, "book" | "ladder" | "ttlMs" | "notionalUsdc" | "now">;

/**
 * Fetch the token book and place a ladder for one opportunity. Mutates
 * `orders` (push) and returns how many were placed. No book / no asks → 0.
 */
export async function placeShadowLadder(orders: MakerShadowOrder[], plan: ShadowPlan, now = Date.now()): Promise<number> {
  try {
    if (hasRecentLadder(orders, plan.slug, plan.direction, now)) return 0;
    const key = `${plan.slug}|${plan.direction}`;
    if ((noRoomUntil.get(key) ?? 0) > now) return 0;
    const b = bestOf(await fetchClobBook(plan.tokenId));
    if (!b) { noRoomUntil.set(key, now + NO_ROOM_MS); return 0; }
    const s = shadowSettings();
    const placed = planMakerLadder({ ...plan, book: b, ladder: s.ladder, ttlMs: s.ttlMs, notionalUsdc: s.notionalUsdc, now });
    if (placed.length === 0) noRoomUntil.set(key, now + NO_ROOM_MS);
    for (const o of placed) {
      orders.push(o);
      log("MAKER_SHADOW", true, {
        phase: "placed", slug: o.slug, direction: o.direction, targetEdge: o.targetEdge, limit: o.limit,
        bestBid: o.bestBid, bestAsk: o.bestAsk, pSide: +o.pSide.toFixed(4), effectiveEdge: o.effectiveEdge,
      });
    }
    return placed.length;
  } catch {
    return 0;
  }
}

export interface ProcessResult { orders: MakerShadowOrder[]; changed: boolean; booksFetched: number; filled: number; settled: number }

/**
 * One tick of bookkeeping: observe pending orders against fresh books, expire
 * the late ones, and settle finished markets against Gamma. Returns a NEW array.
 */
export async function processShadowOrders(orders: MakerShadowOrder[], exitFeePct: number, now = Date.now()): Promise<ProcessResult> {
  let changed = false, booksFetched = 0, filledN = 0, settledN = 0;
  let next = orders.slice();
  try {
    // 1) observe pending orders — book-by-token, oldest-observed first, bounded.
    const pendingByToken = new Map<string, number[]>();
    next.forEach((o, i) => {
      if (o.status !== "pending") return;
      (pendingByToken.get(o.tokenId) ?? pendingByToken.set(o.tokenId, []).get(o.tokenId)!).push(i);
    });
    const tokens = [...pendingByToken.entries()]
      .sort((a, b) => Math.min(...a[1].map((i) => next[i].lastCheckedAt ?? next[i].placedAt)) - Math.min(...b[1].map((i) => next[i].lastCheckedAt ?? next[i].placedAt)))
      .map(([t]) => t);
    const fetched = new Set(tokens.slice(0, MAX_BOOKS));
    for (const tok of tokens) {
      let bestAsk: number | null = null;
      if (fetched.has(tok)) {
        const b = bestOf(await fetchClobBook(tok));
        booksFetched++;
        bestAsk = b ? b.bestAsk : null;
      }
      for (const i of pendingByToken.get(tok)!) {
        const before = next[i];
        // A token whose book we did not fetch this tick still gets its late orders expired.
        const after = fetched.has(tok) || now > before.expiresAt ? observeShadowOrder(before, bestAsk, now) : before;
        if (after !== before) {
          next[i] = after;
          changed = true;
          if (after.status === "filled") {
            filledN++;
            log("MAKER_SHADOW", true, { phase: "filled", slug: after.slug, direction: after.direction, targetEdge: after.targetEdge, limit: after.limit, fillAsk: after.fillAsk, minutes: +(((after.filledAt ?? now) - after.placedAt) / 60_000).toFixed(1) });
          } else if (after.status === "expired") {
            log("MAKER_SHADOW", true, { phase: "expired", slug: after.slug, direction: after.direction, targetEdge: after.targetEdge, limit: after.limit, checks: after.checks });
          }
        }
      }
    }

    // 2) settle finished markets (every order — the unfilled ones carry the
    //    adverse-selection comparison), a bounded number of Gamma lookups per tick.
    const due = new Map<string, number[]>();
    next.forEach((o, i) => {
      if (o.outcomeYes !== undefined || o.status === "pending" || !o.conditionId || !o.endDate) return;
      if (!(Date.parse(o.endDate) + RESOLVE_GRACE_MS < now)) return;
      (due.get(o.conditionId) ?? due.set(o.conditionId, []).get(o.conditionId)!).push(i);
    });
    for (const [cond, idx] of [...due.entries()].slice(0, MAX_RESOLUTIONS)) {
      const yes = await fetchGammaYesResolution(cond);
      if (yes === null) continue;
      for (const i of idx) {
        next[i] = settleShadowOrder(next[i], yes as 0 | 1, exitFeePct, now);
        settledN++;
        changed = true;
        if (next[i].status === "filled") {
          log("MAKER_SHADOW", true, { phase: "settled", slug: next[i].slug, direction: next[i].direction, targetEdge: next[i].targetEdge, outcomeYes: yes, pnl: next[i].pnl });
        }
      }
    }
  } catch { /* best-effort: return whatever was processed */ }
  return { orders: next, changed, booksFetched, filled: filledN, settled: settledN };
}
