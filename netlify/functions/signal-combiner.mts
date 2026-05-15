// netlify/functions/signal-combiner.mts
// GET /.netlify/functions/signal-combiner?slug=us-x-iran-ceasefire-by-april-30
// GET /.netlify/functions/signal-combiner  (auto: top volume piac)
//
// Fundamental Law of Active Management: IR = IC × √N
// Market-specific: minden signal az adott piacra fut
// Output: combined_probability, kelly_fraction, BUY YES/NO/WAIT ajánlás

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  analyseResolutionRisk,
  applyResolutionAdjustment,
  type MarketMeta,
  type ResolutionRiskScore,
} from "./_resolution-risk.js";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const GAMMA    = "https://gamma-api.polymarket.com";
const CLOB     = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const CACHE_TTL = 3 * 60 * 1000;

const SIGNAL_ICS: Record<string, number> = {
  vol_divergence: 0.06,
  orderflow:      0.09,
  apex_consensus: 0.08,
  cond_prob:      0.07,
  funding_rate:   0.05,
  momentum:       0.06,  // Kakushadze 3.1: price momentum (Jegadeesh & Titman 1993)
  contrarian:     0.05,  // Kakushadze 10.3: mean-reversion vs market index (Wang & Yu 2004)
  pairs_spread:   0.07,  // Kakushadze 3.8: pairs Z-score on related markets
};

// ─── Market info type ─────────────────────────────────────────────────────────
interface MarketInfo {
  question:         string;
  slug:             string;
  conditionId:      string;
  yesTokenId:       string;
  noTokenId:        string;
  yesPrice:         number;
  noPrice:          number;
  volume24h:        number;
  endDate:          string;
  url:              string;
  // Extra fields for resolution-risk analysis
  rules:            string;
  resolutionSource: string;
  category:         string;
  closed:           boolean;
}

// ─── Helpers shared by both resolution paths ─────────────────────────────────

// Parse the YES / NO clob token IDs from a Gamma market object. The Gamma
// API consistently returns `clobTokenIds` as a JSON-encoded string (e.g.
// '["123…", "456…"]') and does NOT include a top-level `tokens` array on the
// markets endpoint — even though the legacy code path expected one. We keep
// the `tokens` fallback for forward compatibility in case the API ever
// surfaces it, but in practice every modern Polymarket market goes through
// the clobTokenIds JSON-string branch.
function parseTokenIds(m: any): { yesTokenId: string; noTokenId: string } | null {
  // Preferred path — clobTokenIds is the documented field.
  if (m.clobTokenIds) {
    try {
      const ids = typeof m.clobTokenIds === "string"
        ? JSON.parse(m.clobTokenIds)
        : m.clobTokenIds;
      if (Array.isArray(ids) && ids.length >= 2 && ids[0] && ids[1]) {
        return { yesTokenId: String(ids[0]), noTokenId: String(ids[1]) };
      }
    } catch { /* fall through */ }
  }
  // Forward-compatible fallback — if Gamma ever returns a tokens array.
  if (Array.isArray(m.tokens) && m.tokens.length >= 2) {
    const yes = m.tokens.find((t: any) => (t.outcome || "").toUpperCase() === "YES");
    const no  = m.tokens.find((t: any) => (t.outcome || "").toUpperCase() === "NO");
    const a = yes?.token_id ?? m.tokens[0]?.token_id;
    const b = no?.token_id  ?? m.tokens[1]?.token_id;
    if (a && b) return { yesTokenId: String(a), noTokenId: String(b) };
  }
  return null;
}

function parseYesNoPrices(m: any): { yp: number; np: number } {
  try {
    const op = typeof m.outcomePrices === "string"
      ? JSON.parse(m.outcomePrices)
      : m.outcomePrices;
    if (Array.isArray(op) && op.length >= 2) {
      const yp = parseFloat(op[0]);
      const np = parseFloat(op[1]);
      if (Number.isFinite(yp) && Number.isFinite(np)) return { yp, np };
    }
  } catch { /* fall through */ }
  return { yp: 0.5, np: 0.5 };
}

// Resolve a market by its market slug (e.g. "bitcoin-above-80k-on-may-9").
// Returns null if no live market matches. The Gamma `/markets?slug=` endpoint
// returns an array; the market object also carries an `events` array whose
// first entry yields the event slug for URL building.
async function resolveByMarketSlug(slug: string): Promise<MarketInfo | null> {
  try {
    const r = await fetch(
      `${GAMMA}/markets?slug=${encodeURIComponent(slug)}&limit=1`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return null;
    const data: any = await r.json();
    const list: any[] = Array.isArray(data) ? data : [];
    const m = list[0];
    if (!m) return null;
    if (m.closed === true) return null;
    if (m.endDate && new Date(m.endDate).getTime() < Date.now()) return null;

    const tokens = parseTokenIds(m);
    if (!tokens) return null;
    const { yp, np } = parseYesNoPrices(m);

    const eventSlug = Array.isArray(m.events) && m.events[0]?.slug
      ? String(m.events[0].slug)
      : "";
    const eventDescription = Array.isArray(m.events) && m.events[0]?.description
      ? String(m.events[0].description)
      : "";
    const tags = (Array.isArray(m.events) && m.events[0]?.tags) || m.tags || [];
    const catRaw = Array.isArray(tags) && tags[0]
      ? ((typeof tags[0] === "object" ? tags[0].label : tags[0]) || "").toString()
      : "";

    const marketSlug = String(m.slug || slug);
    return {
      question:         String(m.question || m.title || ""),
      slug:             marketSlug,
      conditionId:      String(m.conditionId || m.id || ""),
      yesTokenId:       tokens.yesTokenId,
      noTokenId:        tokens.noTokenId,
      yesPrice:         yp,
      noPrice:          np,
      volume24h:        parseFloat(m.volume24hr || m.volume || "0") || 0,
      endDate:          String(m.endDate || ""),
      url: eventSlug
        ? `https://polymarket.com/event/${eventSlug}/${marketSlug}`
        : `https://polymarket.com/market/${marketSlug}`,
      rules:            String(m.description || eventDescription || ""),
      resolutionSource: String(m.resolutionSource || ""),
      category:         catRaw,
      closed:           !!m.closed,
    };
  } catch { return null; }
}

// ─── Resolve market from slug or auto-pick top volume ─────────────────────────
async function resolveMarket(slug?: string): Promise<MarketInfo | null> {
  try {
    // FAST PATH — try market-slug lookup first. The auto-trader's signal
    // aggregator passes a *market* slug (e.g. "bitcoin-above-80k-on-may-9"),
    // not an event slug; the legacy events lookup below would return 0
    // hits for those and the function used to 404. The /markets?slug=
    // endpoint resolves the exact market in one call and exposes the
    // parent event slug for URL building.
    if (slug) {
      const fast = await resolveByMarketSlug(slug);
      if (fast) return fast;
    }

    // Use events API for correct event_slug → URL mapping
    const eventsUrl = slug
      ? `${GAMMA}/events?slug=${encodeURIComponent(slug.replace(/-\d+$/, ""))}&limit=5`
      : `${GAMMA}/events?limit=5&order=volume24hr&ascending=false&active=true`;
    const evRes = await fetch(eventsUrl, { signal: AbortSignal.timeout(6000) });
    if (!evRes.ok) return null;
    const events: any[] = await evRes.json().then(d => Array.isArray(d) ? d : []);

    // If slug search returned nothing, try top events
    if (events.length === 0 && slug) {
      const fallback = await fetch(`${GAMMA}/events?limit=10&order=volume24hr&ascending=false&active=true`, { signal: AbortSignal.timeout(6000) });
      if (fallback.ok) {
        const all: any[] = await fallback.json().then(d => Array.isArray(d) ? d : []);
        // Search within all event markets for matching slug
        for (const evt of all) {
          for (const m of (evt.markets || [])) {
            if ((m.slug || "").includes(slug.replace(/-\d+$/, "").slice(0, 15))) {
              events.push(evt);
              break;
            }
          }
          if (events.length > 0) break;
        }
      }
    }

    // Find the right market within events (skip closed/expired)
    for (const evt of events) {
      const eventSlug = evt.slug || "";
      for (const m of (evt.markets || [])) {
        if (m.closed === true) continue;
        if (m.endDate && new Date(m.endDate).getTime() < Date.now()) continue;
        // If specific slug requested, match it
        if (slug && !(m.slug || "").includes(slug.replace(/-\d+$/, "").slice(0, 15))) continue;

        // Parse tokens
        let yesToken: any = null, noToken: any = null;
        if (m.tokens?.length > 0) {
          yesToken = m.tokens.find((t: any) => (t.outcome || "").toUpperCase() === "YES");
          noToken  = m.tokens.find((t: any) => (t.outcome || "").toUpperCase() === "NO");
        }
        if (!yesToken?.token_id && m.clobTokenIds) {
          try {
            const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
            if (ids.length >= 2) { yesToken = { token_id: ids[0] }; noToken = { token_id: ids[1] }; }
          } catch {}
        }
        if (!yesToken?.token_id) continue;

        let yp = 0.5, np = 0.5;
        try {
          const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          if (Array.isArray(op) && op.length >= 2) { yp = parseFloat(op[0]); np = parseFloat(op[1]); }
        } catch {}

        const marketSlug = m.slug || "";
        const tags = evt.tags || m.tags || [];
        const catRaw = Array.isArray(tags) && tags[0]
          ? ((typeof tags[0] === "object" ? tags[0].label : tags[0]) || "").toString()
          : "";
        return {
          question:         m.question || m.title || evt.title || "",
          slug:             marketSlug,
          conditionId:      m.id || m.conditionId || "",
          yesTokenId:       yesToken.token_id,
          noTokenId:        noToken?.token_id || "",
          yesPrice:         yp,
          noPrice:          np,
          volume24h:        parseFloat(m.volume24hr || m.volume || 0),
          endDate:          m.endDate || "",
          url:              eventSlug && marketSlug
            ? `https://polymarket.com/event/${eventSlug}/${marketSlug}`
            : eventSlug
              ? `https://polymarket.com/event/${eventSlug}`
              : "",
          rules:            m.description || evt.description || "",
          resolutionSource: m.resolutionSource || "",
          category:         catRaw,
          closed:           !!m.closed,
        };
      }
    }
    return null;
  } catch { return null; }
}

// ─── Price data with geo-block fallback ───────────────────────────────────────
async function fetchCloses(limit: number): Promise<number[]> {
  // 1. Binance Futures
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) { const k = await r.json() as any[][]; return k.map(c => parseFloat(c[4])); }
  } catch {}
  // 2. CoinGecko OHLC
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=1`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const d = await r.json() as number[][]; return d.slice(-limit).map(c => c[4]); }
  } catch {}
  // 3. CryptoCompare
  try {
    const r = await fetch(`https://min-api.cryptocompare.com/data/v2/histominute?fsym=BTC&tsym=USD&limit=${limit}`, { signal: AbortSignal.timeout(6000) });
    if (r.ok) { const d = await r.json() as any; return (d.Data?.Data || []).map((c: any) => c.close); }
  } catch {}
  return [];
}

// ─── 1. VOL DIVERGENCE SIGNAL — Black-Scholes digital option pricing ─────────
//
// 2026-05-11 (Tier 1) redesign: a korábbi képlet (`iv = 2|yp−0.5|/√T × 100`)
// nem volt érvényes Black-Scholes implied vol — egy önkényes mapping ami a
// YES árat kvázi-újraskálázta IV-be. Short horizonton degenerált
// (1h-os gate kellett, 30. session A-fix), és az output [0.1, 0.9]
// clamp-elt normalizált zaj volt, nem fair value.
//
// Új megközelítés: a Polymarket BTC up/down piacok matematikailag
// **digitális call opciók** — payoff $1 ha S(T) > K, $0 ha S(T) ≤ K. A
// Black-Scholes digital pricing zárt formában létezik:
//
//     fair YES = N(d₂),   d₂ = [ln(S/K) − σ²/2 · T] / (σ · √T)
//
// ahol:
//   • S = current BTC spot price
//   • K = reference / strike price (a piac kezdetekor érvényes BTC ár)
//   • T = idő a resolution-ig (years)
//   • σ = realized vol annualizált
//
// Output: a `prob` MOST a fair YES price közvetlenül (nem önkényes score) —
// a signal-combiner ezt 0–1 között súlyozza a többi 7 signal-lal, és a
// `signal-aggregator` ezt veti össze a market YES árához mint edge.
//
// A short-horizon gate eltűnik: a d₂ képlet T → 0 limit-en jól viselkedik,
// és a 1h gate csak az előző (helytelen) formula degenerációja miatt
// kellett. Az új signal a 5m/15m BTC piacokon is érvényes jelet ad.

// Standard normal CDF (Abramowitz & Stegun 26.2.17 approximation, max
// error ≈ 7.5e-8). Minden bemeneten finite output, két oldali szimmetria.
function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return 0.5;
  const absZ = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absZ);
  const pdf = Math.exp(-0.5 * absZ * absZ) / Math.sqrt(2 * Math.PI);
  const poly =
    0.319381530 * t -
    0.356563782 * t * t +
    1.781477937 * t * t * t -
    1.821255978 * t * t * t * t +
    1.330274429 * t * t * t * t * t;
  const cdf = 1 - pdf * poly;
  return z >= 0 ? cdf : 1 - cdf;
}

// Slug-based threshold K-parser for `bitcoin-above-Nk-on-...` markets.
// These markets pay $1 if BTC > $N×1000 at resolution — so the strike
// price is LITERALLY $N×1000, not the spot at market-open. Without this
// parser the vol_divergence signal falls back to K=S (or openedAt-fetched
// K which only works for up-or-down markets), making d₂ ≈ −σ·√T/2 and
// fair YES ≈ 0.5 for ALL above-Nk markets regardless of N. The combiner
// then averages this near-noise output with 7 K-blind directional signals
// and outputs finalProb ≈ 0.5 ± small drift — the bot reads this as "huge
// edge" against the actual market price, opening contrarian trades on
// noise. Bug surfaced 2026-05-15 with 3 simultaneous contrarian trades
// on near-identical finalProb values (0.46, 0.47, 0.47 across 78K/80K/82K
// markets). Mirrors `parseBtcAboveSlug` in cross-position-gates.mts (kept
// duplicated to avoid the top-level ↔ auto-trader/ circular import).
function parseThresholdK(slug: string | undefined | null): number | null {
  if (!slug) return null;
  const m = String(slug).toLowerCase().match(
    /(?:bitcoin|btc)-(?:be-)?above-(\d+(?:\.\d+)?)k(?:-on-(.+?))?$/,
  );
  if (!m) return null;
  const kThousand = parseFloat(m[1]);
  if (!Number.isFinite(kThousand) || kThousand <= 0) return null;
  return kThousand * 1000; // K in USD (78k → $78,000)
}

// Strike-price estimate: a BTC up/down piacok jellemzően a `openedAt`-kori
// BTC árhoz képest mérnek. Ha a piac kezdete kiszámítható (durationMs-ből),
// a referencia árat egy 1m Binance kline lekérdezéssel kapjuk meg arra a
// timestamp-re. Ha nincs durationMs (legacy / daily piacok), fallback a
// jelenlegi spot árra → d₂ ≈ −σ·√T/2 → fair YES ≈ 0.5 (semleges signal).
// 2026-05-15: az `above-Nk` piacokra a `parseThresholdK` veszi át (literal
// strike). Az up-or-down logika ezen kívül változatlan.
async function fetchBtcPriceAt(timestampMs: number): Promise<number | null> {
  try {
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&startTime=${timestampMs}&endTime=${
        timestampMs + 60_000
      }&limit=1`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!r.ok) return null;
    const k = (await r.json()) as any[][];
    if (!Array.isArray(k) || k.length === 0) return null;
    const close = parseFloat(k[0][4]);
    return Number.isFinite(close) ? close : null;
  } catch {
    return null;
  }
}

interface VolSignalOptions {
  /** Master kill-switch for the BS digital signal. Default true. */
  enabled?: boolean;
  /** Fetch the strike from Binance 1m kline at openedAt. If false, K=S
   *  fallback (ATM, signal ≈ 0.5). Saves 1 Binance call per signal. */
  strikeFetchEnabled?: boolean;
}

async function getVolSignal(
  market: MarketInfo,
  options: VolSignalOptions = {},
): Promise<{ prob: number | null; detail: any }> {
  // Master kill-switch: if disabled, return null so the combiner skips
  // this signal entirely (effectively reverts to the pre-Tier 1 7-signal
  // setup). Useful if the new BS pricing turns out to be IC-noise on the
  // user's market mix.
  if (options.enabled === false) {
    return { prob: null, detail: { skipped: "vol_divergence disabled via Settings" } };
  }
  const strikeFetchEnabled = options.strikeFetchEnabled !== false;
  try {
    // Time horizon (years) a resolution-ig. Negatív/nulla horizonton skip.
    let timeHours = 0.25; // default 15min — overridden below
    if (market.endDate) {
      const rem = (new Date(market.endDate).getTime() - Date.now()) / 3600000;
      if (!Number.isFinite(rem) || rem <= 0) {
        return { prob: null, detail: { skipped: "endDate in past or invalid", rem } };
      }
      if (rem > 720) {
        return { prob: null, detail: { skipped: "horizon > 30 days, BS not applicable", rem } };
      }
      timeHours = rem;
    }
    const T = timeHours / (365 * 24);

    // 1. Realized vol annualizált (jelenlegi RV15 logika érintetlen).
    const closes = await fetchCloses(20);
    if (closes.length < 5) return { prob: null, detail: { error: "no price data" } };
    const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    const sigmaAnnual = Math.sqrt(
      (returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length) * 365 * 24 * 60,
    );
    if (!Number.isFinite(sigmaAnnual) || sigmaAnnual <= 0) {
      return { prob: null, detail: { error: "sigma invalid", sigmaAnnual } };
    }

    // 2. Spot ár (S) — a legfrissebb close.
    const S = closes[closes.length - 1];
    if (!Number.isFinite(S) || S <= 0) return { prob: null, detail: { error: "spot invalid" } };

    // 3. Strike ár (K) — a piac kezdetekor érvényes BTC ár, ha tudjuk.
    //    `openedAtEstimate`-et a btc-market-finder számolja a durationMs-ből.
    //    Külső input itt: a MarketInfo-ban a `endDate` + signal-combiner
    //    saját parsing-jából csak az endDate van; az openedAt-et a
    //    durationMs-ből származtatjuk a kérdésből.
    let K = S; // fallback: ATM (signal ≈ 0.5)
    let strikeSource: "slug-threshold" | "fetched" | "spot-fallback" | "fetch-disabled" =
      "spot-fallback";
    // Priority 1: literal threshold from slug (above-Nk markets). This is
    // the most reliable K source because it's the market's resolution
    // criterion verbatim — no Binance round-trip needed, no openedAt
    // estimation error. Skips the fetch-disabled guard since slug parsing
    // is local + free.
    const thresholdK = parseThresholdK(market.slug);
    if (thresholdK !== null) {
      K = thresholdK;
      strikeSource = "slug-threshold";
    } else if (!strikeFetchEnabled) {
      strikeSource = "fetch-disabled";
    } else {
      // Priority 2 (up-or-down markets): K = BTC price at openedAt.
      const durationMs = parseDurationFromQuestion(market.question);
      if (durationMs && market.endDate) {
        const endTs = new Date(market.endDate).getTime();
        if (Number.isFinite(endTs)) {
          const openTs = endTs - durationMs;
          if (openTs < Date.now() && openTs > Date.now() - 24 * 60 * 60 * 1000) {
            const fetched = await fetchBtcPriceAt(openTs);
            if (fetched && fetched > 0) {
              K = fetched;
              strikeSource = "fetched";
            }
          }
        }
      }
    }

    // 4. Black-Scholes digital call: fair YES = N(d₂).
    //    r = 0 short horizonton (5m–48h, intra-day kamatlábat elhanyagoljuk).
    const sqrtT = Math.sqrt(T);
    const d2 = (Math.log(S / K) - 0.5 * sigmaAnnual * sigmaAnnual * T) / (sigmaAnnual * sqrtT);
    if (!Number.isFinite(d2)) {
      return { prob: null, detail: { error: "d2 non-finite", S, K, sigmaAnnual, T } };
    }
    const fairYes = normalCdf(d2);

    return {
      prob: fairYes,
      detail: {
        S: S.toFixed(2),
        K: K.toFixed(2),
        strikeSource,
        sigmaAnnual: (sigmaAnnual * 100).toFixed(1) + "%",
        timeHours: timeHours.toFixed(3),
        d2: d2.toFixed(3),
        fairYes: fairYes.toFixed(3),
        marketYes: market.yesPrice.toFixed(3),
        edge: (fairYes - market.yesPrice).toFixed(3),
      },
    };
  } catch (err: any) {
    return { prob: null, detail: { error: err?.message ?? "unknown" } };
  }
}

// Load the Tier 1 vol-signal toggles from the trader-settings Blobs store.
// Dynamic import + try/catch so a settings outage doesn't take down the
// signal combiner. Defaults match the hardcoded values: signal ON, strike
// fetch ON.
async function loadVolSignalOptions(): Promise<VolSignalOptions> {
  try {
    const mod: any = await import("./trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    return {
      enabled:            ov.volSignalEnabled      === undefined ? true : ov.volSignalEnabled === 1,
      strikeFetchEnabled: ov.volStrikeFetchEnabled === undefined ? true : ov.volStrikeFetchEnabled === 1,
    };
  } catch {
    return { enabled: true, strikeFetchEnabled: true };
  }
}

// Sprint 42A (2026-05-15): load the K-blind downweight knob from the
// trader-settings Blobs store. Default 1.0 (zero behavior change). The
// combiner uses this only on threshold (BTC-above-K) markets; on
// directional / up-or-down markets the value is ignored. Safe-fallback
// on any settings outage so the combiner never breaks.
async function loadKBlindDownweight(): Promise<number> {
  try {
    const mod: any = await import("./trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    if (typeof ov.combinerKBlindDownweight === "number" && Number.isFinite(ov.combinerKBlindDownweight)) {
      return Math.max(0, Math.min(1, ov.combinerKBlindDownweight));
    }
    return 1.0;
  } catch {
    return 1.0;
  }
}

// Duration parser — egyezik a btc-market-finder.mts logikájával, de ott a
// MarketInfo `question` mezőben van, itt is. Másolat hogy az import-cikkust
// elkerüljük (signal-combiner.mts top-level, auto-trader almodul → körutas).
function parseDurationFromQuestion(question: string): number | null {
  if (!question) return null;
  const q = question.toLowerCase();
  const re = /(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h)\b/;
  const match = q.match(re);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2];
  if (unit.startsWith("s")) return n * 1000;
  if (unit.startsWith("h")) return n * 60 * 60 * 1000;
  return n * 60 * 1000; // minutes
}

// ─── 2. ORDER FLOW SIGNAL ────────────────────────────────────────────────────
// Market-specific: az adott piac CLOB order book imbalance-a
async function getOrderflowSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    if (!market.yesTokenId) return { prob: null, detail: { note: "no token_id" } };

    const bookRes = await fetch(`${CLOB}/book?token_id=${market.yesTokenId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!bookRes.ok) return { prob: 0.5, detail: { note: "book unavailable" } };
    const book = await bookRes.json() as any;

    const bidVol = (book.bids || []).reduce((s: number, b: any) => s + parseFloat(b.size || 0), 0);
    const askVol = (book.asks || []).reduce((s: number, a: any) => s + parseFloat(a.size || 0), 0);
    const total  = bidVol + askVol;

    if (total === 0) {
      // Fallback: midpoint vs current price
      try {
        const midRes = await fetch(`${CLOB}/midpoint?token_id=${market.yesTokenId}`, { signal: AbortSignal.timeout(4000) });
        if (midRes.ok) {
          const midData = await midRes.json() as any;
          const mid = parseFloat(midData.mid || 0.5);
          const drift = mid - market.yesPrice;
          const prob = Math.max(0.1, Math.min(0.9, 0.5 + drift * 2));
          return { prob, detail: { mid, drift: drift.toFixed(3), source: "midpoint" } };
        }
      } catch {}
      return { prob: 0.5, detail: { note: "empty book" } };
    }

    const bidPct = bidVol / total;
    const prob   = Math.max(0.1, Math.min(0.9, 0.3 + bidPct * 0.4));
    return { prob, detail: { bid_pct: bidPct.toFixed(2), bid_vol: bidVol.toFixed(0), ask_vol: askVol.toFixed(0) } };
  } catch { return { prob: null, detail: null }; }
}

// ─── 3. APEX CONSENSUS SIGNAL ─────────────────────────────────────────────────
// Market-specific: top walletok trade-jeit szűri az adott piac conditionId-jára.
//
// Wallet ranking (2026-05-11 audit fix #C): a régi képlet a "PnL"-t úgy
// számolta, hogy `SELL → +cash`, `BUY → -cash`. Ez csak a CASH FLOW, NEM a
// realised PnL — egy 100% BUY wallet ami nyer a settlement-en is negatív
// "PnL"-t mutatott (mert a settlement-bevétel nem szerepel a /trades
// feedben). Így a "top 10" valójában a "top sellers" volt. Az új ranking
// a wallet **aktivitását** méri: total notional traded × distinct markets,
// ami a "honnan vannak az informált trader-ek" arányos proxy-ja. A
// részletes per-wallet PnL kalkuláció a /apex-wallets endpoint dolga
// (Tab 8) — ez a signal csak quick aggregate consensus.
async function getApexSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    const tradesRes = await fetch(
      `${DATA_API}/trades?limit=500&sortBy=TIMESTAMP&sortDirection=DESC`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!tradesRes.ok) return { prob: null, detail: null };
    const allTrades: any[] = await tradesRes.json().then(d => Array.isArray(d) ? d : []);
    if (!allTrades.length) return { prob: null, detail: null };

    // Aggregate activity per wallet — total notional + distinct markets.
    // Distinct-markets count is a better diversity proxy than raw trade
    // count (single-market spammers get filtered out by the multiplier).
    const walletMap: Record<string, { notional: number; markets: Set<string>; trades: any[] }> = {};
    for (const t of allTrades) {
      const addr = t.proxyWallet || t.maker || "";
      if (!addr) continue;
      if (!walletMap[addr]) walletMap[addr] = { notional: 0, markets: new Set(), trades: [] };
      const size  = parseFloat(t.size  || 0);
      const price = parseFloat(t.price || 0);
      walletMap[addr].notional += size * price;
      const cid = String(t.conditionId || t.market || "");
      if (cid) walletMap[addr].markets.add(cid);
      walletMap[addr].trades.push(t);
    }

    // Top 10 wallets by activity score = notional × √distinctMarkets.
    // √ shrinks the bonus so a wallet trading 100 markets isn't 10× a
    // wallet trading 10 markets — diminishing returns matches the
    // empirical "informed trader" pattern.
    const topWallets = Object.entries(walletMap)
      .map(([addr, w]) => ({
        addr,
        score: w.notional * Math.sqrt(w.markets.size),
        data: w,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((w) => [w.addr, w.data] as [string, { notional: number; markets: Set<string>; trades: any[] }]);

    // Filter trades for THIS market's conditionId
    const cid = market.conditionId;
    let marketBuys = 0, marketSells = 0, marketWallets = 0;
    for (const [, data] of topWallets) {
      const mktTrades = data.trades.filter((t: any) =>
        (t.conditionId || t.market || "") === cid
      );
      if (mktTrades.length > 0) {
        marketWallets++;
        for (const t of mktTrades) {
          if ((t.side || "").toUpperCase() === "BUY") marketBuys++;
          else marketSells++;
        }
      }
    }

    const total = marketBuys + marketSells;
    if (total === 0) {
      // No apex trades for this specific market → use global signal
      let globalBuys = 0, globalTotal = 0;
      for (const [, data] of topWallets.slice(0, 5)) {
        for (const t of data.trades.slice(0, 10)) {
          globalTotal++;
          if ((t.side || "").toUpperCase() === "BUY") globalBuys++;
        }
      }
      if (globalTotal === 0) return { prob: 0.5, detail: { note: "no data" } };
      const gBuyPct = globalBuys / globalTotal;
      return {
        prob: Math.max(0.1, Math.min(0.9, 0.5 + (gBuyPct - 0.5) * 0.3)),
        detail: { buy_pct: gBuyPct.toFixed(2), scope: "global", wallets: topWallets.length },
      };
    }

    const buyPct = marketBuys / total;
    const prob = Math.max(0.1, Math.min(0.9, 0.5 + (buyPct - 0.5) * 0.6));
    return {
      prob,
      detail: {
        buy_pct: buyPct.toFixed(2),
        buys: marketBuys, sells: marketSells,
        apex_wallets: marketWallets,
        scope: "market-specific",
      },
    };
  } catch { return { prob: null, detail: null }; }
}

// ─── 4. CONDITIONAL PROBABILITY SIGNAL ────────────────────────────────────────
// Market-specific: az adott piac complement check + related markets monotonicity.
//
// Direction-aware violation (2026-05-11 audit fix #D): a régi kód a
// `violationDir`-t csak a complement-check előjeléből származtatta, és
// a monoton-violation magnitúdóját VAKON adta hozzá. Két különböző
// violation-irány kioltása NEM működött — egy "YES overpriced via
// complement" + "YES underpriced via earlier related" nettó signed
// 0-ra konvergált volna a helyes képletben, de a régi kódban az
// abszolút értékeket összeadta. Most:
//
//   - complementDir = ha complement > 1 → YES overpriced → -1 (NO bias)
//                     ha complement < 1 → YES underpriced → +1 (YES bias)
//   - monotonDir:   per-related-market signed contribution
//   - netDir × magnitude → signed shift a 0.5-ről
async function getCondProbSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    // 1. Complement check for THIS market — signed
    const complement = market.yesPrice + market.noPrice;
    const dev = complement - 1.0;
    // dev > 0 (YES+NO > 1) → YES overpriced → NO bias (−1)
    // dev < 0 (YES+NO < 1) → YES underpriced → YES bias (+1)
    const complementSigned = -dev;  // signed contribution toward p(YES)

    // 2. Search related markets for monotonicity violations
    const q = market.question.toLowerCase();
    const keywords = q.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
    let monotonSigned = 0;  // signed contribution from related markets
    let monotonAbsSum = 0;  // for detail display only
    let relatedCount = 0;

    if (keywords.length > 0) {
      try {
        const mRes = await fetch(
          `${GAMMA}/markets?active=true&closed=false&limit=30&order=volume24hr&ascending=false`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (mRes.ok) {
          const mData = await mRes.json() as any;
          const all = Array.isArray(mData) ? mData : (mData.markets || []);
          const related = all.filter((m: any) => {
            if (m.slug === market.slug) return false;
            const mq = (m.question || "").toLowerCase();
            return keywords.some(kw => mq.includes(kw));
          });

          for (const r of related.slice(0, 5)) {
            try {
              const op = typeof r.outcomePrices === "string" ? JSON.parse(r.outcomePrices) : r.outcomePrices;
              const rYes = parseFloat(op?.[0] || 0.5);
              relatedCount++;
              // Monotonicity: P(YES by earlier deadline) ≤ P(YES by later deadline).
              // Each violation contributes a SIGNED nudge toward the correct direction.
              if (r.endDate && market.endDate) {
                const rEnd = new Date(r.endDate).getTime();
                const mEnd = new Date(market.endDate).getTime();
                if (rEnd < mEnd && rYes > market.yesPrice + 0.03) {
                  // Earlier related > our YES → our YES underpriced → +1
                  const violation = rYes - market.yesPrice;
                  monotonSigned += violation;
                  monotonAbsSum += violation;
                } else if (rEnd > mEnd && rYes < market.yesPrice - 0.03) {
                  // Later related < our YES → our YES overpriced → -1
                  const violation = market.yesPrice - rYes;
                  monotonSigned -= violation;
                  monotonAbsSum += violation;
                }
              }
            } catch {}
          }
        }
      } catch {}
    }

    // Net signed signal — direction emerges from the SUM, not from a
    // single component. Magnitude capped at 0.3 (±30% from 0.5).
    const netSigned = complementSigned + monotonSigned;
    const totalMagnitude = Math.abs(netSigned);
    if (totalMagnitude < 0.02) {
      return {
        prob: 0.5,
        detail: { complement: complement.toFixed(3), monotonicity: "ok", related: relatedCount },
      };
    }

    const shift = Math.sign(netSigned) * Math.min(totalMagnitude, 0.3);
    const prob = Math.max(0.1, Math.min(0.9, 0.5 + shift));
    return {
      prob,
      detail: {
        complement: complement.toFixed(3),
        complement_signed: (complementSigned * 100).toFixed(1) + "¢",
        monoton_signed:    (monotonSigned    * 100).toFixed(1) + "¢",
        monoton_abs_sum:   (monotonAbsSum    * 100).toFixed(1) + "¢",
        net_signed:        (netSigned        * 100).toFixed(1) + "¢",
        related: relatedCount,
      },
    };
  } catch { return { prob: null, detail: null }; }
}

// ─── 5. FUNDING RATE SIGNAL ───────────────────────────────────────────────────
// Global (cross-venue BTC funding)
async function getFundingSignal(): Promise<{ prob: number | null; detail: any }> {
  let rate: number | null = null;
  let source = "";

  try {
    const res = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) { const d = await res.json() as any; const t = d?.result?.list?.[0]; if (t?.fundingRate) { rate = parseFloat(t.fundingRate); source = "bybit"; } }
  } catch {}

  if (rate === null) {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) { const d = await res.json() as any; if (d.lastFundingRate) { rate = parseFloat(d.lastFundingRate); source = "binance"; } }
    } catch {}
  }

  if (rate === null) {
    try {
      const [s, f] = await Promise.all([
        fetch(`https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD`, { signal: AbortSignal.timeout(5000) }),
        fetch(`https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USDT`, { signal: AbortSignal.timeout(5000) }),
      ]);
      if (s.ok && f.ok) { const sd = await s.json() as any; const fd = await f.json() as any; if (sd.USD && fd.USDT) { rate = (fd.USDT - sd.USD) / sd.USD; source = "premium_proxy"; } }
    } catch {}
  }

  if (rate === null) return { prob: null, detail: { error: "all sources failed" } };
  const prob = Math.max(0.1, Math.min(0.9, 0.5 + rate * 50));
  return { prob, detail: { funding_rate: (rate * 100).toFixed(4) + "%", source } };
}

// ─── 6. MOMENTUM SIGNAL (Kakushadze 3.1: Price Momentum) ──────────────────────
// "future returns are positively correlated with past returns"
// Rcum = (P_now - P_past) / P_past → short-term directional bias
//
// The legacy implementation read `pastPrice` from the same Gamma `?slug=`
// endpoint as the current price → both queries returned the *current*
// midpoint, Rcum was always ~0, and the function silently fell back to a
// "distance from 0.5" proxy which has no momentum signal at all.
//
// v9 fix: keep a per-slug snapshot in Netlify Blobs. Each call:
//   1. Fetch current midpoint.
//   2. Load saved snapshot for this slug (if any).
//   3. If snapshot age ∈ [MIN_AGE, MAX_AGE], compute Rcum vs the saved
//      price — that's a real over-time return.
//   4. Always update the snapshot to the current state.
//
// The combiner is cached for 3 min, so consecutive snapshot updates land
// roughly every 3-15 minutes (between manual scans + cron ticks). That
// gives Rcum a meaningful 3-15 min look-back window for short BTC markets.
const MOMENTUM_MIN_AGE_MS =  60_000;        // < 1 min: too noisy, skip
const MOMENTUM_MAX_AGE_MS =  60 * 60_000;   // > 1 hour: stale, treat as no data

interface MomentumSnapshot { ts: number; yes: number; }

async function loadMomentumSnapshot(slug: string): Promise<MomentumSnapshot | null> {
  try {
    const raw = await getStore("momentum-snapshots").get(`v1:${slug}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw as string);
    if (typeof parsed?.ts !== "number" || typeof parsed?.yes !== "number") return null;
    return parsed;
  } catch { return null; }
}

async function saveMomentumSnapshot(slug: string, snap: MomentumSnapshot): Promise<void> {
  try { await getStore("momentum-snapshots").set(`v1:${slug}`, JSON.stringify(snap)); } catch {}
}

async function getMomentumSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    if (!market.yesTokenId) return { prob: null, detail: null };

    // 1. Current midpoint (CLOB authoritative for short-term ticks).
    let currentMid = market.yesPrice;
    try {
      const midRes = await fetch(`${CLOB}/midpoint?token_id=${market.yesTokenId}`, { signal: AbortSignal.timeout(4000) });
      if (midRes.ok) {
        const d = await midRes.json() as any;
        const m = parseFloat(d.mid);
        if (Number.isFinite(m) && m > 0) currentMid = m;
      }
    } catch {}

    // 2. Past snapshot.
    const snap = await loadMomentumSnapshot(market.slug);
    const ageMs = snap ? Date.now() - snap.ts : null;

    // 4. Always refresh the snapshot before returning, so the next call has
    //    a fresh anchor regardless of whether we emit a signal this time.
    await saveMomentumSnapshot(market.slug, { ts: Date.now(), yes: currentMid });

    // 3. Decide what to return based on snapshot age.
    if (!snap || ageMs === null || ageMs < MOMENTUM_MIN_AGE_MS) {
      // First time we see this slug, or anchor is too fresh — neutral signal.
      return {
        prob: 0.5,
        detail: {
          current: currentMid.toFixed(3),
          source: snap ? "anchor_too_fresh" : "no_anchor",
          ageSec: snap ? Math.round((ageMs ?? 0) / 1000) : null,
        },
      };
    }
    if (ageMs > MOMENTUM_MAX_AGE_MS) {
      // Anchor too stale — treat as no signal but the snapshot has just
      // been refreshed above so the *next* call gets a fresh anchor.
      return {
        prob: 0.5,
        detail: {
          current: currentMid.toFixed(3),
          source: "anchor_stale",
          ageSec: Math.round(ageMs / 1000),
        },
      };
    }

    // Rcum = (P_now - P_past) / P_past — Kakushadze Eq. 3.1
    //
    // Regime-aware interpretation (2026-05-11 audit fix #E): a Polymarket
    // YES midpoint mozgása reflexív — a saját piacunkat mérjük, NEM a BTC
    // árat. Empirikus szabály: kis mozgások (|Rcum| < 5%) trend-folytatást
    // jeleznek (Jegadeesh & Titman), de >5% gyors mozgások a prediction
    // market microstructure-ben tipikusan likviditás-driven és
    // mean-reverting. A momentum-signalt ezért két regime-re osztjuk:
    //
    //   |rcum| < 5%  → momentum mode: prob = 0.5 + rcum × 2.0   (trend follow)
    //   |rcum| ≥ 5%  → contrarian mode: prob = 0.5 − rcum × 1.0 (mean revert)
    //
    // A kisebb multiplier a contrarian ágban azt tükrözi, hogy a regime
    // detection nem tökéletes — ne reagáljunk túl agresszíven egyik
    // irányba sem.
    const rcum = snap.yes > 0.01 ? (currentMid - snap.yes) / snap.yes : 0;
    const REGIME_THRESHOLD = 0.05;
    const isContrarian = Math.abs(rcum) >= REGIME_THRESHOLD;
    const prob = isContrarian
      ? Math.max(0.1, Math.min(0.9, 0.5 - rcum * 1.0))
      : Math.max(0.1, Math.min(0.9, 0.5 + rcum * 2.0));
    return {
      prob,
      detail: {
        current: currentMid.toFixed(3),
        past:    snap.yes.toFixed(3),
        rcum:    (rcum * 100).toFixed(1) + "%",
        regime:  isContrarian ? "contrarian (large move)" : "momentum (small move)",
        ageSec:  Math.round(ageMs / 1000),
        source:  "blobs_anchor",
      },
    };
  } catch { return { prob: null, detail: null }; }
}

// ─── 7. CONTRARIAN SIGNAL (Kakushadze 10.3: Mean-Reversion) ──────────────────
// wi = -α × [Ri - Rm] — buy losers, sell winners relative to market index
async function getContrarianSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    // Fetch top active markets to compute "market index"
    const mRes = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=15&order=volume24hr&ascending=false`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!mRes.ok) return { prob: null, detail: null };
    const mData = await mRes.json() as any;
    const all = Array.isArray(mData) ? mData : [];

    const prices: number[] = [];
    for (const m of all) {
      try {
        const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        if (Array.isArray(op)) prices.push(parseFloat(op[0]));
      } catch {}
    }

    if (prices.length < 3) return { prob: null, detail: null };

    // Rm = market index (mean YES price)  — Kakushadze Eq. 10.7
    const rm = prices.reduce((s, p) => s + p, 0) / prices.length;

    // Deviation from market mean — Kakushadze Eq. 10.8
    const dev = market.yesPrice - rm;

    // Contrarian: if price is above market mean → expect reversion down (NO bias)
    // If below mean → expect reversion up (YES bias)
    if (Math.abs(dev) < 0.05) return { prob: 0.5, detail: { rm: rm.toFixed(3), dev: dev.toFixed(3), note: "within normal range" } };

    const prob = Math.max(0.1, Math.min(0.9, 0.5 - dev * 0.3));
    return {
      prob,
      detail: { rm: rm.toFixed(3), dev: dev.toFixed(3), markets_sampled: prices.length },
    };
  } catch { return { prob: null, detail: null }; }
}

// ─── 8. PAIRS SPREAD SIGNAL (Kakushadze 3.8: Pairs Z-Score) ──────────────────
// If related markets exist (same event, different deadlines), check spread consistency
async function getPairsSpreadSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    // Find related markets by keyword matching (same base event)
    const q = market.question.toLowerCase();
    const keywords = q.split(/\s+/).filter(w => w.length > 3 && !["will","the","by","and","for","from","with","this","that","what"].includes(w)).slice(0, 4);
    if (keywords.length < 2) return { prob: null, detail: { note: "insufficient keywords" } };

    const mRes = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=30&order=volume24hr&ascending=false`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!mRes.ok) return { prob: null, detail: null };
    const mData = await mRes.json() as any;
    const all = Array.isArray(mData) ? mData : [];

    // Find related markets (share 2+ keywords, different slug)
    const related: { slug: string; yesPrice: number; question: string; endDate: string }[] = [];
    for (const m of all) {
      if ((m.slug || "") === market.slug) continue;
      const mq = (m.question || "").toLowerCase();
      const matches = keywords.filter(kw => mq.includes(kw)).length;
      if (matches >= 2) {
        try {
          const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          if (Array.isArray(op)) {
            related.push({
              slug: m.slug, yesPrice: parseFloat(op[0]),
              question: m.question || "", endDate: m.endDate || "",
            });
          }
        } catch {}
      }
    }

    if (related.length === 0) return { prob: 0.5, detail: { note: "no related markets", keywords: keywords.slice(0, 3).join(",") } };

    // Calculate spread vs each related market — Kakushadze Eq. 3.18-3.22
    let totalSpreadDev = 0;
    let pairCount = 0;
    const pairDetails: string[] = [];

    for (const r of related.slice(0, 3)) {
      const spread = market.yesPrice - r.yesPrice;

      // Expected spread based on deadline difference
      let expectedSpread = 0;
      if (market.endDate && r.endDate) {
        const mEnd = new Date(market.endDate).getTime();
        const rEnd = new Date(r.endDate).getTime();
        const daysDiff = (mEnd - rEnd) / 86400000;
        // Later deadline → should have higher or equal price
        expectedSpread = daysDiff > 0 ? -Math.abs(daysDiff) * 0.002 : Math.abs(daysDiff) * 0.002;
      }

      const dev = spread - expectedSpread;
      totalSpreadDev += dev;
      pairCount++;
      pairDetails.push(`${r.slug.slice(0, 20)}:${(dev * 100).toFixed(1)}c`);
    }

    if (pairCount === 0) return { prob: 0.5, detail: { note: "no valid pairs" } };

    const avgDev = totalSpreadDev / pairCount;
    // Positive dev = market overpriced vs pairs → NO bias
    // Negative dev = market underpriced → YES bias
    const prob = Math.max(0.1, Math.min(0.9, 0.5 - avgDev * 2.0));
    return {
      prob,
      detail: { pairs: pairCount, avg_dev: (avgDev * 100).toFixed(1) + "c", pairs_detail: pairDetails },
    };
  } catch { return { prob: null, detail: null }; }
}

// Sprint 42A (2026-05-15): K-blind signal classification for the
// market-aware re-weighting. The 4 signals below provide BTC-wide
// directional sentiment with no per-K dependence (momentum / contrarian
// look at BTC price; funding_rate is a single Bybit funding number;
// pairs_spread compares BTC/ETH-style related markets). On
// `bitcoin-above-Nk-on-...` threshold markets these 4 signals therefore
// mean-revert the combined output toward 0.5 regardless of how far BTC
// is from K. The other 4 signals (vol_divergence, orderflow,
// apex_consensus, cond_prob) ARE per-market / per-K aware.
//
// The `combinerKBlindDownweight` Settings knob (default 1.0 = zero
// behavior change) multiplies the IC of K_BLIND_SIGNALS on threshold
// markets so the combiner output becomes meaningfully K-sensitive. Set
// to 0.5 to halve K-blind contribution, 0 to fully suppress.
const K_BLIND_SIGNALS = new Set([
  "momentum",
  "contrarian",
  "funding_rate",
  "pairs_spread",
]);

type MarketKind = "threshold" | "directional";

// ─── KOMBINÁTOR ───────────────────────────────────────────────────────────────
// `icMap` (optional): per-signal IC override map. When provided, the combiner
// uses these IC values instead of the static SIGNAL_ICS priors. The
// signal-calibration pipeline computes these as Bayes-shrinkage blends of
// realized IC (from closedTrades) and the academic priors. Falling back to
// SIGNAL_ICS when a signal is missing from icMap (or the whole map is
// undefined) means existing callers behave exactly as before.
//
// `marketKind` (optional, default "directional"): when set to "threshold",
// the IC for K_BLIND_SIGNALS is multiplied by `kBlindDownweight` so K-aware
// signals get proportionally more weight in the combined output. Sprint 42A
// (2026-05-15). On "directional" markets (up-or-down, generic) the
// downweight is NEVER applied, regardless of the knob — zero regression
// risk for the existing market types.
//
// `kBlindDownweight` (optional, default 1.0 = no change): the multiplier
// applied to K_BLIND_SIGNALS' IC on threshold markets. Settings-tunable
// via `combinerKBlindDownweight` (range [0, 1]).
function combine(
  signals: Record<string, number | null>,
  icMap?: Record<string, number>,
  marketKind: MarketKind = "directional",
  kBlindDownweight: number = 1.0,
) {
  const valid: Record<string, number> = {};
  for (const [k, v] of Object.entries(signals)) {
    if (v !== null && !isNaN(v)) valid[k] = v;
  }

  const names = Object.keys(valid);
  const n     = names.length;
  if (n === 0) return { combined: 0.5, weights: {}, ir: 0, kelly_q: 0, cv_edge: 1 };

  // Sprint 42A: clamp downweight to [0, 1] defensively. On
  // non-threshold markets the multiplier never applies — we just keep
  // baseIC as the priors define it.
  const effectiveDownweight = marketKind === "threshold"
    ? Math.max(0, Math.min(1, kBlindDownweight))
    : 1.0;
  const icFor = (k: string) => {
    const baseIC = (icMap && Number.isFinite(icMap[k]) ? icMap[k] : SIGNAL_ICS[k]) || 0.05;
    if (effectiveDownweight !== 1.0 && K_BLIND_SIGNALS.has(k)) {
      return baseIC * effectiveDownweight;
    }
    return baseIC;
  };

  const mean = names.reduce((s, k) => s + valid[k], 0) / n;
  const demeaned: Record<string, number> = {};
  for (const k of names) demeaned[k] = valid[k] - mean;

  let totalW = 0;
  const weights: Record<string, number> = {};
  for (const k of names) {
    const ic = icFor(k);
    const w  = ic * (1 + Math.abs(demeaned[k]) * 0.5);
    weights[k] = w;
    totalW += w;
  }
  for (const k of names) weights[k] = parseFloat((weights[k] / totalW).toFixed(4));

  let combined = 0;
  for (const k of names) combined += weights[k] * valid[k];

  const avgIC = names.reduce((s, k) => s + icFor(k), 0) / n;
  const effN  = Math.max(1, n * 0.6);
  const ir    = avgIC * Math.sqrt(effN);

  const p      = combined;
  const b      = Math.abs(p - 0.5) > 0.01 ? (1 / p) - 1 : 1;
  const kelly  = Math.max(0, (p * b - (1 - p)) / b);
  const cvEdge = Math.max(0, 1 - ir * 0.8);
  const kellyQ = kelly * (1 - cvEdge) * 0.25;

  return {
    combined: parseFloat(combined.toFixed(4)),
    weights,
    ir:       parseFloat(ir.toFixed(4)),
    kelly_q:  parseFloat(kellyQ.toFixed(4)),
    cv_edge:  parseFloat(cvEdge.toFixed(3)),
  };
}

function recommend(p: number, ir: number, kellyQ: number) {
  const edge = p - 0.5;
  if (Math.abs(edge) < 0.05 || ir < 0.1) {
    return { action: "WAIT", confidence: "LOW", rationale: "Jelzések nem konvergálnak – nincs szignifikáns edge" };
  }
  if (kellyQ < 0.005) {
    return { action: "WATCH", confidence: "LOW", rationale: "Van edge de a pozíció méret túl kicsi" };
  }
  const side = edge > 0 ? "YES" : "NO";
  const conf = ir > 0.3 ? "HIGH" : ir > 0.2 ? "MEDIUM" : "LOW";
  return {
    action:    `BUY ${side}`,
    confidence: conf,
    rationale: `IR=${ir.toFixed(3)} | p=${(p * 100).toFixed(1)}% | ¼-Kelly=${(kellyQ * 100).toFixed(1)}% bankroll`,
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url  = new URL(req.url);
  const slug = url.searchParams.get("slug") || "";
  // Optional category param: when provided + `useRealizedIC` is ON in
  // trader-settings, the combiner blends per-category realized IC
  // (computed by auto-trader/shared/signal-calibration.mts from the
  // bot's closedTrades) into the static priors via Bayes-shrinkage.
  // Falling back to static priors when absent keeps the public API stable.
  const categoryParam = url.searchParams.get("category");
  const calibrationCategory =
    categoryParam === "crypto" || categoryParam === "hyperliquid"
      ? categoryParam
      : null;

  // Cache keyed by market + category (different IC blends per-category
  // would otherwise share a single cache entry and bleed across bots).
  const cKey = `combined:${slug || "auto"}:${calibrationCategory ?? "static"}`;
  let store: any = null;
  try {
    store = getStore("signal-combiner-v3");
    const cached = store ? await store.getWithMetadata(cKey) : null;
    if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < CACHE_TTL) {
      return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
    }
  } catch {}

  try {
    // 1. Resolve target market
    const market = await resolveMarket(slug || undefined);
    if (!market) {
      return new Response(JSON.stringify({ ok: false, error: "Market not found" }), { status: 404, headers: CORS });
    }

    // 1.5. Load Tier 1 toggles from trader-settings (Blobs overrides).
    // Dynamic import to avoid circular module init; falls back to defaults
    // on any error so the combiner is never broken by a settings outage.
    const volOptions = await loadVolSignalOptions();

    // 1.6. Sprint 42A (2026-05-15): K-blind signal downweight knob +
    // market-kind classification. The combiner applies the downweight only
    // on threshold (BTC-above-K) markets; up-or-down / directional markets
    // are unaffected regardless of the setting.
    const kBlindDownweight = await loadKBlindDownweight();
    const marketKind: MarketKind = parseThresholdK(market.slug) !== null
      ? "threshold"
      : "directional";

    // 2. Parallel signal fetch — 8 signals + resolution-risk
    // Resolution-risk runs in parallel; never blocks the primary signals.
    const skipRisk    = url.searchParams.get("skip_risk") === "1";
    const riskMeta: MarketMeta = {
      question:         market.question,
      slug:             market.slug,
      rules:            market.rules,
      resolutionSource: market.resolutionSource,
      endDate:          market.endDate,
      category:         market.category,
      closed:           market.closed,
    };
    const riskTask: Promise<ResolutionRiskScore | null> = skipRisk
      ? Promise.resolve(null)
      : analyseResolutionRisk(riskMeta).catch(() => null);

    const [vol, flow, apex, cond, fund, mom, contr, pairs, risk] = await Promise.all([
      getVolSignal(market, volOptions),
      getOrderflowSignal(market),
      getApexSignal(market),
      getCondProbSignal(market),
      getFundingSignal(),
      getMomentumSignal(market),
      getContrarianSignal(market),
      getPairsSpreadSignal(market),
      riskTask,
    ]);

    const raw_signals: Record<string, number | null> = {
      vol_divergence: vol.prob,
      orderflow:      flow.prob,
      apex_consensus: apex.prob,
      cond_prob:      cond.prob,
      funding_rate:   fund.prob,
      momentum:       mom.prob,
      contrarian:     contr.prob,
      pairs_spread:   pairs.prob,
    };

    // Optional realized-IC blend. Off by default — operator opts in via
    // Settings → Signal calibration → "Use realized IC (per-bot)". When ON
    // + category is recognised, load the latest calibration record from
    // Blobs (computed on cron tick by signal-calibration.mts) and shrink
    // toward the static priors with constant K (default 30).
    let effectiveICMap: Record<string, number> | undefined;
    let calibrationMeta: any = null;
    if (calibrationCategory) {
      try {
        const settings: any = await import("./trader-settings.mts");
        const ov = await settings.loadRuntimeOverrides();
        const useRealized = ov.useRealizedIC === 1;
        const k = typeof ov.calibrationShrinkageK === "number" ? ov.calibrationShrinkageK : 30;
        if (useRealized) {
          const cal: any = await import("./auto-trader/shared/signal-calibration.mts");
          const record = await cal.loadCalibration(calibrationCategory);
          if (record) {
            effectiveICMap = cal.effectiveICs(SIGNAL_ICS, record, k);
            calibrationMeta = {
              category:    calibrationCategory,
              computedAt:  record.computedAt,
              sampleSize:  record.sampleSize,
              shrinkageK:  k,
              perSignal:   record.perSignal,
              effective:   effectiveICMap,
            };
          }
        }
      } catch { /* swallow — fall back to static priors */ }
    }

    const combo = combine(raw_signals, effectiveICMap, marketKind, kBlindDownweight);
    const rec   = recommend(combo.combined, combo.ir, combo.kelly_q);
    const active = Object.values(raw_signals).filter(v => v !== null).length;

    // Resolution-risk adjustment (additive, never breaks legacy output)
    let adjusted: ReturnType<typeof applyResolutionAdjustment> | null = null;
    if (risk) {
      adjusted = applyResolutionAdjustment(combo.combined, market.yesPrice, risk);
      // If risk blocks the trade, downgrade recommendation — leave `rec` intact
      // so legacy consumers still see what the raw signals said.
      if (!adjusted.trade_recommended && rec.action?.startsWith("BUY")) {
        (rec as any).original_action = rec.action;
        rec.action = risk.category === "SKIP" ? "SKIP" : "WATCH";
        rec.rationale = `${adjusted.trade_blocked_reason} | was ${(rec as any).original_action}`;
      }
    }

    const payload = JSON.stringify({
      ok:                   true,
      fetched_at:           new Date().toISOString(),
      market: {
        question:  market.question,
        slug:      market.slug,
        url:       market.url,
        yes_price: market.yesPrice,
        no_price:  market.noPrice,
        volume_24h: market.volume24h,
        end_date:   market.endDate,
      },
      combined_probability: combo.combined,
      edge_pct:             parseFloat(((combo.combined - 0.5) * 100).toFixed(2)),
      signal_weights:       combo.weights,
      raw_signals,
      signal_details: {
        vol_divergence: vol.detail,
        orderflow:      flow.detail,
        apex_consensus: apex.detail,
        cond_prob:      cond.detail,
        funding_rate:   fund.detail,
        momentum:       mom.detail,
        contrarian:     contr.detail,
        pairs_spread:   pairs.detail,
      },
      fundamental_law: {
        avg_ic:      0.07,
        n_signals:   active,
        effective_n: parseFloat((active * 0.6).toFixed(1)),
        ir:          combo.ir,
        formula:     `IR = 0.070 × √${active} = ${combo.ir.toFixed(3)}`,
      },
      // Optional realized-IC calibration metadata (null when off or no record).
      // Lets the UI render "Calibrated vs Prior IC" + which K + sample size.
      calibration: calibrationMeta,
      kelly: {
        full:     parseFloat((combo.kelly_q * 4).toFixed(4)),
        quarter:  combo.kelly_q,
        cv_edge:  combo.cv_edge,
      },
      recommendation: rec,
      active_signals: active,
      // ─── Resolution-risk adjustment (additive) ───────────────────────────
      resolution_risk:      risk || null,
      adjusted_probability: adjusted?.adjusted_probability ?? null,
      adjusted_edge_pct:    adjusted?.adjusted_edge_pct ?? null,
      trade_recommended:    adjusted?.trade_recommended ?? null,
      trade_blocked_reason: adjusted?.trade_blocked_reason || null,
    });

    try { if (store) await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}

    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502, headers: CORS,
    });
  }
}
