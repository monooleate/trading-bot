// packages/core/settings-store.ts
//
// Postgres backend for the trader-settings / user-settings Blobs overrides
// (migration 002, `settings` KV). Value is arbitrary JSON. Keys mirror the
// Blobs keys, e.g. "trader:crypto", "user". Phase 3 points trader-settings.mts
// at these instead of getStore("trader-settings").

import type { Db } from "./db.ts";

export async function getSetting<T = unknown>(db: Db, key: string): Promise<T | null> {
  const { rows } = await db.query<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows.length ? rows[0].value : null;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.query("DELETE FROM settings WHERE key = $1", [key]);
}

export async function listSettings(db: Db, prefix?: string): Promise<Record<string, unknown>> {
  const { rows } = prefix
    ? await db.query<{ key: string; value: unknown }>(
        "SELECT key, value FROM settings WHERE key LIKE $1", [`${prefix}%`])
    : await db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings");
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
