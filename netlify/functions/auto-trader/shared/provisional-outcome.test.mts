// netlify/functions/auto-trader/shared/provisional-outcome.test.mts
//
// Lives under auto-trader/shared/ (NOT top-level) so Netlify never bundles it
// as a serverless function. Pins the YES-price → won/lost mapping used by the
// crypto/weather/sports pending-position "provisional outcome" badge.
//
// Run: npx tsx netlify/functions/auto-trader/shared/provisional-outcome.test.mts

import { classifyProvisional } from "./provisional-outcome.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(got: string, want: string, test: string) {
  if (got !== want) failures.push({ test, message: `expected ${want}, got ${got}` });
}

// YES outcome winning (yes ≥ 0.9)
expect(classifyProvisional(0.99, "YES"), "won",  "yes-high + YES");
expect(classifyProvisional(0.99, "NO"),  "lost", "yes-high + NO");
expect(classifyProvisional(0.90, "YES"), "won",  "yes-boundary + YES");

// NO outcome winning (yes ≤ 0.1)
expect(classifyProvisional(0.005, "NO"),  "won",  "yes-low + NO");
expect(classifyProvisional(0.005, "YES"), "lost", "yes-low + YES");
expect(classifyProvisional(0.10, "NO"),   "won",  "yes-boundary-low + NO");

// Undetermined (in-between) → pending
expect(classifyProvisional(0.55, "YES"), "pending", "midrange + YES");
expect(classifyProvisional(0.42, "NO"),  "pending", "midrange + NO");

// Missing / invalid → pending
expect(classifyProvisional(null, "YES"),      "pending", "null");
expect(classifyProvisional(undefined, "NO"),  "pending", "undefined");
expect(classifyProvisional(NaN, "YES"),       "pending", "NaN");

// Case-insensitive direction
expect(classifyProvisional(0.99, "yes"), "won", "lowercase yes");

if (failures.length === 0) {
  console.log("provisional-outcome.test: all checks passed");
} else {
  console.error(`provisional-outcome.test: ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.test}: ${f.message}`);
  process.exit(1);
}
