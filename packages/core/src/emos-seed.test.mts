// packages/core/src/emos-seed.test.mts
//
// Regression guard for the offline EMOS seed parsers (model-discovery-training
// §3.C / #5, sprints.md B50). Pure, no I/O.
//
// Run: npx tsx packages/core/src/emos-seed.test.mts

import { parseDailySeries, buildSeedSamples, seedDateWindow } from "./emos-seed.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ── 1. parseDailySeries ──────────────────────────────────────────────────────
{
  const t = "parse";
  const daily = { time: ["2026-01-01", "2026-01-02", "2026-01-03"], temperature_2m_max_gfs_seamless: [10, 12, null] };
  const m = parseDailySeries(daily, "temperature_2m_max_gfs_seamless");
  expect(m.size === 2, t, `2 finite entries, got ${m.size}`);
  expect(m.get("2026-01-01") === 10 && m.get("2026-01-02") === 12, t, "values parsed");
  expect(!m.has("2026-01-03"), t, "null dropped");
  expect(parseDailySeries({}, "x").size === 0, t, "empty → 0");
  expect(parseDailySeries({ time: ["2026-01-01"], x: [] }, "x").size === 0, t, "mismatched length → 0");
}

// ── 2. buildSeedSamples: multi-model mean/std + join ─────────────────────────
{
  const t = "build";
  const modelA = new Map([["2026-01-01", 10], ["2026-01-02", 20], ["2026-01-03", 30]]);
  const modelB = new Map([["2026-01-01", 12], ["2026-01-02", 24], ["2026-01-03", 30]]);
  const realized = new Map([["2026-01-01", 11], ["2026-01-02", 22]]); // no obs for 01-03
  const samples = buildSeedSamples([modelA, modelB], realized, 2);
  expect(samples.length === 2, t, `2 samples (01-03 has no obs), got ${samples.length}`);
  const s1 = samples.find((s) => s.date === "2026-01-01")!;
  expect(approx(s1.ensMean, 11), t, `ensMean (10,12)→11, got ${s1.ensMean}`);
  expect(approx(s1.ensStd, 1), t, `population std of (10,12)→1, got ${s1.ensStd}`);
  expect(s1.obs === 11, t, "obs joined");
  // sorted by date
  expect(samples[0].date < samples[1].date, t, "sorted by date");
}

// ── 3. minModels gate ────────────────────────────────────────────────────────
{
  const t = "minModels";
  const modelA = new Map([["2026-01-01", 10]]);
  const modelB = new Map<string, number>(); // no data
  const realized = new Map([["2026-01-01", 11]]);
  expect(buildSeedSamples([modelA, modelB], realized, 2).length === 0, t, "only 1 model → skipped");
  expect(buildSeedSamples([modelA, modelB], realized, 1).length === 1, t, "minModels=1 → included");
  // single-model std = 0
  const one = buildSeedSamples([modelA, modelB], realized, 1)[0];
  expect(one.ensStd === 0, t, "single model → std 0");
}

// ── 4. seedDateWindow ────────────────────────────────────────────────────────
{
  const t = "window";
  const now = Date.parse("2026-09-03T00:00:00Z");
  const w = seedDateWindow(6, now, 1);
  expect(w.end === "2026-09-02", t, `end = yesterday, got ${w.end}`);
  expect(/^\d{4}-\d{2}-\d{2}$/.test(w.start), t, `start formatted, got ${w.start}`);
  expect(w.start < w.end, t, "start before end");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("emos-seed.test.mts") || entry.endsWith("emos-seed.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("emos-seed.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`emos-seed.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
