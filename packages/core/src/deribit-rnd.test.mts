// netlify/functions/auto-trader/shared/deribit-rnd.test.mts
//
// Regression guard for the #7 Deribit risk-neutral density (Breeden–Litzenberger)
// module. Lives under auto-trader/shared/ (never its own function); imports the
// REAL dependency-free module → pins shipped code.
//
// Run: npx tsx netlify/functions/auto-trader/shared/deribit-rnd.test.mts

import {
  impliedVolAt,
  blackScholesCall,
  blDigitalAbove,
  type SmilePoint,
} from "./deribit-rnd.mts";
import { terminalAboveProbability } from "./first-passage.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

const flat: SmilePoint[] = [{ strike: 80000, iv: 0.6 }, { strike: 120000, iv: 0.6 }];
const skew: SmilePoint[] = [
  { strike: 80000, iv: 0.80 }, { strike: 100000, iv: 0.60 }, { strike: 120000, iv: 0.50 },
];

// ── impliedVolAt: interpolation, flat extrapolation, guards ─────────────────
{
  const t = "impliedVolAt";
  // midpoint of the skew smile: K=90000 → halfway between 0.80 and 0.60 = 0.70.
  expect(approx(impliedVolAt(skew, 90000), 0.70), t, `mid interp = 0.70, got ${impliedVolAt(skew, 90000)}`);
  // flat extrapolation beyond the listed range.
  expect(impliedVolAt(skew, 50000) === 0.80, t, "below range → first IV");
  expect(impliedVolAt(skew, 200000) === 0.50, t, "above range → last IV");
  // single point / empty.
  expect(impliedVolAt([{ strike: 100000, iv: 0.55 }], 123456) === 0.55, t, "single point");
  expect(Number.isNaN(impliedVolAt([], 100000)), t, "empty → NaN");
}

// ── blackScholesCall: sanity + monotonicity ─────────────────────────────────
{
  const t = "bs-call";
  const T = 7 / 365;
  expect(blackScholesCall(100000, 100000, 0.6, T) > 0, t, "ATM call positive");
  // Call price decreases in strike.
  expect(blackScholesCall(100000, 95000, 0.6, T) > blackScholesCall(100000, 105000, 0.6, T), t, "C decreasing in K");
  // Deep ITM ≈ intrinsic (S − K) for tiny T.
  const deep = blackScholesCall(100000, 50000, 0.6, 1 / 365);
  expect(deep > 49000 && deep < 51000, t, `deep ITM ≈ intrinsic, got ${deep.toFixed(0)}`);
}

// ── blDigitalAbove: FLAT smile ⇒ ≈ N(d₂) (the BL correctness pin) ────────────
{
  const t = "bl-flat-equals-terminal";
  const S = 100000, T = 7 / 365;
  for (const K of [90000, 100000, 110000]) {
    const bl = blDigitalAbove(S, K, flat, T);
    const nd2 = terminalAboveProbability(S, K, 0.6, T);
    expect(approx(bl, nd2, 6e-3), t, `K=${K}: BL(${bl.toFixed(4)}) ≈ N(d₂)(${nd2.toFixed(4)})`);
  }
}

// ── blDigitalAbove: monotone decreasing in K, bounded, tails ────────────────
{
  const t = "bl-monotone";
  const S = 100000, T = 7 / 365;
  const p90 = blDigitalAbove(S, 90000, skew, T);
  const p100 = blDigitalAbove(S, 100000, skew, T);
  const p110 = blDigitalAbove(S, 110000, skew, T);
  expect(p90 > p100 && p100 > p110, t, `decreasing in K: ${p90.toFixed(3)} > ${p100.toFixed(3)} > ${p110.toFixed(3)}`);
  expect(p90 <= 1 && p110 >= 0, t, "bounded [0,1]");
  // deep ITM → ~1, deep OTM → ~0.
  expect(blDigitalAbove(S, 60000, skew, T) > 0.95, t, "deep ITM ~1");
  expect(blDigitalAbove(S, 160000, skew, T) < 0.05, t, "deep OTM ~0");
}

// ── skew-awareness: a skewed smile differs from flat at the same strike ─────
{
  const t = "bl-skew-aware";
  const S = 100000, T = 30 / 365, K = 115000;
  const flatP = blDigitalAbove(S, K, flat, T);         // flat 0.60
  const skewP = blDigitalAbove(S, K, skew, T);         // lower IV up here (~0.53)
  expect(Math.abs(flatP - skewP) > 3e-3, t, `skew changes the digital: flat=${flatP.toFixed(4)} skew=${skewP.toFixed(4)}`);
}

// ── guards ──────────────────────────────────────────────────────────────────
{
  const t = "guards";
  expect(Number.isNaN(blDigitalAbove(0, 100000, flat, 0.02)), t, "S=0 → NaN");
  expect(Number.isNaN(blDigitalAbove(100000, 100000, [], 0.02)), t, "empty smile → NaN");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("deribit-rnd.test.mts") || entry.endsWith("deribit-rnd.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("deribit-rnd.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`deribit-rnd.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
