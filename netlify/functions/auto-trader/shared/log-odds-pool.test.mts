// netlify/functions/auto-trader/shared/log-odds-pool.test.mts
//
// Contract pin for the #3 general LOG-ODDS POOL added to signal-combiner.mts
// `combine()`. Lives under auto-trader/shared/ so a *.test.mts never deploys as
// its own Netlify function. The combiner imports getStore + many Netlify-only
// modules, so — like signal-combiner-threshold.test.mts — this RE-IMPLEMENTS
// the pooling formula locally. It MUST stay in sync with the block in
// combine() (signal-combiner.mts, guarded `marketKind !== "threshold" &&
// logOddsStrength > 0`).
//
// Run: npx tsx netlify/functions/auto-trader/shared/log-odds-pool.test.mts

// ── local mirror of the combiner helpers + blend ────────────────────────────
function clampProb01(p: number): number { return Math.max(1e-4, Math.min(1 - 1e-4, p)); }
function logit(p: number): number { const c = clampProb01(p); return Math.log(c / (1 - c)); }
function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

// Mirror of the combine() block. `weights` are pre-normalized (Σ≈1), exactly
// as in combine() at the point the block runs.
function logOddsBlend(
  linear: number,
  values: Record<string, number>,
  weights: Record<string, number>,
  s: number,
  marketKind: "directional" | "threshold",
): number {
  if (marketKind === "threshold" || !(s > 0)) return linear;   // skip: threshold pools via K-anchor
  let logitSum = 0, wSum = 0;
  for (const k of Object.keys(values)) { logitSum += weights[k] * logit(values[k]); wSum += weights[k]; }
  const pLogOdds = sigmoid(wSum > 1e-9 ? logitSum / wSum : 0);
  const ss = Math.max(0, Math.min(1, s));
  return (1 - ss) * linear + ss * pLogOdds;
}

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

const eqW = { a: 0.5, b: 0.5 };

// ── s=0 is an exact no-op (the load-bearing regression pin) ─────────────────
{
  const t = "default-off";
  const vals = { a: 0.9, b: 0.5 };
  const linear = 0.7;                       // arithmetic mean under equal weights
  expect(logOddsBlend(linear, vals, eqW, 0, "directional") === linear, t, "s=0 → linear untouched");
}

// ── log-odds pool is MORE decisive than the linear mean (under-confidence fix)
{
  const t = "more-decisive";
  const vals = { a: 0.9, b: 0.5 };
  const linear = 0.7;
  // sigmoid((0.5·logit0.9 + 0.5·logit0.5)) = sigmoid(1.0986) = 0.75
  const out = logOddsBlend(linear, vals, eqW, 1, "directional");
  expect(approx(out, 0.75, 2e-3), t, `log-odds pool = 0.75, got ${out.toFixed(4)}`);
  expect(out > linear, t, `more decisive than linear ${linear}, got ${out.toFixed(4)}`);
  // bounded: stays within [min input, max input]
  expect(out >= 0.5 && out <= 0.9, t, `bounded within inputs, got ${out.toFixed(4)}`);
}

// ── symmetric inputs around 0.5 stay at 0.5 (no spurious bias) ──────────────
{
  const t = "symmetric";
  const out = logOddsBlend(0.5, { a: 0.7, b: 0.3 }, eqW, 1, "directional");
  expect(approx(out, 0.5), t, `symmetric → 0.5, got ${out.toFixed(4)}`);
}

// ── partial blend interpolates linearly between linear and log-odds ─────────
{
  const t = "partial-blend";
  const vals = { a: 0.9, b: 0.5 };
  const out = logOddsBlend(0.7, vals, eqW, 0.5, "directional");
  // 0.5·0.7 + 0.5·0.75 = 0.725
  expect(approx(out, 0.725, 2e-3), t, `s=0.5 blend = 0.725, got ${out.toFixed(4)}`);
}

// ── threshold markets are skipped (K-anchor owns pooling there) ─────────────
{
  const t = "threshold-skip";
  const out = logOddsBlend(0.7, { a: 0.9, b: 0.5 }, eqW, 1, "threshold");
  expect(out === 0.7, t, "threshold → blend skipped, linear untouched");
}

// ── weighted (unequal) weights: the more-weighted signal dominates the pool ──
{
  const t = "weighted";
  const vals = { a: 0.8, b: 0.2 };
  const w = { a: 0.75, b: 0.25 };           // 'a' carries 3× the weight
  // sigmoid(0.75·logit0.8 + 0.25·logit0.2) = sigmoid(0.75·1.3863 + 0.25·(−1.3863))
  //  = sigmoid(0.6931) = 0.6667
  const out = logOddsBlend(0.5, vals, w, 1, "directional");
  expect(approx(out, 0.6667, 2e-3), t, `weighted log-odds = 0.667, got ${out.toFixed(4)}`);
  expect(out > 0.5, t, "leans toward the heavier bullish signal");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("log-odds-pool.test.mts") || entry.endsWith("log-odds-pool.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("log-odds-pool.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`log-odds-pool.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
