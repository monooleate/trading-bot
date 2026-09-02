// services/api/src/import-blobs.ts
//
// Phase 4 (data migration) — one-shot importer. Reads a Netlify Blobs export
// (JSON array of { store, key, value }) and writes each entry through the SAME
// compat facade the runtime uses (setBlobsDb(pool)):
//   • session stores → normalized pillar_* tables (dispatch)
//   • prediction-ledger + other durable KV → blob_kv
//   • *-cache → skipped (ephemeral; not worth importing)
// so the imported state is byte-consistent with what the workers/api read.
//
// Idempotent: every write is an upsert. Safe to re-run.
//
// Usage:  bun run services/api/src/import-blobs.ts <export.json>
//         (locally: npx tsx services/api/src/import-blobs.ts <export.json>)

import { readFileSync } from "node:fs";
import { pool } from "@core/db.ts";
import { setBlobsDb, getStore } from "@core/blobs-compat.ts";

interface BlobEntry { store: string; key: string; value: string }

async function main() {
  const file = process.argv[2];
  if (!file) { console.error("usage: import-blobs <export.json>"); process.exit(1); }

  const entries: BlobEntry[] = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(entries)) { console.error("export must be a JSON array of {store,key,value}"); process.exit(1); }

  setBlobsDb(await pool());

  let imported = 0, skipped = 0;
  for (const e of entries) {
    if (!e?.store || !e?.key || typeof e.value !== "string") { skipped++; continue; }
    if (e.store.toLowerCase().includes("cache")) { skipped++; continue; } // ephemeral
    try {
      await getStore(e.store).set(e.key, e.value);
      imported++;
    } catch (err) {
      console.error(`  ! failed ${e.store}/${e.key}:`, (err as Error).message);
      skipped++;
    }
  }
  console.log(`import-blobs: imported ${imported}, skipped ${skipped} (of ${entries.length})`);
  process.exit(0);
}

main().catch((e) => { console.error("import-blobs failed:", e); process.exit(1); });
