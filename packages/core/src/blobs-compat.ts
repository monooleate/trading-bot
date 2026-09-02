// packages/core/blobs-compat.ts
//
// A drop-in replacement for @netlify/blobs' getStore(), backed by Postgres
// (durable stores) and an in-process Map (ephemeral *-cache stores). This lets
// every existing worker/api module — which calls
// getStore(name).get/set/getWithMetadata/delete — run UNCHANGED on Bun.
//
// Wiring (Phase 3): the Bun build aliases "@netlify/blobs" → this module (see
// tsconfig paths), and the entrypoints call setBlobsDb(await pool()) once at
// startup. Without a db (pure unit tests), durable stores degrade to in-process
// so nothing throws.
//
// Storage split:
//   • name contains "cache"  → in-process Map (TTL metadata; rebuilt on demand)
//   • otherwise              → Postgres blob_kv(store,key,value,metadata)
//
// Session state does NOT come through here — the session-managers use the
// normalized session-store directly (runbook §11.1). The ledger uses @core/ledger.

import type { Db } from "./db.ts";
import { loadSession, saveSession, type SessionMode } from "./session-store.ts";

export interface BlobMetadata { [k: string]: unknown }
export interface BlobWithMetadata { data: string; metadata: BlobMetadata }

export interface BlobStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { metadata?: BlobMetadata }): Promise<void>;
  getWithMetadata(key: string): Promise<BlobWithMetadata | null>;
  delete(key: string): Promise<void>;
}

let _db: Db | null = null;
/** Inject the Postgres handle for durable stores (entrypoints + tests). */
export function setBlobsDb(db: Db | null): void { _db = db; }

const isCache = (name: string) => name.toLowerCase().includes("cache");

// ── in-process backend (caches + db-less fallback) ──────────────────────────
const mem = new Map<string, Map<string, BlobWithMetadata>>();
function memStore(name: string): Map<string, BlobWithMetadata> {
  let m = mem.get(name);
  if (!m) { m = new Map(); mem.set(name, m); }
  return m;
}

function inProcessStore(name: string): BlobStore {
  const m = memStore(name);
  return {
    async get(key) { return m.get(key)?.data ?? null; },
    async set(key, value, opts) { m.set(key, { data: value, metadata: opts?.metadata ?? {} }); },
    async getWithMetadata(key) { return m.get(key) ?? null; },
    async delete(key) { m.delete(key); },
  };
}

// ── Postgres backend (durable stores) ───────────────────────────────────────
function pgStore(db: Db, name: string): BlobStore {
  return {
    async get(key) {
      const { rows } = await db.query<{ value: string | null }>(
        "SELECT value FROM blob_kv WHERE store = $1 AND key = $2", [name, key]);
      return rows.length ? rows[0].value : null;
    },
    async set(key, value, opts) {
      await db.query(
        `INSERT INTO blob_kv(store, key, value, metadata) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (store, key) DO UPDATE SET value = EXCLUDED.value, metadata = EXCLUDED.metadata`,
        [name, key, value, JSON.stringify(opts?.metadata ?? {})]);
    },
    async getWithMetadata(key) {
      const { rows } = await db.query<{ value: string | null; metadata: BlobMetadata | null }>(
        "SELECT value, metadata FROM blob_kv WHERE store = $1 AND key = $2", [name, key]);
      if (!rows.length || rows[0].value == null) return null;
      return { data: rows[0].value, metadata: rows[0].metadata ?? {} };
    },
    async delete(key) {
      await db.query("DELETE FROM blob_kv WHERE store = $1 AND key = $2", [name, key]);
    },
  };
}

// ── Session dispatch → normalized pillar_* tables (runbook §11.1) ────────────
// The trading pillars' session objects (crypto/weather/hyperliquid/sports) are
// stored NORMALIZED, not as JSON blobs. We map each (store, key) to a
// (category, mode) and translate get/set through @core/session-store, so BOTH
// the session-managers (write) and the edge-tracker/multi-status readers stay
// consistent with zero per-file changes. Archive keys + funding-arb (document-
// shaped ArbSessionState) fall through to blob_kv.
interface SessionRoute { category: string; mode: SessionMode }

function sessionRoute(store: string, key: string): SessionRoute | null {
  if (store === "auto-trader-state") {
    if (key.startsWith("auto-trader-session-archive")) return null; // archive → blob_kv
    if (key === "auto-trader-session") return { category: "crypto", mode: "paper" };
    if (key === "auto-trader-session-live") return { category: "crypto", mode: "live" };
    let m = key.match(/^auto-trader-session-live-(.+)$/);
    if (m) return { category: m[1], mode: "live" };
    m = key.match(/^auto-trader-session-(.+)$/);
    if (m) return { category: m[1], mode: "paper" };
    return null;
  }
  if (store === "hyperliquid-session-v1") {
    if (key === "session_paper") return { category: "hyperliquid", mode: "paper" };
    if (key === "session_live") return { category: "hyperliquid", mode: "live" };
    return null; // archive_paper_v* → blob_kv
  }
  if (store === "auto-trader-session-sports") {
    if (key === "session_paper") return { category: "sports", mode: "paper" };
    if (key === "session_live") return { category: "sports", mode: "live" };
    return null; // archive_sim_v* → blob_kv
  }
  return null; // hyperliquid-arb-session-v1 (document-shaped) + everything else → blob_kv
}

const SESSION_STORES = new Set(["auto-trader-state", "hyperliquid-session-v1", "auto-trader-session-sports"]);

function dispatchingStore(db: Db, name: string): BlobStore {
  const base = pgStore(db, name);
  return {
    async get(key) {
      const r = sessionRoute(name, key);
      if (!r) return base.get(key);
      const s = await loadSession(db, r.category, r.mode);
      return s ? JSON.stringify(s) : null;
    },
    async set(key, value, opts) {
      const r = sessionRoute(name, key);
      if (!r) return base.set(key, value, opts);
      await saveSession(db, r.category, JSON.parse(value), r.mode);
    },
    async getWithMetadata(key) {
      const r = sessionRoute(name, key);
      if (!r) return base.getWithMetadata(key);
      const s = await loadSession(db, r.category, r.mode);
      return s ? { data: JSON.stringify(s), metadata: {} } : null;
    },
    delete: base.delete,
  };
}

/** Netlify Blobs getStore() shape: accepts a name string or { name }. */
export function getStore(nameOrOpts: string | { name: string }): BlobStore {
  const name = typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts.name;
  if (isCache(name) || !_db) return inProcessStore(name);
  if (SESSION_STORES.has(name)) return dispatchingStore(_db, name);
  return pgStore(_db, name);
}
