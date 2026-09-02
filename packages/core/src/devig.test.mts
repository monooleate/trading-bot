// netlify/functions/auto-trader/shared/devig.test.mts
//
// Regression guard for the #9 bookmaker de-vig (sports Pinnacle fair-value, B37).
// Lives under auto-trader/shared/ (never its own function); imports the REAL
// dependency-free module → pins shipped code.
//
// Run: npx tsx netlify/functions/auto-trader/shared/devig.test.mts

import {
  impliedFromDecimal,
  overround,
  devigMultiplicative,
  devigPower,
  twoWayFairYes,
  americanToDecimal,
} from "./devig.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

// ── implied + overround ─────────────────────────────────────────────────────
{
  const t = "implied";
  const q = impliedFromDecimal([1.9, 1.9]);
  expect(approx(q[0], 0.5263, 1e-3) && approx(q[1], 0.5263, 1e-3), t, `q from 1.9, got ${q}`);
  expect(approx(overround([1.9, 1.9]), 1.0526, 1e-3), t, `overround ≈ 1.0526, got ${overround([1.9, 1.9]).toFixed(4)}`);
  expect(approx(overround([1.5, 3.0]), 1.0), t, "1.5/3.0 is a fair book (overround 1)");
}

// ── multiplicative de-vig ───────────────────────────────────────────────────
{
  const t = "multiplicative";
  const fair = devigMultiplicative([2.0, 2.0]);
  expect(approx(fair[0], 0.5) && approx(fair[1], 0.5), t, `2.0/2.0 → 50/50, got ${fair}`);
  // 1.5 / 2.5: q=[0.6667,0.4], sum=1.0667 → [0.625, 0.375].
  const f2 = devigMultiplicative([1.5, 2.5]);
  expect(approx(f2[0], 0.625) && approx(f2[1], 0.375), t, `1.5/2.5 → 0.625/0.375, got ${f2}`);
  // Always sums to 1.
  const f3 = devigMultiplicative([1.9, 1.9]);
  expect(approx(sum(f3), 1), t, `sums to 1, got ${sum(f3)}`);
  // A 3-way book (home/draw/away).
  const f4 = devigMultiplicative([2.1, 3.4, 3.9]);
  expect(approx(sum(f4), 1), t, `3-way sums to 1, got ${sum(f4)}`);
}

// ── power de-vig: sums to 1, no-vig identity, FLB direction ──────────────────
{
  const t = "power";
  // No positive margin → falls back to multiplicative.
  const p0 = devigPower([2.0, 2.0]);
  expect(approx(p0[0], 0.5) && approx(p0[1], 0.5), t, `no-vig → 50/50, got ${p0}`);
  // With vig: sums to 1.
  const p = devigPower([1.5, 2.5]);
  expect(approx(sum(p), 1, 2e-3), t, `power sums to 1, got ${sum(p).toFixed(4)}`);
  // FLB: power gives the FAVORITE slightly MORE than multiplicative
  // (longshots are over-bet → their true prob is lower).
  const m = devigMultiplicative([1.5, 2.5]);
  expect(p[0] > m[0], t, `power favorite(${p[0].toFixed(4)}) > multiplicative(${m[0].toFixed(4)})`);
  expect(p[0] < 0.7, t, "favorite stays sane");
}

// ── twoWayFairYes convenience ───────────────────────────────────────────────
{
  const t = "twoWay";
  expect(approx(twoWayFairYes(1.5, 2.5), 0.625), t, `2-way YES = 0.625, got ${twoWayFairYes(1.5, 2.5)}`);
  expect(twoWayFairYes(1.5, 2.5, "power") > 0.625, t, "power route > multiplicative");
  // Heavy favorite.
  expect(twoWayFairYes(1.1, 8.0) > 0.85, t, `heavy fav YES high, got ${twoWayFairYes(1.1, 8.0).toFixed(3)}`);
}

// ── american odds conversion ────────────────────────────────────────────────
{
  const t = "american";
  expect(approx(americanToDecimal(-150), 1.6667, 1e-3), t, `-150 → 1.667, got ${americanToDecimal(-150).toFixed(4)}`);
  expect(approx(americanToDecimal(130), 2.30), t, `+130 → 2.30, got ${americanToDecimal(130)}`);
  // Fair YES from american: -150 / +130.
  const y = twoWayFairYes(americanToDecimal(-150), americanToDecimal(130));
  expect(y > 0.5 && y < 0.65, t, `favored side YES ~0.58, got ${y.toFixed(3)}`);
}

// ── guards ──────────────────────────────────────────────────────────────────
{
  const t = "guards";
  expect(Number.isNaN(twoWayFairYes(1.0, 2.0)), t, "odds ≤ 1 → NaN");
  expect(Number.isNaN(twoWayFairYes(2.0, 0.5)), t, "odds ≤ 1 (NO) → NaN");
  expect(Number.isNaN(americanToDecimal(0)), t, "american 0 → NaN");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("devig.test.mts") || entry.endsWith("devig.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("devig.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`devig.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
