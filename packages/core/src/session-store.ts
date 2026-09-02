// packages/core/session-store.ts
//
// NORMALIZED per-pillar session persistence (runbook §11.1 decision). Splits
// the Blobs session object into pillar_session + pillar_open_position +
// pillar_closed_trade (migration 005). Save mirrors the Blobs whole-object
// rewrite: upsert the session row, then replace the category's positions and
// closed trades.
//
// Generic across all 5 bots: known scalar keys map to columns; every other
// top-level key (calibrationAlertSentAt, HL leverage on positions, HL pnlUSDC
// on trades, weatherMeta, entryDecision, …) rides in a JSONB residual so any
// bot's concrete shape round-trips losslessly. Timestamps normalize to ISO;
// NUMERIC comes back via toNum (pg returns numeric as string).

import type { Db, TxDb } from "./db.ts";
import { asTxDb, toIso, toNum } from "./db.ts";

export interface StoredSession {
  openPositions?: any[];
  closedTrades?: any[];
  [k: string]: any;
}

// camelCase key → column. Keys not listed fall into the residual JSONB.
const SESSION_COLS: Record<string, string> = {
  startedAt: "started_at",
  bankrollStart: "bankroll_start",
  bankrollCurrent: "bankroll_current",
  sessionPnL: "session_pnl",
  sessionLoss: "session_loss",
  tradeCount: "trade_count",
  paperMode: "paper_mode",
  stopped: "stopped",
  stoppedReason: "stopped_reason",
  simVersion: "sim_version",
  // HL consecutiveLosses/pausedUntil, weather calibrationAlertSentAt, and any
  // other bot-specific session scalar fall into the `extra` JSONB residual.
};
const SESSION_TS = new Set(["started_at"]);
const SESSION_NUM = new Set(["bankroll_start", "bankroll_current", "session_pnl", "session_loss", "trade_count", "sim_version"]);
const SESSION_BOOL = new Set(["paper_mode", "stopped"]);

const POS_COLS: Record<string, string> = {
  market: "market",
  tokenId: "token_id",
  direction: "direction",
  shares: "shares",
  avgEntry: "avg_entry",
  costBasis: "cost_basis",
  openedAt: "opened_at",
  conditionId: "condition_id",
  endDate: "end_date",
  marketPriceAtEntry: "market_price_at_entry",
  predictedProb: "predicted_prob",
};
const POS_TS = new Set(["opened_at", "end_date"]);
const POS_NUM = new Set(["shares", "avg_entry", "cost_basis", "market_price_at_entry", "predicted_prob"]);

const CT_COLS: Record<string, string> = {
  market: "market",
  direction: "direction",
  entryPrice: "entry_price",
  exitPrice: "exit_price",
  shares: "shares",
  pnl: "pnl",
  pnlPct: "pnl_pct",
  openedAt: "opened_at",
  closedAt: "closed_at",
  predictedProb: "predicted_prob",
  marketPriceAtEntry: "market_price_at_entry",
  edgeAtEntry: "edge_at_entry",
  signalBreakdown: "signal_breakdown", // JSONB column, not residual
};
const CT_TS = new Set(["opened_at", "closed_at"]);
const CT_NUM = new Set(["entry_price", "exit_price", "shares", "pnl", "pnl_pct", "predicted_prob", "market_price_at_entry", "edge_at_entry"]);
const CT_JSON = new Set(["signal_breakdown"]);

const col2key = (map: Record<string, string>) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));

// Split an object into {known columns} + {residual keys}, excluding array keys.
function split(obj: Record<string, any>, map: Record<string, string>, exclude: string[] = []) {
  const cols: Record<string, any> = {};
  const residual: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (exclude.includes(k)) continue;
    if (k in map) cols[map[k]] = v;
    else residual[k] = v;
  }
  return { cols, residual };
}

// Reconstruct scalar column values back to their JS types.
function coerce(colVal: unknown, col: string, tsSet: Set<string>, numSet: Set<string>, boolSet?: Set<string>) {
  if (colVal == null) return null;
  if (tsSet.has(col)) return toIso(colVal);
  if (numSet.has(col)) return toNum(colVal);
  if (boolSet?.has(col)) return Boolean(colVal);
  return colVal;
}

function rebuild(
  row: Record<string, unknown>,
  map: Record<string, string>,
  tsSet: Set<string>,
  numSet: Set<string>,
  jsonSet: Set<string>,
  boolSet: Set<string> | undefined,
  residualCol: string,
): Record<string, any> {
  const c2k = col2key(map);
  const out: Record<string, any> = { ...((row[residualCol] as Record<string, any>) ?? {}) };
  for (const [col, key] of Object.entries(c2k)) {
    if (row[col] === undefined) continue;
    if (jsonSet.has(col)) { out[key] = row[col] ?? null; continue; }
    out[key] = coerce(row[col], col, tsSet, numSet, boolSet);
  }
  return out;
}

export type SessionMode = "paper" | "live";

export async function loadSession(db: Db, category: string, mode: SessionMode = "paper"): Promise<StoredSession | null> {
  const s = await db.query("SELECT * FROM pillar_session WHERE category = $1 AND mode = $2", [category, mode]);
  if (s.rows.length === 0) return null;
  const session = rebuild(s.rows[0], SESSION_COLS, SESSION_TS, SESSION_NUM, new Set(), SESSION_BOOL, "extra");

  const pos = await db.query("SELECT * FROM pillar_open_position WHERE category = $1 AND mode = $2 ORDER BY seq ASC, id ASC", [category, mode]);
  session.openPositions = pos.rows.map((r) => rebuild(r, POS_COLS, POS_TS, POS_NUM, new Set(), undefined, "payload"));

  const ct = await db.query("SELECT * FROM pillar_closed_trade WHERE category = $1 AND mode = $2 ORDER BY seq ASC, id ASC", [category, mode]);
  session.closedTrades = ct.rows.map((r) => rebuild(r, CT_COLS, CT_TS, CT_NUM, CT_JSON, undefined, "payload"));

  return session as StoredSession;
}

export async function saveSession(dbLike: Db | TxDb, category: string, session: StoredSession, mode: SessionMode = "paper"): Promise<void> {
  const tdb = asTxDb(dbLike);
  await tdb.tx(async (db) => {
    const { cols, residual } = split(session, SESSION_COLS, ["openPositions", "closedTrades"]);
    const c = (name: string) => (cols[name] ?? null);
    await db.query(
      `INSERT INTO pillar_session
         (category, mode, started_at, bankroll_start, bankroll_current, session_pnl,
          session_loss, trade_count, paper_mode, stopped, stopped_reason,
          sim_version, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (category, mode) DO UPDATE SET
         started_at=EXCLUDED.started_at, bankroll_start=EXCLUDED.bankroll_start,
         bankroll_current=EXCLUDED.bankroll_current, session_pnl=EXCLUDED.session_pnl,
         session_loss=EXCLUDED.session_loss, trade_count=EXCLUDED.trade_count,
         paper_mode=EXCLUDED.paper_mode, stopped=EXCLUDED.stopped,
         stopped_reason=EXCLUDED.stopped_reason, sim_version=EXCLUDED.sim_version,
         extra=EXCLUDED.extra`,
      [
        category, mode, c("started_at"), c("bankroll_start"), c("bankroll_current"), c("session_pnl"),
        c("session_loss") ?? 0, c("trade_count") ?? 0, c("paper_mode") ?? true, c("stopped") ?? false,
        c("stopped_reason"), c("sim_version"),
        JSON.stringify(residual),
      ],
    );

    await db.query("DELETE FROM pillar_open_position WHERE category = $1 AND mode = $2", [category, mode]);
    const positions = session.openPositions ?? [];
    for (let i = 0; i < positions.length; i++) {
      const { cols: pc, residual: pr } = split(positions[i], POS_COLS);
      const g = (n: string) => (pc[n] ?? null);
      await db.query(
        `INSERT INTO pillar_open_position
           (category, mode, seq, market, token_id, direction, shares, avg_entry, cost_basis,
            opened_at, condition_id, end_date, market_price_at_entry, predicted_prob, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
        [
          category, mode, i, g("market"), g("token_id"), g("direction"), g("shares"), g("avg_entry"),
          g("cost_basis"), g("opened_at"), g("condition_id"), g("end_date"),
          g("market_price_at_entry"), g("predicted_prob"), JSON.stringify(pr),
        ],
      );
    }

    await db.query("DELETE FROM pillar_closed_trade WHERE category = $1 AND mode = $2", [category, mode]);
    const trades = session.closedTrades ?? [];
    for (let i = 0; i < trades.length; i++) {
      const { cols: tc, residual: tr } = split(trades[i], CT_COLS);
      const g = (n: string) => (tc[n] ?? null);
      await db.query(
        `INSERT INTO pillar_closed_trade
           (category, mode, seq, market, direction, entry_price, exit_price, shares, pnl, pnl_pct,
            opened_at, closed_at, predicted_prob, market_price_at_entry, edge_at_entry,
            signal_breakdown, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb)`,
        [
          category, mode, i, g("market"), g("direction"), g("entry_price"), g("exit_price"), g("shares"),
          g("pnl"), g("pnl_pct"), g("opened_at"), g("closed_at"), g("predicted_prob"),
          g("market_price_at_entry"), g("edge_at_entry"),
          tc["signal_breakdown"] == null ? null : JSON.stringify(tc["signal_breakdown"]),
          JSON.stringify(tr),
        ],
      );
    }
  });
}
