// src/components/ApexWalletsPanel.tsx
// Tab 08 – Apex Wallet Profiler + Consensus Detector

import { useState, useEffect, useCallback } from "react";

const FN = "/.netlify/functions";

const css = `
.aw-wrap{display:flex;flex-direction:column;gap:15px}
.aw-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.aw-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.aw-card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:18px}
.aw-ct{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:7px}
.aw-ct::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%;display:inline-block;flex-shrink:0}
.aw-topbar{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:4px}
.aw-big{font-family:var(--mono);font-size:34px;font-weight:700;letter-spacing:-.03em;line-height:1}
.aw-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:3px}
.aw-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px}
.aw-row:last-child{border-bottom:none}
.aw-row .lbl{color:var(--muted);font-size:11px}
.aw-row .val{font-weight:700}
.ec-pos{color:var(--accent)}.ec-neg{color:var(--danger)}.ec-neu{color:var(--accent2)}.ec-warn{color:var(--warn)}
.aw-verdict{padding:13px;border-radius:2px;font-family:var(--mono);font-size:11px;line-height:1.6;border-left:3px solid;font-weight:700}
.aw-verdict.green{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.aw-verdict.yellow{background:#1f1400;border-color:var(--warn);color:var(--warn)}
.aw-verdict.blue{background:#001a2a;border-color:var(--accent2);color:var(--accent2)}
.aw-verdict.red{background:#1f0000;border-color:var(--danger);color:var(--danger)}
.aw-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:7px 13px;border-radius:2px;cursor:pointer;transition:all .2s;letter-spacing:.08em;text-transform:uppercase}
.aw-btn:hover{border-color:var(--accent);color:var(--accent)}
.aw-btn.primary{background:var(--accent);color:#0a0a0c;font-weight:700;border-color:var(--accent)}
.aw-btn:disabled{opacity:.4;cursor:not-allowed}
.aw-btn.active{border-color:var(--accent);color:var(--accent)}
.aw-tbl{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11px}
.aw-tbl th{text-align:left;padding:6px 9px;font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.aw-tbl td{padding:7px 9px;border-bottom:1px solid #151520;vertical-align:middle}
.aw-tbl tr:last-child td{border-bottom:none}
.aw-tbl tr:hover td{background:var(--surface2)}
.aw-tag{display:inline-block;padding:2px 7px;border-radius:2px;font-size:10px;font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.aw-tag.green{background:#0f2000;color:var(--accent);border:1px solid #1a3300}
.aw-tag.yellow{background:#1f1400;color:var(--warn);border:1px solid #332200}
.aw-tag.red{background:#200000;color:var(--danger);border:1px solid #330000}
.aw-tag.blue{background:#001a2a;color:var(--accent2);border:1px solid #003344}
.aw-info{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:12px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7}
.aw-info strong{color:var(--text)}
.aw-info code{color:var(--accent2)}
.aw-input{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;padding:8px 10px;border-radius:2px;outline:none;transition:border-color .2s}
.aw-input:focus{border-color:var(--accent)}
.aw-signal-card{background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:14px;margin-bottom:10px}
.aw-signal-card:last-child{margin-bottom:0}
.aw-signal-card.buy{border-left:3px solid var(--accent)}
.aw-signal-card.sell{border-left:3px solid var(--danger)}
.aw-addr{font-family:var(--mono);font-size:11px;color:var(--muted);word-break:break-all}
.aw-heatmap{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;margin-top:8px}
.aw-heatmap-cell{height:28px;border-radius:2px;position:relative;cursor:default;transition:opacity .2s}
.aw-heatmap-cell:hover{opacity:.8}
.aw-session-bar{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.aw-session-fill{height:14px;border-radius:2px;transition:width .8s ease}
.aw-session-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);width:140px;flex-shrink:0}
.aw-session-val{font-family:var(--mono);font-size:10px;color:var(--muted);width:36px;text-align:right}
.aw-bot-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:2px;font-family:var(--mono);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.aw-bot-badge.BOT{background:#200000;color:var(--danger);border:1px solid #440000}
.aw-bot-badge.LIKELY_BOT{background:#1f0a00;color:#f16535;border:1px solid #3a1500}
.aw-bot-badge.UNCERTAIN{background:#1f1400;color:var(--warn);border:1px solid #332200}
.aw-bot-badge.LIKELY_HUMAN{background:#001a10;color:var(--accent2);border:1px solid #003322}
.aw-bot-badge.HUMAN{background:#0f2000;color:var(--accent);border:1px solid #1a3300}
.aw-bot-bar{height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;margin-top:4px}
.aw-bot-bar-fill{height:100%;border-radius:4px;transition:width .8s ease}
.aw-low-liq-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:#0f1f00;border:1px solid var(--accent);border-radius:2px;font-family:var(--mono);font-size:10px;color:var(--accent);font-weight:700}
.aw-demo-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:var(--surface2);border:1px solid var(--warn);border-radius:2px;font-family:var(--mono);font-size:10px;color:var(--warn)}
.aw-chip-row{display:flex;gap:7px;margin-bottom:14px}
.aw-chip{background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-family:var(--mono);font-size:10px;color:var(--muted);cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:.07em}
.aw-chip:hover,.aw-chip.active{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.aw-progress{height:4px;background:var(--surface2);border-radius:2px;overflow:hidden;margin-top:4px}
.aw-progress-fill{height:100%;border-radius:2px;transition:width .8s ease}
@media(max-width:768px){.aw-grid2,.aw-grid3{grid-template-columns:1fr}}
`;

// ─── DEMO DATA ────────────────────────────────────────────────────────────────
const DEMO_LB = {
  ok: true, window: "7d", count: 10, is_demo: true,
  leaderboard: [
    { rank:1, address:"0xd481...ef35", name:"WhaleX",    pnl:18420, volume:284000, trades_count:342 },
    { rank:2, address:"0x9f2c...ab12", name:null,         pnl:12840, volume:189000, trades_count:218 },
    { rank:3, address:"0x7e3a...cd78", name:"CryptoSage", pnl:9210,  volume:142000, trades_count:187 },
    { rank:4, address:"0x4b1d...ef90", name:null,         pnl:7640,  volume:98000,  trades_count:143 },
    { rank:5, address:"0x2a9e...1234", name:"Apex5",      pnl:6120,  volume:87000,  trades_count:98  },
  ],
};

const DEMO_CONSENSUS = {
  ok: true, window: "7d", apex_wallet_count: 4, consensus_markets: 2, is_demo: true,
  apex_addresses: ["0xd481...ef35","0x7e3a...cd78","0x2a9e...1234","0x9f2c...ab12"],
  consensus: [
    { market:"fed-hold-may-2025",     dominant_side:"BUY",  apex_wallet_count:3, confidence:0.86,
      avg_entry_price:0.67, wallets:["0xd481...","0x7e3a...","0x2a9e..."] },
    { market:"btc-100k-june-2025",    dominant_side:"SELL", apex_wallet_count:2, confidence:0.75,
      avg_entry_price:0.42, wallets:["0xd481...","0x9f2c..."] },
  ],
  methodology: "Top 20% of leaderboard by PnL. Consensus = 2+ apex wallets same side.",
};

const DEMO_PROFILE = {
  ok: true, is_demo: true,
  profile: {
    address:"0xd481...ef35", name:"WhaleX",
    total_trades:342, total_volume:284000, markets_count:18,
    sharpe_ratio:2.84, win_rate:0.71, avg_position_size:375,
    is_apex:true,
    apex_criteria:{ sharpe_ok:true, winrate_ok:true, volume_ok:true },
    recent_markets:["fed-hold-may-2025","btc-100k-june-2025","sp500-q3"],
    time_activity: {
      hourly_distribution: [8,6,4,3,2,2,3,12,18,14,10,8,7,22,28,24,18,14,11,10,9,12,15,10],
      session_breakdown: { low_liquidity:42, london:31, ny_open:84, ny_close:54, asian:131 },
      peak_hour_utc: 14, peak_session: "ny_open",
      low_liq_pct: 0.123, low_liq_trades: 42,
    },
    bot_score: {
      score: 18, classification: "LIKELY_HUMAN",
      signals: ["Focus ratio 19.0 (magas)", "Sleep gap: 7 óra detektálva"],
      metrics: {
        focus_ratio: 19.0, hours_active_pct: 0.67,
        median_interval_sec: 1842, timing_regularity: 0.31,
        has_sleep_gap: true, trades_per_market: 19.0,
      },
    },
    payout_ratio: 3.37, avg_win: 0.091, avg_loss: 0.027, break_even_wr: 0.229,
    best_category: "crypto", best_cat_wr: 0.91,
    category_stats: {
      crypto:    { wins: 191, losses: 19, pnl: 8420, trades: 210 },
      politics:  { wins: 12,  losses: 75, pnl: -1240, trades: 87 },
      economics: { wins: 25,  losses: 20, pnl: 310,   trades: 45 },
    },
  },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function kellySize(confidence: number, price: number, side: string): number {
  const p     = confidence;
  const payoff = side === "BUY" ? (1 / Math.max(price, 0.01)) - 1 : (1 / Math.max(1 - price, 0.01)) - 1;
  const kelly = Math.max(0, (p * payoff - (1 - p)) / payoff);
  return parseFloat((kelly * 0.25 * 100).toFixed(1));
}

function shortAddr(addr: string): string {
  if (addr.length <= 20) return addr;
  return addr.slice(0, 10) + "..." + addr.slice(-6);
}

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────



// ─── PAYOUT RATIO CARD ────────────────────────────────────────────────────────
function PayoutCard({ p }: { p: any }) {
  const pr       = p?.payout_ratio ?? 0;
  const wr       = p?.win_rate ?? 0;
  const beWr     = p?.break_even_wr ?? 0.5;
  const actualEdge = wr - beWr;
  const isStrong = pr >= 3.0 && actualEdge > 0.15;

  const cats = p?.category_stats ?? {};
  const catEntries = Object.entries(cats)
    .map(([cat, cs]: [string, any]) => ({
      cat,
      win_rate: cs.wins / Math.max(cs.wins + cs.losses, 1),
      pnl: cs.pnl,
      trades: cs.trades,
    }))
    .sort((a, b) => b.win_rate - a.win_rate);

  return (
    <>
      <div className="aw-card">
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <div className="aw-ct" style={{ margin:0 }}>Payout Ratio</div>
          {isStrong && (
            <span style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)",
              background:"#0f2000", border:"1px solid var(--accent)", borderRadius:2,
              padding:"2px 8px", fontWeight:700 }}>
              🎯 ASZIMMETRIKUS EDGE
            </span>
          )}
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:16 }}>
          <div>
            <div style={{ fontFamily:"var(--mono)", fontSize:28, fontWeight:700,
              color: pr >= 3 ? "var(--accent)" : pr >= 2 ? "var(--warn)" : "var(--muted)" }}>
              {pr.toFixed(2)}x
            </div>
            <div className="aw-lbl">Payout ratio</div>
          </div>
          <div>
            <div style={{ fontFamily:"var(--mono)", fontSize:28, fontWeight:700, color:"var(--accent2)" }}>
              {(beWr*100).toFixed(1)}%
            </div>
            <div className="aw-lbl">Break-even WR</div>
          </div>
          <div>
            <div style={{ fontFamily:"var(--mono)", fontSize:28, fontWeight:700,
              color: actualEdge > 0.2 ? "var(--accent)" : actualEdge > 0 ? "var(--warn)" : "var(--danger)" }}>
              {actualEdge >= 0 ? "+" : ""}{(actualEdge*100).toFixed(1)}%
            </div>
            <div className="aw-lbl">Tényleges edge</div>
          </div>
        </div>

        <div className="aw-row">
          <span className="lbl">Átlag nyerő trade</span>
          <span className="val ec-pos">{((p?.avg_win??0)*100).toFixed(1)}¢</span>
        </div>
        <div className="aw-row">
          <span className="lbl">Átlag vesztes trade</span>
          <span className="val ec-neg">{((p?.avg_loss??0)*100).toFixed(1)}¢</span>
        </div>
        <div className="aw-row">
          <span className="lbl">Tényleges win rate</span>
          <span className="val">{((wr)*100).toFixed(1)}%</span>
        </div>

        <div style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--muted)", marginTop:12, lineHeight:1.8 }}>
          Logika: Ha payout = {pr.toFixed(2)}x → break-even WR = {(beWr*100).toFixed(1)}%<br />
          A wallet {(wr*100).toFixed(0)}%-ot nyer → edge = {actualEdge>=0?"+":""}{(actualEdge*100).toFixed(1)}% / trade
        </div>
      </div>

      {catEntries.length > 0 && (
        <div className="aw-card">
          <div className="aw-ct">Category Specialist térkép</div>
          <div style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--muted)", marginBottom:12 }}>
            Csak a ✓ COPY kategóriákat másold – a ✗ SKIP kategóriák rontják az összképet
          </div>
          {catEntries.map(({ cat, win_rate, pnl, trades }) => {
            const pct   = win_rate * 100;
            const copy  = pct >= 65 && trades >= 10;
            const skip  = pct < 40;
            const color = copy ? "var(--accent)" : skip ? "var(--danger)" : "var(--warn)";
            return (
              <div key={cat} style={{ marginBottom:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontFamily:"var(--mono)", fontSize:11, fontWeight:700, color, width:80 }}>
                      {cat}
                    </span>
                    <span className={`aw-tag ${copy ? "green" : skip ? "red" : "yellow"}`}>
                      {copy ? "✓ COPY" : skip ? "✗ SKIP" : "WATCH"}
                    </span>
                  </div>
                  <div style={{ fontFamily:"var(--mono)", fontSize:11, color:"var(--muted)" }}>
                    <span style={{ color: pnl >= 0 ? "var(--accent)" : "var(--danger)", fontWeight:700, marginRight:12 }}>
                      ${pnl >= 0 ? "+" : ""}{pnl.toLocaleString("en-US", {maximumFractionDigits:0})}
                    </span>
                    <span>{trades} trade</span>
                  </div>
                </div>
                <div style={{ height:8, background:"var(--surface2)", borderRadius:4, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${pct}%`, background:color,
                    opacity:0.75, borderRadius:4, transition:"width .8s ease" }} />
                </div>
                <div style={{ fontFamily:"var(--mono)", fontSize:10, color, marginTop:2 }}>
                  {pct.toFixed(0)}% win rate
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── BOT SCORE COMPONENT ──────────────────────────────────────────────────────
function botColor(score: number): string {
  if (score >= 80) return "var(--danger)";
  if (score >= 60) return "#f16535";
  if (score >= 35) return "var(--warn)";
  if (score >= 15) return "var(--accent2)";
  return "var(--accent)";
}

function BotScoreCard({ bs }: { bs: any }) {
  const score = bs?.score ?? 0;
  const cls   = bs?.classification ?? "UNCERTAIN";
  const emoji = cls === "BOT" ? "🤖" : cls === "LIKELY_BOT" ? "⚠ 🤖" :
                cls === "UNCERTAIN" ? "❓" : cls === "LIKELY_HUMAN" ? "👤?" : "👤";
  const m     = bs?.metrics || {};
  return (
    <div className="aw-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="aw-ct" style={{ margin: 0 }}>Bot Detector</div>
        <span className={`aw-bot-badge ${cls}`}>{emoji} {cls.replace("_", " ")}</span>
      </div>

      {/* Score bar */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginBottom: 4 }}>
          <span>Bot score</span><span style={{ color: botColor(score), fontWeight: 700 }}>{score}/100</span>
        </div>
        <div className="aw-bot-bar">
          <div className="aw-bot-bar-fill" style={{ width: `${score}%`, background: botColor(score) }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 9, color: "var(--border)", marginTop: 2 }}>
          <span>HUMAN</span><span>UNCERTAIN</span><span>BOT</span>
        </div>
      </div>

      {/* Metrics */}
      <div className="aw-row"><span className="lbl">Focus ratio</span>
        <span className={`val ${(m.focus_ratio||0) > 20 ? "ec-warn" : "ec-pos"}`}>{(m.focus_ratio||0).toFixed(1)} trade/piac</span>
      </div>
      <div className="aw-row"><span className="lbl">24h aktivitás</span>
        <span className={`val ${(m.hours_active_pct||0) > 0.9 ? "ec-warn" : "ec-pos"}`}>{((m.hours_active_pct||0)*100).toFixed(0)}%</span>
      </div>
      <div className="aw-row"><span className="lbl">Sleep gap</span>
        <span className={`val ${m.has_sleep_gap ? "ec-pos" : "ec-warn"}`}>{m.has_sleep_gap ? "✓ Van" : "✗ Nincs"}</span>
      </div>
      <div className="aw-row"><span className="lbl">Median interval</span>
        <span className={`val ${m.median_interval_sec !== null && m.median_interval_sec < 60 ? "ec-warn" : "ec-pos"}`}>
          {m.median_interval_sec !== null ? `${m.median_interval_sec}s` : "N/A"}
        </span>
      </div>
      <div className="aw-row"><span className="lbl">Timing regularity</span>
        <span className={`val ${(m.timing_regularity||0) > 0.7 ? "ec-warn" : "ec-pos"}`}>{((m.timing_regularity||0)*100).toFixed(0)}%</span>
      </div>

      {/* Signals */}
      {bs?.signals?.length > 0 && (
        <div style={{ marginTop: 12, fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", lineHeight: 1.9 }}>
          {bs.signals.map((s: string, i: number) => (
            <div key={i} style={{ color: s.includes("Nincs bot") ? "var(--accent)" : "var(--warn)" }}>→ {s}</div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10, fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", lineHeight: 1.6 }}>
        Forrás: Hubble Research Bot Zone módszertan<br />
        Apex konszenzusból BOT és LIKELY_BOT szűrve
      </div>
    </div>
  );
}

// ─── TIME HEATMAP COMPONENT ───────────────────────────────────────────────────
const SESSION_META: Record<string, { label: string; color: string; utc: string }> = {
  low_liquidity: { label: '4AM ET – Low Liq',  color: 'var(--accent)',  utc: 'UTC 07-10' },
  london:        { label: 'London Open',        color: 'var(--accent2)', utc: 'UTC 06-09' },
  ny_open:       { label: 'NY Open',            color: 'var(--warn)',    utc: 'UTC 13-17' },
  ny_close:      { label: 'NY Close',           color: '#f16535',        utc: 'UTC 20-23' },
  asian:         { label: 'Asian',              color: '#a78bfa',        utc: 'UTC 23-06' },
};

function sessionColor(utcHour: number): string {
  if (utcHour >= 7  && utcHour <= 10) return 'var(--accent)';
  if (utcHour >= 6  && utcHour <= 9)  return 'var(--accent2)';
  if (utcHour >= 13 && utcHour <= 17) return 'var(--warn)';
  if (utcHour >= 20 && utcHour <= 23) return '#f16535';
  return '#a78bfa';
}

function TimeHeatmap({ ta }: { ta: any }) {
  const hourly: number[] = ta.hourly_distribution || new Array(24).fill(0);
  const maxVal = Math.max(...hourly, 1);
  const sessions: Record<string, number> = ta.session_breakdown || {};
  const totalTrades = Object.values(sessions).reduce((s: number, v: any) => s + v, 0) || 1;
  const isLowLiqHeavy = ta.low_liq_pct > 0.20;

  return (
    <div className="aw-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="aw-ct" style={{ margin: 0 }}>Időalapú aktivitás – Trade heatmap (UTC)</div>
        {isLowLiqHeavy && (
          <div className="aw-low-liq-badge">⚡ LOW LIQ HEAVY ({(ta.low_liq_pct * 100).toFixed(0)}%)</div>
        )}
      </div>

      {/* 24h heatmap */}
      <div className="aw-heatmap">
        {hourly.map((v: number, h: number) => {
          const intensity = v / maxVal;
          const color = sessionColor(h);
          return (
            <div key={h} className="aw-heatmap-cell"
              style={{ background: color, opacity: 0.15 + intensity * 0.85 }}
              title={`UTC ${h}:00 – ${v} trade`}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginTop: 4, marginBottom: 14 }}>
        <span>UTC 00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
      </div>

      {/* Session bars */}
      {Object.entries(SESSION_META).map(([key, meta]) => {
        const cnt  = sessions[key] || 0;
        const pct  = cnt / totalTrades * 100;
        return (
          <div key={key} className="aw-session-bar">
            <div className="aw-session-lbl">{meta.label} <span style={{ color: "var(--border)" }}>{meta.utc}</span></div>
            <div style={{ flex: 1, height: 14, background: "var(--surface2)", borderRadius: 2, overflow: "hidden" }}>
              <div className="aw-session-fill" style={{ width: `${pct}%`, background: meta.color, opacity: 0.75 }} />
            </div>
            <div className="aw-session-val">{pct.toFixed(0)}%</div>
          </div>
        );
      })}

      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 10, lineHeight: 1.7 }}>
        Peak: UTC {ta.peak_hour_utc}:00 ({ta.peak_session?.replace("_", " ")}) •
        Low liq trades: {ta.low_liq_trades} ({(ta.low_liq_pct * 100).toFixed(1)}%)
        {isLowLiqHeavy ? " ← swisstony pattern detektálva" : ""}
      </div>
    </div>
  );
}

function LeaderboardTab({ bankroll }: { bankroll: number }) {
  const [data,    setData]    = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [window,  setWindow]  = useState("7d");

  const load = useCallback(async (w: string) => {
    setLoading(true);
    try {
      const r = await fetch(`${FN}/apex-wallets?action=leaderboard&window=${w}&limit=50`);
      const j = await r.json();
      if (j.ok) setData(j);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load("7d"); }, []);

  return (
    <div>
      <div className="aw-chip-row">
        {["1d","7d","30d","all"].map(w => (
          <div key={w} className={`aw-chip ${window === w ? "active" : ""}`}
            onClick={() => { setWindow(w); load(w); }}>{w}</div>
        ))}
        {loading && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>Loading...</div>}
      </div>

      <div className="aw-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div className="aw-ct" style={{ margin: 0 }}>Top Wallets ({data?.count ?? 0}) – {window}</div>
          <button className="aw-btn" onClick={() => load(window)} disabled={loading}>{loading ? "..." : "⟳"}</button>
        </div>
        <table className="aw-tbl">
          <thead>
            <tr><th>#</th><th>Wallet</th><th>PnL</th><th>Volume</th><th>Trades</th><th>Apex?</th></tr>
          </thead>
          <tbody>
            {(data?.leaderboard || []).map((w: any, i: number) => {
              const pnlPerTrade = w.trades_count > 0 ? w.pnl / w.trades_count : 0;
              const likelyApex  = w.pnl > 5000 && w.trades_count > 50;
              return (
                <tr key={i}>
                  <td style={{ color: "var(--muted)" }}>{w.rank}</td>
                  <td>
                    <div style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 11 }}>{w.name || shortAddr(w.address)}</div>
                    <div className="aw-addr">{shortAddr(w.address)}</div>
                  </td>
                  <td className={w.pnl >= 0 ? "ec-pos" : "ec-neg"} style={{ fontWeight: 700 }}>
                    ${w.pnl.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </td>
                  <td style={{ color: "var(--muted)" }}>${(w.volume / 1000).toFixed(0)}k</td>
                  <td>{w.trades_count.toLocaleString()}</td>
                  <td><span className={`aw-tag ${likelyApex ? "green" : "yellow"}`}>{likelyApex ? "APEX?" : "WATCH"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="aw-info" style={{ marginTop: 14 }}>
          <strong>Megjegyzés:</strong> A leaderboard PnL alapú rangsor. Sharpe és win rate számításhoz a Python script szükséges (<code>--consensus</code> mód), mivel az a wallet-enkénti trade history-t is lekéri.
        </div>
      </div>
    </div>
  );
}

function ConsensusTab({ bankroll }: { bankroll: number }) {
  const [data,    setData]    = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${FN}/apex-wallets?action=consensus&window=7d`);
      const j = await r.json();
      if (j.ok) setData(j);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, []);

  const consensus = data?.consensus || [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          {loading && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginBottom: 8 }}>Loading consensus...</div>}
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
            {data?.apex_wallet_count ?? 0} apex wallet elemezve • {data?.consensus_markets ?? 0} consensus piac
          </div>
        </div>
        <button className="aw-btn primary" onClick={load} disabled={loading}>{loading ? "Elemzés..." : "⟳ Consensus Scan"}</button>
      </div>

      {/* Stats */}
      <div className="aw-grid3" style={{ marginBottom: 14 }}>
        <div className="aw-card">
          <div className="aw-big ec-pos">{data?.apex_wallet_count ?? 0}</div>
          <div className="aw-lbl">Apex wallet</div>
        </div>
        <div className="aw-card">
          <div className="aw-big ec-neu">{data?.consensus_markets ?? 0}</div>
          <div className="aw-lbl">Consensus piac</div>
        </div>
        <div className="aw-card">
          <div className="aw-big ec-warn">
            {consensus.length > 0 ? Math.max(...consensus.map((c: any) => c.confidence * 100)).toFixed(0) + "%" : "—"}
          </div>
          <div className="aw-lbl">Max confidence</div>
        </div>
      </div>

      {/* Consensus signals */}
      <div className="aw-card">
        <div className="aw-ct">Consensus jelzések</div>
        {consensus.length === 0 ? (
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", padding: "12px 0" }}>
            Nincs consensus – az apex walletok különböző piacokban aktívak, vagy API nem elérhető.
          </div>
        ) : (
          consensus.map((c: any, i: number) => {
            const isBuy = c.dominant_side === "BUY";
            const qk    = kellySize(c.confidence, c.avg_entry_price, c.dominant_side);
            const pos   = (bankroll * qk / 100).toFixed(2);
            return (
              <div key={i} className={`aw-signal-card ${isBuy ? "buy" : "sell"}`}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <span className={`aw-tag ${isBuy ? "green" : "red"}`}>{isBuy ? "▲ BUY" : "▼ SELL"}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginLeft: 8 }}>
                      {c.apex_wallet_count} apex wallet
                    </span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700, color: isBuy ? "var(--accent)" : "var(--danger)" }}>
                      {(c.confidence * 100).toFixed(0)}% conf.
                    </div>
                  </div>
                </div>

                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)", marginBottom: 10, lineHeight: 1.5 }}>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noopener noreferrer"
                      style={{ color: "var(--text)", textDecoration: "none", borderBottom: "1px dashed var(--border)" }}>
                      {c.question || c.slug || c.market}
                    </a>
                  ) : (
                    c.question || c.slug || c.market
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  <div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 700 }}>{(c.avg_entry_price * 100).toFixed(1)}¢</div>
                    <div className="aw-lbl">Átlag belépés</div>
                  </div>
                  <div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 700, color: "var(--accent2)" }}>{qk}%</div>
                    <div className="aw-lbl">¼-Kelly</div>
                  </div>
                  <div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 16, fontWeight: 700, color: "var(--accent)" }}>${pos}</div>
                    <div className="aw-lbl">Pozíció méret</div>
                  </div>
                </div>

                {/* Confidence bar */}
                <div className="aw-progress" style={{ marginTop: 10 }}>
                  <div className="aw-progress-fill" style={{
                    width: `${c.confidence * 100}%`,
                    background: isBuy ? "var(--accent)" : "var(--danger)",
                    opacity: 0.7,
                  }} />
                </div>

                {c.wallets?.length > 0 && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 8 }}>
                    Wallets: {c.wallets.map(shortAddr).join(" • ")}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="aw-info">
        <strong>Módszertan:</strong> {data?.methodology || "Top 20% leaderboard wallet, consensus = 2+ apex wallet ugyanolyan irányban."}<br /><br />
        <strong>Python CLI (részletesebb):</strong><br />
        <code>python apex_wallet_profiler.py --consensus --window 7d</code><br />
        <code>python apex_wallet_profiler.py --consensus --claude</code> &nbsp;← Claude API elemzéssel
      </div>
    </div>
  );
}

function ProfileTab({ bankroll }: { bankroll: number }) {
  const [address, setAddress] = useState("");
  const [data,    setData]    = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (addr?: string) => {
    const a = addr || address;
    if (!a.trim()) return;
    setLoading(true);
    try {
      const r = await fetch(`${FN}/apex-wallets?action=profile&address=${encodeURIComponent(a)}`);
      const j = await r.json();
      if (j.ok) setData(j);
    } catch {}
    finally { setLoading(false); }
  }, [address]);

  const p = data?.profile;

  return (
    <div>
      <div className="aw-card" style={{ marginBottom: 14 }}>
        <div className="aw-ct">Wallet profil lekérése</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="aw-input" value={address} onChange={e => setAddress(e.target.value)}
            placeholder="0x... (Polymarket proxy wallet address)" style={{ flex: 1 }} />
          <button className="aw-btn primary" onClick={() => load()} disabled={loading || !address.trim()}>
            {loading ? "..." : "PROFIL →"}
          </button>
        </div>
        {loading && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 8 }}>Loading profile...</div>}
      </div>

      {p && (
        <>
          <div className="aw-grid2" style={{ marginBottom: 14 }}>
            <div className="aw-card">
              <div className="aw-ct">Összefoglaló</div>
              <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
                <div>
                  <div className={`aw-big ${p.is_apex ? "ec-pos" : "ec-warn"}`}>{p.is_apex ? "APEX" : "WATCH"}</div>
                  <div className="aw-lbl">Besorolás</div>
                </div>
                <div>
                  <div className="aw-big ec-neu">{p.sharpe_ratio.toFixed(2)}</div>
                  <div className="aw-lbl">Sharpe</div>
                </div>
              </div>
              <div className="aw-row"><span className="lbl">Win rate</span><span className={`val ${p.win_rate > 0.6 ? "ec-pos" : "ec-warn"}`}>{(p.win_rate * 100).toFixed(1)}%</span></div>
              <div className="aw-row"><span className="lbl">Trades</span><span className="val">{p.total_trades.toLocaleString()}</span></div>
              <div className="aw-row"><span className="lbl">Volume</span><span className="val">${p.total_volume.toLocaleString()}</span></div>
              <div className="aw-row"><span className="lbl">Piacok</span><span className="val">{p.markets_count}</span></div>
              <div className="aw-row"><span className="lbl">Átlag pozíció</span><span className="val">${p.avg_position_size.toFixed(0)}</span></div>
            </div>

            <div className="aw-card">
              <div className="aw-ct">Apex kritériumok</div>
              {Object.entries(p.apex_criteria).map(([k, v]: any) => (
                <div key={k} className="aw-row">
                  <span className="lbl">{k.replace("_ok", "").replace("_", " ")}</span>
                  <span className={`aw-tag ${v ? "green" : "red"}`}>{v ? "✓ OK" : "✗ FAIL"}</span>
                </div>
              ))}
              <div style={{ marginTop: 14, fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>
                Apex: Sharpe &gt; 2.0 • WR &gt; 60% • min. 20 trade
              </div>
            </div>
          </div>

          {p.recent_markets?.length > 0 && (
            <div className="aw-card">
              <div className="aw-ct">Legutóbbi aktív piacok</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {p.recent_markets.map((m: string, i: number) => (
                  <div key={i} style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                    → {m}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {p && <PayoutCard p={p} />}
      {p?.time_activity && <TimeHeatmap ta={p.time_activity} />}
      {p?.bot_score && <BotScoreCard bs={p.bot_score} />}

      <div className="aw-info">
        <strong>Fontos:</strong> Polymarket proxy wallet address kell (nem az EOA/MetaMask address).<br />
        A proxy address a profil URL-jében látható: polymarket.com/profile/<strong>0x...</strong><br /><br />
        <code>python apex_wallet_profiler.py --profile 0x...</code>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function ApexWalletsPanel({ bankroll }: { bankroll: number }) {
  const [tab, setTab] = useState("consensus");

  return (
    <>
      <style>{css}</style>
      <div className="aw-wrap">
        <div className="aw-topbar">
          <div>
            <div style={{ fontFamily: "var(--sans)", fontSize: 18, fontWeight: 800, letterSpacing: "-.02em", marginBottom: 3 }}>
              Apex Wallet Profiler
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
              Leaderboard • Sharpe / Win Rate szűrés • Consensus Detection
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
          {[["consensus","Consensus"], ["leaderboard","Leaderboard"], ["profile","Profil"]].map(([id, lbl]) => (
            <button key={id} className={`aw-btn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{lbl}</button>
          ))}
        </div>

        {tab === "consensus"   && <ConsensusTab   bankroll={bankroll} />}
        {tab === "leaderboard" && <LeaderboardTab bankroll={bankroll} />}
        {tab === "profile"     && <ProfileTab     bankroll={bankroll} />}
      </div>
    </>
  );
}
