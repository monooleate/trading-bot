// packages/core/src/market-recorder.mts
//
// Log-forward market-data recorder — model-discovery-training §3.B / #2 (B50).
// Pure, portable (zero I/O). The I/O + scheduling live in the worker
// (services/worker/src/recorders/); this file is the pure record shaping,
// capping, throttling, and API-response parsing so every piece is unit-tested.
//
// WHY: the highest-value training data is NOT retrievable retroactively —
//   • crypto open interest: Binance keeps only ~30 days (Bybit less) → the OI-Δ
//     signal (B49 #5) can never be calibrated on history that was not logged;
//   • Polymarket order-book DEPTH: there is NO historical `/book` endpoint at all
//     → the depth-aware fill model (B49 #1) and Kyle-λ/VPIN have no past substrate.
// So every non-logged day is permanently lost. These recorders start the forward
// log NOW (default-OFF env flags — flip on + deploy to begin capturing). Deribit
// IV-surface and Pinnacle live-close are the same class and are documented
// follow-ups (surface reduction / paid feed); HL L2 needs a persistent WS worker.

// ─── Snapshot shapes (compact — this is bulk time-series) ───────────────────
export interface OiSnapshot {
  ts: number;        // capture time (ms)
  oi: number;        // sum open interest (contracts)
  oiValue: number;   // sum open interest (USD notional) — price ≈ oiValue/oi
}

export interface BookSnapshot {
  ts: number;
  tokenId: string;
  slug: string;
  asks: [number, number][];   // [price, size] best-first (ascending price)
  bids: [number, number][];   // [price, size] best-first (descending price)
}

/**
 * Keep the newest `max` snapshots by `ts` (rolling append-only window). Assumes
 * new records are appended after old; sorts defensively so out-of-order appends
 * still drop the OLDEST. Pure.
 */
export function capSnapshots<T extends { ts: number }>(records: T[], max: number): T[] {
  if (!Array.isArray(records)) return [];
  if (max <= 0) return [];
  if (records.length <= max) return records;
  return records.slice().sort((a, b) => a.ts - b.ts).slice(-max);
}

/**
 * Throttle: true if the stream is empty or its newest record is at least
 * `minIntervalMs` old — so a per-stream cadence (e.g. OI every 15 min) can be
 * coarser than the worker tick (3 min), stretching a fixed cap over more days. Pure.
 */
export function dueForSnapshot(
  records: { ts: number }[], nowMs: number, minIntervalMs: number,
): boolean {
  if (!records || records.length === 0) return true;
  let newest = -Infinity;
  for (const r of records) if (Number.isFinite(r.ts) && r.ts > newest) newest = r.ts;
  if (!Number.isFinite(newest)) return true;
  return nowMs - newest >= minIntervalMs;
}

/**
 * Parse Binance `futures/data/openInterestHist` (array of
 * {sumOpenInterest, sumOpenInterestValue, timestamp}) → the latest OI + USD
 * value, or null if unusable. Pure.
 */
export function parseBinanceOiHist(raw: unknown): { oi: number; oiValue: number } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const last: any = raw[raw.length - 1];
  const oi = Number(last?.sumOpenInterest);
  if (!Number.isFinite(oi) || oi <= 0) return null;
  const oiValue = Number(last?.sumOpenInterestValue);
  return { oi, oiValue: Number.isFinite(oiValue) && oiValue >= 0 ? oiValue : 0 };
}

/**
 * Reduce a full CLOB book to the top-N levels each side, best-first, as compact
 * [price, size] tuples (asks ascending, bids descending). Pure.
 */
export function compactBook(
  book: { asks: { price: number; size: number }[]; bids: { price: number; size: number }[] },
  topN = 10,
): { asks: [number, number][]; bids: [number, number][] } {
  const clean = (arr: { price: number; size: number }[] | undefined) =>
    (Array.isArray(arr) ? arr : []).filter(
      (l) => Number.isFinite(l?.price) && Number.isFinite(l?.size) && l.size > 0,
    );
  const asks = clean(book?.asks).sort((a, b) => a.price - b.price).slice(0, topN)
    .map((l) => [l.price, l.size] as [number, number]);
  const bids = clean(book?.bids).sort((a, b) => b.price - a.price).slice(0, topN)
    .map((l) => [l.price, l.size] as [number, number]);
  return { asks, bids };
}
