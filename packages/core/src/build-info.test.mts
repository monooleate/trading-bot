// packages/core/src/build-info.test.mts
//
// Peer-reported finding, verified live on 2026-09-09 (sprints.md B66).
//
// `currentConfigFingerprint()` hashes the runtime knob overrides and nothing
// else, so `configHash` means "these knobs were set" while every consumer reads
// it as "this is the configuration that produced the prediction". Reproduced on
// the live crypto ledger (n=101): arm `e03b4835` spans 10:45:41 → 11:07:11, a
// window containing the audit deploy at 11:03 that rewrote the HL signal source,
// the ledger provenance rules, the realized-IC blend and the fill validity
// check. Two code regimes, one arm.
//
// Run: npx tsx packages/core/src/build-info.test.mts

import { codeVersionSpread, currentCodeVersion, buildInfo, resetBuildInfoCache } from "./build-info.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── 1. THE MEASUREMENT: the live arm that mixed two code regimes ─────────────
{
  const t = "live-mixed-arm";
  // The real shape: same knob hash either side of the 11:03 deploy.
  const rows = [
    { firstConfigHash: "e03b4835", codeVersion: "aaaaaaaaaaaa" }, // 10:45, pre-deploy
    { firstConfigHash: "e03b4835", codeVersion: "aaaaaaaaaaaa" },
    { firstConfigHash: "e03b4835", codeVersion: "bbbbbbbbbbbb" }, // 11:07, post-deploy
    { firstConfigHash: "de9f9400", codeVersion: "bbbbbbbbbbbb" }, // after the knob change
    { firstConfigHash: "de9f9400", codeVersion: "bbbbbbbbbbbb" },
  ];
  const spread = codeVersionSpread(rows);
  const mixed = spread.find((a) => a.configHash === "e03b4835")!;
  const clean = spread.find((a) => a.configHash === "de9f9400")!;
  expect(mixed.mixed === true, t, "the arm spanning the deploy MUST be flagged as mixed");
  expect(mixed.codeVersions.length === 2, t, `expected 2 code versions in that arm, got ${mixed.codeVersions.length}`);
  expect(clean.mixed === false, t, "an arm written entirely under one build is clean");
  expect(spread[0].n >= spread[spread.length - 1].n, t, "arms are ordered by size");
}

// ── 2. Rows written before the stamp are UNKNOWN, not assumed-same ───────────
// This is the trap the finding is about: silence read as agreement.
{
  const t = "unlabeled-is-unknown";
  const spread = codeVersionSpread([
    { firstConfigHash: "3683673b" },                              // pre-stamp
    { firstConfigHash: "3683673b", codeVersion: "cccccccccccc" }, // post-stamp
  ]);
  expect(spread[0].mixed === true, t,
    "an unstamped row beside a stamped one must count as MIXED — its code is genuinely unknown");
  expect(spread[0].codeVersions.includes("unlabeled"), t, "the unknown bucket is named, not silently dropped");
}

// ── 3. Arm identity follows the first-sighting hash, like the rest of the tuple
{
  const t = "arm-key";
  const spread = codeVersionSpread([
    { firstConfigHash: "first", configHash: "latest", codeVersion: "v1" },
  ]);
  expect(spread[0].configHash === "first", t,
    "must key on firstConfigHash (the config that MADE the prediction), not the latest rescan's");
  const noFirst = codeVersionSpread([{ configHash: "latest", codeVersion: "v1" }]);
  expect(noFirst[0].configHash === "latest", t, "falls back to configHash when no first-tuple exists");
  expect(codeVersionSpread([{}])[0].configHash === "unlabeled", t, "a row with neither is 'unlabeled', not a crash");
  expect(codeVersionSpread([]).length === 0, t, "empty input is empty output");
}

// ── 4. The version resolves, is stable, and never mints an arm per process ───
{
  const t = "resolution";
  resetBuildInfoCache();
  const a = currentCodeVersion();
  const b = currentCodeVersion();
  expect(a === b, t, "cached — must not vary within a process");
  expect(typeof a === "string" && a.length > 0, t, "always resolves to something");
  expect(a.length <= 12, t, `stamp stays short, got ${a.length} chars`);

  // An explicit override wins, so a container can be told what it is.
  resetBuildInfoCache();
  const prev = process.env.EDGECALC_CODE_VERSION;
  process.env.EDGECALC_CODE_VERSION = "deadbeefcafe0000";
  expect(currentCodeVersion() === "deadbeefcafe", t, "env override wins and is truncated to 12");
  resetBuildInfoCache();
  if (prev === undefined) delete process.env.EDGECALC_CODE_VERSION; else process.env.EDGECALC_CODE_VERSION = prev;

  // Locally this reads the tracked BUILD_INFO placeholder (sha=dev), which is a
  // CONSTANT on purpose: a random per-process id would mint a new arm every run.
  resetBuildInfoCache();
  const info = buildInfo();
  expect(typeof info.codeVersion === "string", t, "buildInfo returns a shape, not a throw");
}

// ── 5. The FILE is actually read — the fallback must not impersonate an answer
// The first implementation used `eval("require")` to load node:fs lazily. Under
// ESM that throws, so every call fell into the catch and returned "dev" — which
// is ALSO what the tracked placeholder yields, so the failure was invisible: a
// plausible-looking value standing in for a read that never happened. Exactly
// the class of defect this whole audit is about. Pin the real read.
{
  const t = "file-is-really-read";
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildinfo-"));
  const prevCwd = process.cwd();
  const prevEnv = process.env.EDGECALC_CODE_VERSION;
  delete process.env.EDGECALC_CODE_VERSION;
  try {
    const LF = String.fromCharCode(10);
    fs.writeFileSync(path.join(dir, "BUILD_INFO"), ["sha=87ba884abcdef0123456789", "builtAt=2026-09-09T11:16:00Z", ""].join(LF));
    process.chdir(dir);
    resetBuildInfoCache();
    const got = buildInfo();
    expect(got.codeVersion === "87ba884abcde", t,
      `must read the SHA from BUILD_INFO and truncate to 12, got "${got.codeVersion}" — "dev" means the read silently failed`);
    expect(got.builtAt === "2026-09-09T11:16:00Z", t, `must read builtAt, got ${got.builtAt}`);

    // A malformed file degrades to the constant rather than throwing or
    // half-parsing.
    fs.writeFileSync(path.join(dir, "BUILD_INFO"), ["sha=not-a-sha", ""].join(LF));
    resetBuildInfoCache();
    expect(buildInfo().codeVersion === "dev", t, "a non-hex sha falls back to the constant");

    // No file at all: still the constant, still no throw.
    fs.rmSync(path.join(dir, "BUILD_INFO"));
    resetBuildInfoCache();
    expect(buildInfo().codeVersion === "dev", t, "a missing file is the normal local case, not an error");
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.EDGECALC_CODE_VERSION; else process.env.EDGECALC_CODE_VERSION = prevEnv;
    resetBuildInfoCache();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

if (failures.length) {
  console.error(`FAIL  build-info.test.mts — ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  [${f.test}] ${f.message}`);
  process.exit(1);
}
console.log("PASS  build-info.test.mts");
