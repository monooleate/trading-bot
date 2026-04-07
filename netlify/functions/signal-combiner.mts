// netlify/functions/signal-combiner.mts
// GET /.netlify/functions/signal-combiner
//
// Fundamental Law of Active Management: IR = IC × √N
// Közvetlenül hívja a külső API-kat (nem belső functions)
// Output: combined_probability, kelly_fraction, BUY/SELL/WAIT ajánlás

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const GAMMA    = "https://gamma-api.polymarket.com";
const CLOB     = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const BINANCE    = "https://api.binance.com";
const BN_FUTURES = "https://fapi.binance.com";
const CACHE_TTL = 3 * 60 * 1000;

const SIGNAL_ICS: Record<string, number> = {
  vol_divergence: 0.06,
  orderflow:      0.09,
  apex_consensus: 0.08,
  cond_prob:      0.07,
  funding_rate:   0.05,
};

// ─── 1. VOL DIVERGENCE SIGNAL ─────────────────────────────────────────────────
async function getVolSignal(): Promise<{ prob: number | null; detail: any }> {
  try {
    // Binance 15m klines → realized vol
    const r = await fetch(
      `${BINANCE}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=15`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return { prob: null, detail: null };
    const klines = await r.json() as any[][];
    const closes = klines.map(k => parseFloat(k[4]));
    
    // Realized vol
    const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    const mean    = returns.reduce((s, v) => s + v, 0) / returns.length;
    const rv15    = Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length * 365 * 24 * 60) * 100;

    // Polymarket BTC piacok
    const mRes = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=10&order=volume24hr&ascending=false&tag_slug=crypto`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!mRes.ok) return { prob: 0.5 - rv15 / 1000, detail: { rv15 } };
    const mData = await mRes.json() as any;
    const markets = Array.isArray(mData) ? mData : (mData.markets || []);
    
    // BTC UP/DOWN piacok
    const btcMarkets = markets.filter((m: any) =>
      (m.question || "").toLowerCase().includes("btc") ||
      (m.question || "").toLowerCase().includes("bitcoin")
    ).slice(0, 3);

    // Átlag IV becslés
    let avgIV = rv15;
    if (btcMarkets.length > 0) {
      const prices = btcMarkets.map((m: any) => {
        try {
          const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          return parseFloat(op?.[0] || 0.5);
        } catch { return 0.5; }
      });
      const avgP = prices.reduce((s: number, v: number) => s + v, 0) / prices.length;
      const T    = 15 / (365 * 24 * 60);
      avgIV      = (2 * Math.abs(avgP - 0.5) / Math.sqrt(T)) * 100;
    }

    const spread = avgIV - rv15;
    // Magas IV spread → piac túláraz félelmet → NO side favored
    const prob = Math.max(0.1, Math.min(0.9, 0.5 - (spread / 100) * 0.4));
    return { prob, detail: { rv15: rv15.toFixed(1), iv: avgIV.toFixed(1), spread: spread.toFixed(1) } };
  } catch { return { prob: null, detail: null }; }
}

// ─── 2. ORDER FLOW SIGNAL (VPIN proxy) ────────────────────────────────────────
async function getOrderflowSignal(): Promise<{ prob: number | null; detail: any }> {
  try {
    // Top aktív piac CLOB adatai
    const mRes = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=5&order=volume24hr&ascending=false`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!mRes.ok) return { prob: null, detail: null };
    const mData = await mRes.json() as any;
    const markets = Array.isArray(mData) ? mData : (mData.markets || []);
    
    if (!markets.length) return { prob: null, detail: null };
    
    // Első piac YES token order book imbalance
    const firstMarket = markets[0];
    const tokens      = firstMarket.tokens || [];
    const yesToken    = tokens.find((t: any) =>
      (t.outcome || "").toUpperCase() === "YES"
    );
    
    if (!yesToken?.token_id) return { prob: 0.5, detail: { note: "no token" } };
    
    const bookRes = await fetch(`${CLOB}/book?token_id=${yesToken.token_id}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!bookRes.ok) return { prob: 0.5, detail: null };
    const book = await bookRes.json() as any;
    
    // Order book imbalance: bid volume vs ask volume
    const bidVol = (book.bids || []).reduce((s: number, b: any) => s + parseFloat(b.size || 0), 0);
    const askVol = (book.asks || []).reduce((s: number, a: any) => s + parseFloat(a.size || 0), 0);
    const total  = bidVol + askVol;
    
    if (total === 0) return { prob: 0.5, detail: null };
    
    // VPIN proxy: bid dominancia → YES side pressure
    const bidPct = bidVol / total;
    const prob   = Math.max(0.1, Math.min(0.9, 0.3 + bidPct * 0.4));
    return { prob, detail: { bid_pct: bidPct.toFixed(2), market: firstMarket.question?.slice(0, 40) } };
  } catch { return { prob: null, detail: null }; }
}

// ─── 3. APEX CONSENSUS SIGNAL ─────────────────────────────────────────────────
async function getApexSignal(): Promise<{ prob: number | null; detail: any }> {
  try {
    // Data API has no /leaderboard – fetch recent global trades, aggregate by wallet
    const tradesRes = await fetch(
      `${DATA_API}/trades?limit=500&sortBy=TIMESTAMP&sortDirection=DESC`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!tradesRes.ok) return { prob: null, detail: null };
    const allTrades: any[] = await tradesRes.json().then(d => Array.isArray(d) ? d : []);
    if (!allTrades.length) return { prob: null, detail: null };

    // Aggregate PnL per wallet to find top traders
    const walletMap: Record<string, { pnl: number; trades: any[] }> = {};
    for (const t of allTrades) {
      const addr = t.proxyWallet || t.maker || "";
      if (!addr) continue;
      if (!walletMap[addr]) walletMap[addr] = { pnl: 0, trades: [] };
      const size  = parseFloat(t.size  || 0);
      const price = parseFloat(t.price || 0);
      walletMap[addr].pnl += (t.side || "").toUpperCase() === "SELL" ? size * price : -(size * price);
      walletMap[addr].trades.push(t);
    }

    // Top 5 wallets by PnL
    const topWallets = Object.entries(walletMap)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .slice(0, 5);

    if (!topWallets.length) return { prob: null, detail: null };

    // Aggregate BUY/SELL across top wallets' recent trades
    let totalBuys = 0, totalTrades = 0;
    for (const [, data] of topWallets) {
      for (const t of data.trades.slice(0, 10)) {
        totalTrades++;
        if ((t.side || "").toUpperCase() === "BUY") totalBuys++;
      }
    }

    if (totalTrades === 0) return { prob: 0.5, detail: null };

    const buyPct = totalBuys / totalTrades;
    // Magas buy arány → pozitív consensus
    const prob = Math.max(0.1, Math.min(0.9, 0.5 + (buyPct - 0.5) * 0.6));
    return {
      prob,
      detail: {
        buy_pct: buyPct.toFixed(2),
        trades: totalTrades,
        top_wallets: topWallets.length,
        top_pnl: topWallets[0][1].pnl.toFixed(0),
      },
    };
  } catch { return { prob: null, detail: null }; }
}

// ─── 4. CONDITIONAL PROBABILITY SIGNAL ────────────────────────────────────────
async function getCondProbSignal(): Promise<{ prob: number | null; detail: any }> {
  try {
    // Top piacok complement check
    const mRes = await fetch(
      `${GAMMA}/markets?active=true&closed=false&limit=20&order=volume24hr&ascending=false`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!mRes.ok) return { prob: null, detail: null };
    const mData = await mRes.json() as any;
    const markets = Array.isArray(mData) ? mData : (mData.markets || []);
    
    let maxViolation = 0;
    let violationDir = 0; // +1 = YES túlárazott, -1 = NO túlárazott
    
    for (const m of markets.slice(0, 10)) {
      try {
        const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        if (!Array.isArray(op) || op.length < 2) continue;
        const yp = parseFloat(op[0]);
        const np = parseFloat(op[1]);
        const total = yp + np;
        const dev   = total - 1.0;
        if (Math.abs(dev) > Math.abs(maxViolation)) {
          maxViolation = dev;
          violationDir = dev > 0 ? -1 : 1; // sum > 1 → sell both → NO bias
        }
      } catch {}
    }
    
    if (Math.abs(maxViolation) < 0.02) return { prob: 0.5, detail: { max_violation: "none" } };
    
    // Violation irányából probability
    const prob = Math.max(0.1, Math.min(0.9, 0.5 + violationDir * Math.min(Math.abs(maxViolation), 0.3)));
    return { prob, detail: { max_violation_pct: (maxViolation * 100).toFixed(1) } };
  } catch { return { prob: null, detail: null }; }
}

// ─── 5. FUNDING RATE SIGNAL ───────────────────────────────────────────────────
async function getFundingSignal(): Promise<{ prob: number | null; detail: any }> {
  try {
    const res = await fetch(
      `${BN_FUTURES}/fapi/v1/premiumIndex?symbol=BTCUSDT`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { prob: null, detail: null };
    const data = await res.json() as any;
    const rate = parseFloat(data.lastFundingRate || 0);
    
    // Pozitív funding → long bias → YES favored
    const prob = Math.max(0.1, Math.min(0.9, 0.5 + rate * 50));
    return { prob, detail: { funding_rate: (rate * 100).toFixed(4) + "%" } };
  } catch { return { prob: null, detail: null }; }
}

// ─── KOMBINÁTOR ───────────────────────────────────────────────────────────────
function combine(signals: Record<string, number | null>) {
  const valid: Record<string, number> = {};
  for (const [k, v] of Object.entries(signals)) {
    if (v !== null && !isNaN(v)) valid[k] = v;
  }

  const names = Object.keys(valid);
  const n     = names.length;
  if (n === 0) return { combined: 0.5, weights: {}, ir: 0, kelly_q: 0, cv_edge: 1 };

  // Cross-sectional demeaning
  const mean = names.reduce((s, k) => s + valid[k], 0) / n;
  const demeaned: Record<string, number> = {};
  for (const k of names) demeaned[k] = valid[k] - mean;

  // IC-súlyozás
  let totalW = 0;
  const weights: Record<string, number> = {};
  for (const k of names) {
    const ic = SIGNAL_ICS[k] || 0.05;
    const w  = ic * (1 + Math.abs(demeaned[k]) * 0.5);
    weights[k] = w;
    totalW += w;
  }
  for (const k of names) weights[k] = parseFloat((weights[k] / totalW).toFixed(4));

  // Weighted sum
  let combined = 0;
  for (const k of names) combined += weights[k] * valid[k];

  // IR = IC × √N (effektív N: 60% korreláció-korrekció)
  const avgIC    = names.reduce((s, k) => s + (SIGNAL_ICS[k] || 0.05), 0) / n;
  const effN     = Math.max(1, n * 0.6);
  const ir       = avgIC * Math.sqrt(effN);

  // Kelly
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
  if (kellyQ < 0.01) {
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

  // Cache
  let cached: any = null;
  let store: any  = null;
  try {
    store  = getStore("signal-combiner-v2");
    cached = store ? await store.getWithMetadata("combined") : null;
    if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < CACHE_TTL) {
      return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
    }
  } catch {}

  try {
    // Párhuzamos signal lekérés – közvetlenül külső API-kból
    const [vol, flow, apex, cond, fund] = await Promise.all([
      getVolSignal(),
      getOrderflowSignal(),
      getApexSignal(),
      getCondProbSignal(),
      getFundingSignal(),
    ]);

    const raw_signals: Record<string, number | null> = {
      vol_divergence: vol.prob,
      orderflow:      flow.prob,
      apex_consensus: apex.prob,
      cond_prob:      cond.prob,
      funding_rate:   fund.prob,
    };

    const combo = combine(raw_signals);
    const rec   = recommend(combo.combined, combo.ir, combo.kelly_q);
    const active = Object.values(raw_signals).filter(v => v !== null).length;

    const payload = JSON.stringify({
      ok:                   true,
      fetched_at:           new Date().toISOString(),
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
      },
      fundamental_law: {
        avg_ic:      0.07,
        n_signals:   active,
        effective_n: parseFloat((active * 0.6).toFixed(1)),
        ir:          combo.ir,
        formula:     `IR = 0.070 × √${active} = ${combo.ir.toFixed(3)}`,
      },
      kelly: {
        full:     parseFloat((combo.kelly_q * 4).toFixed(4)),
        quarter:  combo.kelly_q,
        cv_edge:  combo.cv_edge,
      },
      recommendation: rec,
      active_signals: active,
    });

    try { if (store) await store.set("combined", payload, { metadata: { ts: Date.now() } }); } catch {}

    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502, headers: CORS,
    });
  }
}
