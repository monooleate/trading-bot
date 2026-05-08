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

interface FieldSpec {
  default: number;
  min: number;
  max: number;
  label: string;
  step: number;
  unit: string;
}

const SCHEMA: Record<string, FieldSpec> = {
  edgeThreshold:        { default: 0.15,    min: 0.02,    max: 0.30,    label: "Edge threshold (net)",      step: 0.005, unit: "frac" },
  maxKellyFraction:     { default: 0.08,    min: 0.01,    max: 0.25,    label: "Max Kelly fraction",        step: 0.005, unit: "frac" },
  cooldownSeconds:      { default: 300,     min: 30,      max: 3600,    label: "Cooldown per market",       step: 30,    unit: "sec" },
  sessionLossLimit:     { default: 20,      min: 5,       max: 1000,    label: "Session loss limit",        step: 5,     unit: "USD" },
  btcTpTarget:          { default: 0.75,    min: 0.55,    max: 0.95,    label: "BTC short-market TP",       step: 0.01,  unit: "price" },
  btcSlTarget:          { default: 0.35,    min: 0.05,    max: 0.45,    label: "BTC short-market SL",       step: 0.01,  unit: "price" },
  btcEntryWindowStartMs:{ default: 60000,   min: 0,       max: 600000,  label: "Entry window start",        step: 5000,  unit: "ms" },
  btcEntryWindowEndMs:  { default: 180000,  min: 30000,   max: 900000,  label: "Entry window end",          step: 5000,  unit: "ms" },
  btcHoldToEndCutoffMs: { default: 60000,   min: 10000,   max: 300000,  label: "Hold-to-end cutoff",        step: 5000,  unit: "ms" },
  // P1.3 OB imbalance (A.4): persisted up-front so the UI can adjust them once the signal lands
  obImbalanceUpRatio:   { default: 1.80,    min: 1.10,    max: 5.00,    label: "OB imbalance UP threshold",  step: 0.05,  unit: "ratio" },
  obImbalanceDownRatio: { default: 0.55,    min: 0.20,    max: 0.95,    label: "OB imbalance DOWN threshold",step: 0.05,  unit: "ratio" },
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
    const effective = {
      edgeThreshold:         overrides.edgeThreshold        ?? env.edgeThreshold,
      maxKellyFraction:      overrides.maxKellyFraction     ?? env.maxKellyFraction,
      cooldownSeconds:       overrides.cooldownSeconds      ?? env.cooldownSeconds,
      sessionLossLimit:      overrides.sessionLossLimit     ?? env.sessionLossLimit,
      btcTpTarget:           overrides.btcTpTarget          ?? btc.tpTarget,
      btcSlTarget:           overrides.btcSlTarget          ?? btc.slTarget,
      btcEntryWindowStartMs: overrides.btcEntryWindowStartMs ?? btc.entryWindowStartMs,
      btcEntryWindowEndMs:   overrides.btcEntryWindowEndMs   ?? btc.entryWindowEndMs,
      btcHoldToEndCutoffMs:  overrides.btcHoldToEndCutoffMs  ?? btc.holdToEndCutoffMs,
      obImbalanceUpRatio:    overrides.obImbalanceUpRatio   ?? SCHEMA.obImbalanceUpRatio.default,
      obImbalanceDownRatio:  overrides.obImbalanceDownRatio ?? SCHEMA.obImbalanceDownRatio.default,
    };
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
