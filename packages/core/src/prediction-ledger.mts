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
import { currentCodeVersion } from "./build-info.mts";

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
  // ── B53: the FIRST-SIGHTING tuple, written once and never overwritten ──
  // The three fields above are refreshed on every rescan, so by the time a
  // market resolves they hold the LAST scan's values — and a market price
  // converges mechanically to the outcome as expiry approaches. Scoring the
  // model against that price is not the entry-time comparison the walk-forward
  // card claims to make; it is a late-life snapshot that flatters the market
  // (measured 2026-09-08: 17 of 43 resolved weather rows had a stored price
  // > 0.98, and 94% of those resolved YES).
  //
  // These carry the state at `firstTs` instead: a fixed, pre-convergence
  // information horizon. Optional so records written before the fix still
  // parse — every consumer falls back to the latest fields and the fix fills
  // forward from deploy (the overwritten prices are NOT recoverable).
  firstPredictedProb?: number;
  firstMarketPrice?: number;
  firstConfigHash?: string | null;    // the config that produced THAT prediction
  // Audit P1-4: true when the tuple above was BACK-FILLED onto a row that
  // already existed (written before B53 shipped), rather than captured at the
  // row's first sighting. Such a value was measured mid-life — for the worst
  // observed case, 2412 scans after `firstTs` — so it is not a pre-convergence
  // horizon and must not be counted as clean evidence.
  // Absent/false does NOT prove the opposite: rows back-filled before this flag
  // shipped never received it. Ask `firstObservationProvenance`, which also
  // checks `firstTs` against FIRST_TUPLE_EPOCH (B67).
  firstBackfilled?: boolean;
  // WHICH CODE produced this prediction. `configHash` above hashes the runtime
  // KNOBS only — no commit, no build id — so two materially different code
  // regimes share an arm whenever a deploy lands without a knob change.
  // Measured live 2026-09-09: arm `e03b4835` spans 10:45:41 → 11:07:11, a window
  // containing the audit deploy at 11:03 that rewrote the HL signal source, the
  // ledger rules, the IC blend and the fill check. Latched with the rest of the
  // first-sighting tuple, so it names the code that made the FIRST prediction,
  // matching `firstConfigHash`. See @core/build-info.mts.
  codeVersion?: string;
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
        // B53: latched at first sighting, never touched again.
        firstPredictedProb: inc.predictedProb,
        firstMarketPrice: inc.marketPrice,
        firstConfigHash: inc.configHash ?? null,
        codeVersion: currentCodeVersion(),
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
      // B53: the first-sighting tuple is write-once — latch BEFORE the refresh
      // below overwrites the latest fields. `??=` also back-fills a record
      // written before these fields existed, using the values it still holds
      // from its previous scan: the oldest state available, and from here on
      // that row's first-tuple stops moving.
      //
      // Audit P1-4 (2026-09-09): that back-fill is NOT a first observation, and
      // silently pretending otherwise is worse than having no value at all.
      // Measured right after the B53 deploy, 32 of 36 latched rows had already
      // been scanned more than 10 times (up to 2412, firstTs up to six days
      // earlier) — hyperliquid/BTC latched firstMarketPrice 0.9995 against
      // outcome 1, i.e. |first − outcome| = 0.0005, a perfectly converged price
      // wearing the name "first". `firstTs` is not updated either, so the record
      // asserts a date the tuple was never measured at, and every consumer just
      // tests `firstPredictedProb ?? predictedProb` — presence, not provenance.
      //
      // So mark it. The value is still the best available (freezing at back-fill
      // time beats letting `latest` drift on to resolution), but downstream can
      // now tell a genuine first sighting from a laundered one and report or
      // exclude accordingly. See `isCleanFirstObservation` below.
      if (prev.firstPredictedProb == null) prev.firstBackfilled = true;
      // Same write-once rule. A back-filled row gets the CURRENT build, which is
      // not the one that made its first prediction — `firstBackfilled` already
      // marks that whole tuple as untrustworthy, and codeVersionSpread treats a
      // mix as mixed either way.
      prev.codeVersion ??= currentCodeVersion();
      prev.firstPredictedProb ??= prev.predictedProb;
      prev.firstMarketPrice ??= prev.marketPrice;
      prev.firstConfigHash ??= prev.configHash ?? null;

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

/**
 * When B53 went live: the moment the deploy that shipped the write-once
 * first-sighting tuple finished (deploy run for `0ed3f93`, which carried
 * `89fccc4`). From here on a NEW row latches the tuple at its first scan.
 *
 * A row whose `firstTs` is earlier was created by the old code, so whatever
 * tuple it carries was filled in afterwards — mid-life — whatever
 * `firstBackfilled` says. The flag cannot vouch for such a row: it shipped with
 * B61 at 11:04 UTC, six hours later, and it is only set while the tuple is
 * still EMPTY. Every pre-B53 row rescanned inside that window had already been
 * back-filled, so no later scan can flag it. B67: the 2026-09-10 drift check
 * found 25 such resolved rows counted as clean, with more of the set still
 * open. The same data shows no flagged row first seen after this instant, so
 * the epoch alone separates the two populations; the flag stays as a record.
 *
 * `firstTs` is written when a row is created and never rewritten, so comparing
 * it with this instant settles provenance for every row, old or new. It is a
 * historical fact, not a tunable: moving it silently reclassifies evidence.
 * (Measured 2026-09-10: no ledger row has a `firstTs` within ten minutes of it,
 * so the deploy's own few seconds of ambiguity decide nothing.)
 */
export const FIRST_TUPLE_EPOCH = "2026-09-09T05:25:24Z";
const FIRST_TUPLE_EPOCH_MS = Date.parse(FIRST_TUPLE_EPOCH);

export type FirstObservationProvenance = "clean" | "backfilled" | "missing";

/** The fields provenance is decided from — all present on a PredictionRecord. */
export interface FirstObservationFields {
  firstTs: string;
  firstPredictedProb?: number;
  firstBackfilled?: boolean;
}

/**
 * Classify a record's first-sighting tuple (audit P1-4 + B67). Three states
 * exist in the live ledger and the measurement layer must not treat them alike:
 *
 *   "clean"      tuple set, not flagged, row first seen at/after
 *                FIRST_TUPLE_EPOCH → captured at the row's first scan, before
 *                the market price had time to converge.
 *   "backfilled" tuple set, but flagged OR first seen before FIRST_TUPLE_EPOCH
 *                → frozen whenever the new code first reached an existing row,
 *                potentially thousands of scans into its life. An unparseable
 *                `firstTs` lands here too: a row whose age cannot be
 *                established cannot be vouched for.
 *   "missing"    no tuple → pre-B53 row never rescanned; consumers fall back to
 *                the LATEST fields, the converged value the fix exists to avoid.
 *
 * Only "clean" is clean. Consumers should keep scoring every row — dropping the
 * other two today would leave little — but they must be able to say how much
 * of a verdict rests on contaminated evidence. Pure.
 */
export function firstObservationProvenance(
  r: FirstObservationFields | null | undefined,
): FirstObservationProvenance {
  if (!r || typeof r.firstPredictedProb !== "number") return "missing";
  if (r.firstBackfilled === true) return "backfilled";
  const firstSeen = Date.parse(r.firstTs);
  if (!Number.isFinite(firstSeen) || firstSeen < FIRST_TUPLE_EPOCH_MS) return "backfilled";
  return "clean";
}

/** Does this record carry a GENUINE first-sighting observation? Pure. */
export function isCleanFirstObservation(r: FirstObservationFields | null | undefined): boolean {
  return firstObservationProvenance(r) === "clean";
}

/**
 * Split records by first-observation provenance. Returns the counts a card or a
 * promotion verdict should print next to its headline number, so "beats market"
 * can never again be asserted on a pool whose baseline is the outcome itself.
 */
export function firstObservationCoverage(
  records: readonly FirstObservationFields[],
): { total: number; clean: number; backfilled: number; missing: number; cleanFraction: number } {
  let clean = 0, backfilled = 0, missing = 0;
  for (const r of records ?? []) {
    const p = firstObservationProvenance(r);
    if (p === "clean") clean++;
    else if (p === "backfilled") backfilled++;
    else missing++;
  }
  const total = clean + backfilled + missing;
  return { total, clean, backfilled, missing, cleanFraction: total ? clean / total : 0 };
}
