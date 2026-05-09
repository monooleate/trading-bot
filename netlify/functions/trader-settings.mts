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
  help?: string;            // one-sentence explanation rendered as tooltip + inline hint
}

const SCHEMA: Record<string, FieldSpec> = {
  edgeThreshold:        { default: 0.15,    min: 0.02,    max: 0.30,    label: "Edge threshold (net)",       step: 0.005, unit: "frac",  category: "crypto", group: "Risk & sizing", help: "Csak akkor lép be az auto-trader, ha a kombinált predikció és piaci ár közti |edge| (a 3.6% roundtrip fee után) ≥ ez az érték. Magasabb = kevesebb, de jobb minőségű trade." },
  maxKellyFraction:     { default: 0.08,    min: 0.01,    max: 0.25,    label: "Max Kelly fraction",         step: 0.005, unit: "frac",  category: "crypto", group: "Risk & sizing", help: "Egy trade max ekkora bankroll-aránya. A binary piacokon a master-plan 8% hard cap-et javasol; magasabbra állítani csak akkor érdemes ha az IC-d > 0.10." },
  cooldownSeconds:      { default: 300,     min: 30,      max: 3600,    label: "Cooldown per market",        step: 30,    unit: "sec",   category: "crypto", group: "Risk & sizing", help: "Ugyanazon a piacon (slug) hány másodpercet kell várni két entry között. Megakadályozza a re-entry spam-et ha gyors a cron." },
  sessionLossLimit:     { default: 20,      min: 5,       max: 1000,    label: "Session loss limit",         step: 5,     unit: "USD",   category: "crypto", group: "Risk & sizing", help: "Ha a session összesített VESZTESÉG-e (csak a vesztes trade-ek abszolút USD-je) eléri ezt → automatikus stop. Reset-tel indítható újra." },
  btcTpTarget:          { default: 0.75,    min: 0.55,    max: 0.95,    label: "BTC short-market TP",        step: 0.01,  unit: "price", category: "crypto", group: "BTC short-market exit", help: "Take-profit ár: ha a pozíció oldali ár eléri ezt, lezárjuk. 0.75 = 75¢ — a master-plan 5m piacokon átlag $19 helyett $52 veszteséget ment meg." },
  btcSlTarget:          { default: 0.35,    min: 0.05,    max: 0.45,    label: "BTC short-market SL",        step: 0.01,  unit: "price", category: "crypto", group: "BTC short-market exit", help: "Stop-loss ár: ha a pozíció oldali ár ez alá esik, lezárjuk. Élesben szigorúan SL nélkül NE menj — a 5m piacok gyorsan $0-ra eshetnek." },
  btcEntryWindowStartMs:{ default: 60000,   min: 0,       max: 600000,  label: "Entry window start",         step: 5000,  unit: "ms",    category: "crypto", group: "BTC short-market exit", help: "A market megnyitása után mennyi ms-tól léphetünk be. <60s = retail zaj és pánik, ne lépj be." },
  btcEntryWindowEndMs:  { default: 180000,  min: 30000,   max: 900000,  label: "Entry window end",           step: 5000,  unit: "ms",    category: "crypto", group: "BTC short-market exit", help: "Meddig léphetünk be a megnyitás után. >180s a 5m piacon = nem lesz idő exitálni TP/SL hit nélkül." },
  btcHoldToEndCutoffMs: { default: 60000,   min: 10000,   max: 300000,  label: "Hold-to-end cutoff",         step: 5000,  unit: "ms",    category: "crypto", group: "BTC short-market exit", help: "Ha kevesebb mint ennyi ms van resolution-ig, NE zárjuk a pozíciót — hagyjuk lejárni (a Polymarket settles-en pörög le)." },
  obImbalanceUpRatio:   { default: 1.80,    min: 1.10,    max: 5.00,    label: "OB imbalance UP threshold",  step: 0.05,  unit: "ratio", category: "crypto", group: "OB imbalance", help: "Binance top-10 bid/ask depth ratio. Felette → UP irány konfirmált. Magasabb = szigorúbb konvergencia, kevesebb trade." },
  obImbalanceDownRatio: { default: 0.55,    min: 0.20,    max: 0.95,    label: "OB imbalance DOWN threshold",step: 0.05,  unit: "ratio", category: "crypto", group: "OB imbalance", help: "Bid/ask ratio alsó küszöb. Alatta → DOWN irány konfirmált. 0.55 = kb. inverze az UP threshold-nak (1/1.8)." },
  paperFallbackAfterMs: { default: 1800000, min: 60000,   max: 21600000,label: "Paper resolver fallback delay", step: 60000, unit: "ms",   category: "crypto", group: "Paper resolver", help: "Mennyi időt várunk a tényleges Polymarket resolution-re a market endDate után, mielőtt a Brownian-bridge szimulátorra esünk vissza. Hosszabb = realisztikusabb paper PnL, de később zárul." },
  paperBrownianSigma:   { default: 0.45,    min: 0.10,    max: 1.50,    label: "Brownian σ per √min",        step: 0.05,  unit: "σ",     category: "crypto", group: "Paper resolver", help: "A finalProb-tól FÜGGETLEN random-walk σ-ja. 0.45 / √min ~ a Polymarket BTC 5m piacok empirikus volatilitása. Magasabb = nagyobb pnl-szórás." },
  btcMinPriceBand:      { default: 0.10,    min: 0.02,    max: 0.30,    label: "Min YES price (deep-OTM cut)", step: 0.01, unit: "frac", category: "crypto", group: "Market finder", help: "Az olyan piacokat skippeljük, ahol a YES ár 0.10 alatt vagy 0.90 felett van — ezeken a depth alig 1-2 share, nem realisztikus paper-ben filltetni. A 141 paper trade $0.01 entry probléma fő javítása." },
  // ─── Live-readiness gates (apply to every trader) ──────────────
  // The cron loop refuses to honor PAPER_MODE=false until a session has
  // accumulated enough validated paper data. Every trader (crypto,
  // weather, hyperliquid, funding-arb) reads these knobs from the same
  // store, so a single tuning surface drives the live-go decision.
  liveReadyMinTrades:      { default: 30,   min: 10,   max: 300,  label: "Min closed trades",         step: 5,    unit: "n",     category: "common", group: "Live readiness", help: "Minimum lezárt paper trade-ek száma, amik kellenek a live aktiváláshoz. 30 = statisztikailag értelmes, 100+ = magas konfidencia." },
  liveReadyMinWinRate:     { default: 0.50, min: 0.30, max: 0.80, label: "Min win rate",              step: 0.01, unit: "frac",  category: "common", group: "Live readiness", help: "Minimum win-ráta a paper történetben. 0.50 = positive expectancy minimum (a fees miatt valójában >0.52 kell hogy a stratégia valós profitot termeljen)." },
  liveReadyMinIC:          { default: 0.05, min: 0.01, max: 0.30, label: "Min top-signal |IC|",       step: 0.01, unit: "frac",  category: "common", group: "Live readiness", help: "A legmagasabb |IC| signal Pearson-korrelációja a tényleges win/loss kimenetelekkel. 0.05 = értelmes prediktív erő, 0.10+ = erős. Csak crypto + weather-re alkalmazható (funding-arb rate-driven)." },
  liveReadyMaxCalibDev:    { default: 0.07, min: 0.01, max: 0.30, label: "Max calibration deviation", step: 0.01, unit: "frac",  category: "common", group: "Live readiness", help: "A predicted-prob és tényleges-win-rate átlagos eltérése bucket-enként. <0.07 = a model jól kalibrált. Csak crypto + weather-re." },
  liveReadyMinSharpe:      { default: 0.5,  min: 0,    max: 5.0,  label: "Min Sharpe ratio",          step: 0.05, unit: "ratio", category: "common", group: "Live readiness", help: "Per-trade kockázat-igazított hozam minimum. 0.5 = elfogadható, 1.0+ = jó, 2.0+ = kiváló (általában gyanús kis mintán)." },
  liveReadyMaxDrawdownPct: { default: 25,   min: 5,    max: 80,   label: "Max drawdown %",            step: 1,    unit: "pct",   category: "common", group: "Live readiness", help: "Maximum megengedett drawdown a kezdő bankrollhoz képest. >25% = a stratégia túl volatilis a live-hoz, csökkenteni kell a Kelly fraction-t vagy szigorítani a signal filtereket." },
  // ─── Weather trader knobs ──────────────────────────────────────
  weatherEdgeThreshold:   { default: 0.12, min: 0.02, max: 0.40, label: "Edge threshold (net)",          step: 0.005, unit: "frac", category: "weather", group: "Risk & sizing", help: "A weather predikció és a Polymarket-ár közti |edge| minimum, amitől entry-zünk. Alacsonyabb mint a crypto-é mert a hőmérséklet predikció pontosabb." },
  weatherConfidenceMin:   { default: 0.65, min: 0.30, max: 0.95, label: "Min model confidence",          step: 0.01,  unit: "frac", category: "weather", group: "Risk & sizing", help: "A 31-tagú GFS ensemble vagy a single-run forecast confidence-e (mennyire egységes a tagok jóslata). Alatta skippeljük a piacot." },
  weatherExitBeforeMin:   { default: 45,   min: 10,   max: 240,  label: "Exit-before window",            step: 5,     unit: "min",  category: "weather", group: "Risk & sizing", help: "Hány perccel a market lezárása előtt nem indítunk új pozíciót (slippage és exit nehezedik a végén)." },
  weatherMaxPositionUSD:  { default: 25,   min: 5,    max: 500,  label: "Max position size",             step: 5,     unit: "USD",  category: "weather", group: "Risk & sizing", help: "Egy weather trade max USD értéke. Konzervatív ($25 default) mert a weather edge sokszor nagyobb mint a binary 8% Kelly cap engedne." },
  weatherMaxEdgeCap:      { default: 0.40, min: 0.10, max: 0.95, label: "Max-edge sanity cap",           step: 0.01,  unit: "frac", category: "weather", group: "Risk & sizing", help: "Ha az edge számítás >40%-ot ad, akkor valószínűleg számolási hiba (pl. rossz station temp). Cap-elem hogy ne tegyünk irreális pozíciót." },
  weatherForecastDays:    { default: 0,    min: 0,    max: 7,    label: "forecast_days (0 = auto)",      step: 1,     unit: "days", category: "weather", group: "Forecast pipeline", help: "Mennyi napra előre kérjük le a forecast-ot. 0 = auto (a piac endDate alapján számolva). Manual override csak teszteléshez." },
  weatherApplyCityOffset: { default: 0,    min: 0,    max: 1,    label: "Apply city_offset to forecast", step: 1,     unit: "bool", category: "weather", group: "Forecast pipeline", help: "Bekapcsolva: a tényleges station vs. lakossági centroid közti hőmérséklet-eltolás (pl. KLGA → NYC) alkalmazza. Nemzetközi piacokon is fontos." },
  weatherUseEnsemble:     { default: 0,    min: 0,    max: 1,    label: "Use 31-member GFS ensemble",    step: 1,     unit: "bool", category: "weather", group: "Forecast pipeline", help: "Bekapcsolva: 31 GFS ensemble tag → P(YES) = (hány tag jósol >= threshold) / 31. Kikapcsolva: csak a control run. Master-plan szerint +15-20% pontosság ensemble-lel." },
  weatherCronEnabled:     { default: 0,    min: 0,    max: 1,    label: "Enable scheduled cron runs",    step: 1,     unit: "bool", category: "weather", group: "Scheduling", help: "A weather auto-trader-weather-cron 5 percenként fut, de csak akkor csinál bármit ha ez a toggle BE van kapcsolva. Default OFF — biztonsági ráhagyás." },
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
