// services/worker/src/pillars/weather/multi-model-store.test.mts
//
// The B52 #1 recorder store against a REAL Postgres (PGlite) through the same
// blobs-compat facade the worker uses: throttling, the rolling cap, and the
// obs hand-off from the EMOS store (which is what keeps the recorder from
// issuing a second round of METAR fetches).
//
// Run: npx tsx services/worker/src/pillars/weather/multi-model-store.test.mts

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "@core/db.ts";
import { runMigrations } from "@core/migrate.ts";
import { setBlobsDb } from "@core/blobs-compat.ts";
import {
  isRecordDue,
  recordSnapshot,
  fillObsFromEmos,
  loadSnapshots,
  recordIntervalMs,
} from "./multi-model-store.mts";
import { logForecast } from "./emos-store.mts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "migrations");
const wrap = (pg: PGlite): Db => ({
  query: (t, p) => pg.query(t, p as any[]) as any,
  exec: async (s) => { await pg.exec(s); },
});

let passed = 0;
const ok = (l: string) => { console.log(`  ✓ ${l}`); passed++; };

const snap = (date: string, ts: number, over: Partial<Parameters<typeof recordSnapshot>[1]> = {}) => ({
  ts,
  date,
  perModel: [
    { model: "ncep_gefs_seamless", n: 31, mean: 33.97, sd: 1.02 },
    { model: "google_weathernext2_ensemble", n: 64, mean: 29.16, sd: 0.82 },
  ],
  pooledMean: 31.57,
  pooledSd: 2.5,
  interModelSpread: 2.4,
  baseMean: 33.97,
  baseSd: 1.02,
  ...over,
});

async function main() {
  const pg = new PGlite();
  const db = wrap(pg);
  await runMigrations(db, MIGRATIONS_DIR);
  setBlobsDb(db);

  const ST = "RJTT";
  const D1 = "2026-09-09";
  const D2 = "2026-09-10";
  const now = Date.parse("2026-09-08T09:00:00Z");

  // ─── Throttle ───────────────────────────────────────────────────────────
  assert.equal(await isRecordDue(ST, D1, now), true, "empty store → due");
  ok("first snapshot for a (station, date) is always due");

  await recordSnapshot(ST, snap(D1, now));
  assert.equal(await isRecordDue(ST, D1, now + 60_000), false);
  ok("throttled a minute later");

  assert.equal(await isRecordDue(ST, D1, now + recordIntervalMs()), true);
  ok("due again once the interval has elapsed");

  // The throttle is per target date: a newly-listed market must not wait for
  // an unrelated date's cadence.
  assert.equal(await isRecordDue(ST, D2, now + 60_000), true);
  ok("throttle is per (station, date), not per station");

  // ─── Persistence + shape ────────────────────────────────────────────────
  const stored = await loadSnapshots(ST);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].date, D1);
  assert.equal(stored[0].obs, null, "obs starts unlabelled");
  assert.equal(stored[0].perModel.length, 2, "per-system breakdown survives the round-trip");
  assert.equal(stored[0].baseSd, 1.02, "the live GEFS baseline is recorded alongside");
  ok("snapshot round-trips through Postgres with the per-system breakdown");

  // leadHours: capture 2026-09-08T09:00Z → 2026-09-09T12:00Z = 27h
  assert.equal(stored[0].leadHours, 27, `leadHours ${stored[0].leadHours}`);
  ok("leadHours derived against 12:00 UTC on the target date");

  // ─── obs hand-off from the EMOS store ───────────────────────────────────
  await recordSnapshot(ST, snap(D2, now + 60_000));
  assert.equal((await fillObsFromEmos(ST)).filled, 0, "nothing resolved yet");
  ok("no EMOS residuals → nothing filled, no throw");

  // logForecast creates the residual; obs is filled by the METAR reconciler.
  // Simulate that by writing a resolved residual straight into the store the
  // recorder reads.
  await logForecast(ST, D1, 33.9, 1.02);
  assert.equal((await fillObsFromEmos(ST)).filled, 0, "residual exists but obs is still null");
  ok("unresolved residual does not label a snapshot");

  const raw = await (await import("@core/blobs-compat.ts")).getStore("weather-emos").get("v1:RJTT");
  const emos = JSON.parse(raw as string);
  emos.residuals.find((r: any) => r.date === D1).obs = 30.6;
  await (await import("@core/blobs-compat.ts")).getStore("weather-emos").set("v1:RJTT", JSON.stringify(emos));

  assert.equal((await fillObsFromEmos(ST)).filled, 1, "the resolved date is labelled");
  const afterFill = await loadSnapshots(ST);
  assert.equal(afterFill.find((s) => s.date === D1)!.obs, 30.6);
  assert.equal(afterFill.find((s) => s.date === D2)!.obs, null, "unresolved date untouched");
  ok("obs copied from the EMOS store — no second METAR fetch");

  assert.equal((await fillObsFromEmos(ST)).filled, 0, "already-labelled rows are skipped");
  ok("fill is idempotent");

  // ─── Rolling cap ────────────────────────────────────────────────────────
  for (let i = 0; i < 420; i++) {
    await recordSnapshot(ST, snap(`2026-10-${String((i % 28) + 1).padStart(2, "0")}`, now + 10_000 + i));
  }
  const capped = await loadSnapshots(ST);
  assert.ok(capped.length <= 400, `cap holds: ${capped.length}`);
  assert.ok(capped.every((s) => s.ts >= now + 10_000), "the OLDEST rows were dropped, not the newest");
  ok("rolling cap keeps the newest 400 snapshots");

  // ─── Robustness ─────────────────────────────────────────────────────────
  const before = (await loadSnapshots(ST)).length;
  await recordSnapshot(ST, snap(D1, now, { pooledMean: NaN as any }));
  await recordSnapshot("", snap(D1, now));
  assert.equal((await loadSnapshots(ST)).length, before, "junk snapshots rejected");
  ok("non-finite / station-less snapshots are dropped, not stored");

  assert.deepEqual(await loadSnapshots("NOPE"), [], "unknown station → empty");
  assert.equal(await isRecordDue("NOPE", D1, now), true);
  ok("unknown station reads clean");

  console.log(`\n=== multi-model-store: ${passed} passed, 0 failed ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
