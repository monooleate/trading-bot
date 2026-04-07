// netlify/functions/apex-wallets.mts
// GET /.netlify/functions/apex-wallets?action=leaderboard&window=7d
// GET /.netlify/functions/apex-wallets?action=profile&address=0x...
// GET /.netlify/functions/apex-wallets?action=consensus&min_sharpe=2.0
//
// Polymarket Data API alapú apex wallet profiler.
// Nincs auth szükséges – a Polymarket publikus blokklánc adat.

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const DATA_API  = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

// Cache TTL-ek
const TTL = {
  leaderboard: 10 * 60 * 1000,  // 10 perc
  profile:      5 * 60 * 1000,  // 5 perc
  consensus:   10 * 60 * 1000,  // 10 perc
};

// ─── API helpers ──────────────────────────────────────────────────────────────
async function dataGet(path: string, params: Record<string, string> = {}) {
  const qs  = Object.keys(params).length ? "?" + new URLSearchParams(params) : "";
  const res = await fetch(`${DATA_API}${path}${qs}`, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Data API ${res.status}: ${path}`);
  return res.json();
}

// ─── SESSION CLASSIFIER ───────────────────────────────────────────────────────
function classifySession(utcHour: number): string {
  if (utcHour >= 7  && utcHour <= 10) return "low_liquidity";
  if (utcHour >= 6  && utcHour <= 9)  return "london";
  if (utcHour >= 13 && utcHour <= 17) return "ny_open";
  if (utcHour >= 20 && utcHour <= 23) return "ny_close";
  return "asian";
}

function extractUTCHour(ts: string | number): number | null {
  try {
    const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
    return isNaN(d.getTime()) ? null : d.getUTCHours();
  } catch { return null; }
}

function analyzeTimeActivity(trades: any[]) {
  const hourly = new Array(24).fill(0);
  const sessions: Record<string,number> = { low_liquidity:0, london:0, ny_open:0, ny_close:0, asian:0 };
  for (const t of trades) {
    const h = extractUTCHour(t.timestamp || t.created_at || t.time || 0);
    if (h === null) continue;
    hourly[h]++;
    sessions[classifySession(h)]++;
  }
  const total   = trades.length || 1;
  const peakH   = hourly.indexOf(Math.max(...hourly));
  const peakS   = Object.entries(sessions).sort((a,b) => b[1]-a[1])[0]?.[0] ?? "unknown";
  return {
    hourly_distribution: hourly,
    session_breakdown:   sessions,
    peak_hour_utc:       peakH,
    peak_session:        peakS,
    low_liq_pct:         parseFloat((sessions.low_liquidity / total).toFixed(3)),
    low_liq_trades:      sessions.low_liquidity,
  };
}

// ─── Sharpe ratio számítás PnL history-ból ────────────────────────────────────
function calcSharpe(pnlSeries: number[]): number {
  if (pnlSeries.length < 3) return 0;
  const returns: number[] = [];
  for (let i = 1; i < pnlSeries.length; i++) {
    returns.push(pnlSeries[i] - pnlSeries[i - 1]);
  }
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const std  = Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length);
  return std > 0 ? (mean / std) * Math.sqrt(returns.length) : 0;
}

// ─── Win rate számítás trade listából ─────────────────────────────────────────
function calcWinRate(trades: any[]): { win_rate: number; wins: number; losses: number; total: number } {
  // Csak lezárt pozíciók ahol ismerjük a PnL-t
  const closed = trades.filter(t => t.outcome !== null && t.outcome !== undefined);
  if (closed.length === 0) return { win_rate: 0, wins: 0, losses: 0, total: 0 };
  const wins   = closed.filter(t => parseFloat(t.outcome || 0) > 0).length;
  const losses = closed.length - wins;
  return {
    win_rate: wins / closed.length,
    wins, losses,
    total: closed.length,
  };
}


// ─── BOT DETECTOR ─────────────────────────────────────────────────────────────
// Hubble Research módszertan alapján:
// - Focus ratio: trades / markets (botoknál extrém magas)
// - Trade timing regularity: embereknél zajos, botoknál metronóm
// - Sleep gap: emberek alszanak, botok nem
// - Median inter-trade interval: botoknál jellemzően < 30 másodperc
// - 24h coverage: botok minden órában aktívak, emberek nem
//
// Forrás: Hubble Research "Bot Zone" elemzés (2026)

interface BotScore {
  score:           number;   // 0-100, magasabb = valószínűbb bot
  classification:  "HUMAN" | "LIKELY_HUMAN" | "UNCERTAIN" | "LIKELY_BOT" | "BOT";
  signals:         string[];
  metrics: {
    focus_ratio:         number;
    hours_active_pct:    number;
    median_interval_sec: number | null;
    timing_regularity:   number;   // 0-1, magasabb = szabályosabb = bot
    has_sleep_gap:       boolean;
    trades_per_market:   number;
  };
}

function detectBot(trades: any[]): BotScore {
  const signals: string[] = [];
  let score = 0;

  if (trades.length < 5) {
    return {
      score: 0, classification: "UNCERTAIN", signals: ["Insufficient data"],
      metrics: { focus_ratio: 0, hours_active_pct: 0, median_interval_sec: null, timing_regularity: 0, has_sleep_gap: true, trades_per_market: 0 },
    };
  }

  // ── 1. Focus Ratio ─────────────────────────────────────────────────────────
  // Botoknál: egy vagy néhány piacon sok trade (arb bot)
  // vagy sok piacon rengeteg trade (scanner bot)
  // Emberek: 2-10 trade/piac
  const markets = new Set(trades.map((t: any) => t.market || t.conditionId || "")).size;
  const focusRatio = markets > 0 ? trades.length / markets : trades.length;
  const tradesPerMarket = focusRatio;

  if (focusRatio > 50) { score += 35; signals.push(`Focus ratio ${focusRatio.toFixed(0)} (>50 = bot szint)`); }
  else if (focusRatio > 20) { score += 15; signals.push(`Focus ratio ${focusRatio.toFixed(0)} (magas)`); }
  else if (focusRatio < 3)  { score += 5;  signals.push(`Focus ratio ${focusRatio.toFixed(1)} (alacsony diverzifikáció)`); }

  // ── 2. 24h Lefedettség ─────────────────────────────────────────────────────
  // Botok: minden órában aktívak (egyenletes eloszlás)
  // Emberek: van sleep gap, jellemzően 6-8 óra inaktív
  const hourCounts = new Array(24).fill(0);
  let validTs = 0;
  const intervals: number[] = [];
  const sortedTrades = [...trades].sort((a: any, b: any) => {
    const ta = new Date(a.timestamp || 0).getTime();
    const tb = new Date(b.timestamp || 0).getTime();
    return ta - tb;
  });

  for (let i = 0; i < sortedTrades.length; i++) {
    const t = sortedTrades[i];
    const ts = new Date(t.timestamp || 0).getTime();
    if (ts > 0) {
      hourCounts[new Date(ts).getUTCHours()]++;
      validTs++;
      if (i > 0) {
        const prev = new Date(sortedTrades[i-1].timestamp || 0).getTime();
        if (prev > 0) intervals.push((ts - prev) / 1000); // másodpercben
      }
    }
  }

  const hoursActive = hourCounts.filter(c => c > 0).length;
  const hoursActivePct = hoursActive / 24;

  if (hoursActivePct > 0.9) { score += 25; signals.push(`24/7 aktív (${hoursActive}/24 óra)`); }
  else if (hoursActivePct > 0.75) { score += 12; signals.push(`Szinte folyamatos aktivitás (${hoursActive}/24 óra)`); }

  // Sleep gap: van-e legalább 6 egymást követő inaktív óra?
  let maxGap = 0, curGap = 0;
  for (let h = 0; h < 48; h++) { // dupla kör a körbezáráshoz
    if (hourCounts[h % 24] === 0) { curGap++; maxGap = Math.max(maxGap, curGap); }
    else curGap = 0;
  }
  const hasSleepGap = maxGap >= 6;
  if (!hasSleepGap && validTs > 20) {
    score += 20;
    signals.push("Nincs sleep gap (6+ egymást követő inaktív óra hiányzik)");
  }

  // ── 3. Inter-trade interval elemzés ───────────────────────────────────────
  // Botok: nagyon rövid és/vagy szabályos időközök
  let medianInterval: number | null = null;
  let timingRegularity = 0;

  if (intervals.length >= 5) {
    const sorted = [...intervals].sort((a, b) => a - b);
    medianInterval = sorted[Math.floor(sorted.length / 2)];

    // Nagyon rövid median interval
    if (medianInterval < 10)  { score += 25; signals.push(`Median interval ${medianInterval.toFixed(1)}s (<10s = HFT bot)`); }
    else if (medianInterval < 60) { score += 15; signals.push(`Median interval ${medianInterval.toFixed(1)}s (<60s = gyors bot)`); }
    else if (medianInterval < 300) { score += 5; signals.push(`Median interval ${medianInterval.toFixed(1)}s (rövid)`); }

    // Timing regularity: CV (coefficient of variation) – botoknál alacsony
    const mean   = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const stddev = Math.sqrt(intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length);
    const cv     = mean > 0 ? stddev / mean : 1;
    // Alacsony CV = szabályos = bot
    timingRegularity = Math.max(0, 1 - cv);
    if (cv < 0.3) { score += 20; signals.push(`Timing nagyon szabályos (CV=${cv.toFixed(2)} < 0.3)`); }
    else if (cv < 0.6) { score += 10; signals.push(`Timing mérsékelten szabályos (CV=${cv.toFixed(2)})`); }
  }

  // ── Klasszifikáció ─────────────────────────────────────────────────────────
  score = Math.min(100, score);
  const classification =
    score >= 80 ? "BOT" :
    score >= 60 ? "LIKELY_BOT" :
    score >= 35 ? "UNCERTAIN" :
    score >= 15 ? "LIKELY_HUMAN" :
    "HUMAN";

  if (signals.length === 0) signals.push("Nincs bot jelzés – valószínűleg humán trader");

  return {
    score,
    classification,
    signals,
    metrics: {
      focus_ratio:         parseFloat(focusRatio.toFixed(2)),
      hours_active_pct:    parseFloat(hoursActivePct.toFixed(2)),
      median_interval_sec: medianInterval !== null ? parseFloat(medianInterval.toFixed(1)) : null,
      timing_regularity:   parseFloat(timingRegularity.toFixed(3)),
      has_sleep_gap:       hasSleepGap,
      trades_per_market:   parseFloat(tradesPerMarket.toFixed(2)),
    },
  };
}


// ─── Wallet profil számítás ───────────────────────────────────────────────────
function buildProfile(address: string, trades: any[], activity: any[]) {
  // Total PnL (redemptions + trade PnL)
  const redemptions = activity.filter((a: any) => a.type === "REDEEM" || a.type === "redemption");
  const totalRedeemed = redemptions.reduce((s: number, r: any) => s + parseFloat(r.cashAmount || r.cash || 0), 0);

  // Trade volume
  const totalVolume = trades.reduce((s: number, t: any) => s + parseFloat(t.size || 0) * parseFloat(t.price || 0), 0);

  // Piac diverzifikáció
  const markets = new Set(trades.map((t: any) => t.market || t.conditionId)).size;

  // PnL series per market (naïv közelítés)
  const marketPnl: Record<string, number> = {};
  const marketCat: Record<string, string> = {};
  const CAT_KEYWORDS: Record<string, string[]> = {
    crypto:    ["btc","bitcoin","eth","ethereum","crypto","sol","xrp","up-or-down","15-minute","5-minute"],
    politics:  ["president","election","trump","biden","harris","congress","senate","vote","democrat","republican"],
    sports:    ["nba","nfl","mlb","nhl","soccer","football","basketball","tennis","golf","game","match","championship"],
    economics: ["fed","rate","gdp","inflation","cpi","recession","fomc","interest","unemployment","jobs"],
  };
  function detectCategory(slug: string): string {
    const s = slug.toLowerCase();
    for (const [cat, kws] of Object.entries(CAT_KEYWORDS)) {
      if (kws.some(kw => s.includes(kw))) return cat;
    }
    return "other";
  }
  for (const t of trades) {
    const mkt = t.market || t.conditionId || "unknown";
    if (!marketPnl[mkt]) { marketPnl[mkt] = 0; marketCat[mkt] = detectCategory(mkt); }
    const side = (t.side || "").toUpperCase() === "BUY" ? -1 : 1;
    marketPnl[mkt] += side * parseFloat(t.size || 0) * parseFloat(t.price || 0);
  }
  const pnlSeries = Object.values(marketPnl);
  const sharpe    = calcSharpe(pnlSeries);
  const wr        = calcWinRate(trades.map((t: any) => ({
    outcome: marketPnl[t.market || t.conditionId || "unknown"],
  })));

  // Payout ratio
  const wins_pnl   = pnlSeries.filter(p => p > 0.01);
  const losses_pnl = pnlSeries.filter(p => p < -0.01).map(Math.abs);
  const avg_win    = wins_pnl.length   ? wins_pnl.reduce((s,v)=>s+v,0)/wins_pnl.length   : 0;
  const avg_loss   = losses_pnl.length ? losses_pnl.reduce((s,v)=>s+v,0)/losses_pnl.length : 0.01;
  const payout_ratio  = parseFloat((avg_win / avg_loss).toFixed(3));
  const break_even_wr = parseFloat((1 / (1 + payout_ratio)).toFixed(3));

  // Category breakdown
  const catStats: Record<string, { wins: number; losses: number; pnl: number; trades: number }> = {};
  for (const [mkt, pnl] of Object.entries(marketPnl)) {
    const cat = marketCat[mkt] || "other";
    if (!catStats[cat]) catStats[cat] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
    catStats[cat].pnl    += pnl;
    catStats[cat].trades += 1;
    if (pnl > 0.01) catStats[cat].wins++;
    else if (pnl < -0.01) catStats[cat].losses++;
  }
  const catWinRates = Object.entries(catStats).map(([cat, cs]) => ({
    cat, wr: cs.wins / Math.max(cs.wins + cs.losses, 1),
  }));
  const bestCat   = catWinRates.sort((a,b) => b.wr - a.wr)[0];
  const bestCatWr = bestCat?.wr ?? 0;

  // Legutóbbi aktivitás
  const latestTrades = trades
    .sort((a: any, b: any) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0, 5)
    .map((t: any) => ({
      market:    t.market || t.conditionId,
      side:      t.side,
      price:     parseFloat(t.price || 0),
      size:      parseFloat(t.size  || 0),
      timestamp: t.timestamp,
    }));

  // Apex kritériumok
  const isApex = sharpe > 2.0 && wr.win_rate > 0.60 && trades.length >= 20;

  // Időalapú aktivitás
  const timeActivity = analyzeTimeActivity(trades);

  // Bot detekció
  const botScore = detectBot(trades);

  // Apex csak ha nem bot
  const isApexFinal = isApex && botScore.classification !== "BOT" && botScore.classification !== "LIKELY_BOT";

  return {
    address,
    total_trades:   trades.length,
    total_volume:   totalVolume,
    total_redeemed: totalRedeemed,
    markets_traded: markets,
    sharpe_ratio:   parseFloat(sharpe.toFixed(3)),
    win_rate:       parseFloat(wr.win_rate.toFixed(3)),
    wins:           wr.wins,
    losses:         wr.losses,
    is_apex:        isApexFinal,
    is_apex_raw:    isApex,
    apex_criteria:  {
      sharpe_ok:   sharpe > 2.0,
      winrate_ok:  wr.win_rate > 0.60,
      volume_ok:   trades.length >= 20,
    },
    latest_trades:  latestTrades,
    time_activity:  timeActivity,
    bot_score:      botScore,
    payout_ratio:   payout_ratio,
    avg_win:        parseFloat(avg_win.toFixed(4)),
    avg_loss:       parseFloat(avg_loss.toFixed(4)),
    break_even_wr:  break_even_wr,
    category_stats: catStats,
    best_category:  bestCat?.cat ?? "",
    best_cat_wr:    parseFloat(bestCatWr.toFixed(3)),
  };
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
async function getLeaderboard(window: string, limit: number) {
  const data = await dataGet("/leaderboard", { window, limit: String(limit) });
  return Array.isArray(data) ? data : (data.data || data.results || []);
}

// ─── CONSENSUS DETECTOR ───────────────────────────────────────────────────────
async function detectConsensus(apexWallets: string[], minApex: number = 2) {
  // Lekérjük az apex walletok legutóbbi trades-eit és keressük ahol többen is aktívak
  const recentTrades: Record<string, { wallets: string[]; side: string[]; prices: number[] }> = {};

  await Promise.allSettled(
    apexWallets.slice(0, 10).map(async (addr) => {  // max 10 wallet rate limit miatt
      try {
        const trades = await dataGet("/trades", { user: addr, limit: "20" });
        const list: any[] = Array.isArray(trades) ? trades : [];
        for (const t of list) {
          const mkt = t.market || t.conditionId || "";
          if (!mkt) continue;
          if (!recentTrades[mkt]) recentTrades[mkt] = { wallets: [], side: [], prices: [] };
          recentTrades[mkt].wallets.push(addr);
          recentTrades[mkt].side.push(t.side || "");
          recentTrades[mkt].prices.push(parseFloat(t.price || 0));
        }
      } catch {}
    })
  );

  // Konszenzus: ugyanabban a piacban min. 2 apex wallet ugyanolyan irányba
  const consensus: any[] = [];
  for (const [market, data] of Object.entries(recentTrades)) {
    if (data.wallets.length < minApex) continue;
    const buys  = data.side.filter(s => s.toUpperCase() === "BUY").length;
    const sells = data.side.filter(s => s.toUpperCase() === "SELL").length;
    const dominant = buys >= sells ? "BUY" : "SELL";
    const domCount = Math.max(buys, sells);
    if (domCount < minApex) continue;

    const avgPrice = data.prices.reduce((s, v) => s + v, 0) / data.prices.length;
    consensus.push({
      market,
      apex_wallet_count: data.wallets.length,
      dominant_side:     dominant,
      dominant_count:    domCount,
      avg_entry_price:   parseFloat(avgPrice.toFixed(4)),
      confidence:        parseFloat((domCount / data.wallets.length).toFixed(2)),
      wallets:           [...new Set(data.wallets)],
    });
  }

  return consensus.sort((a, b) => b.apex_wallet_count - a.apex_wallet_count);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get("action") || "leaderboard";
  let store: any = null;
  try { store = getStore("apex-wallets-cache"); } catch {}

  try {
    // ── LEADERBOARD ────────────────────────────────────────────────────
    if (action === "leaderboard") {
      const window = url.searchParams.get("window") || "7d";
      const limit  = parseInt(url.searchParams.get("limit") || "50");
      const cKey   = `lb:${window}:${limit}`;

      let cached: any = null; try { cached = await store.getWithMetadata(cKey); } catch {}
      if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < TTL.leaderboard) {
        return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
      }

      const raw = await getLeaderboard(window, limit);
      const payload = JSON.stringify({
        ok: true, window, count: raw.length,
        leaderboard: raw.slice(0, limit).map((w: any, i: number) => ({
          rank:         i + 1,
          address:      w.proxyWalletAddress || w.address || w.user,
          name:         w.name || w.username || null,
          pnl:          parseFloat(w.pnl || w.profit || 0),
          volume:       parseFloat(w.volume || 0),
          trades_count: parseInt(w.tradesCount || w.trades || 0),
        })),
      });

      try { await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}
      return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });
    }

    // ── WALLET PROFILE ────────────────────────────────────────────────
    if (action === "profile") {
      const address = url.searchParams.get("address");
      if (!address) return new Response(JSON.stringify({ ok: false, error: "address required" }), { status: 400, headers: CORS });

      const cKey = `profile:${address}`;
      let cached: any = null; try { cached = await store.getWithMetadata(cKey); } catch {}
      if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < TTL.profile) {
        return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
      }

      const [trades, activity] = await Promise.all([
        dataGet("/trades",   { user: address, limit: "500" }).catch(() => []),
        dataGet("/activity", { user: address, limit: "200" }).catch(() => []),
      ]);

      const profile = buildProfile(
        address,
        Array.isArray(trades)   ? trades   : [],
        Array.isArray(activity) ? activity : [],
      );

      const payload = JSON.stringify({ ok: true, profile });
      try { await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}
      return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });
    }

    // ── CONSENSUS ─────────────────────────────────────────────────────
    if (action === "consensus") {
      const minSharpe = parseFloat(url.searchParams.get("min_sharpe") || "2.0");
      const window    = url.searchParams.get("window") || "7d";
      const cKey      = `consensus:${window}:${minSharpe}`;

      let cached: any = null; try { cached = await store.getWithMetadata(cKey); } catch {}
      if (cached?.metadata && Date.now() - ((cached.metadata as any).ts || 0) < TTL.consensus) {
        return new Response(cached.data as string, { status: 200, headers: { ...CORS, "X-Cache": "HIT" } });
      }

      // 1. Leaderboard lekérés
      const lb = await getLeaderboard(window, 100);
      const addresses = lb
        .map((w: any) => w.proxyWalletAddress || w.address || w.user)
        .filter(Boolean)
        .slice(0, 20); // top 20 a rate limit miatt

      // 2. Apex szűrés – top 20% PnL alapján, majd bot szűrő
      const apexCount = Math.ceil(addresses.length * 0.2);
      const apexCandidates = addresses.slice(0, apexCount);

      // Bot szűrés: gyors mintavétel az első 5 wallet-en
      const botChecked: string[] = [];
      for (const addr of apexCandidates.slice(0, 8)) {
        try {
          const sample = await dataGet("/trades", { user: addr, limit: "50" });
          const trades = Array.isArray(sample) ? sample : [];
          const bs = detectBot(trades);
          if (bs.classification !== "BOT" && bs.classification !== "LIKELY_BOT") {
            botChecked.push(addr);
          }
        } catch { botChecked.push(addr); } // hálózati hiba esetén bent marad
      }
      // Ha túl sok kiszűrve, a maradék candidateket hozzáadjuk szűrés nélkül
      const apexAddresses = botChecked.length >= 2 ? botChecked : apexCandidates;

      // 3. Consensus keresés
      const consensusMarkets = await detectConsensus(apexAddresses, 2);

      const payload = JSON.stringify({
        ok: true,
        window,
        apex_wallet_count:    apexAddresses.length,
        consensus_markets:    consensusMarkets.length,
        apex_addresses:       apexAddresses.slice(0, 5), // csak első 5 publikusan
        consensus:            consensusMarkets.slice(0, 10),
        methodology: "Top 20% of leaderboard by PnL. Consensus = 2+ apex wallets same side in same market within last 20 trades.",
      });

      try { await store.set(cKey, payload, { metadata: { ts: Date.now() } }); } catch {}
      return new Response(payload, { status: 200, headers: { ...CORS, "X-Cache": "MISS" } });
    }

    return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers: CORS });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
