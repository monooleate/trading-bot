// netlify/functions/auto-trader/shared/prediction-ledger.mts
//
// Prediction ledger — the unbiased, point-in-time forecast dataset for
// validating the forecasting layer now AND after the Hetzner migration.
// Model-discovery §2 (data): the bots' `closedTrades` only hold markets the
// bot TOOK (selection bias) and are tiny. The ledger logs the model's
// prediction for EVERY scanned market (taken + skipped), then fills the
// realised YES-outcome once the market resolves — so calibration/backtests
// run on a clean, unbiased, growing label set.
//
// Storage: one Blobs store ("prediction-ledger"), one key per category. The
// data is the asset; this Blobs backend is a swappable adapter — at Hetzner
// the records dump→insert into Postgres (B12) unchanged. Point-in-time signal
// values (orderflow / apex / CLOB microstructure) CANNOT be reconstructed
// later, which is why logging must start now regardless of where compute lives.
//
// Design choices (deliberate):
//  • One record per market slug, UPSERTED each scan — latest prediction wins,
//    `firstTs`/`scans`/`outcome` preserved. One labeled prediction per market
//    = unbiased, bounded, calibration-ready. "Latest before resolution" is a
//    consistent anchor closest to the outcome.
//  • `outcome` = YES-resolution (0/1), direction-agnostic — any future model
//    can be scored regardless of which side the bot took.
//  • Cap keeps the most-recent N by firstTs; resolved records are the asset,
//    kept until capped out.

import { getStore } from "@netlify/blobs";

const LEDGER_STORE = "prediction-ledger";
const DEFAULT_CAP = 3000;             // records per category (append-only rolling)
const GAMMA_API = "https://gamma-api.polymarket.com";

export interface PredictionRecord {
  slug: string;
  category: string;
  firstTs: string;                    // first time this market was logged
  ts: string;                         // latest prediction timestamp (upserted)
  conditionId: string | null;
  endDate: string | null;
  predictedProb: number;              // model P(YES) at the latest scan
  marketPrice: number;                // market YES price at the latest scan
  edge: number;                       // |predictedProb − marketPrice|
  direction: string;                  // side the bot took / would take (YES/NO/LONG/SHORT)
  taken: boolean;                     // did the bot ever open a position here?
  lastAction: string;                 // position_opened / skip / failed / error
  skipReason: string | null;
  signalBreakdown: Record<string, number | null> | null;
  scans: number;                      // # ticks this market was logged
  outcome: number | null;             // YES-resolution 0/1 once resolved, else null
  resolvedAt: string | null;
  configHash?: string | null;         // B50 #4: fingerprint of the active config at the latest scan
}

// Shape of the incoming per-market prediction (derived from a bot's scan
// `results[]` row + the scanned market object for conditionId).
export interface IncomingPrediction {
  slug: string;
  ts: string;
  conditionId: string | null;
  endDate: string | null;
  predictedProb: number;
  marketPrice: number;
  edge: number;
  direction: string;
  taken: boolean;
  lastAction: string;
  skipReason: string | null;
  signalBreakdown: Record<string, number | null> | null;
  configHash?: string | null;
}

const isYesLike = (d: unknown): boolean => d === "YES" || d === "LONG";

// Actions a scan-row can carry that mean "no position taken". Anything else
// (crypto "position_opened", weather "traded", HL "position_opened") = taken.
// Bot-agnostic so one generic builder serves all three runners.
const NON_TAKEN_ACTIONS = new Set(["skip", "failed", "error", "unknown"]);

/**
 * Build IncomingPrediction[] from a bot's scan `results[]` (each row is
 * marketContext + action) plus the scanned `markets[]` (for conditionId).
 * Rows without a finite predictedProb (e.g. error rows) are dropped — they
 * carry no forecast to score. Pure.
 */
export function buildIncoming(
  results: any[],
  markets: any[],
  ts: string,
  configHash: string = "default",
): IncomingPrediction[] {
  const condBySlug = new Map<string, string>();
  for (const m of markets ?? []) {
    if (m?.slug && m?.conditionId) condBySlug.set(m.slug, String(m.conditionId));
  }
  const out: IncomingPrediction[] = [];
  for (const r of results ?? []) {
    // HL rows key on `coin`; crypto/weather on `market`.
    const slug = r?.market ?? r?.coin;
    const pp = r?.predictedProb;
    if (!slug || typeof pp !== "number" || !Number.isFinite(pp)) continue;
    const price = typeof r.marketPrice === "number" && Number.isFinite(r.marketPrice) ? r.marketPrice : 0;
    const action = String(r.action ?? "unknown");
    out.push({
      slug: String(slug),
      ts,
      conditionId: condBySlug.get(String(slug)) ?? (r.conditionId ? String(r.conditionId) : null),
      endDate: r.endDate ?? null,
      predictedProb: pp,
      marketPrice: price,
      edge: typeof r.edge === "number" ? r.edge : Math.abs(pp - price),
      direction: String(r.direction ?? ""),
      taken: !NON_TAKEN_ACTIONS.has(action),
      lastAction: action,
      skipReason: action === "skip" || action === "failed" ? (r.reason ?? null) : null,
      signalBreakdown: r.signalBreakdown ?? null,
      configHash,
    });
  }
  return out;
}

/**
 * Upsert incoming predictions into the existing record list (by slug).
 * New slug → append. Existing → refresh latest fields, bump `scans`, keep
 * `firstTs`/`outcome`/`resolvedAt`, and latch `taken` to true if ever taken.
 * Pure.
 */
export function upsertRecords(
  existing: PredictionRecord[],
  incoming: IncomingPrediction[],
  category: string,
): PredictionRecord[] {
  const bySlug = new Map<string, PredictionRecord>();
  for (const r of existing) bySlug.set(r.slug, r);

  for (const inc of incoming) {
    const prev = bySlug.get(inc.slug);
    if (!prev) {
      bySlug.set(inc.slug, {
        slug: inc.slug,
        category,
        firstTs: inc.ts,
        ts: inc.ts,
        conditionId: inc.conditionId,
        endDate: inc.endDate,
        predictedProb: inc.predictedProb,
        marketPrice: inc.marketPrice,
        edge: inc.edge,
        direction: inc.direction,
        taken: inc.taken,
        lastAction: inc.lastAction,
        skipReason: inc.skipReason,
        signalBreakdown: inc.signalBreakdown,
        scans: 1,
        outcome: null,
        resolvedAt: null,
        configHash: inc.configHash ?? null,
      });
    } else {
      prev.ts = inc.ts;
      prev.conditionId = inc.conditionId ?? prev.conditionId;
      prev.endDate = inc.endDate ?? prev.endDate;
      prev.predictedProb = inc.predictedProb;
      prev.marketPrice = inc.marketPrice;
      prev.edge = inc.edge;
      prev.direction = inc.direction;
      prev.taken = prev.taken || inc.taken;
      prev.lastAction = inc.lastAction;
      prev.skipReason = inc.skipReason;
      if (inc.signalBreakdown) prev.signalBreakdown = inc.signalBreakdown;
      if (inc.configHash) prev.configHash = inc.configHash;   // latest scan's config wins
      prev.scans += 1;
    }
  }
  return Array.from(bySlug.values());
}

/**
 * Cap the ledger to `max` records, keeping the most-recent by `firstTs`.
 * Resolved records are the labeled asset, so they are kept until they age out
 * of the most-recent window like any other. Pure.
 */
export function capRecords(records: PredictionRecord[], max: number = DEFAULT_CAP): PredictionRecord[] {
  if (records.length <= max) return records;
  return [...records]
    .sort((a, b) => new Date(b.firstTs).getTime() - new Date(a.firstTs).getTime())
    .slice(0, max);
}

/**
 * YES-resolution (0/1) implied by a closed trade, direction-agnostic.
 * A YES/LONG trade that won → YES resolved 1; a NO/SHORT trade that won → YES
 * resolved 0. Uses pnl sign (the same win definition the rest of the tracker
 * uses). Returns null if pnl is exactly 0 (push / unresolved). Pure.
 */
export function yesOutcomeFromClosedTrade(t: {
  direction: unknown;
  pnl?: number;
  pnlUSDC?: number;      // HL closed trades store pnlUSDC, not pnl
}): number | null {
  const pnl = Number(t.pnl ?? t.pnlUSDC);
  if (!Number.isFinite(pnl) || pnl === 0) return null;
  const won = pnl > 0;
  const yesLike = isYesLike(t.direction);
  // YES-side win ⇒ YES=1; YES-side loss ⇒ YES=0; NO-side win ⇒ YES=0; etc.
  return (yesLike === won) ? 1 : 0;
}

/**
 * Fill `outcome` on taken records from the bot's closedTrades (matched by
 * slug). Cheap, no network — the resolver already settled these. Skipped
 * markets still need the Gamma reconcile. Pure; mutates a shallow copy.
 */
export function fillOutcomesFromClosedTrades(
  records: PredictionRecord[],
  closedTrades: any[],
  nowIso: string,
): PredictionRecord[] {
  const bySlug = new Map<string, any>();
  for (const t of closedTrades ?? []) {
    const key = t?.market ?? t?.coin;      // HL closed trades key on `coin`
    if (key) bySlug.set(String(key), t);
  }
  return records.map((r) => {
    if (r.outcome !== null) return r;
    const t = bySlug.get(r.slug);
    if (!t) return r;
    const yes = yesOutcomeFromClosedTrade(t);
    if (yes === null) return r;
    return { ...r, outcome: yes, resolvedAt: t.closedAt ?? nowIso };
  });
}

// ─── Blobs IO ─────────────────────────────────────────────

function ledgerKey(category: string): string {
  return `ledger-${category}`;
}

export async function loadLedger(category: string): Promise<PredictionRecord[]> {
  try {
    const store = getStore(LEDGER_STORE);
    const raw = await store.get(ledgerKey(category));
    if (!raw) return [];
    const parsed = JSON.parse(raw as string);
    return Array.isArray(parsed) ? parsed as PredictionRecord[] : [];
  } catch {
    return [];
  }
}

export async function saveLedger(category: string, records: PredictionRecord[]): Promise<void> {
  try {
    const store = getStore(LEDGER_STORE);
    await store.set(ledgerKey(category), JSON.stringify(records));
  } catch {
    /* best-effort: the ledger must never break a trade tick */
  }
}

/**
 * Append this tick's scan predictions to the ledger + fill outcomes for taken
 * markets from closedTrades. Best-effort and non-throwing — a ledger failure
 * must never break a trade tick. Call once per runner, after the scan loop.
 */
export async function appendPredictions(
  category: string,
  results: any[],
  markets: any[],
  closedTrades: any[] = [],
  cap: number = DEFAULT_CAP,
  configHash: string = "default",
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const incoming = buildIncoming(results, markets, now, configHash);
    if (incoming.length === 0 && (closedTrades?.length ?? 0) === 0) return;
    const existing = await loadLedger(category);
    let next = upsertRecords(existing, incoming, category);
    next = fillOutcomesFromClosedTrades(next, closedTrades, now);
    next = capRecords(next, cap);
    await saveLedger(category, next);
  } catch {
    /* swallow — never break the tick */
  }
}

/**
 * Reconcile unresolved records (past endDate, has conditionId, no outcome) by
 * reading the Polymarket Gamma resolution. This is what fills SKIPPED-market
 * outcomes (the resolver only settles taken positions). Budgeted per tick to
 * respect the Netlify function timeout. Best-effort, non-throwing.
 *
 * Gamma quirk: `&closed=true` is MANDATORY or Gamma hides resolved markets.
 * A market is resolved when outcomePrices is binary {0,1}.
 */
export async function reconcileLedger(
  category: string,
  budget: number = 12,
): Promise<{ checked: number; resolved: number }> {
  let checked = 0;
  let resolved = 0;
  try {
    const records = await loadLedger(category);
    const now = Date.now();
    const nowIso = new Date().toISOString();
    const pending = records.filter(
      (r) =>
        r.outcome === null &&
        r.conditionId &&
        r.endDate &&
        new Date(r.endDate).getTime() < now,
    );
    if (pending.length === 0) return { checked: 0, resolved: 0 };

    let mutated = false;
    for (const rec of pending.slice(0, budget)) {
      checked += 1;
      const yes = await fetchGammaYesResolution(rec.conditionId!);
      if (yes !== null) {
        rec.outcome = yes;
        rec.resolvedAt = nowIso;
        resolved += 1;
        mutated = true;
      }
    }
    if (mutated) await saveLedger(category, records);
  } catch {
    /* swallow */
  }
  return { checked, resolved };
}

/**
 * Fetch the YES-resolution (0/1) for a conditionId from Gamma, or null if not
 * yet resolved / on error. Mirrors the crypto paper-resolver pattern
 * (`&closed=true` mandatory; resolved ⇔ outcomePrices binary extreme).
 */
async function fetchGammaYesResolution(conditionId: string): Promise<number | null> {
  try {
    const url = `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}&closed=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const arr = await res.json();
    const m = Array.isArray(arr) ? arr[0] : null;
    if (!m || m.closed !== true) return null;
    const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (!Array.isArray(op) || op.length < 1) return null;
    const yesPrice = Number(op[0]);
    if (!Number.isFinite(yesPrice)) return null;
    if (yesPrice <= 0.001) return 0;
    if (yesPrice >= 0.999) return 1;
    return null;                        // closed but not yet binary (UMA window)
  } catch {
    return null;
  }
}

// ─── Read-side summary (for a future ledger UI / API) ─────

export interface LedgerStats {
  category: string;
  total: number;
  resolved: number;
  taken: number;
  skippedResolved: number;      // the unbiased add-on: resolved markets the bot did NOT take
  oldestTs: string | null;
  newestTs: string | null;
}

export function computeLedgerStats(category: string, records: PredictionRecord[]): LedgerStats {
  const resolved = records.filter((r) => r.outcome !== null);
  const taken = records.filter((r) => r.taken);
  const skippedResolved = resolved.filter((r) => !r.taken).length;
  const tss = records.map((r) => r.firstTs).filter(Boolean).sort();
  return {
    category,
    total: records.length,
    resolved: resolved.length,
    taken: taken.length,
    skippedResolved,
    oldestTs: tss[0] ?? null,
    newestTs: tss[tss.length - 1] ?? null,
  };
}
