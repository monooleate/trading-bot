// services/api/src/migrate.ts
//
// One-shot migration runner (compose `--profile migrate run migrate`). Applies
// migrations/*.sql against DATABASE_URL, idempotently. Runs on Bun in the
// container; also runnable locally with `npx tsx services/api/src/migrate.ts`.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "@core/db.ts";
import { runMigrations } from "@core/migrate.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");

async function main() {
  const db = await pool();
  const applied = await runMigrations(db, MIGRATIONS_DIR);
  if (applied.length === 0) console.log("migrate: already up to date");
  else console.log(`migrate: applied ${applied.length} migration(s):\n  ${applied.join("\n  ")}`);
  process.exit(0);
}

main().catch((e) => { console.error("migrate failed:", e); process.exit(1); });
