// packages/core/ledger.ts
//
// Postgres-backed persistence for the prediction ledger. The PURE logic is
// unchanged — it is re-exported verbatim from ./prediction-ledger.mts (which
// still carries the Blobs adapter for the not-yet-ported Netlify path). Only
// loadLedger/saveLedger/appendPredictions get a Postgres backend here, on the
// `prediction_ledger` table (migration 003). Blobs `store.set(whole array)`
// becomes upsert-per-(category,slug) + prune, matching hetzner-docker-setup §8.
//
// Phase 3 switches the workers from prediction-ledger.mts's loadLedger/append
// to these. reconcileLedger (Gamma fetch) is ported alongside that wiring.

import type { Db, TxDb } from "./db.ts";
import { toIso, toNum } from "./db.ts";
import {
  type PredictionRecord,
  buildIncoming,
  upsertRecords,
  capRecords,
  fillOutcomesFromClosedTrades,
} from "./prediction-ledger.mts";

// Re-export the pure surface so callers import everything ledger-related from
// @core/ledger.ts once ported.
export {
  buildIncoming,
  upsertRecords,
  capRecords,
  yesOutcomeFromClosedTrade,
  fillOutcomesFromClosedTrades,
  computeLedgerStats,
} from "./prediction-ledger.mts";
export type { PredictionRecord, IncomingPrediction, LedgerStats } from "./prediction-ledger.mts";

const DEFAULT_CAP = 3000;

function rowToRecord(r: Record<string, unknown>): PredictionRecord {
  return {
    slug: String(r.slug),
    category: String(r.category),
    firstTs: toIso(r.first_ts) ?? "",
    ts: toIso(r.ts) ?? "",
    conditionId: r.condition_id == null ? null : String(r.condition_id),
    endDate: toIso(r.end_date),
    predictedProb: toNum(r.predicted_prob) ?? 0,
    marketPrice: toNum(r.market_price) ?? 0,
    edge: toNum(r.edge) ?? 0,
    direction: r.direction == null ? "" : String(r.direction),
    taken: Boolean(r.taken),
    lastAction: r.last_action == null ? "" : String(r.last_action),
    skipReason: r.skip_reason == null ? null : String(r.skip_reason),
    signalBreakdown: (r.signal_breakdown as Record<string, number | null> | null) ?? null,
    scans: toNum(r.scans) ?? 1,
    outcome: r.outcome == null ? null : toNum(r.outcome),
    resolvedAt: toIso(r.resolved_at),
  };
}

export async function loadLedger(db: Db, category: string): Promise<PredictionRecord[]> {
  const { rows } = await db.query(
    "SELECT * FROM prediction_ledger WHERE category = $1 ORDER BY first_ts ASC, id ASC",
    [category],
  );
  return rows.map(rowToRecord);
}

/** Replace `category`'s rows with exactly `records` (upsert + prune). */
export async function saveLedger(dbLike: Db | TxDb, category: string, records: PredictionRecord[]): Promise<void> {
  const run = async (db: Db) => {
    for (const r of records) {
      await db.query(
        `INSERT INTO prediction_ledger
           (category, slug, condition_id, end_date, first_ts, ts, predicted_prob,
            market_price, edge, direction, taken, last_action, skip_reason,
            signal_breakdown, scans, outcome, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (category, slug) DO UPDATE SET
           condition_id=EXCLUDED.condition_id, end_date=EXCLUDED.end_date,
           first_ts=EXCLUDED.first_ts, ts=EXCLUDED.ts,
           predicted_prob=EXCLUDED.predicted_prob, market_price=EXCLUDED.market_price,
           edge=EXCLUDED.edge, direction=EXCLUDED.direction, taken=EXCLUDED.taken,
           last_action=EXCLUDED.last_action, skip_reason=EXCLUDED.skip_reason,
           signal_breakdown=EXCLUDED.signal_breakdown, scans=EXCLUDED.scans,
           outcome=EXCLUDED.outcome, resolved_at=EXCLUDED.resolved_at`,
        [
          category, r.slug, r.conditionId, r.endDate, r.firstTs, r.ts, r.predictedProb,
          r.marketPrice, r.edge, r.direction, r.taken, r.lastAction, r.skipReason,
          r.signalBreakdown == null ? null : JSON.stringify(r.signalBreakdown), r.scans,
          r.outcome, r.resolvedAt,
        ],
      );
    }
    // Prune rows no longer in the capped set (honours cap eviction).
    const slugs = records.map((r) => r.slug);
    if (slugs.length > 0) {
      await db.query(
        `DELETE FROM prediction_ledger WHERE category = $1 AND slug <> ALL($2::text[])`,
        [category, slugs],
      );
    } else {
      await db.query("DELETE FROM prediction_ledger WHERE category = $1", [category]);
    }
  };
  if ("tx" in dbLike && typeof (dbLike as TxDb).tx === "function") {
    await (dbLike as TxDb).tx(run);
  } else {
    await run(dbLike);
  }
}

/**
 * Append this tick's scan predictions + fill outcomes for taken markets. Reuses
 * the tested pure fns; best-effort (never throws — a ledger failure must not
 * break a trade tick). Postgres analogue of prediction-ledger.mts appendPredictions.
 */
export async function appendPredictions(
  db: Db | TxDb,
  category: string,
  results: any[],
  markets: any[],
  closedTrades: any[] = [],
  cap: number = DEFAULT_CAP,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const incoming = buildIncoming(results, markets, now);
    if (incoming.length === 0 && (closedTrades?.length ?? 0) === 0) return;
    const existing = await loadLedger(db, category);
    let next = upsertRecords(existing, incoming, category);
    next = fillOutcomesFromClosedTrades(next, closedTrades, now);
    next = capRecords(next, cap);
    await saveLedger(db, category, next);
  } catch {
    /* swallow — never break the tick */
  }
}
