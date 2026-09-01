// netlify/functions/auto-trader/shared/first-passage.test.mts
//
// Regression guard for the #6 first-passage / one-touch pricing + barrier
// classifier. Lives under auto-trader/shared/ (never its own function); imports
// the REAL dependency-free module → pins shipped code.
//
// Run: npx tsx netlify/functions/auto-trader/shared/first-passage.test.mts

import {
  normalCdf,
  oneTouchProbability,
  terminalAboveProbability,
  classifyBarrierMarket,
} from "./first-passage.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
const approx = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

// ── normalCdf ───────────────────────────────────────────────────────────────
{
  const t = "normalCdf";
  expect(approx(normalCdf(0), 0.5), t, `Φ(0)=0.5, got ${normalCdf(0)}`);
  expect(approx(normalCdf(1.96), 0.975, 2e-3), t, `Φ(1.96)≈0.975, got ${normalCdf(1.96).toFixed(4)}`);
  expect(approx(normalCdf(-1.96), 0.025, 2e-3), t, `Φ(-1.96)≈0.025, got ${normalCdf(-1.96).toFixed(4)}`);
}

// ── terminal digital sanity ─────────────────────────────────────────────────
{
  const t = "terminal";
  // Deep ITM (S >> K) → ~1; deep OTM (S << K) → ~0.
  expect(terminalAboveProbability(120, 100, 0.6, 0.02) > 0.9, t, "deep ITM ~1");
  expect(terminalAboveProbability(80, 100, 0.6, 0.02) < 0.1, t, "deep OTM ~0");
}

// ── one-touch ≈ 2× terminal for a near barrier (reflection principle) ───────
{
  const t = "one-touch-2x";
  const S = 100, K = 102, sigma = 0.6, T = 1 / 365;
  const term = terminalAboveProbability(S, K, sigma, T);
  const touch = oneTouchProbability(S, K, sigma, T);
  expect(touch > term, t, `touch(${touch.toFixed(4)}) > terminal(${term.toFixed(4)})`);
  expect(touch <= 1, t, "touch ≤ 1");
  // ~2× (reflection), within tolerance.
  expect(approx(touch / term, 2, 0.15), t, `touch/terminal ≈ 2, got ${(touch / term).toFixed(3)}`);
  expect(approx(touch, 0.523, 0.02), t, `touch ≈ 0.523, got ${touch.toFixed(4)}`);
}

// ── down-touch (lower barrier) is symmetric-ish and > terminal-below ────────
{
  const t = "down-touch";
  const S = 100, K = 98, sigma = 0.6, T = 1 / 365;
  const touch = oneTouchProbability(S, K, sigma, T);
  const termBelow = 1 - terminalAboveProbability(S, K, sigma, T); // P(S_T < K)
  expect(touch > termBelow, t, `down-touch(${touch.toFixed(4)}) > P(finish below)(${termBelow.toFixed(4)})`);
  expect(touch > 0.45 && touch < 0.6, t, `down-touch ≈ 0.52, got ${touch.toFixed(4)}`);
}

// ── edge cases ──────────────────────────────────────────────────────────────
{
  const t = "edge";
  expect(oneTouchProbability(100, 100, 0.6, 0.02) === 1, t, "S==K → already touched → 1");
  // Far barrier: small but still ≥ terminal.
  const far = oneTouchProbability(100, 200, 0.6, 1 / 365);
  const farTerm = terminalAboveProbability(100, 200, 0.6, 1 / 365);
  expect(far >= farTerm && far < 0.1, t, `far touch small but ≥ terminal, got ${far.toExponential(2)}`);
  // Longer horizon → higher touch prob (more time to reach the barrier).
  const short = oneTouchProbability(100, 110, 0.6, 1 / 365);
  const long = oneTouchProbability(100, 110, 0.6, 30 / 365);
  expect(long > short, t, `longer horizon → higher touch (${short.toFixed(3)} → ${long.toFixed(3)})`);
  // Invalid input → NaN.
  expect(Number.isNaN(oneTouchProbability(0, 100, 0.6, 0.02)), t, "S=0 → NaN");
}

// ── classifier: touch verbs vs terminal ─────────────────────────────────────
{
  const t = "classify";
  expect(classifyBarrierMarket("bitcoin-above-80k-on-may-15") === "terminal", t, "above-on → terminal");
  expect(classifyBarrierMarket("bitcoin-up-or-down-on-may-10-15min") === "terminal", t, "up-or-down → terminal");
  expect(classifyBarrierMarket("will-bitcoin-hit-150k-by-2026") === "touch", t, "hit → touch");
  expect(classifyBarrierMarket("will-bitcoin-reach-100k-in-2026") === "touch", t, "reach → touch");
  expect(classifyBarrierMarket("will-btc-ever-touch-200k") === "touch", t, "touch/ever → touch");
  // Question overrides a generic slug.
  expect(classifyBarrierMarket("btc-market-123", "Will Bitcoin reach $150,000 by Dec 31?") === "touch", t, "question 'reach' → touch");
  expect(classifyBarrierMarket("btc-market-123", "Will Bitcoin be above $150,000 on Dec 31?") === "terminal", t, "question 'above on' → terminal");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("first-passage.test.mts") || entry.endsWith("first-passage.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("first-passage.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`first-passage.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
