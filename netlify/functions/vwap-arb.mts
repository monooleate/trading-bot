// netlify/functions/vwap-arb.mts
// GET /.netlify/functions/vwap-arb?slug=market-slug
// GET /.netlify/functions/vwap-arb?action=scan  ← top markets scan
//
// Per-block VWAP alapú arbitrázs kalkulátor.
// A cikk módszertana: ha |VWAP_yes + VWAP_no - 1.0| > 0.02 → arbitrázs lehetőség
//
// Különbség a locked profit scannertől:
//   - Mid price helyett VWAP-ot használ (valódi kitölthető ár)
//   - Order book depth alapján méretezi a pozíciót
//   - Slippage becslés beépítve
//   - $0.05 minimum profit threshold (a paper alapján)

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const CLOB  = "https://clob.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const CACHE_TTL = 90 * 1000; // 90 mp

// A paper $0.05 minimum thresholdot használt (execution risk miatt)
const MIN_PROFIT_THRESHOLD = 0.05;
const POLYMARKET_FEE       = 0.02; // taker fee/oldal

// ─── Order book fetch ─────────────────────────────────────────────────────────
async function fetchOrderBook(tokenId: string): Promise<any> {
  const res = await fetch(`${CLOB}/book?token_id=${tokenId}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`OrderBook ${res.status}`);
  return res.json();
}

// ─── VWAP számítás order book alapján ────────────────────────────────────────
// Szimulálja az adott méretű order kitöltését az order book-on
function calcVWAP(
  orders: { price: string; size: string }[],
  side: "buy" | "sell",
  targetSize: number = 100, // USDC-ben
): { vwap: number; filled: number; slippage: number; levels: number } {
  if (!orders?.length) return { vwap: 0, filled: 0, slippage: 0, levels: 0 };

  // Buy: asks alapján (legalacsonyabb ártól), Sell: bids alapján (legmagasabb ártól)
  const sorted = [...orders].sort((a, b) =>
    side === "buy"
      ? parseFloat(a.price) - parseFloat(b.price)   // asks: alacsonyabbtól
      : parseFloat(b.price) - parseFloat(a.price)   // bids: magasabbtól
  );

  let totalCost   = 0;
  let totalTokens = 0;
  let levels      = 0;
  let remaining   = targetSize;

  for (const level of sorted) {
    if (remaining <= 0) break;
    const price   = parseFloat(level.price);
    const size    = parseFloat(level.size);
    const canFill = Math.min(remaining / price, size); // tokenek
    const cost    = canFill * price;

    totalCost   += cost;
    totalTokens += canFill;
    remaining   -= cost;
    levels++;
  }

  if (totalTokens === 0) return { vwap: 0, filled: 0, slippage: 0, levels: 0 };

  const vwap          = totalCost / totalTokens;
  const bestPrice     = parseFloat(sorted[0]?.price || "0");
  const slippage      = side === "buy"
    ? vwap - bestPrice    // buy: fizettünk többet mint a legjobb ask
    : bestPrice - vwap;   // sell: kaptunk kevesebbet mint a legjobb bid

  return {
    vwap:     parseFloat(vwap.toFixed(6)),
    filled:   parseFloat(totalCost.toFixed(2)),
    slippage: parseFloat(slippage.toFixed(6)),
    levels,
  };
}

// ─── Arbitrázs analízis egy piacon ───────────────────────────────────────────
async function analyzeMarket(market: any, positionSize: number = 200): Promise<any> {
  const tokens = market.tokens || [];
  const yesToken = tokens.find((t: any) =>
    (t.outcome || "").toUpperCase() === "YES" ||
    (t.outcome || "").toUpperCase() === "UP"
  );
  const noToken = tokens.find((t: any) =>
    (t.outcome || "").toUpperCase() === "NO" ||
    (t.outcome || "").toUpperCase() === "DOWN"
  );

  if (!yesToken?.token_id || !noToken?.token_id) return null;

  try {
    const [yesBook, noBook] = await Promise.all([
      fetchOrderBook(yesToken.token_id),
      fetchOrderBook(noToken.token_id),
    ]);

    // VWAP kalkuláció: megvesszük mind a YES-t, mind a NO-t
    const yesVwap = calcVWAP(yesBook.asks, "buy", positionSize);
    const noVwap  = calcVWAP(noBook.asks,  "buy", positionSize);

    if (!yesVwap.vwap || !noVwap.vwap) return null;

    // Arbitrázs feltétel: VWAP_yes + VWAP_no < 1.0 - fees
    const grossCost   = yesVwap.vwap + noVwap.vwap;
    const feeCost     = (yesVwap.vwap + noVwap.vwap) * POLYMARKET_FEE;
    const netProfit   = 1.0 - grossCost - feeCost;

    // Max kitölthető méret (min a két oldal likviditásából)
    const maxSize     = Math.min(yesVwap.filled, noVwap.filled);
    const maxProfit   = maxSize * netProfit;

    // Mid price alapú (régi módszer) vs VWAP alapú különbség
    const yesMid = parseFloat(yesToken.price || 0.5);
    const noMid  = parseFloat(noToken.price  || 0.5);
    const midGross = yesMid + noMid;

    return {
      slug:          market.slug || "",
      question:      market.question || "",
      yes_vwap:      yesVwap.vwap,
      no_vwap:       noVwap.vwap,
      gross_cost:    parseFloat(grossCost.toFixed(4)),
      fee_cost:      parseFloat(feeCost.toFixed(4)),
      net_profit:    parseFloat(netProfit.toFixed(4)),
      net_profit_pct: parseFloat((netProfit * 100).toFixed(2)),
      max_position:  parseFloat(maxSize.toFixed(2)),
      max_profit:    parseFloat(maxProfit.toFixed(2)),
      has_edge:      netProfit > MIN_PROFIT_THRESHOLD,
      above_threshold: netProfit > MIN_PROFIT_THRESHOLD,
      // Összehasonlítás mid price-szal
      mid_gross:     parseFloat(midGross.toFixed(4)),
      mid_apparent_edge: parseFloat(((1 - midGross) * 100).toFixed(2)),
      vwap_vs_mid_diff: parseFloat(((grossCost - midGross) * 100).toFixed(2)),
      // Slippage info
      yes_slippage:  yesVwap.slippage,
      no_slippage:   noVwap.slippage,
      yes_levels:    yesVwap.levels,
      no_levels:     noVwap.levels,
      signal: netProfit > MIN_PROFIT_THRESHOLD ? "EXECUTE" :
              netProfit > 0                    ? "MARGINAL – fee language edge" :
                                                 "NO_EDGE",
    };
  } catch (err: any) {
    return { slug: market.slug, error: err.message };
  }
}

// ─── Top markets scan ─────────────────────────────────────────────────────────
async function scanTopMarkets(limit = 20): Promise<any[]> {
  const res = await fetch(
    `${GAMMA}/markets?active=true&closed=false&limit=${limit}&order=volume24hr&ascending=false`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`Gamma ${res.status}`);
  const data = await res.json() as any;
  return Array.isArray(data) ? data : (data.markets || []);
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get("action") || "scan";
  const slug   = url.searchParams.get("slug");
  const size   = parseInt(url.searchParams.get("size") || "200");

  let store: any = null;

  try { store = getStore("vwap-arb-cache-v3"); } catch {}
  const cKey  = slug ? `market:${slug}` : `scan:${action}`;

  try {
    let cached: any = null; try { cached = store ? await store.getWithMetadata(cKey) : null; } catch {}
    if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < CACHE_TTL) {
      return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
    }
  } catch {}

  try {
    let result: any;

    if (slug) {
      // Egy konkrét piac
      const markets = await scanTopMarkets(50);
      const market  = markets.find((m: any) => m.slug === slug);
      if (!market) {
        return new Response(JSON.stringify({ ok: false, error: "Market not found" }), { status: 404, headers: CORS });
      }
      const analysis = await analyzeMarket(market, size);
      result = { ok: true, market: analysis };
    } else {
      // Top markets scan
      const markets = await scanTopMarkets(20);

      // Rate limit miatt max 10 párhuzamosan
      const analyses: any[] = [];
      for (let i = 0; i < Math.min(markets.length, 10); i += 3) {
        const batch = markets.slice(i, i + 3);
        const results = await Promise.all(batch.map(m => analyzeMarket(m, size)));
        analyses.push(...results.filter(Boolean));
        await new Promise(r => setTimeout(r, 200)); // rate limit
      }

      const opportunities = analyses
        .filter(a => !a.error && a.has_edge)
        .sort((a, b) => b.net_profit - a.net_profit);

      const allValid = analyses.filter(a => !a.error);

      result = {
        ok: true,
        scanned:       allValid.length,
        opportunities: opportunities.length,
        min_threshold: MIN_PROFIT_THRESHOLD,
        best:          opportunities[0] || null,
        markets:       allValid.sort((a, b) => b.net_profit - a.net_profit).slice(0, 10),
        summary: {
          avg_mid_apparent_edge: parseFloat(
            (allValid.reduce((s, m) => s + (m.mid_apparent_edge || 0), 0) / Math.max(allValid.length, 1)).toFixed(2)
          ),
          avg_vwap_real_edge: parseFloat(
            (allValid.reduce((s, m) => s + (m.net_profit_pct || 0), 0) / Math.max(allValid.length, 1)).toFixed(2)
          ),
          mid_vs_vwap_gap: "Mid price a valódi kitölthető ár illúzióját kelti – VWAP pontosabb",
        },
      };
    }

    const payload = JSON.stringify(result);
    try { if (store) await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}
    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
