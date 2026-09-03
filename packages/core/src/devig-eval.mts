// packages/core/src/devig-eval.mts
//
// Offline de-vig validation — model-discovery-training §3.C / #5 (sports domain,
// sprints.md B50). Pure, portable (zero I/O). The fetch + report live in a script
// (scripts/eval-devig.ts); these are the pure CSV parser + method scorer.
//
// WHY: B49 #7 added Shin de-vig on the claim it is the best-calibrated method for
// favorite-longshot bias (Štrumbelj 2014), but nothing verified that on OUR data
// before `sportsUsePinnacle` is trusted. The honest measure-first check: take
// historical PINNACLE CLOSING lines with realised outcomes (football-data.co.uk,
// free — the PSC* columns are Pinnacle's closing odds), de-vig each match with
// multiplicative / power / Shin, and score the fair probabilities against the
// realised outcome on a strictly-proper metric (multiclass Brier + log-loss).
// The method with the lowest score is the best-calibrated on real closing lines.
// This is validation, not a store seed — the sports Shin is stateless (it solves
// z per market), so there is nothing to fit; the harness confirms the method.

import { devigMultiplicative, devigPower, devigShin, type DevigMethod } from "./devig.mts";

export interface DevigRecord {
  odds: number[];    // decimal odds per outcome, in a fixed order (e.g. [H, D, A])
  outcome: number;   // index of the realised winning outcome
}

/**
 * Parse a football-data.co.uk CSV into 3-way (H/D/A) de-vig records using the
 * PINNACLE CLOSING odds (PSCH/PSCD/PSCA), falling back to the pre-close Pinnacle
 * columns (PSH/PSD/PSA), then Bet365 closing (B365C*), then Bet365 (B365*).
 * `FTR` (H/D/A) is the realised result. Rows with missing/invalid odds or result
 * are skipped. Pure (takes the CSV text).
 */
export function parseFootballData(csv: string): DevigRecord[] {
  const lines = (csv ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  // Preference order: Pinnacle closing → Pinnacle → Bet365 closing → Bet365.
  const sets: Array<[number, number, number]> = [
    [col("PSCH"), col("PSCD"), col("PSCA")],
    [col("PSH"), col("PSD"), col("PSA")],
    [col("B365CH"), col("B365CD"), col("B365CA")],
    [col("B365H"), col("B365D"), col("B365A")],
  ];
  const ftrCol = col("FTR");
  if (ftrCol < 0) return [];
  const outcomeIndex: Record<string, number> = { H: 0, D: 1, A: 2 };

  const out: DevigRecord[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(",");
    const ftr = (cells[ftrCol] ?? "").trim().toUpperCase();
    if (!(ftr in outcomeIndex)) continue;
    let odds: number[] | null = null;
    for (const [h, d, a] of sets) {
      if (h < 0 || d < 0 || a < 0) continue;
      const oh = Number(cells[h]), od = Number(cells[d]), oa = Number(cells[a]);
      if (oh > 1 && od > 1 && oa > 1) { odds = [oh, od, oa]; break; }
    }
    if (!odds) continue;
    out.push({ odds, outcome: outcomeIndex[ftr] });
  }
  return out;
}

export interface DevigMethodScore {
  method: DevigMethod;
  n: number;
  brier: number;     // mean multiclass Brier Σ_i (p_i − y_i)²  (lower = better)
  logLoss: number;   // mean −ln p(realised outcome)  (lower = better)
}

const EPS = 1e-6;

function devigBy(method: DevigMethod, odds: number[]): number[] {
  return method === "shin" ? devigShin(odds)
    : method === "power" ? devigPower(odds)
    : devigMultiplicative(odds);
}

/**
 * Score each de-vig method on the records: mean multiclass Brier + log-loss of
 * the fair probabilities against the realised one-hot outcome. Records whose
 * de-vig yields a non-finite / non-normalised vector are skipped (per method).
 * Returns rows sorted by Brier ascending (best-calibrated first). Pure.
 */
export function scoreDevigMethods(
  records: DevigRecord[],
  methods: DevigMethod[] = ["multiplicative", "power", "shin"],
): DevigMethodScore[] {
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const rows: DevigMethodScore[] = [];
  for (const method of methods) {
    let n = 0, brierSum = 0, logSum = 0;
    for (const rec of records ?? []) {
      const k = rec?.odds?.length ?? 0;
      if (k < 2 || !(rec.outcome >= 0 && rec.outcome < k)) continue;
      const p = devigBy(method, rec.odds);
      if (p.length !== k || p.some((x) => !Number.isFinite(x))) continue;
      const sum = p.reduce((s, x) => s + x, 0);
      if (!(sum > 0.5)) continue;               // degenerate de-vig
      let b = 0;
      for (let i = 0; i < k; i++) {
        const y = i === rec.outcome ? 1 : 0;
        b += (p[i] - y) ** 2;
      }
      const pc = Math.min(1 - EPS, Math.max(EPS, p[rec.outcome]));
      brierSum += b;
      logSum += -Math.log(pc);
      n++;
    }
    rows.push({ method, n, brier: n ? r4(brierSum / n) : NaN, logLoss: n ? r4(logSum / n) : NaN });
  }
  // Push NaN scores (n=0 methods) to the end; a legitimate Brier of 0 must
  // sort FIRST, so guard on finiteness rather than truthiness (`0 || Infinity`).
  const key = (x: number) => (Number.isFinite(x) ? x : Infinity);
  return rows.sort((a, b) => key(a.brier) - key(b.brier));
}
