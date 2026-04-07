// netlify/functions/llm-dependency.mts
// POST /.netlify/functions/llm-dependency
// Body: { market_a: { slug, question }, market_b: { slug, question } }
// GET  /.netlify/functions/llm-dependency?action=scan ← auto-scan top pairs
//
// Claude API alapú logikai függőség detektor.
// A cikk módszertana: DeepSeek-R1 két piac leírását kapja, JSON-ban
// visszaadja a valid outcome kombinációkat és a függőség típusát.
//
// Ha N × M -nél kevesebb valid kombináció van → függőség → arbitrázs lehetőség

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

const GAMMA     = "https://gamma-api.polymarket.com";
const CACHE_TTL = 30 * 60 * 1000; // 30 perc (LLM hívás drága)

// ─── Claude API hívás ─────────────────────────────────────────────────────────
async function callClaude(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":         "application/json",
      "anthropic-version":    "2023-06-01",
      "x-api-key":            process.env.ANTHROPIC_API_KEY || "",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages:   [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json() as any;
  return data.content?.[0]?.text || "";
}

// ─── Dependency detection prompt ──────────────────────────────────────────────
function buildPrompt(mA: any, mB: any): string {
  return `You are a prediction market analyst. Analyze whether these two Polymarket markets have logical dependencies.

Market A: "${mA.question}"
Market B: "${mB.question}"

Task: Determine if there are logical constraints between outcomes.

Examples of dependencies:
- "Will Trump win Pennsylvania?" and "Will Trump win the presidency?" → If Trump wins presidency, he likely won PA. P(win PA) cannot be much lower than P(win presidency).
- "Will BTC exceed $100k in 2025?" and "Will BTC exceed $120k in 2025?" → $120k implies $100k, so P(>120k) ≤ P(>100k).
- "Will Fed cut in May?" and "Will Fed cut in Q2?" → May cut implies Q2 cut, so P(May) ≤ P(Q2).

Respond ONLY with valid JSON, no other text:
{
  "has_dependency": true/false,
  "dependency_type": "IMPLICATION" | "MUTUAL_EXCLUSION" | "SUBSET" | "CORRELATED" | "NONE",
  "direction": "A_IMPLIES_B" | "B_IMPLIES_A" | "SYMMETRIC" | "NONE",
  "constraint": "short description of the logical constraint",
  "arbitrage_condition": "what mispricing to look for",
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explanation"
}`;
}

// ─── Parse Claude response ────────────────────────────────────────────────────
function parseResponse(text: string): any {
  try {
    // JSON kinyerés ha szükséges
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}
  return {
    has_dependency: false,
    dependency_type: "UNKNOWN",
    confidence: 0,
    reasoning: "Parse error",
  };
}

// ─── Top markets fetch ────────────────────────────────────────────────────────
async function fetchTopMarkets(limit = 30): Promise<any[]> {
  const res = await fetch(
    `${GAMMA}/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`Gamma ${res.status}`);
  const data = await res.json() as any;
  return Array.isArray(data) ? data : (data.markets || []);
}

// ─── Group markets by category ────────────────────────────────────────────────
function groupByCategory(markets: any[]): Record<string, any[]> {
  const groups: Record<string, any[]> = {};
  const KEYWORDS: Record<string, string[]> = {
    btc:      ["bitcoin", "btc"],
    eth:      ["ethereum", " eth "],
    fed:      ["fed", "rate cut", "interest rate", "fomc"],
    election: ["election", "president", "trump", "harris", "senate"],
    sports:   ["nba", "nfl", "super bowl", "world cup"],
  };

  for (const m of markets) {
    const q = (m.question || "").toLowerCase();
    let placed = false;
    for (const [cat, kws] of Object.entries(KEYWORDS)) {
      if (kws.some(kw => q.includes(kw))) {
        groups[cat] = groups[cat] || [];
        groups[cat].push(m);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups["other"] = groups["other"] || [];
      groups["other"].push(m);
    }
  }
  return groups;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const store = getStore("llm-dep-cache");

  // ── POST: konkrét pár elemzése ────────────────────────────────────────────
  if (req.method === "POST") {
    let body: any;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), { status: 400, headers: CORS });
    }

    const { market_a, market_b } = body;
    if (!market_a?.question || !market_b?.question) {
      return new Response(JSON.stringify({ ok: false, error: "market_a and market_b required" }), { status: 400, headers: CORS });
    }

    const cKey = `pair:${market_a.slug}:${market_b.slug}`;
    try {
      let cached: any = null; try { cached = await store.getWithMetadata(cKey); } catch {}
      if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < CACHE_TTL) {
        return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
      }
    } catch {}

    try {
      const prompt   = buildPrompt(market_a, market_b);
      const rawText  = await callClaude(prompt);
      const analysis = parseResponse(rawText);

      const payload = JSON.stringify({
        ok: true,
        market_a,
        market_b,
        analysis,
        prompt_tokens_est: Math.ceil(prompt.length / 4),
      });

      try { await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}
      return new Response(payload, { status: 200, headers: CORS });

    } catch (err: any) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
    }
  }

  // ── GET: auto-scan top market pairs ──────────────────────────────────────
  const url    = new URL(req.url);
  const action = url.searchParams.get("action") || "scan";

  if (action !== "scan") {
    return new Response(JSON.stringify({ ok: false, error: "Unknown action" }), { status: 400, headers: CORS });
  }

  const cKey = "auto-scan";
  try {
    let cached: any = null; try { cached = await store.getWithMetadata(cKey); } catch {}
    if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < CACHE_TTL) {
      return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
    }
  } catch {}

  try {
    const markets = await fetchTopMarkets(30);
    const groups  = groupByCategory(markets);

    // Minden csoportból csak 2-2 piacot elemzünk (API cost)
    const pairs: [any, any][] = [];
    for (const [, grp] of Object.entries(groups)) {
      if (grp.length >= 2) {
        pairs.push([grp[0], grp[1]]);
        if (grp.length >= 3) pairs.push([grp[0], grp[2]]);
      }
    }

    // Max 6 pár (LLM cost limit)
    const selectedPairs = pairs.slice(0, 6);
    const results: any[] = [];

    for (const [mA, mB] of selectedPairs) {
      try {
        const prompt   = buildPrompt(mA, mB);
        const rawText  = await callClaude(prompt);
        const analysis = parseResponse(rawText);
        results.push({
          market_a:    { slug: mA.slug, question: mA.question },
          market_b:    { slug: mB.slug, question: mB.question },
          analysis,
        });
        await new Promise(r => setTimeout(r, 500)); // rate limit
      } catch (err: any) {
        results.push({
          market_a: { slug: mA.slug },
          market_b: { slug: mB.slug },
          error: err.message,
        });
      }
    }

    const dependencies = results.filter(r => r.analysis?.has_dependency);

    const payload = JSON.stringify({
      ok: true,
      pairs_analyzed: results.length,
      dependencies_found: dependencies.length,
      results,
      dependencies,
      note: "Claude API alapú elemzés. Magas confidence (>0.8) esetén manuális verifikáció ajánlott.",
    });

    try { await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}
    return new Response(payload, { status: 200, headers: CORS });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
