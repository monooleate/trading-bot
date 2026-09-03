// packages/core/src/config-fingerprint.mts
//
// Per-prediction config fingerprint + A/B attribution — model-discovery-training
// §2.C / #4 (sprints.md B50). Pure, portable (zero I/O).
//
// WHY: the prediction ledger records the forecast + outcome, but NOT which knob
// configuration produced it. The only knob trail is trader-trials ({ts, keys} —
// changed keys, no values, no per-prediction linkage), so you cannot slice
// performance by "what was the config when this forecast fired." That blocks real
// A/B attribution and is the prerequisite the discovery flags for the #3
// follow-ups (true ONC + cross-trial σ_SR).
//
// The fix (this file): stamp each ledger record with a stable HASH of the active
// overrides at scan time. Then `computeConfigAttribution` groups resolved records
// by that hash and scores each config's forecast quality (Brier skill vs the
// market price) — an honest, forward-native A/B on the FORECAST (which is exactly
// what the #1 promotion gate's proper-score objective cares about). PnL-side A/B
// (stamping ClosedTrade at entry) is a follow-up; the ledger is the cleaner,
// migration-free, unbiased substrate the discovery names.

/** FNV-1a 32-bit hash → 8-char lowercase hex. Deterministic, pure. */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stable fingerprint of the active config = a hash of the SAVED overrides (the
 * non-default knobs; the SCHEMA is all-numeric). No overrides → "default". The
 * key=value pairs are sorted so the hash is order-independent. Pure.
 */
export function configFingerprint(overrides: Record<string, unknown> | null | undefined): string {
  const entries = Object.entries(overrides ?? {})
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v as number))
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return entries.length === 0 ? "default" : hash32(entries.join("|"));
}

export interface ConfigAttributionRow {
  configHash: string;
  n: number;            // resolved predictions logged under this config
  brierModel: number;
  brierMarket: number;
  brierSkill: number;   // 1 − model/market  (>0 ⇒ the model beat the price)
  avgEdge: number;
  avgPredicted: number;
}

const EPS = 1e-6;
const brier = (p: number, y: number) => (p - y) * (p - y);

/**
 * Group resolved ledger records by their config fingerprint and score each
 * config's forecast quality (Brier skill vs the market baseline). Records with no
 * fingerprint (pre-#4) group under "unlabeled". Returns rows sorted by n desc. Pure.
 */
export function computeConfigAttribution(
  records: Array<{
    configHash?: string | null;
    predictedProb?: unknown; marketPrice?: unknown; outcome?: unknown; edge?: unknown;
  }>,
): ConfigAttributionRow[] {
  const acc = new Map<string, { n: number; bm: number; bk: number; edge: number; pred: number }>();
  for (const r of records ?? []) {
    if (r?.outcome === null || r?.outcome === undefined) continue; // Number(null)===0 would slip through
    const y = Number(r?.outcome);
    if (y !== 0 && y !== 1) continue;                       // unresolved / non-binary
    const p = Number(r?.predictedProb);
    const m = Number(r?.marketPrice);
    if (!Number.isFinite(p) || p < 0 || p > 1) continue;
    if (!Number.isFinite(m) || m <= 0 || m >= 1) continue;  // need a usable baseline
    const key = (typeof r?.configHash === "string" && r.configHash) ? r.configHash : "unlabeled";
    const g = acc.get(key) ?? { n: 0, bm: 0, bk: 0, edge: 0, pred: 0 };
    g.n += 1;
    g.bm += brier(p, y);
    g.bk += brier(m, y);
    g.edge += Number.isFinite(Number(r?.edge)) ? Number(r?.edge) : Math.abs(p - m);
    g.pred += p;
    acc.set(key, g);
  }
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return [...acc.entries()]
    .map(([configHash, g]) => {
      const brierModel = g.bm / g.n;
      const brierMarket = g.bk / g.n;
      return {
        configHash,
        n: g.n,
        brierModel: r4(brierModel),
        brierMarket: r4(brierMarket),
        brierSkill: r4(brierMarket > EPS ? 1 - brierModel / brierMarket : 0),
        avgEdge: r4(g.edge / g.n),
        avgPredicted: r4(g.pred / g.n),
      };
    })
    .sort((a, b) => b.n - a.n);
}
