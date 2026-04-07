// netlify/functions/cond-prob-matrix.mts
// GET /.netlify/functions/cond-prob-matrix?group=btc
// GET /.netlify/functions/cond-prob-matrix?group=fed
// GET /.netlify/functions/cond-prob-matrix?group=auto   ← auto-scan top markets
//
// Conditional Probability Mispricing Detector
// Három violation típus: MONOTONICITY | COMPLEMENT | CONDITIONAL

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const GAMMA = "https://gamma-api.polymarket.com";
const CACHE_TTL = 5 * 60 * 1000; // 5 perc

// ─── Market fetch ─────────────────────────────────────────────────────────────
async function fetchMarket(slug: string): Promise<any | null> {
  try {
    const res = await fetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}&limit=1`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const list  = Array.isArray(data) ? data : (data.markets || []);
    if (!list.length) return null;
    const m = list[0];
    let yp = 0.5, np = 0.5;
    try {
      const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      if (Array.isArray(op) && op.length >= 2) { yp = parseFloat(op[0]); np = parseFloat(op[1]); }
    } catch {}
    return {
      slug, question: m.question || slug,
      yes_price: Math.round(yp * 10000) / 10000,
      no_price:  Math.round(np * 10000) / 10000,
      volume_24h: parseFloat(m.volume24hr || 0),
    };
  } catch { return null; }
}

async function fetchTopMarkets(limit = 40): Promise<any[]> {
  try {
    const res = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    const list  = Array.isArray(data) ? data : (data.markets || []);
    return list.map((m: any) => {
      let yp = 0.5, np = 0.5;
      try {
        const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        if (Array.isArray(op) && op.length >= 2) { yp = parseFloat(op[0]); np = parseFloat(op[1]); }
      } catch {}
      return {
        slug: m.slug || "", question: m.question || "",
        yes_price: Math.round(yp * 10000) / 10000,
        no_price:  Math.round(np * 10000) / 10000,
        volume_24h: parseFloat(m.volume24hr || 0),
        tags: (m.tags || []).map((t: any) => typeof t === "object" ? t.label : t),
      };
    });
  } catch { return []; }
}

// ─── Violation detectors ───────────────────────────────────────────────────────
function checkMonotonicity(mStrong: any, mWeak: any): any | null {
  const pa = mStrong.yes_price, pb = mWeak.yes_price;
  if (pa <= pb + 0.02) return null;
  const violation = pa - pb;
  return {
    type: "MONOTONICITY",
    severity: Math.min(1, violation / 0.2),
    edge_cents: Math.round(violation * 100 * 10) / 10,
    market_a: mStrong.slug, market_b: mWeak.slug,
    question_a: mStrong.question, question_b: mWeak.question,
    price_a: pa, price_b: pb,
    description: `P(${mStrong.question.slice(0,45)}) = ${pa.toFixed(3)} > P(${mWeak.question.slice(0,45)}) = ${pb.toFixed(3)}`,
    action: `SELL ${mStrong.slug} YES @ ${pa.toFixed(2)} | BUY ${mWeak.slug} YES @ ${pb.toFixed(2)}`,
  };
}

function checkComplement(m: any): any | null {
  const total = m.yes_price + m.no_price;
  const dev   = Math.abs(total - 1.0);
  if (dev < 0.02) return null;
  return {
    type: "COMPLEMENT",
    severity: Math.min(1, dev / 0.1),
    edge_cents: Math.round(dev * 100 * 10) / 10,
    market_a: m.slug, market_b: m.slug,
    question_a: m.question, question_b: m.question,
    price_a: m.yes_price, price_b: m.no_price,
    description: `P(YES)+P(NO)=${total.toFixed(4)} ≠ 1.000 | Eltérés: ${(dev*100).toFixed(2)}¢`,
    action: total > 1.0
      ? `SELL YES (${m.yes_price.toFixed(2)}) + SELL NO (${m.no_price.toFixed(2)})`
      : `BUY YES (${m.yes_price.toFixed(2)}) + BUY NO (${m.no_price.toFixed(2)})`,
  };
}

// Auto-scan: hasonló kérdések közötti monotonicitás keresés
function autoDetectChains(markets: any[]): any[] {
  const violations: any[] = [];

  // Complement minden piacon
  for (const m of markets) {
    const v = checkComplement(m);
    if (v) violations.push(v);
  }

  // Csoportosítás kulcsszavak szerint
  const groups: Record<string, any[]> = {};
  for (const m of markets) {
    const q = m.question.toLowerCase();
    // BTC árszint piacok
    if (q.includes("bitcoin") || q.includes("btc")) {
      groups["btc"] = groups["btc"] || [];
      groups["btc"].push(m);
    }
    // Fed piacok
    if (q.includes("fed") || q.includes("rate cut") || q.includes("interest rate")) {
      groups["fed"] = groups["fed"] || [];
      groups["fed"].push(m);
    }
    // ETH
    if (q.includes("ethereum") || q.includes(" eth ")) {
      groups["eth"] = groups["eth"] || [];
      groups["eth"].push(m);
    }
  }

  // Minden csoporton belül minden párra ellenőrzés
  for (const [, grp] of Object.entries(groups)) {
    if (grp.length < 2) continue;
    for (let i = 0; i < grp.length; i++) {
      for (let j = i + 1; j < grp.length; j++) {
        const v1 = checkMonotonicity(grp[i], grp[j]);
        if (v1) violations.push(v1);
        const v2 = checkMonotonicity(grp[j], grp[i]);
        if (v2) violations.push(v2);
      }
    }
  }

  return violations.sort((a, b) => b.severity - a.severity).slice(0, 15);
}

// ─── Predefined groups ────────────────────────────────────────────────────────
const GROUPS: Record<string, { slugs: string[]; chains: [string,string][] }> = {
  btc: {
    slugs: [
      "will-bitcoin-hit-120000-in-2025",
      "will-bitcoin-hit-100000-in-2025",
      "will-bitcoin-hit-80000-in-2025",
      "will-bitcoin-hit-60000-in-2025",
    ],
    chains: [
      ["will-bitcoin-hit-120000-in-2025","will-bitcoin-hit-100000-in-2025"],
      ["will-bitcoin-hit-100000-in-2025","will-bitcoin-hit-80000-in-2025"],
      ["will-bitcoin-hit-80000-in-2025","will-bitcoin-hit-60000-in-2025"],
    ],
  },
  fed: {
    slugs: [
      "will-the-fed-cut-rates-in-may-2025",
      "will-the-fed-cut-rates-in-june-2025",
      "will-the-fed-cut-in-q2-2025",
      "will-the-fed-cut-rates-in-2025",
    ],
    chains: [
      ["will-the-fed-cut-rates-in-may-2025","will-the-fed-cut-in-q2-2025"],
      ["will-the-fed-cut-in-q2-2025","will-the-fed-cut-rates-in-2025"],
    ],
  },
};

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url   = new URL(req.url);
  const group = url.searchParams.get("group") || "auto";

  // Cache
  const store  = getStore("cond-prob-cache");
  const cKey   = `cp:${group}`;
  try {
    const cached = await store.getWithMetadata(cKey);
    if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < CACHE_TTL) {
      return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
    }
  } catch {}

  try {
    let violations: any[] = [];
    let markets_analyzed  = 0;

    if (group === "auto") {
      // Top 40 market auto-scan
      const markets = await fetchTopMarkets(40);
      markets_analyzed = markets.length;
      violations = autoDetectChains(markets);
    } else {
      const grpDef = GROUPS[group];
      if (!grpDef) {
        return new Response(JSON.stringify({ ok: false, error: `Unknown group: ${group}` }), { status: 400, headers: CORS });
      }
      // Fetch all markets
      const fetched = await Promise.all(grpDef.slugs.map(fetchMarket));
      const markets = fetched.filter(Boolean) as any[];
      markets_analyzed = markets.length;
      const mMap = Object.fromEntries(markets.map(m => [m.slug, m]));

      // Complement check
      for (const m of markets) {
        const v = checkComplement(m);
        if (v) violations.push(v);
      }
      // Chain monotonicity
      for (const [slugA, slugB] of grpDef.chains) {
        const ma = mMap[slugA], mb = mMap[slugB];
        if (ma && mb) {
          const v = checkMonotonicity(ma, mb);
          if (v) violations.push(v);
        }
      }
    }

    const payload = JSON.stringify({
      ok: true,
      group,
      markets_analyzed,
      violations_found: violations.length,
      violations,
      scanned_at: new Date().toISOString(),
    });

    try { await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}

    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
