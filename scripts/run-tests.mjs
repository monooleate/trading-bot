#!/usr/bin/env node
// Cross-platform test runner: finds every *.test.mts under packages/ and
// services/ and runs it with tsx. Exits non-zero if any suite fails.
// Usage: node scripts/run-tests.mjs [pathFilter]
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOTS = ["packages", "services"];
const filter = process.argv[2] ?? "";

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(p, out);
    } else if (name.endsWith(".test.mts")) {
      out.push(p);
    }
  }
}

const files = [];
for (const r of ROOTS) {
  try { walk(r, files); } catch { /* root may not exist */ }
}
const tests = files.filter((f) => f.includes(filter)).sort();

let pass = 0;
const failed = [];
for (const t of tests) {
  const rel = relative(process.cwd(), t);
  const res = spawnSync("npx", ["tsx", t], { stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" });
  if (res.status === 0) { pass++; console.log(`PASS  ${rel}`); }
  else { failed.push(rel); console.log(`FAIL  ${rel} (exit ${res.status})`); if (res.stderr) console.log(String(res.stderr).trim().split("\n").slice(-6).join("\n")); }
}

console.log(`\n=== ${pass} passed, ${failed.length} failed (of ${tests.length}) ===`);
process.exit(failed.length > 0 ? 1 : 0);
