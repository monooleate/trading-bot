// packages/core/src/emos.test.mts
//
// Regression guard for EMOS/NGR post-processing (model-discovery-expansion §4.E /
// sprints.md B49 #6). Pure, no I/O, deterministic (constructed data, no RNG).
//
// Run: npx tsx packages/core/src/emos.test.mts

import {
  gaussianCrps,
  emosApply,
  fitEmos,
  observationRank,
  normalCdf,
  type EmosSample,
} from "./emos.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 2e-3) => Math.abs(a - b) < eps;

// ── 1. Gaussian CRPS closed form ─────────────────────────────────────────────
{
  const t = "crps";
  expect(approx(normalCdf(0), 0.5), t, "Φ(0)=0.5");
  // CRPS of N(0,1) at y=0 = 2φ(0) − 1/√π ≈ 0.2337
  expect(approx(gaussianCrps(0, 1, 0), 0.2337, 2e-3), t, `CRPS(0,1,0)≈0.2337, got ${gaussianCrps(0, 1, 0).toFixed(4)}`);
  // farther obs → larger CRPS; wider σ around the truth → CRPS grows from the min
  expect(gaussianCrps(0, 1, 3) > gaussianCrps(0, 1, 0), t, "farther obs → larger CRPS");
  expect(gaussianCrps(0, 0, 0) === 0, t, "point forecast exact → 0");
  expect(gaussianCrps(0, 0, 2) === 2, t, "point forecast miss → |y-μ|");
}

// ── 2. emosApply: μ and σ mapping ────────────────────────────────────────────
{
  const t = "apply";
  const r = emosApply({ a: 1, b: 0.9, c: 1, d: 2 }, 20, 0.5, 0.25);
  expect(approx(r.mu, 1 + 0.9 * 20), t, `μ=a+b·ensMean=19, got ${r.mu}`);
  expect(approx(r.sigma, Math.sqrt(1 + 2 * 0.25)), t, `σ=√(c+d·std²)=√1.5, got ${r.sigma}`);
  // variance floor
  const floored = emosApply({ a: 0, b: 1, c: 0, d: 0 }, 20, 0.1, 0.25);
  expect(approx(floored.sigma, 0.5), t, `σ floored to √0.25=0.5, got ${floored.sigma}`);
}

// ── 3. fitEmos: recovers the mean map + INFLATES σ to fix underdispersion ─────
{
  const t = "fit";
  // Construct: obs = ensMean + alternating ±2 residual (realised std ≈2),
  // but the reported ensStd is 0.5 (badly underdispersed). EMOS should inflate.
  const samples: EmosSample[] = [];
  for (let i = 0; i < 40; i++) {
    const ensMean = 10 + i * 0.5;
    const resid = i % 2 === 0 ? 2 : -2;
    samples.push({ ensMean, ensStd: 0.5, obs: ensMean + resid });
  }
  const f = fitEmos(samples, { minSamples: 20, varFloor: 0.25 });
  expect(f.fitted, t, "fitted");
  expect(approx(f.b, 1, 0.1), t, `b≈1, got ${f.b.toFixed(3)}`);
  expect(Math.abs(f.a) < 1.5, t, `a≈0, got ${f.a.toFixed(3)}`);
  // calibrated σ must be much larger than the underdispersed raw 0.5 (≈2)
  const { sigma } = emosApply(f, 15, 0.5, f.varFloor);
  expect(sigma > 1.5, t, `EMOS inflates σ toward realised ~2, got ${sigma.toFixed(3)}`);
  // and the calibration improves CRPS vs the raw underdispersed ensemble
  expect(f.calibratedCrps < f.rawCrps, t, `calibrated CRPS < raw (${f.calibratedCrps.toFixed(3)} < ${f.rawCrps.toFixed(3)})`);
}

// ── 4. fitEmos: too few samples → identity fallback ──────────────────────────
{
  const t = "fallback";
  const f = fitEmos([{ ensMean: 10, ensStd: 1, obs: 11 }], { minSamples: 20 });
  expect(!f.fitted, t, "not fitted");
  expect(f.a === 0 && f.b === 1 && f.d === 1, t, "identity params");
  // identity apply → μ=ensMean, σ=ensStd (above floor)
  const r = emosApply(f, 12, 1, f.varFloor);
  expect(approx(r.mu, 12) && approx(r.sigma, 1), t, "identity passthrough");
}

// ── 5. observationRank (rank histogram building block) ───────────────────────
{
  const t = "rank";
  const members = [10, 11, 12, 13, 14];
  expect(observationRank(members, 12.5) === 3, t, "3 members below 12.5");
  expect(observationRank(members, 9) === 0, t, "below all → 0");
  expect(observationRank(members, 20) === 5, t, "above all → n");
}

// ── 6. WEIGHTED fit (audit P0-2) ─────────────────────────────────────────────
// The live problem in one line: every station is fitted on ~181 SEEDED residuals
// (ERA5 obs vs inter-model spread, measured bias -0.03 C) and 0-5 FORWARD ones
// (METAR obs vs GEFS sigma, measured bias +0.50 C). Two different distributions,
// and the seed outvotes the live data ~40:1, so the mean correction it produces
// does not transfer. Weighting is what lets forward data take over as it
// accumulates. The FORWARD rows below are real (live store, 2026-09-09).
{
  const t = "weighted-fit";

  // A deterministic stand-in for the seeded population: unbiased (matching the
  // measured -0.03 C) and centred well away from the forward rows so that a
  // shift in the fitted intercept is unambiguous evidence of re-weighting.
  const seed: EmosSample[] = [];
  for (let i = 0; i < 180; i++) {
    const m = 10 + (i % 20) * 0.5;
    const err = ((i * 7919) % 21 - 10) / 10;     // deterministic, mean ~0
    seed.push({ ensMean: m, ensStd: 0.9, obs: m + err });
  }
  // Real forward rows: consistently WARM (the live +0.5 C bias).
  const forward: EmosSample[] = [
    { ensMean: 28.9, ensStd: 0.5, obs: 31 }, { ensMean: 28.3, ensStd: 0.5, obs: 30 },
    { ensMean: 27.8, ensStd: 0.5, obs: 30 }, { ensMean: 27.2, ensStd: 0.5, obs: 30 },
    { ensMean: 28.3, ensStd: 0.5, obs: 31 }, { ensMean: 27.2, ensStd: 0.5, obs: 30 },
    { ensMean: 26.7, ensStd: 0.5, obs: 29 }, { ensMean: 23.3, ensStd: 0.94, obs: 24 },
  ];

  // 6a. UNWEIGHTED IS BIT-IDENTICAL. The default path must not move at all.
  const all = [...seed, ...forward];
  const plain = fitEmos(all, { minSamples: 20, varFloor: 0.25 });
  const ones = fitEmos(all.map((x) => ({ ...x, weight: 1 })), { minSamples: 20, varFloor: 0.25 });
  for (const k of ["a", "b", "c", "d"] as const) {
    expect(plain[k] === ones[k], t, `weight:1 must be bit-identical to unweighted for ${k} (${plain[k]} vs ${ones[k]})`);
  }
  expect(plain.nEffective === plain.n, t, "unweighted nEffective must equal n");

  // 6b. Down-weighting the seed moves the fit toward the live distribution.
  // Measured on the real store the forward residuals are warm, so the fitted
  // map must predict HIGHER at a forward-typical ensMean as seed weight falls.
  const at = (w: number) => {
    const f = fitEmos(
      [...seed.map((x) => ({ ...x, weight: w })), ...forward],
      { minSamples: 20, varFloor: 0.25 },
    );
    return { fit: f, pred: f.a + f.b * 28 };
  };
  const w100 = at(1), w10 = at(0.1), w03 = at(0.03);
  expect(w10.pred > w100.pred, t,
    `seed weight 0.1 must pull the map toward the warm live rows (${w100.pred.toFixed(3)} -> ${w10.pred.toFixed(3)})`);
  expect(w03.pred > w10.pred, t, "monotone: less seed weight -> more forward influence");

  // 6c. nEffective reports the real (weighted) sample size, so an operator can
  // see when a low weight has collapsed the fit to a handful of points. This is
  // the guard against tuning the weight to 0.01 and believing the result.
  expect(Math.abs((w10.fit.nEffective ?? 0) - (180 * 0.1 + 8)) < 1e-9, t,
    `nEffective must be the weight sum, got ${w10.fit.nEffective}`);
  expect((w03.fit.nEffective ?? 0) < 15, t, "at weight 0.03 the effective sample must visibly collapse");
  expect(w03.fit.n === all.length, t, "raw n must still report every sample used");

  // 6d. Non-finite / non-positive weights fall back to 1 rather than poisoning
  // the fit with a zero or NaN denominator.
  const junk = fitEmos(all.map((x, i) => ({ ...x, weight: i % 3 === 0 ? NaN : i % 3 === 1 ? 0 : -1 })), { minSamples: 20 });
  for (const k of ["a", "b", "c", "d"] as const) {
    expect(Math.abs(junk[k] - plain[k]) < 1e-12, t, `junk weights must degrade to unweighted for ${k}`);
  }
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("emos.test.mts") || entry.endsWith("emos.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("emos.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`emos.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
