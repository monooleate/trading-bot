// services/worker/src/recorders/index.mts
//
// Log-forward market-data recorders — model-discovery-training §3.B / #2 (B50).
// Runs best-effort each worker tick (main.ts). Captures the data that is NOT
// retrievable retroactively so the training substrate starts accumulating NOW:
//   • OI  — Binance open interest (BTC/ETH/SOL), only ~30 days retained by the
//           API → the OI-Δ signal (B49 #5) needs the forward log.
//   • BOOK — Polymarket /book depth for currently-open crypto+weather positions,
//           no historical endpoint at all → the depth-aware fill model (B49 #1)
//           and Kyle-λ/VPIN need the forward log.
//
// DEFAULT-OFF: each recorder is gated by an env flag (RECORD_OI / RECORD_CLOB_BOOK
// = "true"|"1"). Zero trading impact — read-only external fetches + writes to a
// dedicated `market-recorder` KV store (→ blob_kv). Every fetch/parse is
// exception-safe: a recorder failure must never break the trade tick.
//
// Follow-ups (same #2, not yet wired): Deribit IV-surface snapshot (needs
// near-the-money surface reduction), Pinnacle live-close (needs the-odds-api key
// + sports live), HL l2Book/OI (needs a persistent WS worker → Hetzner phase).

import { getStore } from "@netlify/blobs";
import { pool } from "@core/db.ts";
import { loadSession } from "@core/session-store.ts";
import {
  capSnapshots, dueForSnapshot, parseBinanceOiHist, compactBook,
  type OiSnapshot, type BookSnapshot,
} from "@core/market-recorder.mts";
import { fetchClobBook } from "../pillars/shared/clob-book.mts";

const STORE = "market-recorder";
const BN_FUTURES = "https://fapi.binance.com";

// Recorder env is read directly from process.env (like the ~100 pillar tuning
// knobs) — the zod env schema validates infra vars only.
const flagOn = (v: string | undefined) => v === "true" || v === "1";
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

async function loadStream<T>(key: string): Promise<T[]> {
  try {
    const raw = await getStore(STORE).get(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw as string);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch { return []; }
}
async function saveStream(key: string, records: unknown[]): Promise<void> {
  try { await getStore(STORE).set(key, JSON.stringify(records)); }
  catch { /* best-effort: a recorder must never break the tick */ }
}

/** Snapshot Binance OI for each coin, throttled per-coin, one capped stream/coin. */
async function recordOi(coins: string[], nowMs: number, minIntervalMs: number, cap: number): Promise<void> {
  for (const coin of coins) {
    try {
      const key = `oi-${coin}`;
      const existing = await loadStream<OiSnapshot>(key);
      if (!dueForSnapshot(existing, nowMs, minIntervalMs)) continue;
      const res = await fetch(
        `${BN_FUTURES}/futures/data/openInterestHist?symbol=${coin}USDT&period=5m&limit=1`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) continue;
      const parsed = parseBinanceOiHist(await res.json());
      if (!parsed) continue;
      const next = capSnapshots<OiSnapshot>([...existing, { ts: nowMs, ...parsed }], cap);
      await saveStream(key, next);
    } catch { /* skip this coin */ }
  }
}

/** Snapshot the CLOB book for every open crypto+weather position, one capped stream. */
async function recordBooks(nowMs: number, cap: number): Promise<void> {
  try {
    const db = await pool();
    const tokens = new Map<string, string>();   // tokenId → slug
    for (const cat of ["crypto", "weather"]) {
      for (const mode of ["paper", "live"] as const) {
        try {
          const s = await loadSession(db, cat, mode);
          for (const p of (s?.openPositions ?? []) as any[]) {
            const tid = String(p?.tokenId ?? "");
            if (tid) tokens.set(tid, String(p?.market ?? ""));
          }
        } catch { /* no session for this cat/mode */ }
      }
    }
    if (tokens.size === 0) return;   // nothing open → nothing to snapshot

    const additions: BookSnapshot[] = [];
    for (const [tokenId, slug] of tokens) {
      const book = await fetchClobBook(tokenId);
      if (!book) continue;
      const c = compactBook(book);
      if (c.asks.length === 0 && c.bids.length === 0) continue;
      additions.push({ ts: nowMs, tokenId, slug, asks: c.asks, bids: c.bids });
    }
    if (additions.length === 0) return;

    const key = "clob-book";
    const stream = await loadStream<BookSnapshot>(key);
    await saveStream(key, capSnapshots<BookSnapshot>([...stream, ...additions], cap));
  } catch { /* never break the tick */ }
}

/**
 * Run all enabled recorders once. Best-effort; called from the worker tick.
 * Each recorder is independently env-gated and independently exception-safe.
 */
export async function runRecorders(nowMs: number = Date.now()): Promise<void> {
  if (flagOn(process.env.RECORD_OI)) {
    const coins = String(process.env.RECORDER_OI_COINS ?? "BTC,ETH,SOL")
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    await recordOi(coins, nowMs, num(process.env.RECORDER_OI_INTERVAL_SEC, 900) * 1000, num(process.env.RECORDER_OI_CAP, 5000));
  }
  if (flagOn(process.env.RECORD_CLOB_BOOK)) {
    await recordBooks(nowMs, num(process.env.RECORDER_BOOK_CAP, 5000));
  }
}
