import { useState, useEffect, useCallback, useRef } from "react";
import { fetchMarkets, fetchFundingRates, loadSettings, saveSettings, getOrCreateUID } from "../lib/api";
import TradingPanel from "./TradingPanel";
import OrderFlowPanel from "./OrderFlowPanel";
import VolDivergencePanel from "./VolDivergencePanel";
import ApexWalletsPanel from "./ApexWalletsPanel";
import CondProbPanel from "./CondProbPanel";
import SignalCombinerPanel from "./SignalCombinerPanel";
import ArbMatrixPanel from "./ArbMatrixPanel";

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Market {
  question: string;
  slug: string;
  category: string;
  yes_price: number;
  no_price: number;
  volume_24h: number;
  liquidity: number;
  end_date: string;
  signal_note: string;
  url: string;
}

interface AgentType {
  id: string;
  label: string;
  color: string;
  bgColor: string;
  count: number;
  description: string;
  biasDir: number;
  updateSpeed: number;
  noiseLevel: number;
  weight: number;
}

interface Agent {
  id: number;
  typeId: string;
  color: string;
  bgColor: string;
  weight: number;
  updateSpeed: number;
  noiseLevel: number;
  biasDir: number;
  belief: number;
  prevBelief: number;
  x: number;
  y: number;
  active: boolean;
}

interface MCResult {
  mean: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  results: number[];
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const calcEV  = (tp: number, mp: number) => tp * (1 - mp) - (1 - tp) * mp;
const calcKelly = (tp: number, mp: number): number => {
  if (mp <= 0 || mp >= 1) return 0;
  const b = 1 / mp - 1;
  return Math.max(0, (tp * b - (1 - tp)) / b);
};
const clamp   = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rand    = (a: number, b: number) => a + Math.random() * (b - a);
const randNorm = (mu = 0, sigma = 1) => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ─── CSS-IN-JS ────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {};

const css = `
.ec-header{border-bottom:1px solid var(--border);padding:13px 26px;display:flex;align-items:center;justify-content:space-between;background:var(--surface)}
.ec-logo{font-family:var(--mono);font-size:11px;color:var(--accent);letter-spacing:.15em;text-transform:uppercase}
.ec-logo span{color:var(--muted)}
.ec-tabs{display:flex;border-bottom:1px solid var(--border);background:var(--surface);padding:0 26px;overflow-x:auto}
.ec-tab{background:none;border:none;color:var(--muted);font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:12px 17px;cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;position:relative;top:1px;white-space:nowrap}
.ec-tab:hover{color:var(--text)}
.ec-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.ec-content{padding:24px;max-width:1200px;margin:0 auto}
.ec-grid2{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.ec-card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:19px}
.ec-card-title{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:15px;display:flex;align-items:center;gap:7px}
.ec-card-title::before{content:'';display:inline-block;width:6px;height:6px;background:var(--accent);border-radius:50%}
.ec-field{margin-bottom:12px}
.ec-field label{display:block;font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}
.ec-field input,.ec-field select{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:13px;padding:8px 10px;border-radius:2px;outline:none;transition:border-color .2s;-webkit-appearance:none;appearance:none}
.ec-field input:focus,.ec-field select:focus{border-color:var(--accent)}
.ec-field input[type=range]{padding:5px 0;background:none;border:none;accent-color:var(--accent);cursor:pointer}
.ec-big{font-family:var(--mono);font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1}
.ec-big-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-top:3px}
.ec-pos{color:var(--accent)}.ec-neg{color:var(--danger)}.ec-neu{color:var(--accent2)}.ec-warn{color:var(--warn)}
.ec-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px}
.ec-row:last-child{border-bottom:none}
.ec-row .lbl{color:var(--muted);font-size:11px}
.ec-row .val{font-weight:700}
.ec-verdict{margin-top:14px;padding:12px;border-radius:2px;font-family:var(--mono);font-size:11px;line-height:1.6;border-left:3px solid}
.ec-verdict.go{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.ec-verdict.wait{background:#1f1400;border-color:var(--warn);color:var(--warn)}
.ec-verdict.stop{background:#1f0000;border-color:var(--danger);color:var(--danger)}
.ec-info{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:12px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7;margin-top:12px}
.ec-info strong{color:var(--text)}
.ec-sec-title{font-family:var(--sans);font-size:18px;font-weight:800;margin-bottom:3px;letter-spacing:-.02em}
.ec-sec-sub{font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:19px}
.ec-tbl{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px}
.ec-tbl th{text-align:left;padding:6px 9px;font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.ec-tbl td{padding:8px 9px;border-bottom:1px solid #151520;vertical-align:middle}
.ec-tbl tr:hover td{background:var(--surface2);cursor:pointer}
.ec-badge{display:inline-block;padding:1px 6px;border-radius:2px;font-size:10px;font-family:var(--mono);letter-spacing:.05em;font-weight:700}
.ec-badge.green{background:#0f2000;color:var(--accent);border:1px solid #1a3300}
.ec-badge.red{background:#200000;color:var(--danger);border:1px solid #330000}
.ec-badge.yellow{background:#1f1400;color:var(--warn);border:1px solid #332200}
.ec-divider{border:none;border-top:1px solid var(--border);margin:14px 0}
.ec-kelly-wrap{margin-top:5px;background:var(--surface2);border-radius:2px;height:6px;overflow:hidden}
.ec-kelly-bar{height:100%;background:var(--accent);border-radius:2px;transition:width .5s ease}
.ec-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:7px 12px;border-radius:2px;cursor:pointer;transition:all .2s;letter-spacing:.08em;text-transform:uppercase}
.ec-btn:hover{border-color:var(--accent);color:var(--accent)}
.ec-btn.primary{background:var(--accent);color:#0a0a0c;font-weight:700;border-color:var(--accent)}
.ec-btn.primary:hover{background:#d4ff40}
.ec-btn:disabled{opacity:.4;cursor:not-allowed}
.ec-tag{display:inline-block;padding:1px 5px;border-radius:2px;font-size:9px;font-family:var(--mono);background:var(--surface2);border:1px solid var(--border);color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.ec-chip-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:13px;align-items:center}
.ec-chip{background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-family:var(--mono);font-size:10px;color:var(--muted);cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:.07em}
.ec-chip:hover,.ec-chip.active{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.ec-mq{max-width:290px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.ec-upload{border:2px dashed var(--border);border-radius:4px;padding:26px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--muted);cursor:pointer;transition:all .2s}
.ec-upload:hover{border-color:var(--accent);color:var(--accent);background:#0f1f00}
.ec-sdot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px}
.ec-sdot.live{background:var(--accent);box-shadow:0 0 6px var(--accent);animation:pulse 2s infinite}
.ec-sdot.off{background:var(--muted)}
/* swarm */
.ec-swarm-canvas{width:100%;height:260px;background:var(--surface2);border-radius:4px;border:1px solid var(--border);position:relative;overflow:hidden}
.ec-agent{position:absolute;border-radius:50%;transform:translate(-50%,-50%);transition:all .55s ease;cursor:default;user-select:none}
.ec-agent.pulse{animation:agentPulse .38s ease}
.ec-sbar-row{display:flex;align-items:center;gap:9px;margin-bottom:9px}
.ec-sbar-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);width:110px;text-align:right;flex-shrink:0;text-transform:uppercase;letter-spacing:.05em}
.ec-sbar-track{flex:1;height:18px;background:var(--surface2);border-radius:2px;overflow:hidden;position:relative}
.ec-sbar-fill{height:100%;border-radius:2px;transition:width .8s ease}
.ec-sbar-val{position:absolute;right:5px;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:10px;font-weight:700;color:var(--bg)}
.ec-sbar-val.out{right:auto;left:calc(100% + 5px);color:var(--text)}
.ec-rnd{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10px;padding:3px 9px;background:var(--surface2);border:1px solid var(--border);border-radius:2px;color:var(--muted)}
.ec-rnd.on{border-color:var(--accent);color:var(--accent)}
.ec-simlog{height:110px;overflow-y:auto;font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1.9;border:1px solid var(--border);background:var(--surface2);padding:9px;border-radius:2px}
.ec-simlog .e{border-bottom:1px solid #151520;padding:1px 0}
.ec-simlog .e.hi{color:var(--accent2)}
.ec-simlog .e.wn{color:var(--warn)}
.ec-consensus{font-family:var(--mono);font-size:44px;font-weight:700;letter-spacing:-.03em;line-height:1;text-align:center;margin:10px 0}
.ec-vs{display:flex;align-items:center;justify-content:center;gap:16px;margin:13px 0}
.ec-vs-block{text-align:center}
.ec-vs-num{font-family:var(--mono);font-size:24px;font-weight:700}
.ec-vs-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:2px}
.ec-vs-sep{font-family:var(--mono);font-size:14px;color:var(--border)}
@media(max-width:768px){.ec-grid2{grid-template-columns:1fr}.ec-content{padding:13px}}
`;

// ─── AGENT CONFIG ─────────────────────────────────────────────────────────────
const AGENT_TYPES: AgentType[] = [
  { id:"base_rate",  label:"Base-rate",   color:"#35f1c8", bgColor:"#003322", count:6, description:"Historikus alap-valószínűségekből indul.", biasDir:0,  updateSpeed:0.15, noiseLevel:0.04, weight:1.2 },
  { id:"momentum",   label:"Momentum",    color:"#f1a035", bgColor:"#2a1500", count:7, description:"Trend követő, gyors frissítés.",           biasDir:1,  updateSpeed:0.45, noiseLevel:0.08, weight:0.8 },
  { id:"contrarian", label:"Contrarian",  color:"#f13535", bgColor:"#220000", count:5, description:"Szélső árakkal szemben fogad.",             biasDir:-1, updateSpeed:0.25, noiseLevel:0.06, weight:0.9 },
  { id:"pollster",   label:"Pollster",    color:"#c8f135", bgColor:"#1a2200", count:5, description:"Külső adatforrásokat dolgoz fel.",           biasDir:0,  updateSpeed:0.20, noiseLevel:0.05, weight:1.3 },
  { id:"narrative",  label:"Narrative",   color:"#a78bfa", bgColor:"#1a0030", count:4, description:"Médiát és narratívákat követ.",             biasDir:1,  updateSpeed:0.55, noiseLevel:0.12, weight:0.6 },
  { id:"quant",      label:"Quant",       color:"#38bdf8", bgColor:"#001a2a", count:5, description:"Matematikai modell, lassú, stabil.",         biasDir:0,  updateSpeed:0.10, noiseLevel:0.02, weight:1.5 },
];

// ─── SWARM FUNCTIONS ──────────────────────────────────────────────────────────
function buildAgents(mp: number, es: number): Agent[] {
  const agents: Agent[] = [];
  let id = 0;
  for (const t of AGENT_TYPES) {
    for (let i = 0; i < t.count; i++) {
      const b = clamp(mp + randNorm(0, t.noiseLevel * 2), 0.05, 0.95);
      agents.push({ id: id++, typeId: t.id, color: t.color, bgColor: t.bgColor, weight: t.weight, updateSpeed: t.updateSpeed, noiseLevel: t.noiseLevel, biasDir: t.biasDir, belief: b, prevBelief: b, x: rand(6, 94), y: rand(6, 94), active: false });
    }
  }
  return agents;
}

function stepAgents(agents: Agent[], mp: number, es: number): Agent[] {
  return agents.map(a => {
    if (Math.random() > a.updateSpeed) return { ...a, active: false };
    const noise      = randNorm(0, a.noiseLevel);
    const sigPull    = (es - a.belief) * 0.12;
    const mktPull    = (mp - a.belief) * 0.08;
    const biasPull   = a.biasDir * 0.015;
    const swarmPull  = agents.filter(b => b.typeId !== a.typeId).reduce((s, b) => s + (b.belief - a.belief) * 0.015, 0) / Math.max(1, agents.length);
    const delta = sigPull + mktPull + biasPull + swarmPull + noise;
    return { ...a, prevBelief: a.belief, belief: clamp(a.belief + delta, 0.05, 0.95), active: Math.abs(delta) > 0.005 };
  });
}

function consensus(agents: Agent[]): number {
  let ws = 0, bs = 0;
  for (const a of agents) { ws += a.weight; bs += a.belief * a.weight; }
  return ws > 0 ? bs / ws : 0.5;
}

function monteCarlo(agents: Agent[], mp: number, es: number, runs = 2000): MCResult {
  const results: number[] = [];
  for (let r = 0; r < runs; r++) {
    let sim = agents.map(a => ({ ...a, belief: clamp(a.belief + randNorm(0, a.noiseLevel * 2), 0.05, 0.95) }));
    for (let s = 0; s < 8; s++) sim = stepAgents(sim, mp, es);
    results.push(consensus(sim));
  }
  results.sort((a, b) => a - b);
  const mean = results.reduce((s, v) => s + v, 0) / runs;
  return { mean, p5: results[Math.floor(runs * 0.05)], p25: results[Math.floor(runs * 0.25)], p75: results[Math.floor(runs * 0.75)], p95: results[Math.floor(runs * 0.95)], results };
}

// ─── DEMO DATA ────────────────────────────────────────────────────────────────
const DEMO_MARKETS: Market[] = [
  { question:"Will the Fed hold rates at May 2025?",       slug:"fed-hold-may-2025",  category:"economics",  yes_price:0.65, no_price:0.35, volume_24h:284000, liquidity:45000,  end_date:"2025-05-07", signal_note:"Közel 50/50", url:"https://polymarket.com" },
  { question:"Will Bitcoin exceed $100k before June 2025?",slug:"btc-100k-june",      category:"crypto",     yes_price:0.42, no_price:0.58, volume_24h:521000, liquidity:112000, end_date:"2025-06-01", signal_note:"Közel 50/50", url:"https://polymarket.com" },
  { question:"Will there be a ceasefire in Gaza by Q2?",   slug:"gaza-ceasefire",     category:"geopolitics",yes_price:0.31, no_price:0.69, volume_24h:178000, liquidity:29000,  end_date:"2025-06-30", signal_note:"Közel 50/50", url:"https://polymarket.com" },
  { question:"Will Elon Musk remain DOGE head 2025?",      slug:"musk-doge",          category:"politics",   yes_price:0.58, no_price:0.42, volume_24h:93000,  liquidity:18000,  end_date:"2025-12-31", signal_note:"Közel 50/50", url:"https://polymarket.com" },
  { question:"Will S&P 500 reach 6000 by March 2025?",     slug:"sp500-6000",         category:"finance",    yes_price:0.71, no_price:0.29, volume_24h:412000, liquidity:87000,  end_date:"2025-03-31", signal_note:"⚠ Magas ár",  url:"https://polymarket.com" },
  { question:"Will there be a US recession in 2025?",      slug:"us-recession",       category:"economics",  yes_price:0.28, no_price:0.72, volume_24h:245000, liquidity:52000,  end_date:"2025-12-31", signal_note:"Közel 50/50", url:"https://polymarket.com" },
];

const FUNDING_PAIRS = [
  { symbol:"BTC/USDT", fundingRate:0.012, interval:8 },
  { symbol:"ETH/USDT", fundingRate:0.008, interval:8 },
  { symbol:"SOL/USDT", fundingRate:0.031, interval:8 },
  { symbol:"BNB/USDT", fundingRate:-0.004,interval:8 },
  { symbol:"ARB/USDT", fundingRate:0.045, interval:8 },
];

const SWARM_PRESETS = [
  { label:"Fed kamat", mp:0.65, es:0.74 },
  { label:"BTC $100k", mp:0.42, es:0.38 },
  { label:"Tűzszünet", mp:0.31, es:0.44 },
  { label:"Egyedi",    mp:0.50, es:0.50 },
];

const CATS = ["összes","crypto","politics","economics","geopolitics","finance"];

// ─── SCANNER TAB ──────────────────────────────────────────────────────────────
function ScannerTab({ bankroll }: { bankroll: number }) {
  const [markets, setMarkets] = useState<Market[]>(DEMO_MARKETS);
  const [isDemo, setIsDemo]   = useState(true);
  const [sel, setSel]         = useState<Market | null>(null);
  const [up, setUp]           = useState(50);
  const [cat, setCat]         = useState("összes");
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = markets.filter(m => cat === "összes" || m.category === cat);

  const handleFile = (file: File) => {
    const r = new FileReader();
    r.onload = e => {
      try {
        const data = JSON.parse(e.target?.result as string);
        const list: Market[] = data.markets || data;
        if (Array.isArray(list) && list.length) { setMarkets(list); setIsDemo(false); }
      } catch { alert("Érvénytelen JSON"); }
    };
    r.readAsText(file);
  };

  return (
    <div>
      <div className="ec-sec-title">Polymarket Scanner</div>
      <div className="ec-sec-sub">
        <span className={`ec-sdot ${isDemo ? "off" : "live"}`} />
        {isDemo ? "DEMO ADATOK – futtasd a polymarket_scanner.py-t és töltsd be a JSON-t" : "ÉLŐ ADATOK"}
      </div>

      <div className="ec-chip-row">
        {CATS.map(c => <div key={c} className={`ec-chip ${cat === c ? "active" : ""}`} onClick={() => setCat(c)}>{c}</div>)}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: sel ? "1.3fr 1fr" : "1fr", gap: 15, marginBottom: 15 }}>
        <div className="ec-card">
          <div className="ec-card-title">Piacok ({filtered.length})</div>
          <div style={{ overflowX: "auto" }}>
            <table className="ec-tbl">
              <thead><tr><th>Kérdés</th><th>Kat.</th><th>YES</th><th>Vol 24h</th></tr></thead>
              <tbody>
                {filtered.map((m, i) => (
                  <tr key={i} onClick={() => { setSel(m); setUp(Math.round(m.yes_price * 100)); }}>
                    <td><div className="ec-mq">{m.question}</div></td>
                    <td><span className="ec-tag">{m.category}</span></td>
                    <td className="ec-pos" style={{ fontWeight: 700 }}>{(m.yes_price * 100).toFixed(1)}¢</td>
                    <td style={{ color: "var(--muted)" }}>${((m.volume_24h || 0) / 1000).toFixed(0)}k</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {sel && (() => {
          const mp = sel.yes_price, tp = up / 100, edge = tp - mp;
          const ev = calcEV(tp, mp), kF = calcKelly(tp, mp), pos = bankroll * kF * 0.25;
          const dir = edge > 0 ? "YES" : "NO", ok = Math.abs(edge) > 0.04 && kF > 0.02;
          return (
            <div className="ec-card">
              <div className="ec-card-title">EV Kalkulátor</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginBottom: 11, borderBottom: "1px solid var(--border)", paddingBottom: 9 }}>{sel.question}</div>
              <div className="ec-field"><label>Piaci ár</label><div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 700, color: "var(--accent)" }}>{(mp * 100).toFixed(1)}¢</div></div>
              <div className="ec-field"><label>Saját becslés: {up}%</label><input type="range" min={1} max={99} value={up} onChange={e => setUp(+e.target.value)} /></div>
              <div className="ec-row"><span className="lbl">Edge</span><span className={`val ${edge > 0 ? "ec-pos" : "ec-neg"}`}>{edge > 0 ? "+" : ""}{(edge * 100).toFixed(1)}%</span></div>
              <div className="ec-row"><span className="lbl">EV/share</span><span className={`val ${ev > 0 ? "ec-pos" : "ec-neg"}`}>{(ev * 100).toFixed(1)}¢</span></div>
              <div className="ec-row"><span className="lbl">¼ Kelly pozíció</span><span className={`val ${ok ? "ec-pos" : "ec-warn"}`}>${pos.toFixed(2)}</span></div>
              <div className={`ec-verdict ${!ok ? "stop" : Math.abs(edge) > 0.1 ? "go" : "wait"}`}>
                {!ok ? `✗ Edge túl kicsi` : Math.abs(edge) > 0.1 ? `✓ BUY ${dir} @ $${pos.toFixed(2)}` : `~ BUY ${dir} @ $${pos.toFixed(2)}`}
              </div>
              <a href={sel.url} target="_blank" rel="noopener noreferrer" style={{ display: "block", marginTop: 8, fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent2)", textDecoration: "none" }}>→ Megnyit Polymarketen ↗</a>
            </div>
          );
        })()}
      </div>

      <div className="ec-card">
        <div className="ec-card-title">JSON import (polymarket_scanner.py output)</div>
        <div className="ec-upload"
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          onClick={() => fileRef.current?.click()}>
          <div style={{ fontSize: 20, marginBottom: 5 }}>📂</div>
          <div>Húzd ide a <strong>polymarket_data.json</strong> fájlt</div>
        </div>
        <input ref={fileRef} type="file" accept=".json" style={{ display: "none" }} onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
        <div className="ec-info">
          <strong>Workflow:</strong> python polymarket_scanner.py → polymarket_data.json → ide töltsd be<br />
          <strong>Fiók nyitás:</strong> polymarket.com → email login → USDC befizetés Polygon hálózaton
        </div>
      </div>
    </div>
  );
}

// ─── EV TAB ───────────────────────────────────────────────────────────────────
function EVTab({ bankroll }: { bankroll: number }) {
  const [mp, setMp]     = useState(40);
  const [tp, setTp]     = useState(60);
  const [kelly, setKelly] = useState(0.25);
  const mpF = mp / 100, tpF = tp / 100;
  const edge = tpF - mpF, ev = calcEV(tpF, mpF);
  const kF = calcKelly(tpF, mpF), kA = kF * kelly, pos = bankroll * kA;
  const dir = edge > 0 ? "YES" : edge < 0 ? "NO" : "—";
  const ok = Math.abs(edge) > 0.04 && kF > 0.02;

  return (
    <div>
      <div className="ec-sec-title">EV Kalkulátor</div>
      <div className="ec-sec-sub">Expected Value + Kelly pozícióméretezés • LMSR ármodell</div>
      <div className="ec-grid2" style={{ marginBottom: 15 }}>
        <div className="ec-card">
          <div className="ec-card-title">Bemeneti adatok</div>
          <div className="ec-field"><label>Piaci ár: {mp}¢</label><input type="range" min={1} max={99} value={mp} onChange={e => setMp(+e.target.value)} /><div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700, marginTop: 4 }}>{mp}¢</div></div>
          <div className="ec-field"><label>Saját becslés: {tp}%</label><input type="range" min={1} max={99} value={tp} onChange={e => setTp(+e.target.value)} /><div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700, color: "var(--accent2)", marginTop: 4 }}>{tp}%</div></div>
          <div className="ec-field"><label>Kelly fraction: {(kelly * 100).toFixed(0)}%</label><input type="range" min={0.1} max={1} step={0.05} value={kelly} onChange={e => setKelly(+e.target.value)} /></div>
        </div>
        <div className="ec-card">
          <div className="ec-card-title">Eredmény</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 13 }}>
            <div><div className={`ec-big ${ev > 0 ? "ec-pos" : "ec-neg"}`}>{ev > 0 ? "+" : ""}{(ev * 100).toFixed(1)}¢</div><div className="ec-big-lbl">EV/share</div></div>
            <div><div className={`ec-big ${edge > 0 ? "ec-pos" : edge < 0 ? "ec-neg" : "ec-neu"}`}>{edge > 0 ? "+" : ""}{(edge * 100).toFixed(1)}%</div><div className="ec-big-lbl">Edge</div></div>
          </div>
          <hr className="ec-divider" />
          <div className="ec-row"><span className="lbl">Irány</span><span className={`val ${dir === "YES" ? "ec-pos" : dir === "NO" ? "ec-neg" : "ec-neu"}`}>BUY {dir}</span></div>
          <div className="ec-row"><span className="lbl">Full Kelly</span><span className="val">{(kF * 100).toFixed(1)}%</span></div>
          <div className="ec-row"><span className="lbl">Pozíció</span><span className={`val ${ok ? "ec-pos" : "ec-warn"}`}>${pos.toFixed(2)}</span></div>
          <div className="ec-kelly-wrap"><div className="ec-kelly-bar" style={{ width: `${Math.min(kA * 100, 100)}%` }} /></div>
          <div className={`ec-verdict ${!ok ? "stop" : Math.abs(edge) > 0.1 ? "go" : "wait"}`}>
            {!ok ? `✗ Edge ${(Math.abs(edge) * 100).toFixed(1)}% – skip` : Math.abs(edge) > 0.1 ? `✓ ERŐS – BUY ${dir} @ $${pos.toFixed(2)}` : `~ MÉRSÉKELT – BUY ${dir} @ $${pos.toFixed(2)}`}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── FUNDING TAB ──────────────────────────────────────────────────────────────
function FundingTab() {
  const [cap, setCap]   = useState(500);
  const [sel, setSel]   = useState(FUNDING_PAIRS[0]);
  const [fee, setFee]   = useState(0.02);
  const [days, setDays] = useState(30);

  const fpd  = (sel.fundingRate / 100) * (24 / sel.interval) * 3;
  const gross = cap * fpd, feeRT = cap * (fee / 100) * 2, net = gross * days - feeRT;
  const annual = (fpd * 365 * 100).toFixed(1), be = (feeRT / Math.max(gross, 0.0001)).toFixed(1);
  const isPos = sel.fundingRate > 0, isGood = Math.abs(sel.fundingRate) > 0.02;

  return (
    <div>
      <div className="ec-sec-title">Funding Rate Arbitrázs</div>
      <div className="ec-sec-sub">Delta-neutral stratégia • Spot long + Futures short</div>
      <div className="ec-grid2" style={{ marginBottom: 15 }}>
        <div className="ec-card">
          <div className="ec-card-title">Paraméterek</div>
          <div className="ec-field"><label>Tőke (USDT)</label><input type="number" value={cap} onChange={e => setCap(+e.target.value)} min={50} /></div>
          <div className="ec-field"><label>Pár</label>
            <select value={sel.symbol} onChange={e => setSel(FUNDING_PAIRS.find(p => p.symbol === e.target.value)!)}>
              {FUNDING_PAIRS.map(p => <option key={p.symbol} value={p.symbol}>{p.symbol} FR:{p.fundingRate > 0 ? "+" : ""}{p.fundingRate}%</option>)}
            </select>
          </div>
          <div className="ec-field"><label>Fee: {fee}%</label><input type="number" value={fee} onChange={e => setFee(+e.target.value)} step={0.01} min={0} /></div>
          <div className="ec-field"><label>Napok: {days}</label><input type="range" min={1} max={180} value={days} onChange={e => setDays(+e.target.value)} /></div>
        </div>
        <div className="ec-card">
          <div className="ec-card-title">Eredmény</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div><div className={`ec-big ${isPos ? "ec-pos" : "ec-neg"}`}>{isPos ? "+" : ""}{annual}%</div><div className="ec-big-lbl">Éves hozam</div></div>
            <div><div className={`ec-big ${net > 0 ? "ec-pos" : "ec-neg"}`}>{net > 0 ? "+" : ""}${net.toFixed(2)}</div><div className="ec-big-lbl">{days} nap</div></div>
          </div>
          <hr className="ec-divider" />
          <div className="ec-row"><span className="lbl">Napi funding</span><span className={`val ${isPos ? "ec-pos" : "ec-neg"}`}>${gross.toFixed(4)}</span></div>
          <div className="ec-row"><span className="lbl">Nyitási fee</span><span className="val ec-neg">-${feeRT.toFixed(4)}</span></div>
          <div className="ec-row"><span className="lbl">Break-even</span><span className="val ec-neu">{isPos ? `${be} nap` : "N/A"}</span></div>
          <div className={`ec-verdict ${!isPos ? "stop" : isGood ? "go" : "wait"}`}>
            {!isPos ? "⛔ Negatív funding – fordítsd meg az irányt" : isGood ? `✓ Break-even ${be} nap` : `⚠ Alacsony funding – lassú megtérülés`}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SWARM TAB ────────────────────────────────────────────────────────────────
function SwarmTab({ bankroll }: { bankroll: number }) {
  const [preset, setPreset]   = useState(0);
  const [mp, setMp]           = useState(SWARM_PRESETS[0].mp);
  const [es, setEs]           = useState(SWARM_PRESETS[0].es);
  const [agents, setAgents]   = useState<Agent[]>(() => buildAgents(SWARM_PRESETS[0].mp, SWARM_PRESETS[0].es));
  const [round, setRound]     = useState(0);
  const [running, setRunning] = useState(false);
  const [cons, setCons]       = useState(() => consensus(buildAgents(SWARM_PRESETS[0].mp, SWARM_PRESETS[0].es)));
  const [mc, setMc]           = useState<MCResult | null>(null);
  const [mcRunning, setMcR]   = useState(false);
  const [log, setLog]         = useState<{ msg: string; type: string }[]>([]);
  const intRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const roundRef = useRef(0);

  const addLog = (msg: string, type = "normal") => setLog(prev => [{ msg, type }, ...prev].slice(0, 40));

  const reset = useCallback((newMp: number, newEs: number) => {
    if (intRef.current) clearInterval(intRef.current);
    setRunning(false); roundRef.current = 0; setRound(0);
    const a = buildAgents(newMp, newEs);
    setAgents(a); setCons(consensus(a)); setMc(null); setLog([]);
  }, []);

  const selectPreset = (i: number) => {
    setPreset(i); const p = SWARM_PRESETS[i];
    setMp(p.mp); setEs(p.es); reset(p.mp, p.es);
  };

  const startStop = () => {
    if (running) { if (intRef.current) clearInterval(intRef.current); setRunning(false); return; }
    setRunning(true);
    intRef.current = setInterval(() => {
      roundRef.current += 1;
      setRound(r => r + 1);
      setAgents(prev => {
        const next = stepAgents(prev, mp, es);
        const c = consensus(next);
        setCons(c);
        const big = next.find(a => Math.abs(a.belief - a.prevBelief) > 0.025);
        if (big) {
          const t = AGENT_TYPES.find(t => t.id === big.typeId)!;
          addLog(`[R${roundRef.current}] ${t.label}: ${(big.prevBelief * 100).toFixed(1)}% → ${(big.belief * 100).toFixed(1)}%`, Math.abs(big.belief - big.prevBelief) > 0.04 ? "hi" : "normal");
        }
        if (roundRef.current % 10 === 0) addLog(`[R${roundRef.current}] Consensus: ${(c * 100).toFixed(2)}%`, "wn");
        return next;
      });
      if (roundRef.current >= 50) {
        if (intRef.current) clearInterval(intRef.current);
        setRunning(false); addLog("▣ Szimuláció kész (50 kör)", "hi");
      }
    }, 230);
  };

  const runMC = () => {
    setMcR(true);
    setTimeout(() => {
      const r = monteCarlo(agents, mp, es, 2000);
      setMc(r);
      addLog(`MC (2000 sim): mean=${(r.mean * 100).toFixed(1)}%, P5=${(r.p5 * 100).toFixed(1)}%, P95=${(r.p95 * 100).toFixed(1)}%`, "hi");
      setMcR(false);
    }, 80);
  };

  useEffect(() => () => { if (intRef.current) clearInterval(intRef.current); }, []);

  const edge = cons - mp, ev = calcEV(cons, mp), kF = calcKelly(cons, mp), pos = bankroll * kF * 0.25;
  const dir = edge > 0.01 ? "YES" : edge < -0.01 ? "NO" : "WAIT";
  const ok = Math.abs(edge) > 0.04 && kF > 0.02;

  const typeConsensus = AGENT_TYPES.map(t => {
    const ta = agents.filter(a => a.typeId === t.id);
    return { ...t, avg: ta.reduce((s, a) => s + a.belief, 0) / ta.length };
  });

  return (
    <div>
      <div className="ec-sec-title">Swarm Intelligence Modul</div>
      <div className="ec-sec-sub">{agents.length} ágens • {AGENT_TYPES.length} klaszter • súlyozott Bayesian konszenzus</div>

      <div className="ec-chip-row">
        {SWARM_PRESETS.map((p, i) => <div key={i} className={`ec-chip ${preset === i ? "active" : ""}`} onClick={() => selectPreset(i)}>{p.label}</div>)}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 15, marginBottom: 15 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          {/* Canvas */}
          <div className="ec-card" style={{ padding: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}>
              <div className="ec-card-title" style={{ margin: 0 }}>Ágens hálózat</div>
              <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <span className={`ec-rnd ${running ? "on" : ""}`}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: running ? "var(--accent)" : "var(--muted)", display: "inline-block" }} />
                  {round}/50
                </span>
                <button className={`ec-btn ${running ? "primary" : ""}`} onClick={startStop}>{running ? "⏸ Stop" : "▶ Start"}</button>
                <button className="ec-btn" onClick={() => reset(mp, es)}>↺</button>
              </div>
            </div>
            <div className="ec-swarm-canvas">
              <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                {agents.filter((_, i) => i % 4 === 0).map(a => {
                  const nearest = agents.filter(b => b.id !== a.id && b.typeId !== a.typeId).sort((x, y) => Math.hypot(x.x - a.x, x.y - a.y) - Math.hypot(y.x - a.x, y.y - a.y))[0];
                  if (!nearest) return null;
                  return <line key={`${a.id}-${nearest.id}`} x1={`${a.x}%`} y1={`${a.y}%`} x2={`${nearest.x}%`} y2={`${nearest.y}%`} stroke={a.active ? a.color : "#232330"} strokeWidth={a.active ? "1.5" : "0.5"} strokeOpacity={a.active ? 0.5 : 0.2} style={{ transition: "all .3s" }} />;
                })}
              </svg>
              {agents.map(a => {
                const size = 10 + a.weight * 5;
                return (
                  <div key={a.id} className={`ec-agent ${a.active ? "pulse" : ""}`}
                    style={{ left: `${a.x}%`, top: `${a.y}%`, width: size, height: size, background: a.active ? a.color : a.bgColor, border: `1.5px solid ${a.color}`, opacity: 0.6 + a.belief * 0.4, boxShadow: a.active ? `0 0 8px ${a.color}88` : "none" }}
                    title={`${a.typeId}: ${(a.belief * 100).toFixed(1)}%`} />
                );
              })}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px 13px", marginTop: 9 }}>
              {AGENT_TYPES.map(t => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: t.color, display: "inline-block" }} />{t.label}
                </div>
              ))}
            </div>
          </div>

          {/* Params */}
          <div className="ec-card">
            <div className="ec-card-title">Paraméterek</div>
            <div className="ec-field">
              <label>Piaci ár (Polymarket): {(mp * 100).toFixed(0)}%</label>
              <input type="range" min={1} max={99} value={Math.round(mp * 100)} onChange={e => { const v = +e.target.value / 100; setMp(v); reset(v, es); }} />
            </div>
            <div className="ec-field">
              <label>Külső jel (fundamentum / OSINT): {(es * 100).toFixed(0)}%</label>
              <input type="range" min={1} max={99} value={Math.round(es * 100)} onChange={e => { const v = +e.target.value / 100; setEs(v); reset(mp, v); }} />
            </div>
            <div className="ec-info" style={{ margin: 0 }}>
              <strong>Külső jel:</strong> az az info, amit a piac még nem árazott be – közvélemény-kutatás, NOAA adat, jegybanki statement.
            </div>
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          <div className="ec-card">
            <div className="ec-card-title">Swarm Konszenzus</div>
            <div className="ec-consensus" style={{ color: edge > 0.04 ? "var(--accent)" : edge < -0.04 ? "var(--danger)" : "var(--accent2)" }}>
              {(cons * 100).toFixed(1)}%
            </div>
            <div className="ec-vs">
              <div className="ec-vs-block"><div className="ec-vs-num" style={{ color: "var(--muted)" }}>{(mp * 100).toFixed(0)}%</div><div className="ec-vs-lbl">Piac</div></div>
              <div className="ec-vs-sep">→</div>
              <div className="ec-vs-block"><div className="ec-vs-num ec-pos">{(cons * 100).toFixed(1)}%</div><div className="ec-vs-lbl">Swarm</div></div>
              <div className="ec-vs-sep">=</div>
              <div className="ec-vs-block"><div className={`ec-vs-num ${edge > 0 ? "ec-pos" : "ec-neg"}`}>{edge > 0 ? "+" : ""}{(edge * 100).toFixed(1)}%</div><div className="ec-vs-lbl">Edge</div></div>
            </div>
            <div className="ec-row"><span className="lbl">EV/share</span><span className={`val ${ev > 0 ? "ec-pos" : "ec-neg"}`}>{ev > 0 ? "+" : ""}{(ev * 100).toFixed(1)}¢</span></div>
            <div className="ec-row"><span className="lbl">¼ Kelly pozíció</span><span className={`val ${ok ? "ec-pos" : "ec-warn"}`}>${pos.toFixed(2)}</span></div>
            <div className="ec-row"><span className="lbl">Irány</span><span className={`val ${dir === "YES" ? "ec-pos" : dir === "NO" ? "ec-neg" : "ec-neu"}`}>{dir}</span></div>
            <div className={`ec-verdict ${!ok ? "stop" : Math.abs(edge) > 0.08 ? "go" : "wait"}`}>
              {!ok ? `✗ Swarm edge nincs (${(Math.abs(edge) * 100).toFixed(1)}%)` : Math.abs(edge) > 0.08 ? `✓ ERŐS SWARM EDGE – BUY ${dir} @ $${pos.toFixed(2)}` : `~ Mérsékelt edge – $${pos.toFixed(2)}`}
            </div>
          </div>

          <div className="ec-card">
            <div className="ec-card-title">Klaszter vélemények</div>
            {typeConsensus.map(t => {
              const pct = t.avg * 100;
              return (
                <div key={t.id} className="ec-sbar-row">
                  <div className="ec-sbar-lbl">{t.label}</div>
                  <div className="ec-sbar-track">
                    <div className="ec-sbar-fill" style={{ width: `${pct}%`, background: t.color, opacity: 0.8 }}>
                      {pct > 18 && <span className="ec-sbar-val">{pct.toFixed(1)}%</span>}
                    </div>
                    {pct <= 18 && <span className="ec-sbar-val out">{pct.toFixed(1)}%</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="ec-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 11 }}>
              <div className="ec-card-title" style={{ margin: 0 }}>Monte Carlo (2000 sim)</div>
              <button className="ec-btn primary" onClick={runMC} disabled={mcRunning}>{mcRunning ? "Fut..." : "▶ Futtat"}</button>
            </div>
            {mc ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9, marginBottom: 11 }}>
                  {([["P5", mc.p5], ["Átlag", mc.mean], ["P95", mc.p95]] as [string, number][]).map(([lbl, v]) => (
                    <div key={lbl} style={{ textAlign: "center" }}>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 17, fontWeight: 700, color: "var(--accent2)" }}>{(v * 100).toFixed(1)}%</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase" }}>{lbl}</div>
                    </div>
                  ))}
                </div>
                {Array.from({ length: 10 }, (_, i) => {
                  const lo = i / 10, hi = (i + 1) / 10;
                  const cnt = mc.results.filter(v => v >= lo && v < hi).length;
                  const pct = cnt / mc.results.length * 100;
                  const maxCnt = Math.max(...Array.from({ length: 10 }, (_, j) => mc.results.filter(v => v >= j / 10 && v < (j + 1) / 10).length));
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", width: 28, textAlign: "right" }}>{(lo * 100).toFixed(0)}%</span>
                      <div style={{ flex: 1, height: 11, background: "var(--surface2)", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct * 3}%`, background: cnt === maxCnt ? "var(--accent)" : "var(--accent2)", opacity: 0.75, borderRadius: 2 }} />
                      </div>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", width: 26 }}>{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </>
            ) : (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", textAlign: "center", padding: "14px 0" }}>
                Futtasd a Monte Carlo szimulációt
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="ec-card">
        <div className="ec-card-title">Szimuláció napló</div>
        <div className="ec-simlog">
          {log.length === 0
            ? <div style={{ textAlign: "center", paddingTop: 28, color: "var(--muted)" }}>Indítsd el a szimulációt a ▶ Start gombbal</div>
            : log.map((e, i) => <div key={i} className={`e ${e.type}`}>{e.msg}</div>)}
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [tab, setTab]         = useState<string>("swarm");
  const [bankroll, setBankroll] = useState(200);
  const TABS = [["scanner","01 // Scanner"],["ev","02 // EV Kalk."],["funding","03 // Funding Arb"],["swarm","04 // Swarm"],["trading","05 // Trading"],["orderflow","06 // Order Flow"],["vol","07 // Vol Harvest"],["apex","08 // Apex Wallets"],["condprob","09 // Cond. Prob"],["signals","10 // Signals"],["arbmatrix","11 // Arb Matrix"]] as const;

  return (
    <>
      <style>{css}</style>
      <div style={{ background: "var(--bg)", minHeight: "100vh", color: "var(--text)" }}>
        <div className="ec-header">
          <div className="ec-logo">EDGE<span>/</span>CALC <span>// polymarket + funding arb toolkit v3</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase" }}>Bankroll:</span>
            <input type="number" value={bankroll} onChange={e => setBankroll(+e.target.value)} min={10}
              style={{ background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 13, padding: "4px 8px", borderRadius: 2, outline: "none", width: 82, textAlign: "right" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>USD</span>
          </div>
        </div>
        <div className="ec-tabs">
          {TABS.map(([id, lbl]) => <button key={id} className={`ec-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{lbl}</button>)}
        </div>
        <div className="ec-content">
          {tab === "scanner"  && <ScannerTab bankroll={bankroll} />}
          {tab === "ev"       && <EVTab bankroll={bankroll} />}
          {tab === "funding"  && <FundingTab />}
          {tab === "swarm"    && <SwarmTab bankroll={bankroll} />}
          {tab === "trading"  && <TradingPanel />}
          {tab === "orderflow" && <OrderFlowPanel />}
          {tab === "vol"       && <VolDivergencePanel />}
          {tab === "apex" && <ApexWalletsPanel bankroll={bankroll} />}
          {tab === "condprob" && <CondProbPanel bankroll={bankroll} />}
        </div>
      </div>
    </>
  );
}
