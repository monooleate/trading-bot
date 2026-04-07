// netlify/functions/cond-prob-matrix.mts
// GET /.netlify/functions/cond-prob-matrix?group=auto

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const GAMMA     = "https://gamma-api.polymarket.com";
const CACHE_TTL = 5 * 60 * 1000;

// ─── Parse outcomePrices safely ───────────────────────────────────────────────
function parsePrices(raw: any): [number, number] | null {
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const y = parseFloat(arr[0]);
    const n = parseFloat(arr[1]);
    if (isNaN(y) || isNaN(n)) return null;
    // Csak binary piacok ahol az összeg ≈ 1.0 és árak reálisak
    if (y < 0.01 || y > 0.99 || n < 0.01 || n > 0.99) return null;
    if (Math.abs(y + n - 1.0) > 0.25) return null;
    return [y, n];
  } catch { return null; }
}

// ─── Fetch top markets ────────────────────────────────────────────────────────
async function fetchTopMarkets(limit = 50): Promise<any[]> {
  const res = await fetch(
    `${GAMMA}/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  const data = await res.json() as any;
  const list  = Array.isArray(data) ? data : (data.markets || []);

  const result: any[] = [];
  for (const m of list) {
    const prices = parsePrices(m.outcomePrices);
    if (!prices) continue;
    result.push({
      slug:       m.slug || "",
      question:   m.question || "",
      yes_price:  prices[0],
      no_price:   prices[1],
      volume_24h: parseFloat(m.volume24hr || 0),
    });
  }
  return result;
}

// ─── Violations ───────────────────────────────────────────────────────────────
function checkComplement(m: any): any | null {
  const total = m.yes_price + m.no_price;
  const dev   = Math.abs(total - 1.0);
  if (dev < 0.025) return null; // legalább 2.5¢ eltérés kell
  return {
    type:        "COMPLEMENT",
    severity:    Math.min(1, dev / 0.10),
    edge_cents:  parseFloat((dev * 100).toFixed(1)),
    market_a:    m.slug,
    market_b:    m.slug,
    question_a:  m.question,
    question_b:  m.question,
    price_a:     m.yes_price,
    price_b:     m.no_price,
    description: `P(YES)+P(NO) = ${total.toFixed(3)} ≠ 1.000 | Edge: ${(dev*100).toFixed(1)}¢`,
    action:      total > 1.0
      ? `SELL YES @ ${m.yes_price.toFixed(3)} + SELL NO @ ${m.no_price.toFixed(3)}`
      : `BUY YES @ ${m.yes_price.toFixed(3)} + BUY NO @ ${m.no_price.toFixed(3)}`,
  };
}

function checkMonotonicity(mHigh: any, mLow: any): any | null {
  // mHigh logikailag erősebb feltétel mint mLow → P(mHigh) ≤ P(mLow)
  const diff = mHigh.yes_price - mLow.yes_price;
  if (diff <= 0.03) return null; // legalább 3¢ különbség
  return {
    type:        "MONOTONICITY",
    severity:    Math.min(1, diff / 0.20),
    edge_cents:  parseFloat((diff * 100).toFixed(1)),
    market_a:    mHigh.slug,
    market_b:    mLow.slug,
    question_a:  mHigh.question,
    question_b:  mLow.question,
    price_a:     mHigh.yes_price,
    price_b:     mLow.yes_price,
    description: `P(A)=${mHigh.yes_price.toFixed(3)} > P(B)=${mLow.yes_price.toFixed(3)} – ha A⊆B, ez sértés`,
    action:      `SELL A YES @ ${mHigh.yes_price.toFixed(3)} | BUY B YES @ ${mLow.yes_price.toFixed(3)}`,
  };
}

function detectViolations(markets: any[]): any[] {
  const violations: any[] = [];

  // 1. Complement check minden piacon
  for (const m of markets) {
    const v = checkComplement(m);
    if (v) violations.push(v);
  }

  // 2. Monotonicity: kulcsszó alapú csoportosítás
  const groups: Record<string, any[]> = {};
  for (const m of markets) {
    const q = (m.question || "").toLowerCase();
    const keys = [
      ["btc",      ["bitcoin","btc","15-minute","up-or-down"]],
      ["eth",      ["ethereum"," eth "]],
      ["fed",      ["fed ","rate cut","fomc","interest rate"]],
      ["election", ["election","president","senate","congress"]],
      ["sports",   ["nba","nfl","championship","super bowl","world cup"]],
    ] as [string, string[]][];

    for (const [cat, kws] of keys) {
      if (kws.some(kw => q.includes(kw))) {
        groups[cat] = groups[cat] || [];
        groups[cat].push(m);
        break;
      }
    }
  }

  for (const [cat, grp] of Object.entries(groups)) {
    if (grp.length < 2) continue;
    // Csak azonos szavakat tartalmazó piac-párokon belül ellenőrzünk
    // Ez kizárja az Iran vs NBA féle értelmetlen összehasonlításokat
    const sorted = [...grp].sort((a, b) => b.yes_price - a.yes_price);
    for (let i = 0; i < sorted.length - 1; i++) {
      const qa = (sorted[i].question || "").toLowerCase();
      const qb = (sorted[i+1].question || "").toLowerCase();
      // Csak ha van közös szó (pl. "btc", "fed", "rate") -> valódi implication
      const wordsA = qa.split(/\s+/).filter(w => w.length > 3);
      const wordsB = qb.split(/\s+/).filter(w => w.length > 3);
      const commonWords = wordsA.filter(w => qb.includes(w));
      if (commonWords.length < 1) continue; // nincs közös szó -> kihagyjuk
      const v = checkMonotonicity(sorted[i], sorted[i + 1]);
      if (v) violations.push(v);
    }
  }

  return violations.sort((a, b) => b.edge_cents - a.edge_cents).slice(0, 20);
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  let store: any = null;
  try { store = getStore("cond-prob-v2"); } catch {}

  const cKey = "auto";
  try {
    let cached: any = null;
    try { cached = store ? await store.getWithMetadata(cKey) : null; } catch {}
    if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < CACHE_TTL) {
      return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
    }
  } catch {}

  try {
    const markets    = await fetchTopMarkets(50);
    const violations = detectViolations(markets);

    const payload = JSON.stringify({
      ok:               true,
      markets_analyzed: markets.length,
      violations_found: violations.length,
      violations,
      scanned_at:       new Date().toISOString(),
    });

    try { if (store) await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}
    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
