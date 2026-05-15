// netlify/functions/signal-combiner-threshold.test.mts
//
// Regression guard for `parseThresholdK` in signal-combiner.mts. The
// parser extracts the LITERAL strike from `bitcoin-above-Nk-on-...`
// slugs so the vol_divergence signal can use the correct K in its
// Black-Scholes digital pricing — not a K=S fallback that collapses
// fair YES to ≈0.5 regardless of N.
//
// 2026-05-15 trigger: the bot opened 3 simultaneous contrarian trades
// (78K-NO, 80K-NO, 82K-YES) on near-identical finalProb values (0.46–0.48)
// because the K-aware vol_divergence signal was returning ≈0.5 for all
// three. Root cause: `getVolSignal` only handled `up-or-down` markets via
// openedAt-fetched K, never the above-Nk threshold form.
//
// Run: npx tsx netlify/functions/signal-combiner-threshold.test.mts
//
// Re-implements the parser locally to avoid pulling the full
// signal-combiner.mts (which imports getStore and other Netlify-only
// modules) into the test runtime. The regex MUST stay in sync with
// `parseThresholdK` in signal-combiner.mts AND `parseBtcAboveSlug` in
// auto-trader/shared/cross-position-gates.mts — all three are intentionally
// duplicated and pinned by this test.

function parseThresholdK(slug: string | undefined | null): number | null {
  if (!slug) return null;
  const m = String(slug).toLowerCase().match(
    /(?:bitcoin|btc)-(?:be-)?above-(\d+(?:\.\d+)?)k(?:-on-(.+?))?$/,
  );
  if (!m) return null;
  const kThousand = parseFloat(m[1]);
  if (!Number.isFinite(kThousand) || kThousand <= 0) return null;
  return kThousand * 1000;
}

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// ── parseThresholdK ─────────────────────────────────────────────────────
{
  const t = "parseThresholdK";

  // Today's incident slugs.
  expect(parseThresholdK("bitcoin-above-78k-on-may-15") === 78000, t, "78k-may-15 → $78,000");
  expect(parseThresholdK("bitcoin-above-80k-on-may-15") === 80000, t, "80k-may-15 → $80,000");
  expect(parseThresholdK("bitcoin-above-82k-on-may-15") === 82000, t, "82k-may-15 → $82,000");

  // Other historical formats.
  expect(parseThresholdK("bitcoin-above-100k-on-2026-05-14") === 100000, t, "100k-ISO → $100,000");
  expect(parseThresholdK("btc-above-65k-on-may-9") === 65000, t, "btc-65k → $65,000");
  expect(parseThresholdK("will-bitcoin-be-above-150k-on-december-31") === 150000, t, "be-above → $150,000");
  expect(parseThresholdK("bitcoin-above-77.5k-on-may-9") === 77500, t, "decimal K (77.5k) → $77,500");

  // Negative cases — must NOT parse (so the existing up-or-down K logic
  // takes over OR the spot fallback applies).
  expect(parseThresholdK("bitcoin-up-or-down-on-may-15-2026") === null, t, "up-or-down must not parse");
  expect(parseThresholdK("eth-above-3k-on-may-15") === null, t, "ETH-above must not parse");
  expect(parseThresholdK("ratio-bitcoin-above-80k-something") === null, t, "non-anchored prefix must not parse");
  expect(parseThresholdK(undefined) === null, t, "undefined input");
  expect(parseThresholdK(null) === null, t, "null input");
  expect(parseThresholdK("") === null, t, "empty input");
}

// ── Black-Scholes digital sanity check (S=80620, T=6h, σ=0.6) ────────────
// Pins the expected fair-YES values that the vol_divergence signal SHOULD
// now produce after the K fix. Pre-fix all three returned ≈0.5 because K
// fell back to S.
{
  const t = "BS-digital-with-literal-K";
  const S = 80620;
  const T = 6 / (365 * 24); // 6 hours in years
  const sigma = 0.6;        // 60% annualized realized vol — typical BTC

  function normalCdf(z: number): number {
    if (!Number.isFinite(z)) return 0.5;
    const absZ = Math.abs(z);
    const tt = 1 / (1 + 0.2316419 * absZ);
    const pdf = Math.exp(-0.5 * absZ * absZ) / Math.sqrt(2 * Math.PI);
    const poly =
      0.319381530 * tt -
      0.356563782 * tt * tt +
      1.781477937 * tt * tt * tt -
      1.821255978 * tt * tt * tt * tt +
      1.330274429 * tt * tt * tt * tt * tt;
    const cdf = 1 - pdf * poly;
    return z >= 0 ? cdf : 1 - cdf;
  }

  function fairYes(K: number): number {
    const sqrtT = Math.sqrt(T);
    const d2 = (Math.log(S / K) - 0.5 * sigma * sigma * T) / (sigma * sqrtT);
    return normalCdf(d2);
  }

  const fy78 = fairYes(78000);
  const fy80 = fairYes(80000);
  const fy82 = fairYes(82000);

  // BTC at $80,620: above-78K is highly probable, above-80K is roughly
  // even, above-82K is unlikely. The point of this test is to pin that the
  // three values DIVERGE with K — pre-fix they all collapsed to ≈0.5.
  expect(fy78 > 0.90, t, `above-78K @ S=$80,620 should be >90%, got ${fy78.toFixed(3)}`);
  expect(fy80 > 0.55 && fy80 < 0.80, t, `above-80K @ S=$80,620 should be in [55%, 80%], got ${fy80.toFixed(3)}`);
  expect(fy82 < 0.25, t, `above-82K @ S=$80,620 should be <25%, got ${fy82.toFixed(3)}`);

  // Monotonicity invariant: P(>K1) > P(>K2) for K1 < K2.
  expect(fy78 > fy80 && fy80 > fy82, t, `monotone in K: 78K=${fy78.toFixed(3)} > 80K=${fy80.toFixed(3)} > 82K=${fy82.toFixed(3)}`);

  // Pre-fix sanity: if K=S, fair YES collapses to N(−σ√T/2), which for
  // T=6h, σ=0.6 is N(−0.0079) ≈ 0.497. This is what was happening to all
  // three markets before today's fix.
  const collapsed = fairYes(S);
  expect(collapsed > 0.49 && collapsed < 0.51, t,
    `pre-fix K=S collapse expected ≈0.5, got ${collapsed.toFixed(3)} — confirms the bug pattern`);
}

// ── Sprint 42A combiner K-blind downweight ──────────────────────────────
// Re-implementation of combine() from signal-combiner.mts. Must stay in
// sync — same constants (SIGNAL_ICS, K_BLIND_SIGNALS), same weight
// formula. Pinned here so the threshold downweight contract is regressed
// in unit tests instead of integration-only.
{
  const t = "combine-kblind-downweight";

  const SIGNAL_ICS: Record<string, number> = {
    vol_divergence: 0.06,
    orderflow:      0.09,
    apex_consensus: 0.08,
    cond_prob:      0.07,
    funding_rate:   0.05,
    momentum:       0.06,
    contrarian:     0.05,
    pairs_spread:   0.07,
  };
  const K_BLIND_SIGNALS = new Set(["momentum", "contrarian", "funding_rate", "pairs_spread"]);

  type MarketKind = "threshold" | "directional";

  function combine(
    signals: Record<string, number | null>,
    icMap: Record<string, number> | undefined,
    marketKind: MarketKind,
    kBlindDownweight: number,
  ) {
    const valid: Record<string, number> = {};
    for (const [k, v] of Object.entries(signals)) {
      if (v !== null && !isNaN(v)) valid[k] = v;
    }
    const names = Object.keys(valid);
    const n     = names.length;
    if (n === 0) return { combined: 0.5, weights: {} };

    const effectiveDownweight = marketKind === "threshold"
      ? Math.max(0, Math.min(1, kBlindDownweight))
      : 1.0;
    const icFor = (k: string) => {
      const baseIC = (icMap && Number.isFinite(icMap[k]) ? icMap[k] : SIGNAL_ICS[k]) || 0.05;
      if (effectiveDownweight !== 1.0 && K_BLIND_SIGNALS.has(k)) {
        return baseIC * effectiveDownweight;
      }
      return baseIC;
    };

    const mean = names.reduce((s, k) => s + valid[k], 0) / n;
    const demeaned: Record<string, number> = {};
    for (const k of names) demeaned[k] = valid[k] - mean;

    let totalW = 0;
    const weights: Record<string, number> = {};
    for (const k of names) {
      const ic = icFor(k);
      const w  = ic * (1 + Math.abs(demeaned[k]) * 0.5);
      weights[k] = w;
      totalW += w;
    }
    for (const k of names) weights[k] /= totalW;

    let combined = 0;
    for (const k of names) combined += weights[k] * valid[k];

    return { combined, weights };
  }

  // Scenario 1: post-K-fix signal mix on `above-80k` (BTC=$80,620, 6h).
  // vol_div is now 0.69 (K-aware), 3 other K-aware contribute mild YES,
  // 4 K-blind sit at 0.50 (noise mean-reversion).
  const signals = {
    vol_divergence: 0.69,   // K-aware (post-fix)
    orderflow:      0.62,   // K-aware (book leans YES-side)
    apex_consensus: 0.55,   // K-aware
    cond_prob:      0.52,   // K-aware
    momentum:       0.50,   // K-blind
    contrarian:     0.50,   // K-blind
    funding_rate:   0.50,   // K-blind
    pairs_spread:   0.50,   // K-blind
  };

  // Default (downweight=1.0): zero behavior change vs pre-Sprint-42A.
  const r1 = combine(signals, undefined, "threshold", 1.0);
  // Directional market: downweight ignored.
  const r2 = combine(signals, undefined, "directional", 0.5);
  // Threshold + downweight 0.5: K-blind IC halved → K-aware win more.
  const r3 = combine(signals, undefined, "threshold", 0.5);
  // Threshold + downweight 0: K-blind fully suppressed.
  const r4 = combine(signals, undefined, "threshold", 0.0);

  expect(Math.abs(r1.combined - r2.combined) < 1e-9, t,
    `default=1.0 must equal directional-with-0.5 (downweight should not apply); r1=${r1.combined.toFixed(4)} r2=${r2.combined.toFixed(4)}`);

  expect(r3.combined > r1.combined, t,
    `threshold+downweight=0.5 must pull combined HIGHER (K-aware lean YES); r1=${r1.combined.toFixed(4)} r3=${r3.combined.toFixed(4)}`);

  expect(r4.combined > r3.combined, t,
    `threshold+downweight=0 (full suppress) must pull combined EVEN HIGHER than 0.5; r3=${r3.combined.toFixed(4)} r4=${r4.combined.toFixed(4)}`);

  // K-blind weight should drop proportionally. At downweight=0.5,
  // each K-blind signal's weight ≈ half of its pre-downweight value
  // (the bonus factor is identical for all signals at 0.5 so the
  // (1 + |demeaned| × 0.5) part doesn't differ much), so total K-blind
  // share drops noticeably.
  const kBlindShare1 = (r1.weights.momentum + r1.weights.contrarian +
                       r1.weights.funding_rate + r1.weights.pairs_spread);
  const kBlindShare3 = (r3.weights.momentum + r3.weights.contrarian +
                       r3.weights.funding_rate + r3.weights.pairs_spread);
  const kBlindShare4 = (r4.weights.momentum + r4.weights.contrarian +
                       r4.weights.funding_rate + r4.weights.pairs_spread);
  expect(kBlindShare3 < kBlindShare1 * 0.7, t,
    `K-blind share at downweight=0.5 must drop ≥30% vs default; default=${kBlindShare1.toFixed(3)} dw=${kBlindShare3.toFixed(3)}`);
  expect(kBlindShare4 < 1e-9, t,
    `K-blind share at downweight=0 must be zero; got ${kBlindShare4.toFixed(3)}`);

  // Above-82k case: K-blind suppression should pull combined LOWER
  // (vol_div 0.14 → strongly NO).
  const signals82 = { ...signals, vol_divergence: 0.14, orderflow: 0.20, apex_consensus: 0.30, cond_prob: 0.35 };
  const r82_default = combine(signals82, undefined, "threshold", 1.0);
  const r82_dw      = combine(signals82, undefined, "threshold", 0.5);
  expect(r82_dw.combined < r82_default.combined, t,
    `82K case: downweight must push combined LOWER (more NO); default=${r82_default.combined.toFixed(4)} dw=${r82_dw.combined.toFixed(4)}`);

  // Clamping: downweight > 1 should be capped to 1 (= no change vs default).
  const rClamp = combine(signals, undefined, "threshold", 2.5);
  expect(Math.abs(rClamp.combined - r1.combined) < 1e-9, t,
    `downweight=2.5 must clamp to 1.0; got combined ${rClamp.combined.toFixed(4)} vs default ${r1.combined.toFixed(4)}`);

  // Negative input clamps to 0 (= full K-blind suppression).
  const rNeg = combine(signals, undefined, "threshold", -0.5);
  expect(Math.abs(rNeg.combined - r4.combined) < 1e-9, t,
    `downweight=-0.5 must clamp to 0; got combined ${rNeg.combined.toFixed(4)} vs full-suppress ${r4.combined.toFixed(4)}`);
}

// ─── CLI report ───────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("signal-combiner-threshold.test.mts") ||
           entry.endsWith("signal-combiner-threshold.test.js");
  } catch { return false; }
})();

if (isMain) {
  if (failures.length === 0) {
    console.log("signal-combiner-threshold.test: all checks passed");
    process.exit(0);
  } else {
    console.log(`signal-combiner-threshold.test: ${failures.length} failure(s)`);
    for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
    process.exit(1);
  }
}

export { failures };
