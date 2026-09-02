// packages/core/migrate.ts
//
// Idempotent migration runner. Applies migrations/NNN_*.sql in order, tracking
// applied versions in schema_migrations. Safe to run repeatedly (compose
// `--profile migrate`). Backend-agnostic — takes a `Db`, so the same code runs
// against production `pg` and the PGlite test harness.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Db, TxDb } from "./db.ts";
import { asTxDb } from "./db.ts";

export interface Migration { version: string; sql: string; }

/** Load migrations/*.sql from a directory, sorted by filename. */
export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: f, sql: readFileSync(join(dir, f), "utf8") }));
}

/** Apply the given migrations that have not yet been recorded. Returns the
 *  versions actually applied this run (empty if already up to date). */
export async function applyMigrations(db: Db, migrations: Migration[]): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );`,
  );
  const { rows } = await db.query<{ version: string }>("SELECT version FROM schema_migrations");
  const done = new Set(rows.map((r) => r.version));
  const applied: string[] = [];
  const tdb: TxDb = asTxDb(db);
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    // Apply the file + record the version atomically, so a mid-file failure
    // rolls back cleanly and re-runs from scratch (audit P3). Safe today
    // because all files are idempotent, but this protects future non-idempotent
    // statements (ALTER/backfill).
    await tdb.tx(async (t) => {
      await t.exec(m.sql);
      await t.query("INSERT INTO schema_migrations(version) VALUES ($1)", [m.version]);
    });
    applied.push(m.version);
  }
  return applied;
}

/** Convenience: read + apply from a directory. */
export async function runMigrations(db: Db, dir: string): Promise<string[]> {
  return applyMigrations(db, loadMigrations(dir));
}
