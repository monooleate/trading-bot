// src/components/OrderFlowPanel.tsx
// Tab 06 – Kyle Lambda + VPIN + Hawkes + AS Quoting live dashboard

import { useState, useEffect, useCallback, useRef } from "react";

const FN = "/.netlify/functions";

// ─── STYLES ───────────────────────────────────────────────────────────────────
const css = `
.of-wrap{display:flex;flex-direction:column;gap:16px}
.of-topbar{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:4px}
.of-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.of-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.of-card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:18px}
.of-ct{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:7px}
.of-ct::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%;display:inline-block;flex-shrink:0}
.of-big{font-family:var(--mono);font-size:32px;font-weight:700;letter-spacing:-.03em;line-height:1}
.of-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:3px}
.of-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px}
.of-row:last-child{border-bottom:none}
.of-row .lbl{color:var(--muted);font-size:11px}
.of-row .val{font-weight:700}
.ec-pos{color:var(--accent)}.ec-neg{color:var(--danger)}.ec-neu{color:var(--accent2)}.ec-warn{color:var(--warn)}
.of-verdict{padding:13px;border-radius:2px;font-family:var(--mono);font-size:12px;line-height:1.6;border-left:3px solid;margin-top:12px;font-weight:700}
.of-verdict.green{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.of-verdict.yellow{background:#1f1400;border-color:var(--warn);color:var(--warn)}
.of-verdict.orange{background:#1f1000;border-color:#f16535;color:#f16535}
.of-verdict.red{background:#1f0000;border-color:var(--danger);color:var(--danger)}
.of-input{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;padding:8px 10px;border-radius:2px;outline:none;transition:border-color .2s}
.of-input:focus{border-color:var(--accent)}
.of-input::placeholder{color:var(--muted)}
.of-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:7px 13px;border-radius:2px;cursor:pointer;transition:all .2s;letter-spacing:.08em;text-transform:uppercase}
.of-btn:hover{border-color:var(--accent);color:var(--accent)}
.of-btn.primary{background:var(--accent);color:#0a0a0c;font-weight:700;border-color:var(--accent)}
.of-btn.primary:hover{background:#d4ff40}
.of-btn:disabled{opacity:.4;cursor:not-allowed}
.of-vpin-bar{height:20px;background:var(--surface2);border-radius:2px;overflow:hidden;position:relative;margin:6px 0}
.of-vpin-fill{height:100%;border-radius:2px;transition:width .8s ease}
.of-vpin-mark{position:absolute;top:0;bottom:0;width:2px;background:var(--danger);opacity:.6}
.of-hist{display:flex;align-items:flex-end;gap:2px;height:50px;margin-top:8px}
.of-hist-bar{flex:1;border-radius:1px 1px 0 0;transition:height .4s ease;min-width:4px}
.of-pulse{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;animation:pulse 2s infinite}
.of-info{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:12px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7}
.of-info strong{color:var(--text)}
.of-info code{color:var(--accent2)}
.of-tbl{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px}
.of-tbl th{text-align:left;padding:6px 9px;font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.of-tbl td{padding:7px 9px;border-bottom:1px solid #151520;cursor:pointer}
.of-tbl tr:hover td{background:var(--surface2)}
.of-mq{max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.of-tag{display:inline-block;padding:1px 6px;border-radius:2px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.07em;font-weight:700}
.of-tag.green{background:#0f2000;color:var(--accent);border:1px solid #1a3300}
.of-tag.yellow{background:#1f1400;color:var(--warn);border:1px solid #332200}
.of-tag.red{background:#200000;color:var(--danger);border:1px solid #330000}
.of-spinner{width:28px;height:28px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto}
.of-demo-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:var(--surface2);border:1px solid var(--warn);border-radius:2px;font-family:var(--mono);font-size:10px;color:var(--warn)}
@media(max-width:768px){.of-grid2,.of-grid3{grid-template-columns:1fr}}
`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function vpinColor(v: number) {
  if (v > 0.80) return "var(--danger)";
  if (v > 0.65) return "#f16535";
  if (v > 0.40) return "var(--warn)";
  return "var(--accent)";
}

function riskColor(risk: string) {
  return risk === "HIGH" ? "red" : risk === "MEDIUM" ? "orange" : risk === "LOW" ? "green" : "yellow";
}

function verdictClass(color: string) {
  return `of-verdict ${color}`;
}

// ─── DEMO DATA (ha nincs token_id) ────────────────────────────────────────────
const DEMO: any = {
  ok: true, mid_price: 0.62, n_trades: 187,
  kyle_lambda: { lambda: 0.00142, r_squared: 0.118, n_obs: 164, danger: false,
    interpretation: "🟡 MODERATE – some informed flow, moderate spread widening" },
  vpin: { current: 0.44, average: 0.38, max: 0.61, history: [0.31,0.35,0.38,0.41,0.44,0.42,0.39,0.44,0.47,0.44],
    signal: "🟡 CAUTION – VPIN > 0.40, above normal", pull_quotes: false, danger: false },
  hawkes: { mu: 0.82, alpha: 0.55, beta: 1.90, branching_ratio: 0.289,
    interpretation: "🟢 28.9% self-excited – normal exogenous flow", danger: false },
  spread_recommendation: {
    recommended_spread: 0.032, bid: 0.604, ask: 0.636,
    action: "✅ NORMÁL piac – standard spread megfelelő",
    reasons: [], pull_quotes: false,
  },
  is_demo: true,
};

// ─── MARKET PICKER ────────────────────────────────────────────────────────────
function MarketPicker({ onSelect }: { onSelect: (tokenId: string, question: string) => void }) {
  const [markets, setMarkets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState("");

  useEffect(() => {
    // Fetch markets directly from Gamma API (bypass proxy cache for fresh clobTokenIds)
    (async () => {
      try {
        const res = await window.fetch(
          "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=15&order=volume24hr&ascending=false"
        );
        const data = await res.json();
        const list = Array.isArray(data) ? data : [];
        const parsed = list.map((m: any) => {
          let yp = 0.5;
          try {
            const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
            if (Array.isArray(op)) yp = parseFloat(op[0]);
          } catch {}
          // Extract token IDs from clobTokenIds
          let tokenId = "";
          try {
            if (m.tokens?.length > 0) {
              const yes = m.tokens.find((t: any) => (t.outcome || "").toUpperCase() === "YES");
              tokenId = yes?.token_id || m.tokens[0]?.token_id || "";
            }
            if (!tokenId && m.clobTokenIds) {
              const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
              if (Array.isArray(ids) && ids.length > 0) tokenId = ids[0];
            }
          } catch {}
          return { question: m.question || "", slug: m.slug || "", yes_price: yp, volume_24h: parseFloat(m.volume24hr || 0), tokenId };
        }).filter((m: any) => m.yes_price > 0.05 && m.yes_price < 0.95);
        setMarkets(parsed);
      } catch {}
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", padding: "12px 0" }}>Piacok betöltése...</div>;

  return (
    <div className="of-card">
      <div className="of-ct">Piac kiválasztása (kattints az elemzéshez)</div>
      {resolving && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--warn)", padding: "4px 0" }}>Elemzés: {resolving}...</div>}
      <table className="of-tbl">
        <thead><tr><th>Kérdés</th><th>YES</th><th>Vol 24h</th></tr></thead>
        <tbody>
          {markets.map((m: any, i: number) => (
            <tr key={i} style={{ cursor: "pointer" }}
              onClick={() => {
                if (m.tokenId) {
                  onSelect(m.tokenId, m.question);
                } else {
                  // Auto-analyze without token_id — the backend resolves it
                  setResolving(m.question.slice(0, 30));
                  onSelect("auto", m.question);
                  setTimeout(() => setResolving(""), 3000);
                }
              }}>
              <td><div className="of-mq">{m.question}</div></td>
              <td className="ec-pos" style={{ fontWeight: 700 }}>{(m.yes_price * 100).toFixed(1)}¢</td>
              <td style={{ color: "var(--muted)" }}>${((m.volume_24h || 0) / 1000000).toFixed(1)}M</td>
            </tr>
          ))}
          {markets.length === 0 && (
            <tr><td colSpan={3} style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", padding: 12 }}>
              API nem elérhető – írd be manuálisan a token ID-t
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function OrderFlowPanel() {
  const [tokenId,  setTokenId]  = useState("");
  const [question, setQuestion] = useState("");
  const [data,     setData]     = useState<any>(null);
  const [loading,  setLoading]  = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdate,  setLastUpdate]  = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const analyze = useCallback(async (tid?: string) => {
    const id = tid || tokenId;
    if (!id.trim()) return;
    setLoading(true);
    try {
      const res  = await fetch(`${FN}/orderflow-analysis?token_id=${encodeURIComponent(id)}&limit=200`);
      const json = await res.json();
      if (json.ok) {
        setData(json);
        setLastUpdate(new Date().toLocaleTimeString("hu-HU"));
      }
    } catch {}
    finally { setLoading(false); }
  }, [tokenId]);

  // Auto-refresh 60mp-ként
  useEffect(() => {
    if (autoRefresh && tokenId) {
      timerRef.current = setInterval(() => analyze(), 60000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, tokenId, analyze]);

  const kyle   = data?.kyle_lambda           || {};
  const vpin   = data?.vpin                  || {};
  const hawkes = data?.hawkes                || {};
  const spread = data?.spread_recommendation || {};
  const mid    = data?.mid_price             || 0.5;
  const risk   = spread.pull_quotes ? "HIGH" : (kyle.danger || vpin.danger) ? "HIGH" : hawkes.danger ? "MEDIUM" : "LOW";

  return (
    <>
      <style>{css}</style>
      <div className="of-wrap">
        {/* Header */}
        <div className="of-topbar">
          <div>
            <div style={{ fontFamily: "var(--sans)", fontSize: 18, fontWeight: 800, letterSpacing: "-.02em", marginBottom: 3 }}>
              Order Flow Analysis
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
              Kyle λ • VPIN • Hawkes Process • Avellaneda-Stoikov
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {loading && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>Loading...</div>}
            {lastUpdate && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>frissítve: {lastUpdate}</span>}
            <button className="of-btn" onClick={() => setAutoRefresh(a => !a)}
              style={{ borderColor: autoRefresh ? "var(--accent)" : undefined, color: autoRefresh ? "var(--accent)" : undefined }}>
              {autoRefresh ? "⏸ Auto" : "▶ Auto"}
            </button>
          </div>
        </div>

        {/* Token input */}
        <div className="of-card" style={{ padding: 14 }}>
          <div className="of-ct">Token ID megadása</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="of-input" value={tokenId} onChange={e => setTokenId(e.target.value)}
              placeholder="Polymarket CLOB token_id (YES token)" style={{ flex: 1 }} />
            <button className="of-btn primary" onClick={() => analyze()} disabled={loading || !tokenId.trim()}>
              {loading ? "..." : "ELEMZÉS →"}
            </button>
          </div>
          {question && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginTop: 8 }}>{question}</div>}
        </div>

        {/* Overall verdict */}
        <div className={verdictClass(riskColor(risk))}>
          {spread.action || "Válassz piacot az elemzéshez"}
          {spread.reasons?.length > 0 && (
            <div style={{ marginTop: 4, fontWeight: 400, fontSize: 11 }}>
              {spread.reasons.join(" • ")}
            </div>
          )}
        </div>

        {/* 3 metrika kártya */}
        <div className="of-grid3">
          {/* Kyle Lambda */}
          <div className="of-card">
            <div className="of-ct">Kyle's Lambda</div>
            <div className={`of-big ${kyle.danger ? "ec-neg" : "ec-pos"}`}>
              {kyle.lambda != null ? kyle.lambda.toFixed(5) : "—"}
            </div>
            <div className="of-lbl">Price impact coeff.</div>
            <div style={{ height: 1, background: "var(--border)", margin: "12px 0" }} />
            <div className="of-row"><span className="lbl">R²</span><span className={`val ${(kyle.r_squared||0) > 0.15 ? "ec-warn" : "ec-neu"}`}>{kyle.r_squared != null ? kyle.r_squared.toFixed(4) : "—"}</span></div>
            <div className="of-row"><span className="lbl">Megfigyelések</span><span className="val">{kyle.n_obs ?? "—"}</span></div>
            <div className="of-row"><span className="lbl">Veszély</span>
              <span className={`of-tag ${kyle.danger ? "red" : "green"}`}>{kyle.danger ? "MAGAS" : "NORMÁL"}</span>
            </div>
            {kyle.interpretation && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
                {kyle.interpretation}
              </div>
            )}
          </div>

          {/* VPIN */}
          <div className="of-card">
            <div className="of-ct">VPIN</div>
            <div className={`of-big`} style={{ color: vpinColor(vpin.current || 0) }}>
              {vpin.current != null ? vpin.current.toFixed(3) : "—"}
            </div>
            <div className="of-lbl">Flow toxicity</div>
            <div className="of-vpin-bar" style={{ marginTop: 12 }}>
              <div className="of-vpin-fill" style={{
                width: `${(vpin.current || 0) * 100}%`,
                background: vpinColor(vpin.current || 0),
              }} />
              {/* Threshold markers */}
              <div className="of-vpin-mark" style={{ left: "65%" }} />
              <div className="of-vpin-mark" style={{ left: "80%" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginBottom: 8 }}>
              <span>0</span><span style={{ color: "var(--warn)" }}>0.65</span><span style={{ color: "var(--danger)" }}>0.80</span><span>1.0</span>
            </div>
            <div className="of-row"><span className="lbl">Átlag</span><span className="val">{vpin.average?.toFixed(3) ?? "—"}</span></div>
            <div className="of-row"><span className="lbl">Max</span><span className="val ec-warn">{vpin.max?.toFixed(3) ?? "—"}</span></div>
            {/* Mini histogram */}
            {vpin.history?.length > 0 && (
              <div className="of-hist">
                {vpin.history.map((v: number, i: number) => (
                  <div key={i} className="of-hist-bar" style={{
                    height: `${v * 100}%`,
                    background: vpinColor(v),
                    opacity: 0.7 + i * 0.03,
                  }} />
                ))}
              </div>
            )}
          </div>

          {/* Hawkes */}
          <div className="of-card">
            <div className="of-ct">Hawkes Branching</div>
            <div className={`of-big ${hawkes.danger ? "ec-warn" : "ec-neu"}`}>
              {hawkes.branching_ratio != null ? (hawkes.branching_ratio * 100).toFixed(1) + "%" : "—"}
            </div>
            <div className="of-lbl">Self-excited orders</div>
            <div style={{ height: 1, background: "var(--border)", margin: "12px 0" }} />
            <div className="of-row"><span className="lbl">μ baseline</span><span className="val">{hawkes.mu?.toFixed(4) ?? "—"}</span></div>
            <div className="of-row"><span className="lbl">α excitation</span><span className="val">{hawkes.alpha?.toFixed(4) ?? "—"}</span></div>
            <div className="of-row"><span className="lbl">β decay</span><span className="val">{hawkes.beta?.toFixed(4) ?? "—"}</span></div>
            {hawkes.interpretation && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
                {hawkes.interpretation}
              </div>
            )}
          </div>
        </div>

        {/* AS Quoting + context */}
        <div className="of-grid2">
          <div className="of-card">
            <div className="of-ct">Avellaneda-Stoikov Quoting</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700, color: "var(--danger)" }}>
                  {spread.bid != null ? (spread.bid * 100).toFixed(1) + "¢" : "—"}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase", marginTop: 3 }}>Bid</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700, color: "var(--muted)" }}>
                  {mid != null ? (mid * 100).toFixed(1) + "¢" : "—"}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase", marginTop: 3 }}>Mid</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700, color: "var(--accent)" }}>
                  {spread.ask != null ? (spread.ask * 100).toFixed(1) + "¢" : "—"}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase", marginTop: 3 }}>Ask</div>
              </div>
            </div>
            <div className="of-row"><span className="lbl">Javasolt spread</span><span className="val ec-neu">{spread.recommended_spread != null ? (spread.recommended_spread * 100).toFixed(2) + "¢" : "—"}</span></div>
            <div className="of-row"><span className="lbl">Overall risk</span>
              <span className={`of-tag ${riskColor(risk)}`}>{risk}</span>
            </div>
            <div className="of-row"><span className="lbl">Trades elemezve</span><span className="val">{data?.n_trades ?? "—"}</span></div>
          </div>

          <div className="of-card">
            <div className="of-ct">Döntési szabályok</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", lineHeight: 2 }}>
              {[
                { cond: `VPIN > 0.80`, act: "🚫 Húzd vissza az ajánlatokat", col: "var(--danger)" },
                { cond: `VPIN > 0.65`, act: "⚠  Duplárd a spreadet", col: "#f16535" },
                { cond: `Kyle λ > 0.002`, act: "⚠  Szélesítsd a spreadet", col: "var(--warn)" },
                { cond: `R² > 0.15`, act: "📊  Informed flow aktív", col: "var(--warn)" },
                { cond: `Branching > 0.75`, act: "⚡ Piac HOT – trend figyeld", col: "var(--accent2)" },
                { cond: `Minden normál`, act: "✅ Standard spread OK", col: "var(--accent)" },
              ].map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                  <span style={{ color: "var(--border)", width: 120, flexShrink: 0 }}>{r.cond}</span>
                  <span style={{ color: r.col }}>{r.act}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Market picker */}
        <MarketPicker onSelect={(tid, q) => { setTokenId(tid); setQuestion(q); analyze(tid); }} />

        {/* Info */}
        <div className="of-info">
          <strong>Python CLI használat:</strong><br />
          <code>python orderflow_analyzer.py --demo</code> &nbsp;→ szintetikus adatokkal<br />
          <code>python orderflow_analyzer.py --list-markets</code> &nbsp;→ token ID-k listája<br />
          <code>python orderflow_analyzer.py --token-id &lt;id&gt; --limit 500</code><br /><br />
          <strong>Paraméterek értelmezése:</strong><br />
          Kyle λ &gt; 0.002 → minden $1000 volume ~$2 árelmozdulás → informed trader aktív<br />
          VPIN &gt; 0.65 → a flow toxikus, a market maker veszteséges pozícióba kerül<br />
          Hawkes branching &gt; 0.75 → a trádek 75%-a korábbi trádekre reagál, nem új hírekre
        </div>
      </div>
    </>
  );
}
