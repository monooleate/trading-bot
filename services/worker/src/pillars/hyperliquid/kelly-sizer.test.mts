// kelly-sizer.test.mts — pins the B36 fix: the TP-before-SL bracket win prob is
// anchored at the driftless baseline 1/(1+RR), so a directional prob of 0.5
// yields ZERO Kelly (break-even bracket), not the old 0.25 over-bet.
//
// Run: npx tsx services/worker/src/pillars/hyperliquid/kelly-sizer.test.mts

import assert from "node:assert/strict";
import { kellyToPerpSize } from "./kelly-sizer.mts";

const base = {
  bankrollUSDC: 200, kellyFraction: 0, edge: 0.06, currentPrice: 60000,
  leverage: 3, maxPctBankroll: 0.5, coin: "BTC" as const,
  tpPct: 0.02, slPct: 0.01,   // RR = 2 → driftless baseline 1/3
};

let passed = 0;
const ok = (l: string) => { console.log(`  ✓ ${l}`); passed++; };

// 1) zero directional edge → zero size (the core B36 fix)
const flat = kellyToPerpSize({ ...base, predProb: 0.5, direction: "LONG" });
assert.equal(flat.sizeUSDC, 0, "predProb=0.5 must give zero Kelly (break-even bracket)");
ok("zero edge → zero size");

// 2) positive edge → positive but conservative size, and far below the old bug
const edge = kellyToPerpSize({ ...base, predProb: 0.58, direction: "LONG" });
assert.ok(edge.sizeUSDC > 0, "predProb=0.58 sizes positive");
// old buggy raw Kelly at 0.58 was 0.37 → quarter 0.092 → ~$18.4 notional (×lev in coins);
// anchored: winBracket=0.373 → raw≈0.06 → quarter≈0.0155 → ~$3.1 notional.
assert.ok(edge.sizeUSDC < 6, `anchored size ($${edge.sizeUSDC.toFixed(2)}) must be well below the old over-bet (~$18)`);
ok(`positive edge → conservative size ($${edge.sizeUSDC.toFixed(2)})`);

// 3) monotonic in conviction
const hi = kellyToPerpSize({ ...base, predProb: 0.70, direction: "LONG" });
assert.ok(hi.sizeUSDC > edge.sizeUSDC, "higher conviction → larger size");
ok("monotonic in conviction");

// 4) SHORT symmetry: predProb 0.42 SHORT ≈ predProb 0.58 LONG
const shortSym = kellyToPerpSize({ ...base, predProb: 0.42, direction: "SHORT" });
assert.ok(Math.abs(shortSym.sizeUSDC - edge.sizeUSDC) < 1e-6, "SHORT mirrors LONG");
ok("SHORT/LONG symmetry");

// 5) below-baseline directional prob → zero (no negative Kelly)
const weak = kellyToPerpSize({ ...base, predProb: 0.52, direction: "LONG" });
assert.ok(weak.sizeUSDC >= 0 && weak.sizeUSDC < edge.sizeUSDC, "weak edge → small/zero, never negative");
ok("no negative Kelly");

console.log(`\nkelly-sizer.test: all ${passed} checks passed`);
