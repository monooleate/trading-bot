// packages/core/blobs-compat.test.mts
//
// The Netlify Blobs compat facade against a real Postgres (PGlite): durable
// stores persist to blob_kv, *-cache stores stay in-process, get/set/
// getWithMetadata/delete behave like @netlify/blobs.
//
// Run: npx tsx packages/core/src/blobs-compat.test.mts

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db.ts";
import { runMigrations } from "./migrate.ts";
import { getStore, setBlobsDb } from "./blobs-compat.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
const wrap = (pg: PGlite): Db => ({ query: (t, p) => pg.query(t, p as any[]) as any, exec: async (s) => { await pg.exec(s); } });

let passed = 0;
const ok = (l: string) => { console.log(`  ✓ ${l}`); passed++; };

async function main() {
  const pg = new PGlite();
  const db = wrap(pg);
  await runMigrations(db, MIGRATIONS_DIR);
  setBlobsDb(db);

  // durable store → Postgres blob_kv
  const s = getStore("crypto-runtime");
  assert.equal(await s.get("v1"), null, "missing key → null");
  await s.set("v1", JSON.stringify({ lastRun: "2026-09-02T10:00:00Z", source: "cron" }));
  assert.deepStrictEqual(JSON.parse((await s.get("v1"))!), { lastRun: "2026-09-02T10:00:00Z", source: "cron" });
  ok("durable get/set round-trip (Postgres)");

  await s.set("v1", JSON.stringify({ lastRun: "later" }));
  assert.deepStrictEqual(JSON.parse((await s.get("v1"))!), { lastRun: "later" }, "durable upsert");
  ok("durable upsert");

  // persistence across a fresh getStore() handle (proves it's not just the closure)
  const s2 = getStore("crypto-runtime");
  assert.equal(JSON.parse((await s2.get("v1"))!).lastRun, "later");
  ok("durable persists across handles");

  await s.delete("v1");
  assert.equal(await s.get("v1"), null, "durable delete");
  ok("durable delete");

  // metadata round-trip (the cache TTL pattern) on a durable store
  const meta = getStore("trade-log-v1");
  await meta.set("k", "payload", { metadata: { ts: 1234567890 } });
  const wm = await meta.getWithMetadata("k");
  assert.deepStrictEqual(wm, { data: "payload", metadata: { ts: 1234567890 } });
  ok("getWithMetadata round-trip");

  // *-cache store → in-process (NOT in blob_kv)
  const cache = getStore("vol-divergence-cache-v3");
  await cache.set("BTC", "cached", { metadata: { ts: Date.now() } });
  assert.equal(await cache.get("BTC"), "cached", "cache get/set (in-process)");
  const { rows } = await db.query("SELECT count(*)::int AS n FROM blob_kv WHERE store = $1", ["vol-divergence-cache-v3"]);
  assert.equal((rows[0] as any).n, 0, "cache store must NOT hit Postgres");
  ok("cache store stays in-process (not persisted)");

  // db-less fallback → in-process (nothing throws)
  setBlobsDb(null);
  const fb = getStore("some-durable-store");
  await fb.set("x", "y");
  assert.equal(await fb.get("x"), "y", "db-less durable falls back to in-process");
  ok("db-less fallback in-process");

  await pg.close();
  console.log(`\nblobs-compat.test: all ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
