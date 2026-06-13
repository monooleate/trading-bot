// netlify/functions/auto-trader/shared/adverse-selection-fixes.test.mts
//
// Lives under auto-trader/shared/ (NOT top-level) so Netlify never bundles it
// as a serverless function (a "...test" function name is illegal → deploy
// fail). Regression guard for the 2026-06-06 adverse-selection work:
//   B22 — weather invertDirection flips the model's chosen side.
//   B23 — weather selectionShrink (optimizer's-curse) gate kills the vacuous
//         max-disagreement bucket picks; OFF (=0) is a strict no-op.
//   Sports — minPrice longshot floor blocks sub-threshold lottery tickets on
//         either side, and is a no-op when 0.
//
// Run: npx tsx netlify/functions/auto-trader/shared/adverse-selection-fixes.test.mts

import { makeWeatherDecision, getWeatherConfig } from "../weather/decision-engine.mts";
import type { WeatherConfig } from "../weather/decision-engine.mts";
import type { BucketMatch } from "../weather/bucket-matcher.mts";
import { makeSportsDecision } from "../sports/decision-engine.mts";
import { getSportsConfig } from "../sports/config.mts";
import type { SportsMarket } from "../sports/types.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

const SELECTION_LABEL = "Szelekciós torzítás (adverse-selection)";
const MINPRICE_LABEL   = "Min bet-side price (longshot floor)";

// ── Weather fixtures ────────────────────────────────────────────────────────
function weatherConfig(over: Partial<WeatherConfig>): WeatherConfig {
  return {
    ...getWeatherConfig(),
    edgeThreshold:      0.05,
    confidenceMin:      0.30,
    exitBeforeMin:      0,
    roundtripFeePct:    0.01,
    maxEdgeCap:         0.95,
    marketDisagreeMaxC: 99,
    invertDirection:    false,
    selectionShrink:    0,
    ...over,
  };
}

function buildMatch(selectedEdge: number, allEdges: number[]): BucketMatch {
  return {
    bucket: { currentPrice: 0.30, label: "20°C", tokenId: "tok-1" } as any,
    probability: 0.50,
    edge: selectedEdge,
    allProbs: allEdges.map((e, i) => ({
      label: `b${i}`, prob: 0.1, price: 0.1, edge: e, lo: 0, hi: 1,
    })),
  };
}

function runWeather(config: WeatherConfig, match: BucketMatch) {
  return makeWeatherDecision({
    forecast: { city: "seoul", date: "2026-06-06", predictedMaxC: 20, confidence: 0.9 } as any,
    match,
    modelLag: { nearBoundary: false, lagMinutes: 10 } as any,
    timeToResolutionMin: 600,
    bankrollUSDC: 250,
    config,
    marketModalTempC: null,
  });
}

// ── 1. B22: invertDirection flips YES↔NO ────────────────────────────────────
{
  const match = buildMatch(0.20, [0.20, -0.03, 0.05]);   // edge>0 ⇒ base YES
  const base = runWeather(weatherConfig({ invertDirection: false }), match);
  const flip = runWeather(weatherConfig({ invertDirection: true  }), match);
  expect(base.direction === "YES", "b22.baseYes", `base should be YES, got ${base.direction}`);
  expect(flip.direction === "NO",  "b22.flipNo",  `invert should flip to NO, got ${flip.direction}`);
}
{
  const match = buildMatch(-0.20, [-0.20, 0.03, 0.05]);  // edge<0 ⇒ base NO
  const base = runWeather(weatherConfig({ invertDirection: false }), match);
  const flip = runWeather(weatherConfig({ invertDirection: true  }), match);
  expect(base.direction === "NO",  "b22.baseNo",  `base should be NO, got ${base.direction}`);
  expect(flip.direction === "YES", "b22.flipYes", `invert should flip to YES, got ${flip.direction}`);
}

// ── 1b. B22 sizing: an inverted trade must bet REAL size (not $0) ────────────
// Regression for the 2026-06-13 "invert mode books $0 PnL" bug: Kelly was
// sized on the flipped (anti-edge) side → (probSide·b − q) < 0 → rawKelly = 0
// → positionSizeUSDC = 0 → shares = costBasis = 0 → the reconciler closed
// every position at pnl = 0×exit − 0 = 0, win or lose. Kelly must size on
// baseDirection so the fade is a same-size mirror of the model's natural bet.
{
  const match = buildMatch(0.20, [0.20, -0.03, 0.05]);   // base YES ⇒ flip NO
  const base = runWeather(weatherConfig({ invertDirection: false }), match);
  const flip = runWeather(weatherConfig({ invertDirection: true  }), match);
  expect(base.shouldTrade === true, "b22.baseTrades", `base should trade, got "${base.reason}"`);
  expect(flip.shouldTrade === true, "b22.flipTrades", `flip should trade, got "${flip.reason}"`);
  expect(flip.positionSizeUSDC > 0, "b22.flipNonZeroSize",
    `inverted trade must have non-zero size, got ${flip.positionSizeUSDC}`);
  expect(Math.abs(flip.positionSizeUSDC - base.positionSizeUSDC) < 1e-6, "b22.flipMirrorSize",
    `inverted size (${flip.positionSizeUSDC}) should mirror base size (${base.positionSizeUSDC})`);
}
// Same invariant from the edge<0 side: base NO ⇒ flip YES must also bet real
// size. Fixture is self-consistent (probYes 0.30 < price 0.50 ⇒ edge −0.20),
// mirroring the real matcher where edge === probability − currentPrice.
{
  const match: BucketMatch = {
    bucket: { currentPrice: 0.50, label: "20°C", tokenId: "tok-1" } as any,
    probability: 0.30,
    edge: -0.20,
    allProbs: [-0.20, 0.03, 0.05].map((e, i) => ({
      label: `b${i}`, prob: 0.1, price: 0.1, edge: e, lo: 0, hi: 1,
    })),
  };
  const flip = runWeather(weatherConfig({ invertDirection: true }), match);
  expect(flip.direction === "YES", "b22.flipYes2", `invert should flip to YES, got ${flip.direction}`);
  expect(flip.positionSizeUSDC > 0, "b22.flipYesNonZeroSize",
    `inverted YES trade must have non-zero size, got ${flip.positionSizeUSDC}`);
}

// ── 2. B23: selectionShrink=0 is a strict no-op (gate passes, "n/a") ─────────
{
  const match = buildMatch(0.20, [0.20, -0.18, 0.17, -0.16, 0.15]);
  const d = runWeather(weatherConfig({ selectionShrink: 0 }), match);
  const g = (d.gates ?? []).find((x) => x.label === SELECTION_LABEL);
  expect(!!g, "b23.gatePresent", "selection gate must be in the list");
  expect(g?.passed === true, "b23.offPass", "shrink=0 must pass (n/a)");
  expect((g?.actual ?? "").includes("n/a"), "b23.offNa", `shrink=0 actual should say n/a, got ${g?.actual}`);
}

// ── 3. B23: high dispersion + shrink=1.0 kills the max-disagreement pick ─────
{
  const allEdges = [0.20, -0.18, 0.17, -0.16, 0.15, -0.14, 0.13, -0.12];  // N=8, big σ
  const grossEdge = 0.20;
  const fee = 0.01, threshold = 0.05, shrink = 1.0;
  const match = buildMatch(grossEdge, allEdges);

  // Recompute the contract formula to pin it.
  const N = allEdges.length;
  const mean = allEdges.reduce((s, e) => s + e, 0) / N;
  const sigma = Math.sqrt(allEdges.reduce((s, e) => s + (e - mean) ** 2, 0) / N);
  const penalty = shrink * Math.sqrt(2 * Math.log(N)) * sigma;
  const shrunkNet = Math.max(0, grossEdge - penalty) - fee;
  const expectFail = shrunkNet < threshold;

  const d = runWeather(weatherConfig({ selectionShrink: shrink, edgeThreshold: threshold, roundtripFeePct: fee }), match);
  const g = (d.gates ?? []).find((x) => x.label === SELECTION_LABEL);
  expect(g?.passed === !expectFail, "b23.contract",
    `gate.passed should equal shrunkNet(${shrunkNet.toFixed(4)})>=thr(${threshold}); expectFail=${expectFail}, got passed=${g?.passed}`);
  // With this dispersion the penalty (~0.30) wipes the 0.20 edge → fail.
  expect(g?.passed === false, "b23.killsNoise", `high-dispersion max-pick should fail, got passed=${g?.passed}`);
  expect(d.shouldTrade === false, "b23.blocksTrade", "shouldTrade must be false when selection gate fails");
}

// ── 4. B23: a genuine standout edge survives the shrink ─────────────────────
{
  // One large edge, the rest near zero ⇒ tiny σ ⇒ tiny penalty ⇒ survives.
  const allEdges = [0.40, 0.001, -0.002, 0.0, 0.001, -0.001, 0.002, 0.0];
  const match = buildMatch(0.40, allEdges);
  const d = runWeather(weatherConfig({ selectionShrink: 1.0, edgeThreshold: 0.05 }), match);
  const g = (d.gates ?? []).find((x) => x.label === SELECTION_LABEL);
  expect(g?.passed === true, "b23.survivesStandout",
    `a lone large edge (small σ) should survive shrink, got passed=${g?.passed} actual=${g?.actual}`);
}

// ── Sports fixtures ─────────────────────────────────────────────────────────
function sportsMarket(yesPrice: number): SportsMarket {
  return {
    slug: "fif-x-y-2026-06-06-y", conditionId: "c1", question: "q",
    league: "soccer" as any, yesTokenId: "y", noTokenId: "n",
    yesPrice, noPrice: 1 - yesPrice, volume24h: 1e5, liquidity: 1e5,
    endDate: "2026-06-07T00:00:00Z", eventSlug: "fif-x-y-2026-06-06",
  };
}
function sportsConfig(minPrice: number) {
  return { ...getSportsConfig(), edgeThreshold: 0.02, minPositionUSDC: 0.1, minPrice };
}

// ── 5. Sports: minPrice=0 is a no-op (gate present + n/a) ────────────────────
{
  const d = makeSportsDecision({ market: sportsMarket(0.05), bankroll: 500, openCount: 0, config: sportsConfig(0) as any });
  const g = d.gates.find((x) => x.label === MINPRICE_LABEL);
  expect(!!g, "sports.gatePresent", "min-price gate must be present");
  expect(g?.passed === true, "sports.offPass", "minPrice=0 must pass");
}

// ── 6. Sports: extreme longshot YES (0.05) blocked by a 0.10 floor ──────────
{
  const d = makeSportsDecision({ market: sportsMarket(0.05), bankroll: 500, openCount: 0, config: sportsConfig(0.10) as any });
  const g = d.gates.find((x) => x.label === MINPRICE_LABEL);
  expect(d.direction === "YES", "sports.dirYes", `0.05 yes-price ⇒ fade-low ⇒ YES, got ${d.direction}`);
  expect(g?.passed === false, "sports.blocksLongshot", `0.05¢ side < 0.10 floor must fail, got ${g?.passed}`);
  expect(d.shouldTrade === false, "sports.noTrade", "shouldTrade must be false under the floor");
}

// ── 7. Sports: upset-NO side (yes 0.97 ⇒ no 0.03) also blocked ──────────────
{
  const d = makeSportsDecision({ market: sportsMarket(0.97), bankroll: 500, openCount: 0, config: sportsConfig(0.10) as any });
  const g = d.gates.find((x) => x.label === MINPRICE_LABEL);
  expect(d.direction === "NO", "sports.dirNo", `0.97 yes-price ⇒ fade-high ⇒ NO, got ${d.direction}`);
  expect(g?.passed === false, "sports.blocksUpset", `0.03¢ NO side < 0.10 floor must fail, got ${g?.passed}`);
}

// ── 8. Sports: a sane side (no-price 0.18 ≥ 0.10) passes the floor ──────────
{
  const d = makeSportsDecision({ market: sportsMarket(0.82), bankroll: 500, openCount: 0, config: sportsConfig(0.10) as any });
  const g = d.gates.find((x) => x.label === MINPRICE_LABEL);
  expect(d.direction === "NO", "sports.saneDir", `0.82 yes-price ⇒ NO, got ${d.direction}`);
  expect(g?.passed === true, "sports.passesSane", `0.18¢ NO side ≥ 0.10 floor must pass, got ${g?.passed}`);
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log("adverse-selection-fixes.test: all checks passed");
} else {
  console.error(`adverse-selection-fixes.test: ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.test}: ${f.message}`);
  process.exit(1);
}
