// netlify/functions/_resolution-risk.ts
// Shared logic for Resolution Risk scoring.
// Used by /resolution-risk.mts endpoint AND /signal-combiner.mts patch.
//
// Reference: "E[X]adjusted = P(YES) - price - resolution_risk - execution_drag"
// The original signal-combiner only computes the first two terms.
// This module estimates resolution_risk from market metadata (rules, source, deadline).

import { getStore } from "@netlify/blobs";

// ─── TYPES ────────────────────────────────────────────────────────────────────
export interface ResolutionFactor {
  name: string;
  weight: number;
  score: number;        // [0-1]  higher = riskier
  description: string;
}

export interface ResolutionRiskScore {
  score: number;                       // [0-1] weighted total
  category: "LOW" | "MEDIUM" | "HIGH" | "SKIP";
  factors: ResolutionFactor[];
  adjustedProbMultiplier: number;      // final_prob × multiplier
  recommendation: string;
  analysedAt: string;
  source: "heuristic" | "claude" | "fallback";
  biggestRisk?: string;
}

export interface MarketMeta {
  question:         string;
  slug:             string;
  rules:            string;
  resolutionSource: string;
  endDate:          string;
  category:         string;
  closed?:          boolean;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const GAMMA     = "https://gamma-api.polymarket.com";
const CACHE_TTL = 30 * 60 * 1000;   // 30 min – rules rarely change
const STORE_KEY = "resolution-risk-v1";

export const FACTOR_WEIGHTS: Record<string, number> = {
  source_clarity:      0.25,
  deadline_precision:  0.20,
  wording_ambiguity:   0.25,
  historical_disputes: 0.15,
  source_availability: 0.15,
};

const FACTOR_NAMES = Object.keys(FACTOR_WEIGHTS);

// ─── SCORE UTILITIES ──────────────────────────────────────────────────────────
export function categorize(score: number): "LOW" | "MEDIUM" | "HIGH" | "SKIP" {
  if (score < 0.15) return "LOW";
  if (score < 0.35) return "MEDIUM";
  if (score < 0.60) return "HIGH";
  return "SKIP";
}

export function multiplier(score: number): number {
  if (score < 0.15) return 0.97;
  if (score < 0.35) return 0.85;
  if (score < 0.60) return 0.70;
  return 0.0;
}

function clamp01(v: any): number {
  const n = parseFloat(v);
  if (isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function totalScore(factors: ResolutionFactor[]): number {
  let s = 0;
  for (const f of factors) s += f.weight * f.score;
  return Math.min(1, Math.max(0, s));
}

function buildFactors(scores: Record<string, { score: number; explanation: string }>): ResolutionFactor[] {
  return FACTOR_NAMES.map(name => ({
    name,
    weight: FACTOR_WEIGHTS[name],
    score: clamp01(scores[name]?.score),
    description: scores[name]?.explanation || "",
  }));
}

function buildScore(
  factors: ResolutionFactor[],
  source: "heuristic" | "claude" | "fallback",
  recommendation: string,
  biggestRisk?: string,
): ResolutionRiskScore {
  const s = totalScore(factors);
  return {
    score: parseFloat(s.toFixed(4)),
    category: categorize(s),
    factors,
    adjustedProbMultiplier: multiplier(s),
    recommendation,
    analysedAt: new Date().toISOString(),
    source,
    biggestRisk,
  };
}

// ─── HEURISTICS ───────────────────────────────────────────────────────────────
// Claude API is expensive; cover known market templates here first.
// Return null → fall through to Claude.
export function quickHeuristic(m: MarketMeta): ResolutionRiskScore | null {
  const slug = (m.slug || "").toLowerCase();
  const q    = (m.question || "").toLowerCase();
  const cat  = (m.category || "").toLowerCase();

  // Closed or expired → SKIP
  if (m.closed || (m.endDate && new Date(m.endDate).getTime() < Date.now())) {
    const factors = buildFactors({
      source_clarity:      { score: 1, explanation: "Market already closed" },
      deadline_precision:  { score: 1, explanation: "Market already closed" },
      wording_ambiguity:   { score: 1, explanation: "Market already closed" },
      historical_disputes: { score: 1, explanation: "Market already closed" },
      source_availability: { score: 1, explanation: "Market already closed" },
    });
    return buildScore(factors, "heuristic", "Market is closed/expired – do not trade",
      "Market no longer tradable");
  }

  // BTC / ETH short-interval binary markets – standardised oracles
  if (/\b(btc|eth)\b.*(up|down)/.test(slug) ||
      /(btc|eth)-?(up|down)-\d+[mh]/.test(slug) ||
      /(bitcoin|ethereum).*(up or down|above|below).*\d+/.test(q)) {
    const factors = buildFactors({
      source_clarity:      { score: 0.10, explanation: "Standardised crypto price oracle" },
      deadline_precision:  { score: 0.05, explanation: "Fixed timestamp cutoff" },
      wording_ambiguity:   { score: 0.10, explanation: "Template-based above/below wording" },
      historical_disputes: { score: 0.08, explanation: "BTC/ETH up-down markets rarely disputed" },
      source_availability: { score: 0.10, explanation: "Crypto feeds are reliable" },
    });
    return buildScore(factors, "heuristic",
      "Standardised BTC/ETH binary – well-defined oracle",
      "Oracle-source switch risk is the only real concern");
  }

  // Weather temperature markets – METAR rounding & timezone risk
  if (/highest-temperature|temperature|temp-in|weather/.test(slug) ||
      /temperature|degrees|°f|°c/.test(q)) {
    const factors = buildFactors({
      source_clarity:      { score: 0.35, explanation: "METAR station but rounding convention varies" },
      deadline_precision:  { score: 0.45, explanation: "Local-time day boundary vs UTC METAR timestamps" },
      wording_ambiguity:   { score: 0.40, explanation: "'Highest' can mean hourly peak vs METAR 6-hour max" },
      historical_disputes: { score: 0.35, explanation: "Weather markets have been disputed historically" },
      source_availability: { score: 0.30, explanation: "Wunderground may lag at the critical timestamp" },
    });
    return buildScore(factors, "heuristic",
      "Weather market: METAR rounding + timezone interpretation risk",
      "Timezone + METAR rounding can flip close calls");
  }

  // Sports – official league feeds, low risk baseline
  if (cat === "sports" ||
      /nfl|nba|nhl|mlb|super bowl|world cup|playoff|champions league|premier league/.test(q)) {
    const factors = buildFactors({
      source_clarity:      { score: 0.12, explanation: "Official league box score" },
      deadline_precision:  { score: 0.10, explanation: "Game end time is unambiguous" },
      wording_ambiguity:   { score: 0.15, explanation: "Win/loss outcome is clear" },
      historical_disputes: { score: 0.12, explanation: "Sports results rarely disputed" },
      source_availability: { score: 0.12, explanation: "Official results published promptly" },
    });
    return buildScore(factors, "heuristic",
      "Sports market – official results, low settlement risk");
  }

  // Vague political "by end of X" – typically needs Claude, but early warn
  if (/\bby (end of )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(m.question) ||
      /will .* happen (by|before)/i.test(m.question)) {
    if (!m.rules || m.rules.length < 120) {
      // Rules too thin to judge → moderate-high risk
      const factors = buildFactors({
        source_clarity:      { score: 0.55, explanation: "Rules text is too short to identify concrete source" },
        deadline_precision:  { score: 0.50, explanation: "'By end of' across timezones is ambiguous" },
        wording_ambiguity:   { score: 0.55, explanation: "'Happen' / 'major' without concrete threshold" },
        historical_disputes: { score: 0.50, explanation: "Politics is Polymarket's most-disputed category" },
        source_availability: { score: 0.40, explanation: "'Major news outlets' — count & identity undefined" },
      });
      return buildScore(factors, "heuristic",
        "Political 'by deadline' market with thin rules – elevated dispute risk",
        "Rules text is too thin to rely on; consider skipping or sizing tiny");
    }
    // Rules long enough — let Claude analyse the text
    return null;
  }

  // Fall-through → Claude
  return null;
}

// ─── CLAUDE PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT =
`You are a Polymarket prediction market settlement analyst. Your task is to
analyse a market's resolution rules text and identify potential resolution
risks. You must answer ONLY with valid JSON, no other text, no prose.

Rate each factor on 0.0–1.0 (0 = perfectly clear, 1 = critically ambiguous):
- source_clarity:      Is the settlement source named and reliable?
- deadline_precision:  Is the cutoff datetime (with timezone) precisely defined?
- wording_ambiguity:   Are the question's key terms ("reach", "close above",
                       "major", "confirmed") unambiguous?
- historical_disputes: How likely is this market class to trigger disputes?
- source_availability: Will the source be automatically queryable at resolution?

Category guidance:
  0.0–0.2 fully clear
  0.2–0.4 minor risk
  0.4–0.6 moderate risk
  0.6–0.8 high risk
  0.8–1.0 critically ambiguous`;

function buildUserPrompt(m: MarketMeta): string {
  const rules = (m.rules || "").slice(0, 2500);  // cap tokens
  return `Analyse this Polymarket market:

Question: ${m.question}
Resolution rules: ${rules || "(none provided)"}
Resolution source: ${m.resolutionSource || "(not specified)"}
Cutoff / end date: ${m.endDate || "(not specified)"}
Category: ${m.category || "(unknown)"}

Respond with this exact JSON shape:
{
  "factors": {
    "source_clarity":      { "score": 0.0, "explanation": "..." },
    "deadline_precision":  { "score": 0.0, "explanation": "..." },
    "wording_ambiguity":   { "score": 0.0, "explanation": "..." },
    "historical_disputes": { "score": 0.0, "explanation": "..." },
    "source_availability": { "score": 0.0, "explanation": "..." }
  },
  "overall_recommendation": "one sentence for a trader",
  "biggest_risk": "one sentence naming the top risk"
}`;
}

async function callClaude(userPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key":         apiKey,
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 900,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(18000),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json() as any;
  return data.content?.[0]?.text || "";
}

function parseClaude(text: string): ResolutionRiskScore | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const j = JSON.parse(match[0]);
    if (!j.factors) return null;
    const factors = buildFactors(j.factors);
    return buildScore(
      factors,
      "claude",
      j.overall_recommendation || "Claude analysis completed",
      j.biggest_risk,
    );
  } catch {
    return null;
  }
}

// Heuristic fallback when Claude fails – unknown category
function fallbackScore(m: MarketMeta): ResolutionRiskScore {
  const rulesLen = (m.rules || "").length;
  const hasSource = !!(m.resolutionSource && m.resolutionSource.length > 3);
  const hasDeadline = !!(m.endDate && m.endDate.length > 5);

  const factors = buildFactors({
    source_clarity:      {
      score: hasSource ? 0.30 : 0.55,
      explanation: hasSource ? "Source field populated" : "No explicit resolution source",
    },
    deadline_precision:  {
      score: hasDeadline ? 0.25 : 0.55,
      explanation: hasDeadline ? "End date present" : "No end date specified",
    },
    wording_ambiguity:   {
      score: rulesLen > 400 ? 0.30 : 0.50,
      explanation: rulesLen > 400 ? "Rules text has useful detail" : "Rules text is thin",
    },
    historical_disputes: {
      score: 0.35,
      explanation: "Unknown category — mid-tier dispute prior",
    },
    source_availability: {
      score: 0.35,
      explanation: "Unknown source — assume moderate availability risk",
    },
  });

  return buildScore(factors, "fallback",
    "Claude unavailable — conservative heuristic applied",
    "Analysis service unavailable");
}

// ─── GAMMA API: fetch market metadata ─────────────────────────────────────────
export async function fetchMarketMeta(slug: string): Promise<MarketMeta | null> {
  if (!slug) return null;
  const baseSlug = slug.replace(/-\d+$/, "");

  // Prefer events API (gives tags + description)
  try {
    const evRes = await fetch(
      `${GAMMA}/events?slug=${encodeURIComponent(baseSlug)}&limit=5`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (evRes.ok) {
      const events: any[] = await evRes.json().then(d => Array.isArray(d) ? d : []);
      for (const evt of events) {
        for (const m of (evt.markets || [])) {
          if ((m.slug || "") === slug ||
              (m.slug || "").includes(baseSlug.slice(0, 20))) {
            const tags = evt.tags || m.tags || [];
            const cat  = Array.isArray(tags) && tags[0]
              ? ((typeof tags[0] === "object" ? tags[0].label : tags[0]) || "").toString()
              : "";
            return {
              question:         m.question || m.title || evt.title || "",
              slug:             m.slug || slug,
              rules:            m.description || evt.description || "",
              resolutionSource: m.resolutionSource || "",
              endDate:          m.endDate || evt.endDate || "",
              category:         cat,
              closed:           !!m.closed,
            };
          }
        }
      }
    }
  } catch {}

  // Direct markets endpoint fallback
  try {
    const res = await fetch(
      `${GAMMA}/markets?slug=${encodeURIComponent(slug)}&limit=1`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (res.ok) {
      const arr: any[] = await res.json().then(d => Array.isArray(d) ? d : []);
      const m = arr[0];
      if (m) {
        return {
          question:         m.question || "",
          slug:             m.slug || slug,
          rules:            m.description || "",
          resolutionSource: m.resolutionSource || "",
          endDate:          m.endDate || "",
          category:         "",
          closed:           !!m.closed,
        };
      }
    }
  } catch {}

  return null;
}

// ─── MAIN ENTRY: cached analysis by slug ──────────────────────────────────────
// Used by both the Netlify function and signal-combiner.
// Graceful: never throws. Returns null if analysis completely impossible.
export async function analyseResolutionRisk(
  slugOrMeta: string | MarketMeta,
  opts: { useCache?: boolean; allowClaude?: boolean } = {},
): Promise<ResolutionRiskScore | null> {
  const useCache    = opts.useCache    !== false;
  const allowClaude = opts.allowClaude !== false;

  let meta: MarketMeta | null;
  if (typeof slugOrMeta === "string") {
    meta = await fetchMarketMeta(slugOrMeta);
  } else {
    meta = slugOrMeta;
  }
  if (!meta) return null;

  const cacheKey = `risk:${meta.slug}`;
  let store: any = null;
  if (useCache) {
    try { store = getStore(STORE_KEY); } catch {}
  }

  // Skip cache if market already closed (return SKIP immediately)
  const isExpired = meta.closed ||
    (meta.endDate && new Date(meta.endDate).getTime() < Date.now());

  if (store && !isExpired) {
    try {
      const cached = await store.getWithMetadata(cacheKey);
      if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < CACHE_TTL) {
        try { return JSON.parse(cached.data as string) as ResolutionRiskScore; } catch {}
      }
    } catch {}
  }

  // 1. Heuristic first
  const heuristic = quickHeuristic(meta);
  if (heuristic) {
    if (store && !isExpired) {
      try { await store.set(cacheKey, JSON.stringify(heuristic), { metadata: { ts: Date.now() } }); } catch {}
    }
    return heuristic;
  }

  // 2. Claude (if allowed and configured)
  if (allowClaude && process.env.ANTHROPIC_API_KEY) {
    try {
      const raw    = await callClaude(buildUserPrompt(meta));
      const parsed = parseClaude(raw);
      if (parsed) {
        if (store && !isExpired) {
          try { await store.set(cacheKey, JSON.stringify(parsed), { metadata: { ts: Date.now() } }); } catch {}
        }
        return parsed;
      }
    } catch {
      // fall through to fallback
    }
  }

  // 3. Fallback
  const fb = fallbackScore(meta);
  // Do not cache fallback – we want to retry Claude next time
  return fb;
}

// ─── SIGNAL-COMBINER ADJUSTMENT ───────────────────────────────────────────────
export interface AdjustedSignalFields {
  resolution_risk:       ResolutionRiskScore;
  adjusted_probability:  number;
  adjusted_edge_pct:     number;
  trade_recommended:     boolean;
  trade_blocked_reason?: string;
}

export function applyResolutionAdjustment(
  finalProb:     number,
  marketYesPrice: number,
  risk:          ResolutionRiskScore,
  edgeThreshold: number = 0.03,
): AdjustedSignalFields {
  const adjusted_prob = finalProb * risk.adjustedProbMultiplier;
  const adjusted_edge = adjusted_prob - marketYesPrice;

  // Trade side doesn't matter for the threshold — we want |edge| > threshold
  const absEdge = Math.abs(adjusted_edge);
  const trade_recommended =
    risk.category !== "SKIP" &&
    absEdge > edgeThreshold;

  let trade_blocked_reason: string | undefined;
  if (!trade_recommended) {
    if (risk.category === "SKIP") {
      trade_blocked_reason = `Resolution risk too high: ${risk.recommendation}`;
    } else {
      trade_blocked_reason =
        `Adjusted edge ${(absEdge * 100).toFixed(1)}% below ${(edgeThreshold * 100).toFixed(1)}% threshold`;
    }
  }

  return {
    resolution_risk:      risk,
    adjusted_probability: parseFloat(adjusted_prob.toFixed(4)),
    adjusted_edge_pct:    parseFloat((adjusted_edge * 100).toFixed(2)),
    trade_recommended,
    trade_blocked_reason,
  };
}
