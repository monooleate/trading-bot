// services/worker/src/main.ts
//
// The Bun worker entrypoint. One container runs all configured pillar loops
// (§18.1 consolidation). Each tick invokes the EXISTING dispatcher
// (pillars/index.mts) with the same { action, category, layer } payloads the
// Netlify multi-cron used — zero pillar-logic duplication. State flows through
// the Blobs compat facade (→ Postgres), so setBlobsDb(pool) is wired once here.
//
// Env: PILLARS (comma list), LOOP_INTERVAL_SEC (default 180), DATABASE_URL.

import handler from "./pillars/index.mts";
import { pool } from "@core/db.ts";
import { setBlobsDb } from "@core/blobs-compat.ts";
import { loadEnv } from "@core/env.ts";

interface RunBody { action: "run" | "reconcile"; category: string; layer?: string }

// pillar name (from PILLARS) → the dispatcher payloads to fire each tick.
function payloadsFor(pillar: string): RunBody[] {
  switch (pillar) {
    case "crypto":      return [{ action: "run", category: "crypto" }, { action: "reconcile", category: "crypto" }];
    case "weather":     return [{ action: "run", category: "weather" }, { action: "reconcile", category: "weather" }];
    case "hyperliquid": return [{ action: "run", category: "hyperliquid", layer: "directional" }];
    case "funding-arb": return [{ action: "run", category: "hyperliquid", layer: "arb" }];
    case "sports":      return [{ action: "run", category: "sports" }];
    default:            return [];
  }
}

async function invoke(body: RunBody): Promise<void> {
  const req = new Request("http://worker.local/?source=cron", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handler(req, {} as any);
  if (!res.ok) console.error(`[worker] ${body.action} ${body.category}${body.layer ? "/" + body.layer : ""} → HTTP ${res.status}`);
}

async function main() {
  const env = loadEnv();
  const pillars = (env.PILLARS ?? "crypto,weather,hyperliquid,funding-arb,sports")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const intervalMs = (env.LOOP_INTERVAL_SEC ?? 180) * 1000;

  // Wire the storage backend (sessions → normalized, KV → blob_kv, cache → memory).
  setBlobsDb(await pool());
  console.log(`[worker] pillars=${pillars.join(",")} interval=${intervalMs / 1000}s`);

  const { startScheduler } = await import("./scheduler.ts");
  const bodies = pillars.flatMap(payloadsFor);
  const handle = startScheduler(async () => {
    const startedAt = Date.now();
    for (const b of bodies) {
      try { await invoke(b); } catch (e) { console.error("[worker] invoke failed:", e); }
    }
    console.log(`[worker] tick done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }, intervalMs);

  const shutdown = async () => {
    console.log("[worker] shutting down — draining in-flight tick (max 10s)…");
    await Promise.race([handle.stop(), new Promise((r) => setTimeout(r, 10_000))]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => { console.error("[worker] fatal:", e); process.exit(1); });
