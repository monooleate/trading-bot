#!/usr/bin/env node
// Phase 4 (data migration) — Netlify Blobs exporter. Enumerates the DURABLE
// stores via the netlify CLI and dumps them to a single JSON array of
// { store, key, value } for services/api/src/import-blobs.ts.
//
// Prereqs (operator): `netlify login` + `netlify link` to the EdgeCalc site.
// The blob DATA still exists in Netlify storage even though main's build now
// fails post-restructure — the CLI reads it directly, no function needed.
//
// Usage:  node scripts/export-blobs.mjs [out.json]
//   out.json defaults to ./blobs-export.json
//
// *-cache stores are intentionally omitted (ephemeral; rebuilt on demand).

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "blobs-export.json";

// Durable stores to migrate (state + ledger + settings). Extend if new durable
// stores are added. Cache stores (*-cache-*) are deliberately excluded.
const STORES = [
  "auto-trader-state",
  "hyperliquid-session-v1",
  "hyperliquid-arb-session-v1",
  "auto-trader-session-sports",
  "crypto-runtime",
  "weather-runtime",
  "trade-log-v1",
  "momentum-snapshots",
  "scan-logs-v3",
  "signal-combiner-v3",
  "prediction-ledger",
  "trader-settings",
  "user-settings",
];

function nf(args) {
  const r = spawnSync("netlify", args, { encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`netlify ${args.join(" ")} → ${r.stderr || r.status}`);
  return r.stdout;
}

function listKeys(store) {
  // `netlify blobs:list <store> --json` → { blobs: [{ key }], ... } (CLI ≥17)
  try {
    const out = nf(["blobs:list", store, "--json"]);
    const parsed = JSON.parse(out);
    const blobs = parsed.blobs ?? parsed ?? [];
    return blobs.map((b) => b.key ?? b).filter(Boolean);
  } catch (e) {
    console.error(`  (skip ${store}: ${e.message.split("\n")[0]})`);
    return [];
  }
}

const entries = [];
for (const store of STORES) {
  const keys = listKeys(store);
  for (const key of keys) {
    try {
      const value = nf(["blobs:get", store, key]);
      entries.push({ store, key, value });
    } catch (e) {
      console.error(`  ! ${store}/${key}: ${e.message.split("\n")[0]}`);
    }
  }
  console.log(`  ${store}: ${keys.length} key(s)`);
}

writeFileSync(OUT, JSON.stringify(entries, null, 2));
console.log(`\nexport-blobs: wrote ${entries.length} entries → ${OUT}`);
console.log(`transfer to the VPS, then:  docker compose run --rm -v $PWD/${OUT}:/tmp/e.json migrate bun run services/api/src/import-blobs.ts /tmp/e.json`);
