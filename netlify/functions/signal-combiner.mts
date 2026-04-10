// netlify/functions/signal-combiner.mts
// GET /.netlify/functions/signal-combiner?slug=us-x-iran-ceasefire-by-april-30
// GET /.netlify/functions/signal-combiner  (auto: top volume piac)
//
// Fundamental Law of Active Management: IR = IC × √N
// Market-specific: minden signal az adott piacra fut
// Output: combined_probability, kelly_fraction, BUY YES/NO/WAIT ajánlás

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
  question:     string;
  slug:         string;
  conditionId:  string;
  yesTokenId:   string;
  noTokenId:    string;
  yesPrice:     number;
  noPrice:      number;
  volume24h:    number;
  endDate:      string;
  url:          string;
}

// ─── Resolve market from slug or auto-pick top volume ─────────────────────────
async function resolveMarket(slug?: string): Promise<MarketInfo | null> {
  try {
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
        return {
          question:    m.question || m.title || evt.title || "",
          slug:        marketSlug,
          conditionId: m.id || m.conditionId || "",
          yesTokenId:  yesToken.token_id,
          noTokenId:   noToken?.token_id || "",
          yesPrice:    yp,
          noPrice:     np,
          volume24h:   parseFloat(m.volume24hr || m.volume || 0),
          endDate:     m.endDate || "",
          url:         eventSlug && marketSlug
            ? `https://polymarket.com/event/${eventSlug}/${marketSlug}`
            : eventSlug
              ? `https://polymarket.com/event/${eventSlug}`
              : "",
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

// ─── 1. VOL DIVERGENCE SIGNAL ─────────────────────────────────────────────────
// Market-specific: az adott piac IV-jét hasonlítja a BTC RV-hez
async function getVolSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    const closes = await fetchCloses(15);
    if (closes.length < 3) return { prob: null, detail: { error: "no price data" } };

    const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    const mean    = returns.reduce((s, v) => s + v, 0) / returns.length;
    const rv15    = Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length * 365 * 24 * 60) * 100;

    // IV from market price
    const yp = market.yesPrice;
    let timeH = 0.25; // default 15min
    if (market.endDate) {
      const rem = (new Date(market.endDate).getTime() - Date.now()) / 3600000;
      if (rem > 0 && rem < 720) timeH = rem; // max 30 days
    }
    const T = timeH / (365 * 24);
    const iv = T > 0 ? (2 * Math.abs(yp - 0.5) / Math.sqrt(T)) * 100 : rv15;

    const spread = iv - rv15;
    const prob = Math.max(0.1, Math.min(0.9, 0.5 - (spread / 100) * 0.4));
    return { prob, detail: { rv15: rv15.toFixed(1), iv: iv.toFixed(1), spread: spread.toFixed(1) } };
  } catch { return { prob: null, detail: null }; }
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
// Market-specific: top walletok trade-jeit szűri az adott piac conditionId-jára
async function getApexSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    const tradesRes = await fetch(
      `${DATA_API}/trades?limit=500&sortBy=TIMESTAMP&sortDirection=DESC`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!tradesRes.ok) return { prob: null, detail: null };
    const allTrades: any[] = await tradesRes.json().then(d => Array.isArray(d) ? d : []);
    if (!allTrades.length) return { prob: null, detail: null };

    // Aggregate PnL per wallet
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

    // Top 10 wallets
    const topWallets = Object.entries(walletMap)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .slice(0, 10);

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
// Market-specific: az adott piac complement check + related markets monotonicity
async function getCondProbSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    // 1. Complement check for THIS market
    const complement = market.yesPrice + market.noPrice;
    const dev = complement - 1.0;

    // 2. Search related markets for monotonicity violations
    const q = market.question.toLowerCase();
    const keywords = q.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
    let monotonViolation = 0;
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
              // If related market has earlier deadline, its price should be ≤ later deadline
              if (r.endDate && market.endDate) {
                const rEnd = new Date(r.endDate).getTime();
                const mEnd = new Date(market.endDate).getTime();
                if (rEnd < mEnd && rYes > market.yesPrice + 0.03) {
                  monotonViolation = Math.max(monotonViolation, rYes - market.yesPrice);
                } else if (rEnd > mEnd && rYes < market.yesPrice - 0.03) {
                  monotonViolation = Math.max(monotonViolation, market.yesPrice - rYes);
                }
              }
            } catch {}
          }
        }
      } catch {}
    }

    const totalViolation = Math.abs(dev) + monotonViolation;
    if (totalViolation < 0.02) return { prob: 0.5, detail: { complement: complement.toFixed(3), monotonicity: "ok", related: relatedCount } };

    const violationDir = dev > 0 ? -1 : 1;
    const prob = Math.max(0.1, Math.min(0.9, 0.5 + violationDir * Math.min(totalViolation, 0.3)));
    return {
      prob,
      detail: {
        complement: complement.toFixed(3),
        complement_dev: (dev * 100).toFixed(1) + "¢",
        monoton_violation: (monotonViolation * 100).toFixed(1) + "¢",
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
async function getMomentumSignal(market: MarketInfo): Promise<{ prob: number | null; detail: any }> {
  try {
    if (!market.yesTokenId) return { prob: null, detail: null };

    // Get current midpoint
    let currentMid = market.yesPrice;
    try {
      const midRes = await fetch(`${CLOB}/midpoint?token_id=${market.yesTokenId}`, { signal: AbortSignal.timeout(4000) });
      if (midRes.ok) { const d = await midRes.json() as any; currentMid = parseFloat(d.mid || market.yesPrice); }
    } catch {}

    // Get price history — try CLOB prices-history, fallback to Gamma timeseries
    let pastPrice = market.yesPrice;
    try {
      // Gamma market history endpoint
      const histRes = await fetch(
        `${GAMMA}/markets/${market.slug}?limit=1`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (histRes.ok) {
        const hist = await histRes.json() as any;
        // Use the market's stored price as "past" reference
        const op = typeof hist.outcomePrices === "string" ? JSON.parse(hist.outcomePrices) : hist.outcomePrices;
        if (Array.isArray(op)) pastPrice = parseFloat(op[0]);
      }
    } catch {}

    // If we can't get historical price, use deviation from 0.5 as proxy
    if (Math.abs(currentMid - pastPrice) < 0.001) {
      // Momentum proxy: distance from 0.5 indicates recent movement
      const dist = currentMid - 0.5;
      const prob = Math.max(0.1, Math.min(0.9, 0.5 + dist * 0.4));
      return { prob, detail: { current: currentMid.toFixed(3), source: "distance_proxy" } };
    }

    // Rcum = (P_now - P_past) / P_past — Kakushadze Eq. 3.1
    const rcum = pastPrice > 0.01 ? (currentMid - pastPrice) / pastPrice : 0;
    // Positive momentum → YES bias, negative → NO bias
    const prob = Math.max(0.1, Math.min(0.9, 0.5 + rcum * 2.0));
    return {
      prob,
      detail: { current: currentMid.toFixed(3), past: pastPrice.toFixed(3), rcum: (rcum * 100).toFixed(1) + "%" },
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

// ─── KOMBINÁTOR ───────────────────────────────────────────────────────────────
function combine(signals: Record<string, number | null>) {
  const valid: Record<string, number> = {};
  for (const [k, v] of Object.entries(signals)) {
    if (v !== null && !isNaN(v)) valid[k] = v;
  }

  const names = Object.keys(valid);
  const n     = names.length;
  if (n === 0) return { combined: 0.5, weights: {}, ir: 0, kelly_q: 0, cv_edge: 1 };

  const mean = names.reduce((s, k) => s + valid[k], 0) / n;
  const demeaned: Record<string, number> = {};
  for (const k of names) demeaned[k] = valid[k] - mean;

  let totalW = 0;
  const weights: Record<string, number> = {};
  for (const k of names) {
    const ic = SIGNAL_ICS[k] || 0.05;
    const w  = ic * (1 + Math.abs(demeaned[k]) * 0.5);
    weights[k] = w;
    totalW += w;
  }
  for (const k of names) weights[k] = parseFloat((weights[k] / totalW).toFixed(4));

  let combined = 0;
  for (const k of names) combined += weights[k] * valid[k];

  const avgIC = names.reduce((s, k) => s + (SIGNAL_ICS[k] || 0.05), 0) / n;
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

  // Cache keyed by market
  const cKey = `combined:${slug || "auto"}`;
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

    // 2. Parallel signal fetch — all market-specific (8 signals)
    const [vol, flow, apex, cond, fund, mom, contr, pairs] = await Promise.all([
      getVolSignal(market),
      getOrderflowSignal(market),
      getApexSignal(market),
      getCondProbSignal(market),
      getFundingSignal(),
      getMomentumSignal(market),
      getContrarianSignal(market),
      getPairsSpreadSignal(market),
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

    const combo = combine(raw_signals);
    const rec   = recommend(combo.combined, combo.ir, combo.kelly_q);
    const active = Object.values(raw_signals).filter(v => v !== null).length;

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
      kelly: {
        full:     parseFloat((combo.kelly_q * 4).toFixed(4)),
        quarter:  combo.kelly_q,
        cv_edge:  combo.cv_edge,
      },
      recommendation: rec,
      active_signals: active,
    });

    try { if (store) await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}

    return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502, headers: CORS,
    });
  }
}
