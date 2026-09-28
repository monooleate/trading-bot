// packages/core/src/pooled-emos.test.mts
//
// Regression guard for the pooled-mixture EMOS (B69 step 2). Pure, no I/O.
// Run: npx tsx packages/core/src/pooled-emos.test.mts

import { selectCalibrationRows, fitPooledEmos, applyPooledEmos, type PooledCalibrationInput } from "./pooled-emos.mts";
import { gaussianCrps } from "./emos.mts";

interface Failure { test: string; message: string; }
const failures: Failure[] = [];
function expect(cond: boolean, test: string, message: string) {
  if (!cond) failures.push({ test, message });
}

// Deterministic synthetic world: the pool runs 0.8 °C COLD (obs − μ = +0.8,
// the measured forward residual) and its σ is ~1.5× too narrow.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function world(nStations: number, nDays: number, warm = 0.8): PooledCalibrationInput[] {
  const out: PooledCalibrationInput[] = [];
  for (let s = 0; s < nStations; s++) {
    for (let d = 0; d < nDays; d++) {
      const truth = 20 + 8 * rnd();
      const sd = 0.8 + 0.8 * rnd();
      const mean = truth - warm + 1.5 * sd * gauss();
      const date = `2026-09-${String(10 + d).padStart(2, "0")}`;
      // Two re-snapshots of the SAME forecast in the T+0 bucket: only the later may count.
      out.push({ station: `S${s}`, ts: d * 1e6 + 1, date, leadHours: 10, mean: mean + 5, sd, obs: truth });
      out.push({ station: `S${s}`, ts: d * 1e6 + 2, date, leadHours: 6, mean, sd, obs: truth });
    }
  }
  return out;
}

// ── selection ────────────────────────────────────────────────────────────────
{
  const t = "select";
  const rows = world(2, 3);
  rows.push({ station: "S0", ts: 1, date: "2026-09-30", leadHours: -3, mean: 1, sd: 1, obs: 1 });
  rows.push({ station: "S0", ts: 1, date: "2026-09-29", leadHours: 60, mean: 1, sd: 1, obs: 1 });
  rows.push({ station: "S0", ts: 1, date: "2026-09-28", leadHours: 20, mean: 1, sd: 1, obs: null });
  const sel = selectCalibrationRows(rows);
  expect(sel.length === 6, t, `one per station-day-leadday, got ${sel.length}`);
  expect(sel.every((r) => r.ts % 1e6 === 2), t, "latest snapshot in the bucket wins");
}

// ── fit removes the warm bias and fixes the dispersion ──────────────────────
{
  const t = "fit";
  const train = world(18, 12);
  const test = world(18, 12);
  const model = fitPooledEmos(train);
  expect(model.fit.fitted, t, `fitted with n=${model.n}`);
  expect(model.n === 18 * 12, t, `dedup to 216, got ${model.n}`);
  expect(model.stations === 18, t, `18 stations, got ${model.stations}`);

  let rawC = 0, calC = 0, bias = 0;
  const sel = selectCalibrationRows(test);
  for (const r of sel) {
    rawC += gaussianCrps(r.mean, Math.max(0.5, r.sd), r.obs as number);
    const c = applyPooledEmos(model, r.station, r.mean, r.sd);
    calC += gaussianCrps(c.mu, c.sigma, r.obs as number);
    bias += (r.obs as number) - c.mu;
  }
  bias /= sel.length;
  expect(calC < rawC * 0.95, t, `calibrated CRPS ${calC.toFixed(1)} beats raw ${rawC.toFixed(1)} by ≥5%`);
  expect(Math.abs(bias) < 0.25, t, `out-of-sample bias removed, got ${bias.toFixed(3)}`);
}

// ── too little data → raw passthrough, never a borrowed map ─────────────────
{
  const t = "unfitted";
  const model = fitPooledEmos(world(1, 5));
  expect(!model.fit.fitted, t, "5 samples must not fit");
  const c = applyPooledEmos(model, "S0", 21.3, 0.2);
  expect(c.mu === 21.3 && c.sigma === 0.5 && !c.calibrated, t, `raw μ + σ floor, got ${JSON.stringify(c)}`);
  const n = applyPooledEmos(null, "S0", 21.3, 1.2);
  expect(n.mu === 21.3 && n.sigma === 1.2 && !n.calibrated, t, "null model → raw");
}

// ── station bias is shrunk, unknown station gets none ───────────────────────
{
  const t = "bias";
  const rows = world(18, 12);
  // Station S0 alone runs an extra +2 °C warm residual.
  for (const r of rows) if (r.station === "S0" && r.obs !== null) r.obs += 2;
  const model = fitPooledEmos(rows, { biasK: 5 });
  const b = model.stationBias["S0"];
  expect(b > 1.0 && b < 2.0, t, `S0 bias shrunk toward 0 but present, got ${b}`);
  const c = applyPooledEmos(model, "UNKNOWN", 20, 1);
  const g = applyPooledEmos(model, "S1", 20, 1);
  expect(Math.abs(c.mu - (g.mu - (model.stationBias["S1"] ?? 0))) < 1e-9, t, "unknown station → no bias term");
}

const isMain = (() => {
  try {
    const entry = process.argv?.[1] || "";
    return entry.endsWith("pooled-emos.test.mts") || entry.endsWith("pooled-emos.test.js");
  } catch { return false; }
})();
if (isMain) {
  if (failures.length === 0) { console.log("pooled-emos.test: all checks passed"); process.exit(0); }
  console.log(`pooled-emos.test: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  ✗ [${f.test}] ${f.message}`);
  process.exit(1);
}
export { failures };
