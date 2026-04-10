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
    // Skip closed/expired markets
    if (m.closed === true) continue;
    if (m.endDate && new Date(m.endDate).getTime() < Date.now()) continue;
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

// Mutual exclusion marker phrases - these markets CANNOT be implication chains
const MUTEX_PATTERNS = [
  /will .+ win the \d+ .+ world cup/i,
  /will .+ win the \d+ .+ championship/i,
  /will .+ win the \d+ nba finals/i,
  /will .+ win the \d+ nfl/i,
  /will .+ win the \d+ super bowl/i,
  /will .+ become .+ president/i,
];

function isMutuallyExclusive(qa: string, qb: string): boolean {
  // If both questions match the same competitive event pattern,
  // they are mutually exclusive - NOT an implication chain
  for (const pat of MUTEX_PATTERNS) {
    if (pat.test(qa) && pat.test(qb)) return true;
  }
  return false;
}

function checkMonotonicity(mHigh: any, mLow: any): any | null {
  // Skip mutual exclusion markets (e.g. "Will Brazil win WC?" vs "Will Switzerland win WC?")
  if (isMutuallyExclusive(mHigh.question || "", mLow.question || "")) return null;

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
      ["nba",      ["nba","nba finals","basketball finals"]],
      ["nfl",      ["nfl","super bowl","american football"]],
      ["soccer",   ["world cup","fifa","premier league","champions league"]],
      ["sports",   ["championship","stanley cup","mlb","world series"]],
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

  // 3. Event chain detection – temporal monotonicity across deadline-based markets
  const chains = detectEventChains(markets);
  for (const chain of chains) {
    for (const v of chain.violations) {
      violations.push(v);
    }
  }

  return violations.sort((a, b) => b.edge_cents - a.edge_cents).slice(0, 20);
}

// ─── EVENT CHAIN DETECTION ───────────────────────────────────────────────────
// Markets like "X by April 7", "X by April 15", "X by April 30"
// must satisfy P(earlier) ≤ P(later) — temporal monotonicity

const MONTHS: Record<string, number> = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};

function extractDeadline(question: string): Date | null {
  const q = question.toLowerCase();

  // "by April 7" / "by April 7, 2026" / "by april 30?"
  const byMatch = q.match(/by\s+(\w+)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
  if (byMatch) {
    const month = MONTHS[byMatch[1]];
    if (month) {
      const day  = parseInt(byMatch[2]);
      const year = byMatch[3] ? parseInt(byMatch[3]) : new Date().getFullYear();
      return new Date(year, month - 1, day);
    }
  }

  // "in May 2026" / "in May"
  const inMatch = q.match(/in\s+(\w+)\s*(\d{4})?/);
  if (inMatch) {
    const month = MONTHS[inMatch[1]];
    if (month) {
      const year = inMatch[2] ? parseInt(inMatch[2]) : new Date().getFullYear();
      return new Date(year, month, 0); // last day of month
    }
  }

  // "by Q1/Q2/Q3/Q4 2026"
  const qMatch = q.match(/by\s+q([1-4])\s+(\d{4})/);
  if (qMatch) {
    const quarter = parseInt(qMatch[1]);
    const year    = parseInt(qMatch[2]);
    return new Date(year, quarter * 3, 0); // last day of quarter
  }

  // "by December 31" / "by year end"
  if (q.includes("year end") || q.includes("end of year")) {
    const yearMatch = q.match(/(\d{4})/);
    const year = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();
    return new Date(year, 11, 31);
  }

  return null;
}

function extractBaseEvent(question: string): string {
  // Strip temporal markers to get base event
  return question
    .replace(/\?$/,  "")
    .replace(/by\s+\w+\s+\d{1,2}(,?\s*\d{4})?/gi, "")
    .replace(/by\s+q[1-4]\s+\d{4}/gi, "")
    .replace(/in\s+\w+\s*\d{0,4}/gi, "")
    .replace(/by\s+(year end|december \d+)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

interface EventChain {
  base_event:  string;
  markets:     { slug: string; question: string; yes_price: number; deadline: Date }[];
  violations:  any[];
  chain_score: number;
}

function detectEventChains(markets: any[]): EventChain[] {
  // Group markets by base event
  const eventGroups: Record<string, { slug: string; question: string; yes_price: number; deadline: Date }[]> = {};

  for (const m of markets) {
    const deadline = extractDeadline(m.question || "");
    if (!deadline) continue;
    const base = extractBaseEvent(m.question || "");
    if (base.length < 5) continue;

    if (!eventGroups[base]) eventGroups[base] = [];
    eventGroups[base].push({
      slug:      m.slug,
      question:  m.question,
      yes_price: m.yes_price,
      deadline,
    });
  }

  const chains: EventChain[] = [];

  for (const [base, group] of Object.entries(eventGroups)) {
    if (group.length < 2) continue;

    // Sort by deadline
    const sorted = [...group].sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
    const violations: any[] = [];

    // Check: P(earlier) ≤ P(later)
    for (let i = 0; i < sorted.length - 1; i++) {
      const earlier = sorted[i];
      const later   = sorted[i + 1];
      const diff    = earlier.yes_price - later.yes_price;

      if (diff > 0.03) { // 3¢ threshold
        violations.push({
          type:        "TEMPORAL_CHAIN",
          severity:    Math.min(1, diff / 0.15),
          edge_cents:  parseFloat((diff * 100).toFixed(1)),
          market_a:    earlier.slug,
          market_b:    later.slug,
          question_a:  earlier.question,
          question_b:  later.question,
          price_a:     earlier.yes_price,
          price_b:     later.yes_price,
          description: `EVENT CHAIN: P(${earlier.deadline.toLocaleDateString("en",{month:"short",day:"numeric"})})=${earlier.yes_price.toFixed(3)} > P(${later.deadline.toLocaleDateString("en",{month:"short",day:"numeric"})})=${later.yes_price.toFixed(3)}`,
          action:      `SELL "${earlier.question.slice(0,40)}..." @ ${earlier.yes_price.toFixed(3)} | BUY "${later.question.slice(0,40)}..." @ ${later.yes_price.toFixed(3)}`,
        });
      }
    }

    if (violations.length > 0 || sorted.length >= 3) {
      const chainScore = violations.reduce((s, v) => s + v.edge_cents, 0) / sorted.length;
      chains.push({ base_event: base, markets: sorted, violations, chain_score: parseFloat(chainScore.toFixed(1)) });
    }
  }

  return chains.sort((a, b) => b.chain_score - a.chain_score);
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
    const chains     = detectEventChains(markets);

    const payload = JSON.stringify({
      ok:               true,
      markets_analyzed: markets.length,
      violations_found: violations.length,
      violations,
      event_chains:     chains.map(c => ({
        base_event:     c.base_event,
        markets_count:  c.markets.length,
        chain_score:    c.chain_score,
        violations:     c.violations.length,
        markets:        c.markets.map(m => ({
          question:  m.question,
          slug:      m.slug,
          yes_price: m.yes_price,
          deadline:  m.deadline.toISOString().slice(0, 10),
        })),
      })),
      scanned_at:       new Date().toISOString(),
    });

    try { if (store) await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}
    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
