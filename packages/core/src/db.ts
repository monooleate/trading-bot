// packages/core/db.ts
//
// The single Postgres access point. Every state module (ledger, session,
// settings, trade-log) takes a `Db` so it is trivially testable against an
// embedded PGlite instance — and runs unchanged against the real umami
// postgres:17 (`edgecalc` DB) in production via the `pg` Pool.
//
// `Db` is the minimal surface both `pg.Pool` and `PGlite` already satisfy:
// `.query(text, params) → { rows }`. No ORM; plain parameterised SQL.

import { requireDatabaseUrl } from "./env.ts";

export type Row = Record<string, unknown>;

export interface Db {
  query<R extends Row = Row>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Run one or more statements (DDL / migration files). No params. */
  exec(sql: string): Promise<void>;
}

/** A Db that can run a callback inside a single transaction. */
export interface TxDb extends Db {
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

// ── Production pool (lazy singleton) ────────────────────────────────────────
// `pg` is imported lazily so tests (PGlite) and the type-check never require a
// running Postgres or the pg native bits.
let _pool: TxDb | null = null;

export async function pool(): Promise<TxDb> {
  if (_pool) return _pool;
  const { Pool } = await import("pg");
  const pg = new Pool({ connectionString: requireDatabaseUrl(), max: 10 });
  _pool = {
    query: (text, params) => pg.query(text as string, params as unknown[]) as any,
    exec: async (sql) => { await pg.query(sql); },
    async tx(fn) {
      const client = await pg.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({
          query: (t, p) => client.query(t as string, p as unknown[]) as any,
          exec: async (sql) => { await client.query(sql); },
        });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
  return _pool;
}

/**
 * Wrap any plain `Db` (e.g. a PGlite instance in tests, which has no pooled
 * clients) so it satisfies `TxDb`. PGlite is single-connection, so the "tx"
 * just runs BEGIN/COMMIT on the same handle.
 */
export function asTxDb(db: Db): TxDb {
  return {
    query: db.query.bind(db),
    exec: db.exec.bind(db),
    async tx(fn) {
      await db.query("BEGIN");
      try {
        const out = await fn(db);
        await db.query("COMMIT");
        return out;
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    },
  };
}

/** ISO-8601 string ↔ SQL timestamptz helpers (faithful round-trip). */
export function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return isNaN(n) ? null : n;
}
