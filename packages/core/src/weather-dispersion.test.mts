// packages/core/src/weather-dispersion.test.mts
//
// P0-1 regression guard (system audit 2026-09-09, sprints.md B58).
//
// This suite deliberately pins the MEASUREMENT, not just the code path. The
// fixture below is the REAL forward half of the live EMOS residual store as of
// 2026-09-09 — every row is an observation the bot actually made (live METAR
// obs vs the GEFS mean it actually used), copied off the Hetzner box with
//
//   select key, value from blob_kv where store = 'weather-emos';
//
// and filtered to `seed !== true`, rounded to 2 dp. If someone "improves" the
// dispersion handling and the numbers below move, that is the signal — the
// point of the fix is the calibration figure, not the function signature.
//
// Run: npx tsx packages/core/src/weather-dispersion.test.mts

import {
  inflateSigma,
  dispersionDiagnostics,
  suggestSigmaInflation,
  CALIBRATED_MEDIAN_VAR_RATIO,
  SIGMA_INFLATION_MAX,
  type DispersionSample,
} from "./weather-dispersion.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── The live forward residuals (n = 35). Do not "tidy" these numbers. ────────
const FORWARD: DispersionSample[] = [
  { ensMean: 29.4, ensStd: 0.51, obs: 30 },
  { ensMean: 31.1, ensStd: 0.5,  obs: 32 },
  { ensMean: 31.7, ensStd: 0.5,  obs: 29 },
  { ensMean: 32.2, ensStd: 0.5,  obs: 33 },
  { ensMean: 27.2, ensStd: 1.1,  obs: 28 },
  { ensMean: 25,   ensStd: 1.17, obs: 25 },
  { ensMean: 28.3, ensStd: 1.08, obs: 28 },
  { ensMean: 27.8, ensStd: 1.49, obs: 29 },
  { ensMean: 23.9, ensStd: 1.53, obs: 25 },
  { ensMean: 25,   ensStd: 1.58, obs: 28 },
  { ensMean: 28.9, ensStd: 0.5,  obs: 31 },
  { ensMean: 28.3, ensStd: 0.5,  obs: 30 },
  { ensMean: 28.3, ensStd: 0.5,  obs: 30 },
  { ensMean: 27.8, ensStd: 0.5,  obs: 30 },
  { ensMean: 27.2, ensStd: 0.5,  obs: 30 },
  { ensMean: 22.8, ensStd: 0.8,  obs: 23 },
  { ensMean: 25.6, ensStd: 0.88, obs: 27 },
  { ensMean: 24.4, ensStd: 0.84, obs: 25 },
  { ensMean: 18.3, ensStd: 0.64, obs: 19 },
  { ensMean: 24.4, ensStd: 0.75, obs: 20.6 },
  { ensMean: 28.3, ensStd: 0.5,  obs: 31 },
  { ensMean: 27.2, ensStd: 0.5,  obs: 30 },
  { ensMean: 26.7, ensStd: 0.5,  obs: 29 },
  { ensMean: 32.2, ensStd: 0.5,  obs: 32.2 },
  { ensMean: 32.2, ensStd: 0.5,  obs: 32.8 },
  { ensMean: 23.3, ensStd: 0.94, obs: 24 },
  { ensMean: 23.3, ensStd: 1.18, obs: 24 },
  { ensMean: 27.8, ensStd: 0.95, obs: 28 },
  { ensMean: 30,   ensStd: 0.99, obs: 32 },
  { ensMean: 15.6, ensStd: 0.56, obs: 15 },
  { ensMean: 32.8, ensStd: 0.5,  obs: 28 },
  { ensMean: 29.4, ensStd: 1.1,  obs: 27 },
  { ensMean: 26.1, ensStd: 0.96, obs: 25 },
  { ensMean: 23.3, ensStd: 0.5,  obs: 23 },
  { ensMean: 24.4, ensStd: 0.9,  obs: 24 },
];

// ── 1. factor 1.0 is a BIT-IDENTICAL no-op ───────────────────────────────────
// The knob ships default-OFF, so "off" has to mean exactly off — not
// approximately off. Multiplying by 1.0 would be fine in floating point, but
// pinning identity means a future refactor cannot smuggle in a rounding step.
{
  const t = "off-is-identity";
  for (const s of [0.5, 0.51, 1.49, 2.0, 0.0001, 1e6]) {
    expect(inflateSigma(s, 1) === s, t, `factor 1 must return σ unchanged, ${s} → ${inflateSigma(s, 1)}`);
  }
  for (const bad of [NaN, undefined as any, null as any, 0, -3, 0.5]) {
    expect(inflateSigma(0.8, bad) === 0.8, t, `factor ${bad} must be treated as 1 (never shrink σ)`);
  }
  expect(inflateSigma(0, 2) === 0, t, "non-positive σ passes through");
  expect(inflateSigma(NaN, 2) !== inflateSigma(NaN, 2) , t, "NaN σ passes through as NaN");
}

// ── 2. clamped at the documented ceiling ─────────────────────────────────────
{
  const t = "clamp";
  expect(inflateSigma(1, 99) === SIGMA_INFLATION_MAX, t, `σ×99 must clamp to ×${SIGMA_INFLATION_MAX}`);
  expect(inflateSigma(2, 2) === 4, t, "in-range factor multiplies");
}

// ── 3. THE MEASUREMENT: the live forecast is overconfident by ~10× in variance
// This is the number that justified the whole fix. mean(err²/σ²) = 10.04 where
// 1.0 is calibrated. If this assertion ever fails, either the fixture drifted
// or the scoring changed — and the P0-1 argument has to be re-made, not patched.
{
  const t = "baseline-overconfidence";
  const d = dispersionDiagnostics(FORWARD, 1);
  expect(d.n === 35, t, `expected n=35, got ${d.n}`);
  expect(Math.abs(d.varRatio - 10.04) < 0.05, t, `var-ratio should be ≈10.04, got ${d.varRatio.toFixed(3)}`);
  // Outlier-robust view: the median ratio is ~3.2× the calibrated χ²₁ median,
  // i.e. σ too small by ~1.8× even after discarding the tail.
  expect(d.medianVarRatio > 2.5 * CALIBRATED_MEDIAN_VAR_RATIO, t,
    `median var-ratio ${d.medianVarRatio.toFixed(3)} should be well above the calibrated ${CALIBRATED_MEDIAN_VAR_RATIO.toFixed(3)}`);
  // The bot also runs WARM: it under-forecasts the daily max by about half a
  // degree. σ inflation does not touch this — it is P0-2's problem.
  expect(d.meanBias > 0.3 && d.meanBias < 0.7, t, `mean bias should be ≈+0.50 °C, got ${d.meanBias.toFixed(3)}`);
}

// ── 4. inflation monotonically repairs the dispersion, and overshoots ────────
{
  const t = "monotone-repair";
  const ratios = [1, 1.5, 2, 2.5, 3, 3.5].map((f) => dispersionDiagnostics(FORWARD, f).varRatio);
  for (let i = 1; i < ratios.length; i++) {
    expect(ratios[i] < ratios[i - 1], t, `var-ratio must fall as σ widens (step ${i}: ${ratios[i - 1].toFixed(2)} → ${ratios[i].toFixed(2)})`);
  }
  expect(ratios[0] > 1, t, "starts overconfident");
  expect(ratios[ratios.length - 1] < 1, t, "σ×3.5 overshoots into UNDER-confident — so more is not better");
  // λ = 2 is the shipped recommendation: still slightly overconfident (safer
  // than overshooting) but 4× closer to calibrated than today.
  const at2 = dispersionDiagnostics(FORWARD, 2).varRatio;
  expect(at2 > 1 && at2 < 3, t, `σ×2 should land in (1,3), got ${at2.toFixed(2)}`);
}

// ── 5. the bias diagnostic is INVARIANT to σ — guards against conflating them
// A reviewer's likely instinct is "widen σ and the calibration is fixed".
// It is not: the +0.5 °C warm bias survives untouched at every factor.
{
  const t = "bias-invariant";
  const b1 = dispersionDiagnostics(FORWARD, 1).meanBias;
  const b3 = dispersionDiagnostics(FORWARD, 3).meanBias;
  expect(Math.abs(b1 - b3) < 1e-12, t, `bias must not move with σ (${b1} vs ${b3})`);
}

// ── 6. the recommendation is a PLATEAU, not the argmax ───────────────────────
{
  const t = "plateau-not-peak";
  const s = suggestSigmaInflation(FORWARD)!;
  expect(s !== null, t, "expected a suggestion at n=35");
  expect(!s.isPeak, t, "the log-score optimum should be a broad plateau, not a lone spike");
  expect(s.plateauWidth >= 3, t, `plateau should span several grid points, got ${s.plateauWidth}`);
  expect(s.factor >= 1.75 && s.factor <= 3.0, t, `recommended factor ${s.factor} outside the measured plateau`);
  expect(s.factor <= s.peakFactor, t, "plateau centre should not exceed the peak on a monotone-ish curve");
  expect(s.recommended.meanLogScore < s.baseline.meanLogScore, t,
    `recommendation must improve the log score (${s.baseline.meanLogScore.toFixed(3)} → ${s.recommended.meanLogScore.toFixed(3)})`);
}

// ── 7. refuses to recommend from a thin sample ───────────────────────────────
// n=35 is already thin. Below the floor the caller must get null, not a
// confident number derived from five points.
{
  const t = "min-samples";
  expect(suggestSigmaInflation(FORWARD.slice(0, 5)) === null, t, "n=5 must yield no recommendation");
  expect(suggestSigmaInflation([]) === null, t, "empty input must yield no recommendation");
  expect(suggestSigmaInflation(FORWARD, { minSamples: 3 }) !== null, t, "explicit low floor is honoured");
}

// ── 8. composition with EMOS — the LIVE path, and the reason λ is 2.25 ───────
// The knob is applied AFTER emosApply, and `weatherUseEmos` is ON in production,
// so the λ an operator sets acts on top of EMOS, not on top of the raw ensemble.
//
// CALIBRATED below is the SAME 35 observations after each station's own live
// EMOS fit (copied from blob_kv store 'weather-emos', field `params`, fittedAt
// 2026-09-09T00:01Z) — per-station, because applying one station's a/b to
// another's rows is meaningless.
//
// This group guards a claim the audit initially got WRONG. EMOS *looked* like
// it was hurting: 17 of 27 stations shrink σ (VHHH 0.80 → 0.53). It is not —
// its mean correction more than pays for the tighter spread. Measured here:
// variance ratio 10.04 → 5.96. If a future change makes EMOS-then-inflate worse
// than raw-then-inflate, these assertions are the alarm.
const CALIBRATED: DispersionSample[] = [
  { ensMean: 29.179, ensStd: 0.514, obs: 30 },
  { ensMean: 30.872, ensStd: 0.513, obs: 32 },
  { ensMean: 31.47,  ensStd: 0.513, obs: 29 },
  { ensMean: 31.968, ensStd: 0.513, obs: 33 },
  { ensMean: 26.466, ensStd: 1.071, obs: 28 },
  { ensMean: 24.342, ensStd: 1.125, obs: 25 },
  { ensMean: 27.528, ensStd: 1.056, obs: 28 },
  { ensMean: 27.045, ensStd: 1.377, obs: 29 },
  { ensMean: 23.28,  ensStd: 1.409, obs: 25 },
  { ensMean: 25.401, ensStd: 1.08,  obs: 28 },
  { ensMean: 29.767, ensStd: 0.672, obs: 31 },
  { ensMean: 29.156, ensStd: 0.672, obs: 30 },
  { ensMean: 29.156, ensStd: 0.672, obs: 30 },
  { ensMean: 28.646, ensStd: 0.672, obs: 30 },
  { ensMean: 28.035, ensStd: 0.672, obs: 30 },
  { ensMean: 23.022, ensStd: 0.81,  obs: 23 },
  { ensMean: 25.88,  ensStd: 0.861, obs: 27 },
  { ensMean: 24.655, ensStd: 0.835, obs: 25 },
  { ensMean: 18.43,  ensStd: 0.714, obs: 19 },
  { ensMean: 24.939, ensStd: 1.009, obs: 20.6 },
  { ensMean: 28.71,  ensStd: 0.532, obs: 31 },
  { ensMean: 27.603, ensStd: 0.532, obs: 30 },
  { ensMean: 27.099, ensStd: 0.532, obs: 29 },
  { ensMean: 32.432, ensStd: 0.607, obs: 32.2 },
  { ensMean: 32.432, ensStd: 0.607, obs: 32.8 },
  { ensMean: 22.786, ensStd: 0.576, obs: 24 },
  { ensMean: 22.786, ensStd: 0.615, obs: 24 },
  { ensMean: 27.076, ensStd: 0.577, obs: 28 },
  { ensMean: 29.173, ensStd: 0.583, obs: 32 },
  { ensMean: 15.46,  ensStd: 0.677, obs: 15 },
  { ensMean: 32.877, ensStd: 0.892, obs: 28 },
  { ensMean: 28.586, ensStd: 0.74,  obs: 27 },
  { ensMean: 25.419, ensStd: 0.74,  obs: 25 },
  { ensMean: 22.733, ensStd: 0.74,  obs: 23 },
  { ensMean: 23.788, ensStd: 0.74,  obs: 24 },
];
{
  const t = "emos-composition";
  const raw  = dispersionDiagnostics(FORWARD, 1);
  const emos = dispersionDiagnostics(CALIBRATED, 1);

  expect(CALIBRATED.length === FORWARD.length, t, "the two fixtures must describe the same 35 observations");
  expect(Math.abs(emos.varRatio - 5.96) < 0.05, t,
    `EMOS alone should take the variance ratio to ≈5.96, got ${emos.varRatio.toFixed(3)}`);
  expect(emos.varRatio < raw.varRatio, t,
    `EMOS must REDUCE dispersion error (${raw.varRatio.toFixed(2)} → ${emos.varRatio.toFixed(2)}) — it is not the villain`);
  expect(emos.meanLogScore < raw.meanLogScore, t,
    `EMOS must improve the log score (${raw.meanLogScore.toFixed(2)} → ${emos.meanLogScore.toFixed(2)})`);
  // ...and yet it is nowhere near enough on its own — this is why λ exists.
  expect(emos.varRatio > 3, t,
    `EMOS alone must not be mistaken for the fix; residual overconfidence should remain, got ${emos.varRatio.toFixed(2)}`);
  // ...and it does NOT fix the warm bias — measured +0.497 °C raw, +0.55 °C after
  // EMOS. That is P0-2 in one number: the mean correction was fitted on 4887
  // SEEDED residuals (ERA5 obs + inter-model spread, bias −0.03 °C) and simply
  // does not transfer to the live METAR-vs-GEFS distribution it is applied to.
  // Widening σ cannot help here either — see group 5. Pinned so that a future
  // EMOS refit has an explicit target to beat.
  expect(emos.meanBias > 0.4, t,
    `EMOS is NOT expected to remove the forward warm bias (raw +${raw.meanBias.toFixed(2)}, EMOS +${emos.meanBias.toFixed(2)}) — if it ever does, P0-2 has been fixed and this pin should be retightened`);

  // The shipped λ for the live (EMOS-on) path lands essentially calibrated.
  const at225 = dispersionDiagnostics(CALIBRATED, 2.25);
  expect(at225.varRatio > 0.8 && at225.varRatio < 1.6, t,
    `EMOS + λ=2.25 should land near a variance ratio of 1, got ${at225.varRatio.toFixed(2)}`);
  expect(at225.meanLogScore < emos.meanLogScore, t, "λ must still improve the log score after EMOS");

  // λ is PATH-DEPENDENT, and the direction is the non-obvious part: the EMOS-on
  // path needs slightly LESS inflation (2.25) than raw (2.5 on log score), because
  // EMOS has already absorbed part of the overconfidence (10.04 → 5.96). Pinned so
  // that nobody collapses the two paths into a single "correct" constant.
  const rawBest  = suggestSigmaInflation(FORWARD)!.factor;
  const liveBest = suggestSigmaInflation(CALIBRATED)!.factor;
  expect(liveBest < rawBest, t,
    `EMOS absorbs some overconfidence, so the live path should need LESS inflation than raw (raw ${rawBest}, live ${liveBest})`);
  expect(liveBest === 2.25, t, `shipped live-path recommendation is 2.25, got ${liveBest}`);
}

// ── 9. degenerate input does not throw or poison the stats ───────────────────
{
  const t = "degenerate";
  const d = dispersionDiagnostics(
    [
      { ensMean: 20, ensStd: 0, obs: 21 },      // σ=0 → dropped
      { ensMean: NaN, ensStd: 1, obs: 21 },     // NaN μ → dropped
      { ensMean: 20, ensStd: 1, obs: NaN },     // NaN obs → dropped
      { ensMean: 20, ensStd: 1, obs: 21 },      // the only survivor
    ],
    2,
  );
  expect(d.n === 1, t, `only the finite row should survive, got n=${d.n}`);
  expect(Number.isFinite(d.varRatio) && Number.isFinite(d.meanCrps), t, "stats stay finite");
  const empty = dispersionDiagnostics([], 2);
  expect(empty.n === 0 && Number.isNaN(empty.varRatio), t, "empty input reports n=0 / NaN, not 0");
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`FAIL  weather-dispersion.test.mts — ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  [${f.test}] ${f.message}`);
  process.exit(1);
}
console.log("PASS  weather-dispersion.test.mts");
