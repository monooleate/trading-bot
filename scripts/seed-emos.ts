#!/usr/bin/env bun
// B50 #5 — one-time weather EMOS historical seed.
//
// Backfills each settlement station's weather-emos store from Open-Meteo history
// (multi-model past forecast + ERA5 realised) so `weatherUseEmos` has a fitted
// calibrator immediately instead of waiting weeks for forward residuals. Only
// adds dates not already present — never overwrites forward-logged residuals, and
// the seeds age out of the rolling window as production-matched pairs accumulate.
//
// Run ON THE BOX (needs DATABASE_URL so the store writes hit Postgres):
//   docker compose exec workers bun scripts/seed-emos.ts [months]
//   (months default 6)
//
// Safe to re-run: idempotent (skips dates already stored). Read-only against
// Open-Meteo; writes only the weather-emos store. Zero trading impact.

import { pool } from "@core/db.ts";
import { setBlobsDb } from "@core/blobs-compat.ts";
import { seedAllStations } from "@worker/pillars/weather/emos-seed.mts";

const months = Number(process.argv[2] ?? 6) || 6;

setBlobsDb(await pool());
console.log(`[seed-emos] seeding ${months} months of Open-Meteo history per station…`);

const results = await seedAllStations(months);
for (const r of results) {
  const err = r.error ? `  (${r.error})` : "";
  console.log(`  ${r.station}: +${r.added} residuals → total ${r.total}, fitted=${r.fitted}${err}`);
}
const totalAdded = results.reduce((s, r) => s + r.added, 0);
const fitted = results.filter((r) => r.fitted).length;
console.log(`[seed-emos] done — ${totalAdded} residuals added, ${fitted}/${results.length} stations fitted.`);
process.exit(0);
