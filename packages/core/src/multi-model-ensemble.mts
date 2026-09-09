// packages/core/src/multi-model-ensemble.mts
//
// Multi-model ensemble parsing + mixture statistics — B52 #1 (weather).
// Pure, zero I/O: the fetch lives in the worker
// (services/worker/src/pillars/weather/ensemble-forecast.mts), the storage in
// weather/multi-model-store.mts. This file owns the response shaping and the
// statistics so both are unit-tested.
//
// WHY: the weather bot's σ comes from ONE ensemble family (31-member NCEP
// GEFS). Measured on the bot's own stations (2026-09-08, T+0/T+1 daily max),
// that σ is 2–3× too narrow in Asia/US — Tokyo T+0 GEFS σ 0.49 °C vs 1.58 °C
// across four independent systems, with a 3.0 °C mean shift. A too-narrow σ is
// exactly what oversizes Kelly, which is the documented weather pathology
// (forecast_edge IC +0.393 = good direction, payoffRatio 0.44 = bad sizing).
//
// The Open-Meteo ensemble endpoint serves several independent systems in ONE
// request — 236 members at a typical station, 296 in Europe where the regional
// ICON models also apply — with no extra HTTP call and no API key. See
// DEFAULT_ENSEMBLE_MODELS below for the list and the domain-drop behaviour.
//
// POOLING: members are NOT pooled equally. Weighting per member would give
// WeatherNext 2 (64 members) twice the say of GEFS (31) for no physical
// reason. Instead each MODEL is one equally-weighted mixture component, so the
// pooled variance follows the law of total variance:
//     Var = mean(within-model var) + var(model means)
// The second term — the inter-model spread — is precisely the uncertainty a
// single-family ensemble cannot see.

// ─── Types ────────────────────────────────────────────────────────────────
export interface ModelStats {
  /** Model tag as it appears in the response key suffix (Open-Meteo's internal
   *  domain name, e.g. "ncep_gefs_seamless" — NOT the requested alias
   *  "gfs_seamless"). Empty string for a single-model response, which carries
   *  no suffix at all. */
  model: string;
  n: number;      // members contributing
  mean: number;   // °C
  sd: number;     // °C, sample stddev (n−1) — matches the GEFS-only path
}

export interface MultiModelStats {
  perModel: ModelStats[];
  /** Equal-weight-per-MODEL mixture (see the pooling note above). */
  pooled: { n: number; mean: number; sd: number };
  /** Population stddev of the per-model means — 0 with a single model. */
  interModelSpread: number;
  /** Every member value, flattened. Order groups by model. */
  members: number[];
}

// ─── Model-list parsing ───────────────────────────────────────────────────

/**
 * Independent ensemble systems to log, verified live 2026-09-08 / 2026-09-09.
 *
 * ONE list serves every station: a REGIONAL model outside its domain is
 * silently dropped from a multi-model response (verified — Tokyo with
 * `gfs_seamless,icon_eu` returns HTTP 200 with GEFS's 31 members, no error and
 * no null column). It only 400s when requested on its own, which this code
 * never does. So no per-station table is needed and adding a regional model
 * cannot break a station it does not cover.
 *
 * Measured member counts (2026-09-09, one request, ~42 KB, ~0.2 s):
 *   Europe (London, Munich) 8 systems / 296 members
 *   Madrid                  7 systems / 276   (icon_d2 out of domain)
 *   US, Asia, S-America, Africa
 *                           6 systems / 236
 */
export const DEFAULT_ENSEMBLE_MODELS: readonly string[] = [
  // ── Global (every station) ──
  "gfs_seamless",                  // NCEP GEFS, 31 members (the bot's current source)
  "ecmwf_ifs025",                  // ECMWF IFS-ENS, 51
  "ecmwf_aifs025",                 // ECMWF AIFS-ENS (AI), 51
  "google_weathernext2_ensemble",  // Google DeepMind WeatherNext 2 (AI), 64
  "gem_global",                    // CMC GEPS, 21
  "ukmo_global_ensemble_20km",     // UKMO MOGREPS-G, 18
  // ── Regional, higher resolution — auto-dropped outside their domain ──
  "icon_eu",                       // DWD ICON-EU-EPS, 40 @ 13 km — Europe
  "icon_d2",                       // DWD ICON-D2-EPS, 20 @ 2 km — central Europe + UK
  // NOT included: `bom_access_global_ensemble` advertises 18 members but every
  // temperature column came back null at every station tested; and
  // `ukmo_uk_ensemble_2km` carries only 3 members, too few for a usable
  // within-model σ under equal-weight-per-model pooling (it covers one station).
];

/**
 * Parse a comma-separated model list (env var) into a normalised id array.
 * Trims, lowercases, drops empties, de-duplicates preserving order. Returns
 * `fallback` when the input has no usable entry. Pure.
 */
export function parseModelList(raw: string | undefined | null, fallback: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw ?? "").split(",")) {
    const id = part.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : fallback.slice();
}

// ─── Response-key grouping ────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Group ensemble column keys by the model tag encoded in the key.
 *
 * Open-Meteo names the columns `<var>`, `<var>_memberNN` for a single model and
 * `<var>_<model>`, `<var>_memberNN_<model>` when several models are requested.
 * The tag is read OFF THE KEY rather than matched against the requested alias,
 * because the response carries Open-Meteo's internal domain name (the request
 * `gfs_seamless` comes back as `ncep_gefs_seamless`). Pure.
 *
 * Returns tag → keys; the single-model case lands under "".
 */
export function splitEnsembleKeys(keys: string[], baseVar: string): Map<string, string[]> {
  const re = new RegExp(`^${escapeRe(baseVar)}(?:_member(\\d+))?(?:_(.+))?$`);
  const out = new Map<string, string[]>();
  for (const k of keys ?? []) {
    const m = re.exec(k);
    if (!m) continue;
    const tag = m[2] ?? "";
    const arr = out.get(tag);
    if (arr) arr.push(k);
    else out.set(tag, [k]);
  }
  return out;
}

// ─── Statistics ───────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Sample stddev (n−1) — matches ensemble-forecast.mts so GEFS numbers stay comparable. */
function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Population variance — the mixture identity needs the full-set form. */
function popVar(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
}

const round2 = (v: number) => parseFloat(v.toFixed(2));

/**
 * Extract per-model daily-max statistics for one target date from an
 * Open-Meteo `daily` block (`{ time: string[], <var>...: (number|null)[] }`).
 *
 * Returns null when the date is absent or no model yields a usable member.
 * Never throws on ragged/null series — non-finite values are skipped. Pure.
 */
export function modelStatsForDate(
  daily: Record<string, unknown> | null | undefined,
  baseVar: string,
  date: string,
): MultiModelStats | null {
  const cols = daily as Record<string, any> | null | undefined;
  const times = cols?.time;
  if (!Array.isArray(times)) return null;
  const idx = times.indexOf(date);
  if (idx < 0) return null;

  const grouped = splitEnsembleKeys(
    Object.keys(cols!).filter((k) => k !== "time"),
    baseVar,
  );

  const perModel: ModelStats[] = [];
  const members: number[] = [];
  for (const [tag, keys] of grouped) {
    const vals: number[] = [];
    for (const k of keys) {
      const series = cols![k];
      if (!Array.isArray(series)) continue;
      const v = series[idx];
      if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length === 0) continue;
    perModel.push({ model: tag, n: vals.length, mean: round2(mean(vals)), sd: round2(sampleSd(vals)) });
    members.push(...vals);
  }
  if (perModel.length === 0) return null;

  // Equal weight per MODEL, not per member (see the header note).
  const modelMeans = perModel.map((m) => m.mean);
  const withinVar = mean(perModel.map((m) => m.sd ** 2));
  const betweenVar = popVar(modelMeans);

  return {
    perModel,
    pooled: {
      n: members.length,
      mean: round2(mean(modelMeans)),
      sd: round2(Math.sqrt(withinVar + betweenVar)),
    },
    interModelSpread: round2(Math.sqrt(betweenVar)),
    members,
  };
}
