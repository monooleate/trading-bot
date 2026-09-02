// packages/core/pg-roundtrip.test.mts
//
// Phase 2 acceptance: the migrations + Postgres adapters round-trip against a
// REAL embedded Postgres (PGlite — no Docker needed). Covers:
//   • runMigrations applies migrations/*.sql and is idempotent
//   • prediction ledger: save → load equality, upsert-per-slug, cap prune
//   • normalized session: save → load fidelity (scalars, positions, closed
//     trades, JSONB residuals)
//   • settings KV: set/get/list/delete
//
// Run: npx tsx packages/core/src/pg-roundtrip.test.mts

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db.ts";
import { runMigrations } from "./migrate.ts";
import { loadLedger, saveLedger, appendPredictions, computeLedgerStats } from "./ledger.ts";
import type { PredictionRecord } from "./ledger.ts";
import { loadSession, saveSession } from "./session-store.ts";
import { getSetting, setSetting, listSettings, deleteSetting } from "./settings-store.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");

function wrap(pg: PGlite): Db {
  return {
    query: (text, params) => pg.query(text, params as any[]) as any,
    exec: async (sql) => { await pg.exec(sql); },
  };
}

let passed = 0;
function ok(label: string) { console.log(`  ✓ ${label}`); passed++; }

async function main() {
  const pg = new PGlite();
  const db = wrap(pg);

  // ── migrations ────────────────────────────────────────────────────────────
  const applied = await runMigrations(db, MIGRATIONS_DIR);
  assert.ok(applied.length >= 5, `expected ≥5 migrations, got ${applied.length}`);
  ok(`migrations applied: ${applied.join(", ")}`);
  const again = await runMigrations(db, MIGRATIONS_DIR);
  assert.deepStrictEqual(again, [], "second migrate run must be a no-op (idempotent)");
  ok("migrations idempotent");

  // ── prediction ledger ──────────────────────────────────────────────────────
  const now = "2026-09-02T10:00:00.000Z";
  const recs: PredictionRecord[] = [
    {
      slug: "bitcoin-above-80k-on-sep-02", category: "crypto",
      firstTs: now, ts: now, conditionId: "0xabc", endDate: "2026-09-02T23:59:00.000Z",
      predictedProb: 0.42, marketPrice: 0.19, edge: 0.23, direction: "NO", taken: true,
      lastAction: "position_opened", skipReason: null,
      signalBreakdown: { momentum: 0.17, vol_divergence: -0.05 }, scans: 3,
      outcome: null, resolvedAt: null,
    },
    {
      slug: "bitcoin-above-82k-on-sep-02", category: "crypto",
      firstTs: now, ts: now, conditionId: null, endDate: null,
      predictedProb: 0.31, marketPrice: 0.12, edge: 0.19, direction: "NO", taken: false,
      lastAction: "skip", skipReason: "below edge threshold",
      signalBreakdown: null, scans: 1, outcome: 1, resolvedAt: now,
    },
  ];
  await saveLedger(db, "crypto", recs);
  const loaded = await loadLedger(db, "crypto");
  assert.deepStrictEqual(loaded, recs, "ledger save→load must be faithful");
  ok("ledger save→load faithful");

  // upsert-per-slug: change prob on slug #1, keep count = 2
  const updated = recs.map((r) => r.slug.includes("80k") ? { ...r, predictedProb: 0.55, scans: 4 } : r);
  await saveLedger(db, "crypto", updated);
  const loaded2 = await loadLedger(db, "crypto");
  assert.equal(loaded2.length, 2, "upsert must not duplicate rows");
  assert.equal(loaded2.find((r) => r.slug.includes("80k"))!.predictedProb, 0.55);
  ok("ledger upsert-per-slug");

  // prune: save only slug #1 → slug #2 removed
  await saveLedger(db, "crypto", [updated[0]]);
  const loaded3 = await loadLedger(db, "crypto");
  assert.equal(loaded3.length, 1, "prune must drop rows not in the saved set");
  ok("ledger cap/prune");

  // appendPredictions from a scan (pure builder path) + outcome fill
  await appendPredictions(
    db, "crypto",
    [{ market: "bitcoin-above-84k-on-sep-02", predictedProb: 0.6, marketPrice: 0.5, direction: "YES", action: "skip", reason: "below edge" }],
    [{ slug: "bitcoin-above-84k-on-sep-02", conditionId: "0xdef" }],
    [],
  );
  const afterAppend = await loadLedger(db, "crypto");
  assert.ok(afterAppend.some((r) => r.slug.includes("84k")), "appendPredictions must add the scanned market");
  const stats = computeLedgerStats("crypto", afterAppend);
  assert.ok(stats.total >= 2, "ledger stats compute");
  ok("ledger appendPredictions + stats");

  // ── normalized session (crypto-shaped + JSONB residuals) ────────────────────
  const session = {
    startedAt: "2026-09-01T00:00:00.000Z",
    bankrollStart: 350,
    bankrollCurrent: 412.5,
    sessionPnL: 62.5,
    sessionLoss: 40,
    tradeCount: 5,
    paperMode: true,
    stopped: false,
    stoppedReason: null,
    simVersion: 3,
    calibrationAlertSentAt: null,          // residual → extra
    openPositions: [
      {
        market: "bitcoin-above-80k-on-sep-02", tokenId: "tok1", direction: "NO",
        shares: 100, avgEntry: 0.19, costBasis: 19, openedAt: "2026-09-02T09:00:00.000Z",
        conditionId: "0xabc", endDate: "2026-09-02T23:59:00.000Z",
        marketPriceAtEntry: 0.19, predictedProb: 0.42,
        buyOrderId: "ord1", clobTokenIds: ["tok1", "tok2"],   // residual → payload
        signalBreakdown: { momentum: 0.17 },
      },
    ],
    closedTrades: [
      {
        market: "bitcoin-above-78k-on-sep-01", direction: "YES", entryPrice: 0.3,
        exitPrice: 1, shares: 50, pnl: 35, pnlPct: 233.3, openedAt: "2026-09-01T09:00:00.000Z",
        closedAt: "2026-09-01T23:00:00.000Z", predictedProb: 0.55, marketPriceAtEntry: 0.3,
        edgeAtEntry: 0.25, signalBreakdown: { apex_consensus: 0.2 },
        category: "crypto",                 // residual → payload
      },
    ],
  };
  await saveSession(db, "crypto", session);
  const loadedSession = await loadSession(db, "crypto");
  assert.deepStrictEqual(loadedSession, session, "session save→load must be faithful");
  ok("normalized session save→load faithful");

  // HL-shaped residual scalars (consecutiveLosses/pausedUntil) round-trip via extra
  const hl = {
    startedAt: "2026-09-01T00:00:00.000Z", bankrollStart: 200, bankrollCurrent: 186.81,
    sessionPnL: -13.19, sessionLoss: 20, tradeCount: 188, paperMode: true, stopped: false,
    stoppedReason: null, simVersion: 2, consecutiveLosses: 2, pausedUntil: null,
    openPositions: [], closedTrades: [],
  };
  await saveSession(db, "hyperliquid", hl);
  const loadedHl = await loadSession(db, "hyperliquid");
  assert.deepStrictEqual(loadedHl, hl, "HL session residual scalars must round-trip via extra");
  ok("HL session residual scalars round-trip");

  assert.equal(await loadSession(db, "nonexistent"), null, "missing session → null");
  ok("missing session → null");

  // paper/live mode isolation
  const liveSession = { ...hl, bankrollCurrent: 999, openPositions: [], closedTrades: [] };
  await saveSession(db, "hyperliquid", liveSession, "live");
  assert.equal((await loadSession(db, "hyperliquid", "live"))!.bankrollCurrent, 999);
  assert.equal((await loadSession(db, "hyperliquid", "paper"))!.bankrollCurrent, 186.81, "paper session unaffected by live save");
  ok("paper/live mode isolation");

  // ── settings KV ─────────────────────────────────────────────────────────────
  await setSetting(db, "trader:crypto", { sessionLossLimit: 1000, useRealizedIC: 1 });
  await setSetting(db, "trader:weather", { weatherInvertDirection: 1 });
  assert.deepStrictEqual(await getSetting(db, "trader:crypto"), { sessionLossLimit: 1000, useRealizedIC: 1 });
  ok("settings set/get");
  await setSetting(db, "trader:crypto", { sessionLossLimit: 500 });
  assert.deepStrictEqual(await getSetting(db, "trader:crypto"), { sessionLossLimit: 500 }, "settings upsert");
  ok("settings upsert");
  const all = await listSettings(db, "trader:");
  assert.deepStrictEqual(Object.keys(all).sort(), ["trader:crypto", "trader:weather"]);
  ok("settings list by prefix");
  await deleteSetting(db, "trader:weather");
  assert.equal(await getSetting(db, "trader:weather"), null);
  ok("settings delete");

  await pg.close();
  console.log(`\npg-roundtrip.test: all ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
