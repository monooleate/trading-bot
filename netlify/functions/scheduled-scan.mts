// netlify/functions/scheduled-scan.mts
// Cron: óránként fut, frissíti a Polymarket + Funding cache-t.
// Scheduled functions: 30mp execution limit, nem hívható URL-ről.

import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const GAMMA_API  = "https://gamma-api.polymarket.com";
const BINANCE_FAPI = "https://fapi.binance.com";

const SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","ARBUSDT","AVAXUSDT"];

async function refreshPolymarket() {
  const res = await fetch(
    `${GAMMA_API}/markets?active=true&closed=false&limit=30&order=volume24hr&ascending=false`,
    { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Gamma API: ${res.status}`);
  const raw = await res.json() as any;
  const list = Array.isArray(raw) ? raw : (raw.markets || []);

  const markets = list
    .filter((m: any) => parseFloat(m.volume24hr || 0) > 5000)
    .slice(0, 30)
    .map((m: any) => {
      let yp = 0.5, np = 0.5;
      try {
        const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        if (Array.isArray(op) && op.length >= 2) { yp = parseFloat(op[0]); np = parseFloat(op[1]); }
      } catch {}
      return {
        question:   m.question || "N/A",
        slug:       m.slug || "",
        category:   (Array.isArray(m.tags) && m.tags[0] ? (typeof m.tags[0] === "object" ? m.tags[0].label : m.tags[0]) : "egyéb").toLowerCase(),
        yes_price:  Math.round(yp * 10000) / 10000,
        no_price:   Math.round(np * 10000) / 10000,
        volume_24h: parseFloat(m.volume24hr || 0),
        liquidity:  parseFloat(m.liquidityNum || 0),
        end_date:   m.endDate || "",
        url: m.slug ? `https://polymarket.com/event/${m.slug}` : "https://polymarket.com",
      };
    });

  let store: any = null;

  try { store = getStore("polymarket-cache"); } catch {}
  try { if (store) await store.set("markets_cache", JSON.stringify({ } catch {}
    ok: true,
    fetched_at: new Date().toISOString(),
    market_count: markets.length,
    markets,
  }), { metadata: { ts: Date.now() } });

  return markets.length;
}

async function refreshFunding() {
  const results = await Promise.allSettled(
    SYMBOLS.map(s =>
      fetch(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${s}`, {
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json())
    )
  );

  const pairs = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map(r => r.value)
    .filter(d => d.symbol)
    .map(d => {
      const fr = parseFloat(d.lastFundingRate || 0) * 100;
      return {
        symbol: d.symbol.replace("USDT", "/USDT"),
        mark_price: parseFloat(d.markPrice || 0),
        funding_rate: Math.round(fr * 10000) / 10000,
        funding_rate_annual_pct: Math.round(fr * 3 * 365 * 100) / 100,
        interval_hours: 8,
        quality: Math.abs(fr) > 0.03 ? "strong" : Math.abs(fr) > 0.01 ? "weak" : "skip",
        direction: fr > 0 ? "Long spot / Short futures" : "Short spot / Long futures",
      };
    })
    .sort((a, b) => Math.abs(b.funding_rate) - Math.abs(a.funding_rate));

  let store: any = null;

  try { store = getStore("funding-cache"); } catch {}
  try { if (store) await store.set("funding_cache", JSON.stringify({ } catch {}
    ok: true,
    fetched_at: new Date().toISOString(),
    pairs,
  }), { metadata: { ts: Date.now() } });

  return pairs.length;
}

// ── Scheduled handler – óránként ──────────────────────────────────────────────
export const handler = schedule("0 * * * *", async () => {
  const log: string[] = [];
  const start = Date.now();

  try {
    const pmCount = await refreshPolymarket();
    log.push(`✓ Polymarket: ${pmCount} piac frissítve`);
  } catch (e: any) {
    log.push(`✗ Polymarket hiba: ${e.message}`);
  }

  try {
    const frCount = await refreshFunding();
    log.push(`✓ Funding rates: ${frCount} pár frissítve`);
  } catch (e: any) {
    log.push(`✗ Funding hiba: ${e.message}`);
  }

  const elapsed = Date.now() - start;
  log.push(`⏱ ${elapsed}ms`);

  // Log mentése Blobs-ba (utolsó futás rekordja)
  try {
    const logStore = getStore("scan-logs");
    await logStore.set("last_run", JSON.stringify({
      ran_at: new Date().toISOString(),
      elapsed_ms: elapsed,
      log,
    }));
  } catch {}

  console.log("[scheduled-scan]", log.join(" | "));
  return new Response(JSON.stringify({ ok: true, log }), { status: 200 });
});
