// netlify/functions/trader-settings.mts
//
// Auth-protected runtime override store for the auto-trader engine.
// GET  → returns the current effective config (env defaults merged with
//        any saved overrides) plus the per-field allowed range.
// POST → validates, clamps, and persists overrides into Netlify Blobs.
//
// Why a runtime store rather than env vars:
//   - Tuning during paper testing without redeploys
//   - One source of truth shared by every cron tick of the trader
// Why auth-protected:
//   - These knobs change real money behaviour. Only the JWT-authed owner
//     can change them. Anonymous reads via GET return *defaults only*
//     (never expose currently-active live overrides without auth).

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { checkAuth } from "./_auth-guard.ts";
import { CORS, getTraderConfig, getBtcExitConfig } from "./auto-trader/shared/config.mts";

const STORE_NAME = "trader-settings";
const KEY = "runtime-overrides-v1";

// ─── Schema: each editable field has a default range and a hard min/max ─

type Category = "crypto" | "weather" | "hyperliquid" | "common";

interface FieldSpec {
  default: number;
  min: number;
  max: number;
  label: string;
  step: number;
  unit: string;
  category: Category;
  group: string;            // sub-section title inside the per-category page
}

const SCHEMA: Record<string, FieldSpec> = {
  edgeThreshold:        { default: 0.15,    min: 0.02,    max: 0.30,    label: "Edge threshold (net)",       step: 0.005, unit: "frac",  category: "crypto", group: "Risk & sizing" },
  maxKellyFraction:     { default: 0.08,    min: 0.01,    max: 0.25,    label: "Max Kelly fraction",         step: 0.005, unit: "frac",  category: "crypto", group: "Risk & sizing" },
  cooldownSeconds:      { default: 300,     min: 30,      max: 3600,    label: "Cooldown per market",        step: 30,    unit: "sec",   category: "crypto", group: "Risk & sizing" },
  sessionLossLimit:     { default: 20,      min: 5,       max: 1000,    label: "Session loss limit",         step: 5,     unit: "USD",   category: "crypto", group: "Risk & sizing" },
  btcTpTarget:          { default: 0.75,    min: 0.55,    max: 0.95,    label: "BTC short-market TP",        step: 0.01,  unit: "price", category: "crypto", group: "BTC short-market exit" },
  btcSlTarget:          { default: 0.35,    min: 0.05,    max: 0.45,    label: "BTC short-market SL",        step: 0.01,  unit: "price", category: "crypto", group: "BTC short-market exit" },
  btcEntryWindowStartMs:{ default: 60000,   min: 0,       max: 600000,  label: "Entry window start",         step: 5000,  unit: "ms",    category: "crypto", group: "BTC short-market exit" },
  btcEntryWindowEndMs:  { default: 180000,  min: 30000,   max: 900000,  label: "Entry window end",           step: 5000,  unit: "ms",    category: "crypto", group: "BTC short-market exit" },
  btcHoldToEndCutoffMs: { default: 60000,   min: 10000,   max: 300000,  label: "Hold-to-end cutoff",         step: 5000,  unit: "ms",    category: "crypto", group: "BTC short-market exit" },
  obImbalanceUpRatio:   { default: 1.80,    min: 1.10,    max: 5.00,    label: "OB imbalance UP threshold",  step: 0.05,  unit: "ratio", category: "crypto", group: "OB imbalance" },
  obImbalanceDownRatio: { default: 0.55,    min: 0.20,    max: 0.95,    label: "OB imbalance DOWN threshold",step: 0.05,  unit: "ratio", category: "crypto", group: "OB imbalance" },
  // ─── Weather trader knobs ──────────────────────────────────────
  weatherEdgeThreshold:   { default: 0.12, min: 0.02, max: 0.40, label: "Edge threshold (net)",          step: 0.005, unit: "frac", category: "weather", group: "Risk & sizing" },
  weatherConfidenceMin:   { default: 0.65, min: 0.30, max: 0.95, label: "Min model confidence",          step: 0.01,  unit: "frac", category: "weather", group: "Risk & sizing" },
  weatherExitBeforeMin:   { default: 45,   min: 10,   max: 240,  label: "Exit-before window",            step: 5,     unit: "min",  category: "weather", group: "Risk & sizing" },
  weatherMaxPositionUSD:  { default: 25,   min: 5,    max: 500,  label: "Max position size",             step: 5,     unit: "USD",  category: "weather", group: "Risk & sizing" },
  weatherMaxEdgeCap:      { default: 0.40, min: 0.10, max: 0.95, label: "Max-edge sanity cap",           step: 0.01,  unit: "frac", category: "weather", group: "Risk & sizing" },
  weatherForecastDays:    { default: 0,    min: 0,    max: 7,    label: "forecast_days (0 = auto)",      step: 1,     unit: "days", category: "weather", group: "Forecast pipeline" },
  // 0/1-encoded boolean toggles. The UI renders these as switches.
  weatherApplyCityOffset: { default: 0,    min: 0,    max: 1,    label: "Apply city_offset to forecast", step: 1,     unit: "bool", category: "weather", group: "Forecast pipeline" },
  weatherUseEnsemble:     { default: 0,    min: 0,    max: 1,    label: "Use 31-member GFS ensemble",    step: 1,     unit: "bool", category: "weather", group: "Forecast pipeline" },
  weatherCronEnabled:     { default: 0,    min: 0,    max: 1,    label: "Enable scheduled cron runs",    step: 1,     unit: "bool", category: "weather", group: "Scheduling" },
};

type Overrides = Partial<Record<keyof typeof SCHEMA, number>>;

// ─── Validate + clamp incoming POST body ──────────────────────────────

function validate(body: unknown): { ok: true; overrides: Overrides } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "body must be a JSON object" };
  const out: Overrides = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!(k in SCHEMA)) continue; // ignore unknown keys silently
    const spec = SCHEMA[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, reason: `${k}: must be a finite number` };
    }
    const clamped = Math.max(spec.min, Math.min(spec.max, v));
    out[k as keyof typeof SCHEMA] = clamped;
  }
  return { ok: true, overrides: out };
}

// ─── Public helpers used by other functions ───────────────────────────

export async function loadRuntimeOverrides(): Promise<Overrides> {
  try {
    const store = getStore(STORE_NAME);
    const raw = await store.get(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw as string);
    return parsed?.overrides ?? {};
  } catch {
    return {};
  }
}

// ─── HTTP handler ─────────────────────────────────────────────────────

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // GET: return defaults + (if authed) saved overrides
  if (req.method === "GET") {
    const auth = await checkAuth(req);
    const overrides = auth.ok ? await loadRuntimeOverrides() : {};
    const env = getTraderConfig();
    const btc = getBtcExitConfig();
    // Build the effective view dynamically: every key in SCHEMA falls back to
    // its env default (where one exists) or the schema default. This avoids
    // the "added a knob and forgot to expose it" footgun and makes adding new
    // weather/crypto/etc. fields a one-line change in SCHEMA.
    const envByKey: Record<string, number | undefined> = {
      edgeThreshold:         env.edgeThreshold,
      maxKellyFraction:      env.maxKellyFraction,
      cooldownSeconds:       env.cooldownSeconds,
      sessionLossLimit:      env.sessionLossLimit,
      btcTpTarget:           btc.tpTarget,
      btcSlTarget:           btc.slTarget,
      btcEntryWindowStartMs: btc.entryWindowStartMs,
      btcEntryWindowEndMs:   btc.entryWindowEndMs,
      btcHoldToEndCutoffMs:  btc.holdToEndCutoffMs,
    };
    const effective: Record<string, number> = {};
    for (const [k, spec] of Object.entries(SCHEMA)) {
      effective[k] = (overrides as any)[k] ?? envByKey[k] ?? spec.default;
    }
    return new Response(
      JSON.stringify({ ok: true, schema: SCHEMA, effective, overrides, authed: auth.ok }),
      { status: 200, headers: CORS },
    );
  }

  // POST / DELETE: require auth
  const auth = await checkAuth(req);
  if (!auth.ok) return auth.error;

  if (req.method === "DELETE") {
    try {
      const store = getStore(STORE_NAME);
      await store.delete(KEY);
    } catch {}
    return new Response(JSON.stringify({ ok: true, reset: true }), { status: 200, headers: CORS });
  }

  if (req.method === "POST") {
    let body: unknown;
    try { body = await req.json(); }
    catch { return new Response(JSON.stringify({ ok: false, reason: "bad_json" }), { status: 400, headers: CORS }); }
    const v = validate(body);
    if (!v.ok) return new Response(JSON.stringify({ ok: false, reason: v.reason }), { status: 400, headers: CORS });

    const existing = await loadRuntimeOverrides();
    const merged = { ...existing, ...v.overrides };
    try {
      const store = getStore(STORE_NAME);
      await store.set(
        KEY,
        JSON.stringify({ overrides: merged, savedAt: new Date().toISOString() }),
      );
    } catch (err: any) {
      return new Response(JSON.stringify({ ok: false, reason: `blobs_error: ${err.message}` }), {
        status: 500, headers: CORS,
      });
    }
    return new Response(JSON.stringify({ ok: true, overrides: merged }), { status: 200, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: false, reason: "method_not_allowed" }), {
    status: 405, headers: CORS,
  });
}
