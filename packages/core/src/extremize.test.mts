// netlify/functions/auto-trader/shared/extremize.test.mts
//
// Contract pin for the #8 disagreement-gated extremizing added to
// signal-combiner.mts `combine()`. combine() imports getStore + Netlify-only
// modules, so — like log-odds-pool.test.mts — this RE-IMPLEMENTS the extremize
// block locally. It MUST stay in sync with the block in combine() (guarded
// `extremizeStrength > 0 && n >= 2`).
//
// Run: npx tsx netlify/functions/auto-trader/shared/extremize.test.mts

function clampProb01(p: number): number { return Math.max(1e-4, Math.min(1 - 1e-4, p)); }
function logit(p: number): number { const c = clampProb01(p); return Math.log(c / (1 - c)); }
function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

// Mirror of the combine() extremize block. `weights` are pre-normalized (Σ≈1).
function extremize(
  combined: number,
  values: Record<string, number>,
  weights: Record<string, number>,
  strength: number,
): number {
  const es = Math.max(0, Math.min(1, strength));
  const names = Object.keys(values);
  if (!(es > 0) || names.length < 2) return combined;
  let Lbar = 0, wTot = 0;
  for (const k of names) { Lbar += weights[k] * logit(values[k]); wTot += weights[k]; }
  Lbar /= (wTot || 1);
  let varL = 0;
  for (const k of names) varL += weights[k] * (logit(values[k]) - Lbar) ** 2;
  varL /= (wTot || 1);
  const stdL = Math.sqrt(Math.max(0, varL));
  const disagreement = Math.min(1, stdL / 1.5);
  const aMax = 1 + es * 0.7;
  const a = 1 + (aMax - 1) * disagreement;
  return sigmoid(a * logit(combined));
}

// Weighted-mean-logit pool (the `combined` the block runs on), for realistic inputs.
function pool(values: Record<string, number>, weights: Record<string, number>): number {
  let L = 0, w = 0;
  for (const k of Object.keys(values)) { L += weights[k] * logit(values[k]); w += weights[k]; }
  return sigmoid(L / (w || 1));
}

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;
const eqW = { a: 0.5, b: 0.5 };

// ── strength=0 is an exact no-op (regression pin) ───────────────────────────
{
  const t = "default-off";
  const vals = { a: 0.9, b: 0.4 };
  const c = pool(vals, eqW);
  expect(extremize(c, vals, eqW, 0) === c, t, "strength=0 → unchanged");
}

// ── high disagreement + strength=1 → sharpens away from 0.5 ─────────────────
{
  const t = "high-disagreement";
  const vals = { a: 0.9, b: 0.4 };       // dispersed (logit spread ≈ 2.6)
  const c = pool(vals, eqW);             // ≈ 0.710
  const e = extremize(c, vals, eqW, 1);
  expect(e > c, t, `extremized(${e.toFixed(4)}) > pooled(${c.toFixed(4)})`);
  expect(approx(e, 0.808, 5e-3), t, `extremized ≈ 0.808, got ${e.toFixed(4)}`);
}

// ── low disagreement (clustered signals) → a ≈ 1 → barely changes ───────────
{
  const t = "low-disagreement";
  const vals = { a: 0.68, b: 0.72 };     // tight cluster
  const c = pool(vals, eqW);             // ≈ 0.700
  const e = extremize(c, vals, eqW, 1);
  expect(Math.abs(e - c) < 0.02, t, `clustered → little change, pooled=${c.toFixed(4)} ext=${e.toFixed(4)}`);
  expect(e > c, t, "still nudges the right way");
}

// ── symmetry: p=0.5 stays 0.5 ───────────────────────────────────────────────
{
  const t = "symmetry";
  const vals = { a: 0.9, b: 0.1 };       // pools to 0.5
  const c = pool(vals, eqW);
  expect(approx(c, 0.5), t, `symmetric pool = 0.5, got ${c.toFixed(4)}`);
  expect(approx(extremize(c, vals, eqW, 1), 0.5), t, "extremized 0.5 stays 0.5");
}

// ── direction: pooled < 0.5 → extremized even lower ─────────────────────────
{
  const t = "direction-down";
  const vals = { a: 0.1, b: 0.6 };       // pools below 0.5, dispersed
  const c = pool(vals, eqW);
  const e = extremize(c, vals, eqW, 1);
  expect(c < 0.5 && e < c, t, `pooled ${c.toFixed(4)} < 0.5 → extremized ${e.toFixed(4)} lower`);
  expect(e > 0 && e < 1, t, "bounded in (0,1)");
}

// ── strength scales the effect monotonically ────────────────────────────────
{
  const t = "strength-monotone";
  const vals = { a: 0.9, b: 0.4 };
  const c = pool(vals, eqW);
  const e25 = extremize(c, vals, eqW, 0.25);
  const e50 = extremize(c, vals, eqW, 0.5);
  const e100 = extremize(c, vals, eqW, 1);
  expect(c < e25 && e25 < e50 && e50 < e100, t,
    `more strength → more extreme: ${c.toFixed(3)} < ${e25.toFixed(3)} < ${e50.toFixed(3)} < ${e100.toFixed(3)}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("extremize.test.mts") || entry.endsWith("extremize.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("extremize.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`extremize.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
