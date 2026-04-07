// netlify/functions/orderflow-analysis.mts
// GET /.netlify/functions/orderflow-analysis?token_id=<id>&limit=200
//
// Lekéri az utolsó N trade-et a Polymarket CLOB API-ról,
// majd kiszámolja:
//   - Kyle's λ (price impact coefficient)
//   - VPIN (Volume-synchronized Probability of Informed Trading)
//   - Hawkes branching ratio (naïv becslés)
//   - Spread recommendation

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const CLOB = "https://clob.polymarket.com";
const CACHE_TTL = 5 * 60 * 1000; // 5 perc

// ─── Kyle's Lambda becslés ────────────────────────────────────────────────────
// Δp_t = λ * Q_t + ε  (OLS regresszió)
function estimateKyleLambda(prices: number[], volumes: number[], sides: number[]) {
  // price changes
  const dP: number[] = [];
  const Q:  number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const dp = prices[i] - prices[i - 1];
    const q  = volumes[i] * sides[i]; // signed volume
    if (dp !== 0) { dP.push(dp); Q.push(q); }
  }

  if (Q.length < 10) return null;

  // OLS: slope = cov(Q, dP) / var(Q)
  const n    = Q.length;
  const meanQ  = Q.reduce((s, v) => s + v, 0) / n;
  const meanDP = dP.reduce((s, v) => s + v, 0) / n;
  let covQDP = 0, varQ = 0;
  for (let i = 0; i < n; i++) {
    covQDP += (Q[i] - meanQ) * (dP[i] - meanDP);
    varQ   += (Q[i] - meanQ) ** 2;
  }
  const lambda = varQ > 0 ? covQDP / varQ : 0;

  // R² számítás
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = lambda * Q[i];
    ssTot += (dP[i] - meanDP) ** 2;
    ssRes += (dP[i] - predicted) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return {
    lambda,
    r_squared: Math.max(0, r2),
    n_obs: n,
    interpretation: lambda > 0.002 ? "HIGH informed trading" :
                    lambda > 0.001 ? "MODERATE informed trading" :
                    "LOW – normal liquidity",
    danger: lambda > 0.002,
  };
}

// ─── VPIN számítás ────────────────────────────────────────────────────────────
function computeVPIN(buyVols: number[], sellVols: number[], bucketSize = 20) {
  const nBuckets = Math.floor(buyVols.length / bucketSize);
  if (nBuckets < 2) return null;

  const vpins: number[] = [];
  for (let i = 0; i < nBuckets; i++) {
    let vBuy = 0, vSell = 0;
    for (let j = i * bucketSize; j < (i + 1) * bucketSize; j++) {
      vBuy  += buyVols[j]  || 0;
      vSell += sellVols[j] || 0;
    }
    const total = vBuy + vSell;
    if (total > 0) vpins.push(Math.abs(vBuy - vSell) / total);
  }

  const current = vpins[vpins.length - 1] ?? 0;
  const avg     = vpins.reduce((s, v) => s + v, 0) / vpins.length;

  return {
    current,
    average: avg,
    history: vpins.slice(-20),
    signal: current > 0.80 ? "PULL_QUOTES" :
            current > 0.65 ? "WIDEN_SPREAD" :
            current > 0.40 ? "CAUTION" :
            "NORMAL",
    danger: current > 0.65,
  };
}

// ─── Hawkes branching ratio (naïv becslés) ────────────────────────────────────
// Teljes MLE helyett a Moller-Rasmussen naïv becslőt használjuk
// ami O(n) és elég megbízható ha elég adat van
function estimateHawkesBranching(timestamps: number[]) {
  if (timestamps.length < 20) return null;

  const T  = timestamps[timestamps.length - 1] - timestamps[0];
  const n  = timestamps.length;
  const mu = n / T; // baseline (ha nem lennének klaszterek)

  // Inter-arrival idők átlaga és varianciája
  const iats: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    iats.push(timestamps[i] - timestamps[i - 1]);
  }
  const meanIAT = iats.reduce((s, v) => s + v, 0) / iats.length;
  const varIAT  = iats.reduce((s, v) => s + (v - meanIAT) ** 2, 0) / iats.length;

  // Index of Dispersion (CoV²) – ha > 1, klaszterezés van
  const iod = varIAT / (meanIAT ** 2);

  // Naïv branching ratio becslés: br ≈ 1 - 1/sqrt(IOD) ha IOD > 1
  const branchingRatio = iod > 1 ? Math.min(0.95, 1 - 1 / Math.sqrt(iod)) : 0;

  return {
    branching_ratio: branchingRatio,
    index_of_dispersion: iod,
    baseline_intensity: mu,
    interpretation: branchingRatio > 0.8 ? "Market running HOT – self-exciting order flow" :
                    branchingRatio > 0.6 ? "Elevated clustering – follow the momentum" :
                    "Normal order arrival",
    danger: branchingRatio > 0.8,
  };
}

// ─── Spread recommendation ────────────────────────────────────────────────────
function spreadRecommendation(
  vpin:   ReturnType<typeof computeVPIN>,
  kyle:   ReturnType<typeof estimateKyleLambda>,
  hawkes: ReturnType<typeof estimateHawkesBranching>,
  midPrice: number
) {
  let baseSpread = 0.03; // 3¢ alap
  const reasons: string[] = [];

  if (vpin?.danger)    { baseSpread *= 2.5; reasons.push("VPIN magas – informed flow"); }
  if (kyle?.danger)    { baseSpread *= 2.0; reasons.push("Kyle λ magas – price impact erős"); }
  if (hawkes?.danger)  { baseSpread *= 1.5; reasons.push("Hawkes HOT – klaszteres flow"); }

  // Szélső áraknál természetesen szűkebb a spread
  const distFromEdge = Math.min(midPrice, 1 - midPrice);
  if (distFromEdge < 0.1) baseSpread *= 0.5;

  const action = vpin?.signal === "PULL_QUOTES"  ? "NE KERESKEDJ – húzd vissza az ajánlatokat" :
                 vpin?.signal === "WIDEN_SPREAD"  ? "SZÉLESÍTSD a spreadet" :
                 reasons.length > 0              ? "ÓVATOSAN – emelt spread ajánlott" :
                                                   "NORMÁL – standard spread megfelelő";

  return {
    recommended_spread: Math.min(0.15, baseSpread),
    bid: Math.max(0.01, midPrice - baseSpread / 2),
    ask: Math.min(0.99, midPrice + baseSpread / 2),
    action,
    reasons,
    pull_quotes: vpin?.signal === "PULL_QUOTES",
  };
}

// ─── CLOB trade history lekérés ───────────────────────────────────────────────
async function fetchTrades(tokenId: string, limit: number) {
  const url = `${CLOB}/trades?market=${encodeURIComponent(tokenId)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`CLOB trades ${res.status}`);
  const data = await res.json() as any;
  return Array.isArray(data) ? data : (data.data || data.trades || []);
}

// ─── CLOB midpoint ────────────────────────────────────────────────────────────
async function fetchMid(tokenId: string): Promise<number> {
  try {
    const res = await fetch(`${CLOB}/midpoint?token_id=${encodeURIComponent(tokenId)}`, {
      signal: AbortSignal.timeout(4000),
    });
    const d = await res.json() as any;
    return parseFloat(d.mid || 0.5);
  } catch { return 0.5; }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url     = new URL(req.url);
  const tokenId = url.searchParams.get("token_id");
  const limit   = Math.min(500, parseInt(url.searchParams.get("limit") || "200"));

  if (!tokenId) {
    return new Response(JSON.stringify({ ok: false, error: "token_id required" }), { status: 400, headers: CORS });
  }

  // Cache ellenőrzés
  try {
    const store  = getStore("orderflow-cache");
    const cKey   = `of:${tokenId}:${limit}`;
    let cached: any = null; try { cached = store ? await store.getWithMetadata(cKey); } catch {}
    if (cached?.metadata) {
      const age = Date.now() - ((cached.metadata as any).ts || 0);
      if (age < CACHE_TTL) {
        return new Response(cached.data as string, {
          status: 200,
          headers: { ...CORS, "X-Cache": "HIT" },
        });
      }
    }

    // Friss adat
    const [trades, mid] = await Promise.all([
      fetchTrades(tokenId, limit),
      fetchMid(tokenId),
    ]);

    if (!trades.length) {
      return new Response(JSON.stringify({ ok: false, error: "no trades found" }), { status: 404, headers: CORS });
    }

    // Parse trades
    const prices:     number[] = [];
    const volumes:    number[] = [];
    const sides:      number[] = []; // +1 buy, -1 sell
    const buyVols:    number[] = [];
    const sellVols:   number[] = [];
    const timestamps: number[] = [];

    for (const t of trades) {
      const p    = parseFloat(t.price || t.tradePrice || 0);
      const size = parseFloat(t.size  || t.amount || 0);
      const side = (t.side || t.makerSide || "").toUpperCase() === "BUY" ? 1 : -1;
      const ts   = t.timestamp ? new Date(t.timestamp).getTime() / 1000 : 0;

      if (p > 0 && size > 0) {
        prices.push(p);
        volumes.push(size);
        sides.push(side);
        buyVols.push(side === 1 ? size : 0);
        sellVols.push(side === -1 ? size : 0);
        if (ts > 0) timestamps.push(ts);
      }
    }

    const kyle   = estimateKyleLambda(prices, volumes, sides);
    const vpin   = computeVPIN(buyVols, sellVols, 20);
    const hawkes = timestamps.length >= 20 ? estimateHawkesBranching(timestamps) : null;
    const spread = spreadRecommendation(vpin, kyle, hawkes, mid);

    const payload = JSON.stringify({
      ok: true,
      token_id:   tokenId,
      mid_price:  mid,
      n_trades:   prices.length,
      analyzed_at: new Date().toISOString(),
      kyle_lambda: kyle,
      vpin,
      hawkes,
      spread_recommendation: spread,
    });

    try { if (store) await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}

    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
