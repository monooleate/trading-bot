// netlify/functions/trade-logger.mts
// POST /.netlify/functions/trade-logger   { action: "log", ... }
// GET  /.netlify/functions/trade-logger?action=list
// GET  /.netlify/functions/trade-logger?action=calibrate
//
// Trade logging + IC kalibráció.
// Supabase-t használ ha van SUPABASE_URL, egyébként Netlify Blobs fallback.

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

interface Trade {
  id:              string;
  timestamp:       string;
  market_slug:     string;
  market_question: string;
  side:            string;        // BUY_YES | BUY_NO
  entry_price:     number;
  size_usdc:       number;
  signal_p:        number;        // combined probability
  kelly_used:      number;
  ir_at_trade:     number;
  signal_details:  Record<string, number | null>;
  outcome:         number | null; // null = open, 0 = loss, 1 = win
  pnl:             number | null;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function supabaseQuery(method: string, path: string, body?: any): Promise<any> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=representation" : "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  return res.json();
}

// ─── Blob fallback (ha nincs Supabase) ────────────────────────────────────────
async function blobGetTrades(): Promise<Trade[]> {
  try {
    const store = getStore("trade-log-v1");
    const data = await store.get("trades");
    return data ? JSON.parse(data as string) : [];
  } catch { return []; }
}

async function blobSaveTrades(trades: Trade[]): Promise<void> {
  try {
    const store = getStore("trade-log-v1");
    await store.set("trades", JSON.stringify(trades));
  } catch {}
}

// ─── IC Calibration ───────────────────────────────────────────────────────────
function calibrateIC(trades: Trade[]): Record<string, number> {
  const resolved = trades.filter(t => t.outcome !== null && t.outcome !== undefined);
  if (resolved.length < 10) return {};

  const signals = ["vol_divergence", "orderflow", "apex_consensus", "cond_prob", "funding_rate"];
  const ics: Record<string, number> = {};

  for (const sig of signals) {
    const pairs: { x: number; y: number }[] = [];
    for (const t of resolved) {
      const val = t.signal_details?.[sig];
      if (val !== null && val !== undefined && t.outcome !== null) {
        pairs.push({ x: val, y: t.outcome });
      }
    }
    if (pairs.length < 5) continue;

    // Pearson correlation
    const n = pairs.length;
    const sx = pairs.reduce((s, p) => s + p.x, 0);
    const sy = pairs.reduce((s, p) => s + p.y, 0);
    const sxy = pairs.reduce((s, p) => s + p.x * p.y, 0);
    const sx2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
    const sy2 = pairs.reduce((s, p) => s + p.y * p.y, 0);
    const num = n * sxy - sx * sy;
    const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
    ics[sig] = den > 0 ? parseFloat((num / den).toFixed(4)) : 0;
  }

  return ics;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);

  try {
    // ── POST: Log trade ────────────────────────────────────────────────
    if (req.method === "POST") {
      const body = await req.json() as any;
      if (body.action !== "log") {
        return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers: CORS });
      }

      const trade: Trade = {
        id:              genId(),
        timestamp:       new Date().toISOString(),
        market_slug:     body.market_slug || "",
        market_question: body.market_question || "",
        side:            body.side || "BUY_YES",
        entry_price:     parseFloat(body.entry_price || 0),
        size_usdc:       parseFloat(body.size_usdc || 0),
        signal_p:        parseFloat(body.signal_p || 0.5),
        kelly_used:      parseFloat(body.kelly_used || 0),
        ir_at_trade:     parseFloat(body.ir_at_trade || 0),
        signal_details:  body.signal_details || {},
        outcome:         null,
        pnl:             null,
      };

      if (hasSupabase) {
        const result = await supabaseQuery("POST", "trades", trade);
        if (!result) {
          // Fallback to blobs
          const trades = await blobGetTrades();
          trades.push(trade);
          await blobSaveTrades(trades);
        }
      } else {
        const trades = await blobGetTrades();
        trades.push(trade);
        await blobSaveTrades(trades);
      }

      return new Response(JSON.stringify({ ok: true, trade_id: trade.id, storage: hasSupabase ? "supabase" : "blobs" }), {
        status: 200, headers: CORS,
      });
    }

    // ── GET ──────────────────────────────────────────────────────────────
    const url    = new URL(req.url);
    const action = url.searchParams.get("action") || "list";

    if (action === "list") {
      let trades: Trade[] = [];
      if (hasSupabase) {
        trades = await supabaseQuery("GET", "trades?order=timestamp.desc&limit=50") || [];
      }
      if (trades.length === 0) {
        trades = await blobGetTrades();
      }

      return new Response(JSON.stringify({
        ok: true,
        count: trades.length,
        trades: trades.slice(0, 50),
        storage: hasSupabase ? "supabase" : "blobs",
      }), { status: 200, headers: CORS });
    }

    if (action === "calibrate") {
      let trades: Trade[] = [];
      if (hasSupabase) {
        trades = await supabaseQuery("GET", "trades?outcome=not.is.null&order=timestamp.desc&limit=500") || [];
      }
      if (trades.length === 0) {
        trades = (await blobGetTrades()).filter(t => t.outcome !== null);
      }

      const ics = calibrateIC(trades);
      const stats = {
        total_trades: trades.length,
        resolved: trades.filter(t => t.outcome !== null).length,
        wins: trades.filter(t => t.outcome === 1).length,
        losses: trades.filter(t => t.outcome === 0).length,
        total_pnl: trades.reduce((s, t) => s + (t.pnl || 0), 0),
        avg_signal_p: trades.length > 0 ? trades.reduce((s, t) => s + t.signal_p, 0) / trades.length : 0,
      };

      return new Response(JSON.stringify({
        ok: true,
        calibrated_ics: ics,
        sufficient_data: trades.length >= 50,
        note: trades.length < 50 ? `${50 - trades.length} more resolved trades needed for reliable IC` : "IC values ready for production use",
        stats,
      }), { status: 200, headers: CORS });
    }

    // ── Update outcome ───────────────────────────────────────────────────
    if (action === "resolve") {
      const tradeId = url.searchParams.get("id");
      const outcome = parseFloat(url.searchParams.get("outcome") || "0");
      const pnl     = parseFloat(url.searchParams.get("pnl") || "0");

      if (!tradeId) return new Response(JSON.stringify({ ok: false, error: "id required" }), { status: 400, headers: CORS });

      if (hasSupabase) {
        await supabaseQuery("PATCH", `trades?id=eq.${tradeId}`, { outcome, pnl });
      } else {
        const trades = await blobGetTrades();
        const t = trades.find(t => t.id === tradeId);
        if (t) { t.outcome = outcome; t.pnl = pnl; }
        await blobSaveTrades(trades);
      }

      return new Response(JSON.stringify({ ok: true, trade_id: tradeId, outcome, pnl }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers: CORS });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: CORS });
  }
}
