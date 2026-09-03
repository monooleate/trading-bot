// packages/core/src/plateau.test.mts
//
// Regression guard for plateau-not-peak selection + ensemble weights
// (model-discovery-training §3.A / #7, sprints.md B50). Pure, no I/O.
//
// Run: npx tsx packages/core/src/plateau.test.mts

import { selectPlateau, ensembleWeights, type Candidate } from "./plateau.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

// ── 1. plateau chosen over an isolated peak ──────────────────────────────────
{
  const t = "plateau";
  // values 1..7; a broad plateau at 4-5-6 (~0.80) and an isolated spike at 1 (0.82).
  const cands: Candidate[] = [
    { value: 1, score: 0.82 },  // lone spike
    { value: 2, score: 0.40 },
    { value: 3, score: 0.60 },
    { value: 4, score: 0.79 },
    { value: 5, score: 0.80 },
    { value: 6, score: 0.795 },
    { value: 7, score: 0.55 },
  ];
  const r = selectPlateau(cands, { tol: 0.03 })!;
  expect(r.peakValue === 1, t, `peak is the spike at 1, got ${r.peakValue}`);
  expect(r.value === 5, t, `plateau center at 5 (4-5-6 run), got ${r.value}`);
  expect(r.plateauWidth === 3, t, `plateau width 3, got ${r.plateauWidth}`);
  expect(!r.isPeak, t, "not flagged as isolated peak");
}

// ── 2. isolated peak flagged ─────────────────────────────────────────────────
{
  const t = "isolated";
  const cands: Candidate[] = [
    { value: 1, score: 0.2 }, { value: 2, score: 0.9 }, { value: 3, score: 0.2 },
  ];
  const r = selectPlateau(cands, { tol: 0.05 })!;
  expect(r.value === 2 && r.plateauWidth === 1 && r.isPeak, t, `lone spike flagged, got ${JSON.stringify(r)}`);
}

// ── 3. widest plateau wins over a narrower higher one within tol ─────────────
{
  const t = "widest";
  const cands: Candidate[] = [
    { value: 1, score: 0.90 }, { value: 2, score: 0.91 },              // narrow pair (top)
    { value: 3, score: 0.50 },
    { value: 4, score: 0.89 }, { value: 5, score: 0.90 }, { value: 6, score: 0.895 }, { value: 7, score: 0.89 }, // wide run
  ];
  // tol 0.03 → threshold 0.88; near = [T,T,F,T,T,T,T]; widest run = values 4-7 (len 4).
  const r = selectPlateau(cands, { tol: 0.03 })!;
  expect(r.plateauWidth === 4, t, `widest run len 4, got ${r.plateauWidth}`);
  expect(r.value === 5, t, `center of 4-7 run → 5, got ${r.value}`);
}

// ── 4. degenerate inputs ─────────────────────────────────────────────────────
{
  const t = "degenerate";
  expect(selectPlateau([]) === null, t, "empty → null");
  const one = selectPlateau([{ value: 3, score: 0.5 }])!;
  expect(one.value === 3 && one.isPeak, t, "single candidate → itself, isPeak");
  // unsorted input is handled
  const r = selectPlateau([{ value: 9, score: 0.8 }, { value: 1, score: 0.2 }, { value: 5, score: 0.8 }], { tol: 0.01 })!;
  expect(Number.isFinite(r.value), t, "unsorted handled");
}

// ── 5. ensembleWeights: monotone in score, sums to 1 ─────────────────────────
{
  const t = "ensemble";
  const w = ensembleWeights([{ value: 1, score: 0.2 }, { value: 2, score: 0.8 }, { value: 3, score: 0.5 }], 0.3);
  expect(approx(w.reduce((a, b) => a + b, 0), 1), t, `sums to 1, got ${w.reduce((a, b) => a + b, 0)}`);
  expect(w[1] > w[2] && w[2] > w[0], t, `higher score → higher weight, got ${JSON.stringify(w)}`);
  // equal scores → equal weights
  const eq = ensembleWeights([{ value: 1, score: 0.5 }, { value: 2, score: 0.5 }]);
  expect(approx(eq[0], 0.5) && approx(eq[1], 0.5), t, "equal scores → equal weights");
  expect(ensembleWeights([]).length === 0, t, "empty → []");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("plateau.test.mts") || entry.endsWith("plateau.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("plateau.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`plateau.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
