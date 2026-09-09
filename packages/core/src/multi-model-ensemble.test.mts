// packages/core/src/multi-model-ensemble.test.mts
//
// Pins the B52 #1 multi-model ensemble contract: model-list parsing, the
// response-key grouping (single- AND multi-model shapes), and the
// equal-weight-per-model mixture statistics.

import {
  parseModelList,
  splitEnsembleKeys,
  modelStatsForDate,
  DEFAULT_ENSEMBLE_MODELS,
} from "./multi-model-ensemble.mts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function near(name: string, actual: number, expected: number, tol = 1e-9) {
  check(name, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);
}

// ─── 1. parseModelList ────────────────────────────────────────────────────
console.log("\n1. parseModelList");
{
  check("empty → fallback",
    parseModelList("", ["a", "b"]).join(",") === "a,b");
  check("undefined → fallback",
    parseModelList(undefined, DEFAULT_ENSEMBLE_MODELS).length === DEFAULT_ENSEMBLE_MODELS.length);
  check("null → fallback",
    parseModelList(null, ["x"]).join(",") === "x");
  check("trims + lowercases",
    parseModelList(" GFS_Seamless , ecmwf_ifs025 ", []).join(",") === "gfs_seamless,ecmwf_ifs025");
  check("drops empty segments",
    parseModelList("a,,b,", []).join(",") === "a,b");
  check("de-duplicates, order preserved",
    parseModelList("b,a,b,A", []).join(",") === "b,a");
  check("fallback is copied, not aliased", (() => {
    const fb = ["a"];
    const got = parseModelList("", fb);
    got.push("b");
    return fb.length === 1;
  })());
  // Pins the shipped list: 6 global + 2 European regional. A regional model
  // outside its domain is dropped by the API, so one list serves all stations.
  check("default list is the verified systems, globals first",
    DEFAULT_ENSEMBLE_MODELS.join(",") ===
      "gfs_seamless,ecmwf_ifs025,ecmwf_aifs025,google_weathernext2_ensemble," +
      "gem_global,ukmo_global_ensemble_20km,icon_eu,icon_d2");
  check("no all-null / too-small systems in the default list",
    !DEFAULT_ENSEMBLE_MODELS.includes("bom_access_global_ensemble") &&
    !DEFAULT_ENSEMBLE_MODELS.includes("ukmo_uk_ensemble_2km"));
}

// ─── 2. splitEnsembleKeys ─────────────────────────────────────────────────
console.log("\n2. splitEnsembleKeys");
{
  // Single-model response: no suffix at all → everything under "".
  const single = splitEnsembleKeys(
    ["temperature_2m_max", "temperature_2m_max_member01", "temperature_2m_max_member30"],
    "temperature_2m_max",
  );
  check("single-model → one group under ''", single.size === 1 && single.has(""));
  check("single-model group holds control + members", single.get("")!.length === 3);

  // Multi-model response: Open-Meteo's INTERNAL domain name is the suffix.
  const multi = splitEnsembleKeys(
    [
      "temperature_2m_max_ncep_gefs_seamless",
      "temperature_2m_max_member01_ncep_gefs_seamless",
      "temperature_2m_max_ecmwf_ifs025_ensemble",
      "temperature_2m_max_member50_ecmwf_ifs025_ensemble",
      "temperature_2m_max_member63_google_weathernext2_ensemble",
    ],
    "temperature_2m_max",
  );
  check("multi-model → one group per model tag", multi.size === 3);
  check("control column groups with its members",
    multi.get("ncep_gefs_seamless")!.length === 2);
  check("member index is not mistaken for a model tag",
    multi.has("ecmwf_ifs025_ensemble") && multi.get("ecmwf_ifs025_ensemble")!.length === 2);
  check("3-digit-free member parse keeps the whole tag",
    multi.has("google_weathernext2_ensemble"));

  check("unrelated columns ignored",
    splitEnsembleKeys(["precipitation", "temperature_2m_min"], "temperature_2m_max").size === 0);
  check("empty input is safe", splitEnsembleKeys([], "temperature_2m_max").size === 0);
}

// ─── 3. modelStatsForDate — single model ──────────────────────────────────
console.log("\n3. modelStatsForDate (single model)");
{
  const daily = {
    time: ["2026-09-08", "2026-09-09"],
    temperature_2m_max: [10, 20],
    temperature_2m_max_member01: [12, 22],
    temperature_2m_max_member02: [14, 24],
  };
  const s = modelStatsForDate(daily, "temperature_2m_max", "2026-09-08")!;
  check("returns stats", !!s);
  check("one model", s.perModel.length === 1 && s.perModel[0].model === "");
  near("member count", s.perModel[0].n, 3);
  near("model mean", s.perModel[0].mean, 12);
  near("sample sd (n−1) of [10,12,14]", s.perModel[0].sd, 2);
  near("pooled mean == model mean", s.pooled.mean, 12);
  near("pooled sd == model sd (no between term)", s.pooled.sd, 2);
  near("inter-model spread is 0 with one model", s.interModelSpread, 0);
  near("pooled n counts members", s.pooled.n, 3);
  check("members flattened", s.members.join(",") === "10,12,14");

  const s2 = modelStatsForDate(daily, "temperature_2m_max", "2026-09-09")!;
  near("second date picked by value, not position", s2.pooled.mean, 22);
}

// ─── 4. modelStatsForDate — mixture maths ─────────────────────────────────
console.log("\n4. modelStatsForDate (multi-model mixture)");
{
  // Model A: [10,10,10] → mean 10, sd 0.  Model B: [20,20] → mean 20, sd 0.
  // Unequal member counts on purpose: a per-MEMBER pool would give mean 14,
  // the per-MODEL mixture gives 15.
  const daily = {
    time: ["2026-09-08"],
    temperature_2m_max_a: [10],
    temperature_2m_max_member01_a: [10],
    temperature_2m_max_member02_a: [10],
    temperature_2m_max_b: [20],
    temperature_2m_max_member01_b: [20],
  };
  const s = modelStatsForDate(daily, "temperature_2m_max", "2026-09-08")!;
  check("two models", s.perModel.length === 2);
  near("model A mean", s.perModel.find((m) => m.model === "a")!.mean, 10);
  near("model B mean", s.perModel.find((m) => m.model === "b")!.mean, 20);
  near("pooled mean is equal-weight-per-MODEL (15), not per-member (14)", s.pooled.mean, 15);
  near("inter-model spread = popsd([10,20]) = 5", s.interModelSpread, 5);
  near("pooled sd = sqrt(0 + 25) = 5", s.pooled.sd, 5);
  near("pooled n still counts every member", s.pooled.n, 5);
}
{
  // Law of total variance with a non-zero within-model term:
  // A: [9,11] mean 10, sample sd 1.4142…  B: [19,21] mean 20, sd 1.4142…
  // within = mean(2,2) = 2 ; between = popvar([10,20]) = 25 ; sd = sqrt(27)
  const daily = {
    time: ["2026-09-08"],
    temperature_2m_max_member01_a: [9],
    temperature_2m_max_member02_a: [11],
    temperature_2m_max_member01_b: [19],
    temperature_2m_max_member02_b: [21],
  };
  const s = modelStatsForDate(daily, "temperature_2m_max", "2026-09-08")!;
  near("law of total variance: sd = sqrt(within + between)", s.pooled.sd, parseFloat(Math.sqrt(27).toFixed(2)), 1e-9);
  near("pooled mean", s.pooled.mean, 15);
}
{
  // The measured Tokyo case: one family is far tighter AND offset. The pooled
  // σ must exceed every single-model σ once the means disagree.
  const daily = {
    time: ["2026-09-08"],
    temperature_2m_max_member01_gefs: [32.0],
    temperature_2m_max_member02_gefs: [32.6],
    temperature_2m_max_member01_wn2: [29.0],
    temperature_2m_max_member02_wn2: [29.6],
  };
  const s = modelStatsForDate(daily, "temperature_2m_max", "2026-09-08")!;
  const maxSingle = Math.max(...s.perModel.map((m) => m.sd));
  check("disagreeing families widen σ beyond any single family",
    s.pooled.sd > maxSingle, `pooled ${s.pooled.sd} vs max single ${maxSingle}`);
  near("mixture mean sits between the families", s.pooled.mean, 30.8, 1e-9);
}

// ─── 5. Robustness ────────────────────────────────────────────────────────
console.log("\n5. Robustness (nulls, missing dates, junk)");
{
  const base = { time: ["2026-09-08"], temperature_2m_max_member01_a: [10] };
  check("missing date → null",
    modelStatsForDate(base, "temperature_2m_max", "2026-09-09") === null);
  check("null daily → null",
    modelStatsForDate(null, "temperature_2m_max", "2026-09-08") === null);
  check("undefined daily → null",
    modelStatsForDate(undefined, "temperature_2m_max", "2026-09-08") === null);
  check("missing time array → null",
    modelStatsForDate({ temperature_2m_max: [1] }, "temperature_2m_max", "2026-09-08") === null);

  check("all-null series → null", modelStatsForDate(
    { time: ["2026-09-08"], temperature_2m_max_member01_a: [null] },
    "temperature_2m_max", "2026-09-08") === null);

  // A model whose series is null for this date drops out; the rest survive.
  const partial = modelStatsForDate({
    time: ["2026-09-08"],
    temperature_2m_max_member01_a: [null],
    temperature_2m_max_member01_b: [20],
    temperature_2m_max_member02_b: [22],
  }, "temperature_2m_max", "2026-09-08")!;
  check("null model drops out, others survive",
    partial.perModel.length === 1 && partial.perModel[0].model === "b");
  near("survivor's mean", partial.pooled.mean, 21);

  const ragged = modelStatsForDate({
    time: ["2026-09-08"],
    temperature_2m_max_member01_a: [10],
    temperature_2m_max_member02_a: "not-an-array" as any,
    temperature_2m_max_member03_a: [NaN],
  }, "temperature_2m_max", "2026-09-08")!;
  near("non-array + NaN columns skipped", ragged.perModel[0].n, 1);
  near("single member → sd 0", ragged.perModel[0].sd, 0);
}

console.log(`\n=== multi-model-ensemble: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
