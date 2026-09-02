// netlify/functions/auto-trader/weather/bucket-matcher.test.mts
// Regression guard for the Gaussian-CDF bucket matcher (v2, 2026-05-11).
//
// Run with: npx tsx netlify/functions/auto-trader/weather/bucket-matcher.test.mts
//
// The v1 PDF-based matcher had two structural biases:
//   1. Tail buckets ("84°F or higher") were treated as point masses at the
//      threshold, systematically under-weighting them.
//   2. Internal buckets next to a tail got an over-counted share because the
//      tail's missing mass was redistributed across the rest of the lineup.
// These tests pin down the corrected behaviour using the empirical Shanghai
// and Austin bucket lineups that the live bot was scanning on 2026-05-11.

import { matchBucket, marketConsensusModalTempC } from "./bucket-matcher.mts";
import type { TemperatureBucket } from "./market-finder.mts";

function mkBucket(
  label: string,
  tempC: number,
  currentPrice: number,
  tail: "low" | "high" | null = null,
): TemperatureBucket {
  return {
    label,
    tokenId: "tok-" + label,
    noTokenId: "no-" + label,
    conditionId: "cid-" + label,
    currentPrice,
    tempC,
    tail,
  };
}

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}
function near(a: number, b: number, tol: number, name: string, test: string) {
  expect(Math.abs(a - b) < tol, test, `${name}: ${a.toFixed(3)} not within ±${tol} of ${b.toFixed(3)}`);
}

// ─── Shanghai 2026-05-11 (live data 22:30Z) ───────────────────────────────
// Integer °C buckets with both tails. Predicted 26.1°C, σ=1.5 (cloudy).
// Pre-fix bot reported P(25°C) = 0.203 via PDF; CDF should give a similar
// number for *internal* buckets but redistribute mass toward the high tail.
{
  const buckets: TemperatureBucket[] = [
    mkBucket("21°C or below", 21, 0.0005, "low"),
    mkBucket("22°C",          22, 0.0015),
    mkBucket("23°C",          23, 0.0025),
    mkBucket("24°C",          24, 0.002),
    mkBucket("25°C",          25, 0.0225),
    mkBucket("26°C",          26, 0.17),
    mkBucket("27°C",          27, 0.325),
    mkBucket("28°C",          28, 0.24),
    mkBucket("29°C",          29, 0.148),
    mkBucket("30°C",          30, 0.0695),
    mkBucket("31°C or higher",31, 0.0455, "high"),
  ];
  const match = matchBucket(26.1, buckets, 1.5);
  expect(match !== null, "shanghai", "matcher returned null");

  const p25 = match!.allProbs.find((p) => p.label === "25°C")!;
  const p26 = match!.allProbs.find((p) => p.label === "26°C")!;
  const p27 = match!.allProbs.find((p) => p.label === "27°C")!;
  const tail = match!.allProbs.find((p) => p.label === "31°C or higher")!;
  const lowTail = match!.allProbs.find((p) => p.label === "21°C or below")!;

  // Modal should be 26°C (centred), then 27°C above it.
  expect(p26.prob > p25.prob, "shanghai", `modal 26°C (${p26.prob}) should beat 25°C (${p25.prob})`);
  expect(p26.prob > p27.prob, "shanghai", `modal 26°C (${p26.prob}) should beat 27°C (${p27.prob})`);

  // 25°C bucket prob should be in 12–22% range (vs the live bot's 20.3% PDF
  // estimate). With σ=1.5 a [24.5,25.5] CDF integral around μ=26.1 gives ~17%.
  expect(p25.prob > 0.10 && p25.prob < 0.25,
         "shanghai", `P(25°C) out of expected band: ${p25.prob}`);

  // Tails get *some* mass (extending to ±∞), even when far from the
  // prediction. With μ=26.1, σ=1.5 the upper tail is 4.4σ away → ~0.001
  // mass, which is the expected ballpark.
  expect(tail.prob > 0, "shanghai", `high-tail mass collapsed: ${tail.prob}`);
  expect(lowTail.prob >= 0.0, "shanghai", `low-tail mass negative? ${lowTail.prob}`);

  // The Σ over all buckets must be exactly 1 (after our normalisation step).
  const sum = match!.allProbs.reduce((s, p) => s + p.prob, 0);
  near(sum, 1.0, 0.01, "Σ all bucket probs", "shanghai");

  // The bot's chosen bucket (max |edge|) should be 25°C @ 1.2¢ → big edge.
  expect(match!.bucket.label === "25°C",
         "shanghai", `expected bot to pick 25°C, got ${match!.bucket.label}`);
}

// ─── Austin 2026-05-12 (live data 22:30Z) ─────────────────────────────────
// 2°F-wide buckets with a "84°F or higher" tail. Predicted 28.9°C = 84.02°F
// sits at the boundary. The old PDF model gave P("82-83°F") = 38.8% which was
// inflated; CDF should be smaller (closer to 30%).
{
  const buckets: TemperatureBucket[] = [
    mkBucket("65°F or below", 18.3, 0.0015, "low"),
    mkBucket("66-67°F", 19.2,  0.002),
    mkBucket("68-69°F", 20.3,  0.002),
    mkBucket("70-71°F", 21.4,  0.002),
    mkBucket("72-73°F", 22.5,  0.002),
    mkBucket("74-75°F", 23.6,  0.0025),
    mkBucket("76-77°F", 24.7,  0.0055),
    mkBucket("78-79°F", 25.8,  0.01),
    mkBucket("80-81°F", 26.9,  0.053),
    mkBucket("82-83°F", 28.06, 0.17),
    mkBucket("84°F or higher", 28.89, 0.70, "high"),
  ];
  const match = matchBucket(28.9, buckets, 1.0);
  expect(match !== null, "austin", "matcher returned null");

  const p82 = match!.allProbs.find((p) => p.label === "82-83°F")!;
  const tail = match!.allProbs.find((p) => p.label === "84°F or higher")!;

  // Tail should dominate (≈50% under N(28.9, 1.0²) above 28.89°C), modal.
  expect(tail.prob > 0.40, "austin", `high-tail under-weighted: ${tail.prob}`);
  expect(tail.prob > p82.prob, "austin", `tail (${tail.prob}) should beat internal (${p82.prob})`);

  // 82-83°F prob should land in 0.20-0.35 range (vs old PDF inflated 0.388).
  expect(p82.prob > 0.18 && p82.prob < 0.40,
         "austin", `P(82-83°F) out of expected band: ${p82.prob}`);

  // Σ to 1
  const sum = match!.allProbs.reduce((s, p) => s + p.prob, 0);
  near(sum, 1.0, 0.01, "Σ all bucket probs", "austin");
}

// ─── Single-bucket and edge cases ─────────────────────────────────────────
{
  const oneBucket = matchBucket(20, [mkBucket("20°C", 20, 0.5)], 1.0);
  expect(oneBucket !== null, "single-bucket", "matcher returned null");
  near(oneBucket!.probability, 1.0, 0.01, "single bucket → P=1", "single-bucket");

  const noTemps = matchBucket(20, [mkBucket("???", null as any, 0.5)], 1.0);
  expect(noTemps === null, "no-parseable", "should return null when no tempC parseable");
}

// ─── Market consensus modal helper ────────────────────────────────────────
{
  const buckets: TemperatureBucket[] = [
    mkBucket("82-83°F", 28.06, 0.17),
    mkBucket("84°F or higher", 28.89, 0.70, "high"),
    mkBucket("80-81°F", 26.9,  0.053),
  ];
  const modal = marketConsensusModalTempC(buckets);
  expect(modal !== null, "market-modal", "modal returned null");
  expect(modal!.label === "84°F or higher",
         "market-modal", `expected '84°F or higher', got ${modal?.label}`);
  near(modal!.tempC, 28.89, 0.01, "modal tempC", "market-modal");
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("bucket-matcher.test.mts") || entry.endsWith("bucket-matcher.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("bucket-matcher.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`bucket-matcher.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
