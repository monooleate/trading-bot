// src/components/ArbMatrixPanel.tsx
// Tab 11 – Arbitrage Matrix
//   A: VWAP-based arb scanner (valódi kitölthető ár)
//   B: LLM dependency detector (Claude API)
//   C: Marginal polytope constraints (kibővített cond prob)

import { useState, useCallback } from "react";

const FN = "/.netlify/functions";

const css = `
.am-wrap{display:flex;flex-direction:column;gap:15px}
.am-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.am-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.am-card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:18px}
.am-ct{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:7px}
.am-ct::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%;display:inline-block;flex-shrink:0}
.am-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:7px 13px;border-radius:2px;cursor:pointer;transition:all .2s;letter-spacing:.08em;text-transform:uppercase}
.am-btn:hover{border-color:var(--accent);color:var(--accent)}
.am-btn.primary{background:var(--accent);color:#0a0a0c;font-weight:700;border-color:var(--accent)}
.am-btn.danger{background:var(--danger);color:#fff;border-color:var(--danger)}
.am-btn:disabled{opacity:.4;cursor:not-allowed}
.am-chip-row{display:flex;gap:8px;margin-bottom:14px}
.am-chip{background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:3px 11px;font-family:var(--mono);font-size:10px;color:var(--muted);cursor:pointer;transition:all .2s;text-transform:uppercase}
.am-chip:hover,.am-chip.active{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.am-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px}
.am-row:last-child{border-bottom:none}
.am-row .lbl{color:var(--muted);font-size:11px}
.am-row .val{font-weight:700}
.ec-pos{color:var(--accent)}.ec-neg{color:var(--danger)}.ec-neu{color:var(--accent2)}.ec-warn{color:var(--warn)}
.am-tbl{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11px}
.am-tbl th{padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border);text-align:left}
.am-tbl td{padding:7px 8px;border-bottom:1px solid #151520;vertical-align:middle}
.am-tbl tr:last-child td{border-bottom:none}
.am-tag{display:inline-block;padding:2px 7px;border-radius:2px;font-size:10px;font-family:var(--mono);font-weight:700;text-transform:uppercase}
.am-tag.green{background:#0f2000;color:var(--accent);border:1px solid #1a3300}
.am-tag.red{background:#200000;color:var(--danger);border:1px solid #330000}
.am-tag.yellow{background:#1f1400;color:var(--warn);border:1px solid #332200}
.am-tag.blue{background:#001a2a;color:var(--accent2);border:1px solid #003344}
.am-input{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;padding:8px 10px;border-radius:2px;outline:none;transition:border-color .2s;box-sizing:border-box}
.am-input:focus{border-color:var(--accent)}
.am-info{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:12px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7}
.am-info strong{color:var(--text)}
.am-info code{color:var(--accent2);font-size:10px}
.am-dep-card{background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:14px;margin-bottom:10px}
.am-dep-card.dep{border-left:3px solid var(--danger)}
.am-dep-card.nodep{border-left:3px solid var(--accent)}
.am-mq{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--muted)}
.am-conf-bar{height:5px;background:var(--surface);border-radius:3px;overflow:hidden;margin-top:4px}
.am-conf-fill{height:100%;border-radius:3px;transition:width .6s ease}
.am-big{font-family:var(--mono);font-size:28px;font-weight:700;letter-spacing:-.02em}
.am-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:3px}
@media(max-width:768px){.am-grid2,.am-grid3{grid-template-columns:1fr}}
`;

// ─── VWAP TAB ─────────────────────────────────────────────────────────────────
function VWAPTab({ bankroll }: { bankroll: number }) {
  const [data,    setData]    = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [slug,    setSlug]    = useState("");

  const scan = useCallback(async (s?: string) => {
    setLoading(true);
    try {
      const url = s ? `${FN}/vwap-arb?slug=${s}` : `${FN}/vwap-arb?action=scan`;
      const r   = await fetch(url);
      const j   = await r.json();
      if (j.ok) setData(j);
    } catch {}
    finally { setLoading(false); }
  }, []);

  const markets = data?.markets || (data?.market ? [data.market] : []);
  const opps    = markets.filter((m: any) => m.has_edge);

  return (
    <div>
      {/* Search */}
      <div style={{ display:"flex",gap:8,marginBottom:14 }}>
        <input className="am-input" value={slug} onChange={e => setSlug(e.target.value)}
          placeholder="market-slug (üres = top 10 scan)" style={{ flex:1 }} />
        <button className="am-btn primary" onClick={() => scan(slug || undefined)} disabled={loading}>
          {loading ? "Scan..." : "⟳ VWAP Scan"}
        </button>
      </div>

      {/* Stats */}
      {data && (
        <div className="am-grid3" style={{ marginBottom:14 }}>
          <div className="am-card">
            <div className="am-big ec-neg">{opps.length}</div>
            <div className="am-lbl">VWAP Edge (&gt;5¢)</div>
          </div>
          <div className="am-card">
            <div className="am-big ec-warn">{data?.scanned ?? 1}</div>
            <div className="am-lbl">Piacok elemezve</div>
          </div>
          <div className="am-card">
            <div className="am-big ec-neu">
              {data?.summary?.avg_vwap_real_edge ?? (markets[0]?.net_profit_pct ?? 0)}%
            </div>
            <div className="am-lbl">Átlag VWAP edge</div>
          </div>
        </div>
      )}

      {/* Table */}
      {markets.length > 0 && (
        <div className="am-card">
          <div className="am-ct">VWAP Arbitrázs Eredmények</div>
          <table className="am-tbl">
            <thead>
              <tr>
                <th>Piac</th>
                <th>YES VWAP</th><th>NO VWAP</th>
                <th>Gross</th><th>Net profit</th>
                <th>Max $</th><th>Signal</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m: any, i: number) => (
                <tr key={i}>
                  <td><div className="am-mq" style={{ maxWidth:200 }}>{m.question}</div></td>
                  <td style={{ fontFamily:"var(--mono)" }}>{((m.yes_vwap||0)*100).toFixed(1)}¢</td>
                  <td style={{ fontFamily:"var(--mono)" }}>{((m.no_vwap||0)*100).toFixed(1)}¢</td>
                  <td style={{ fontFamily:"var(--mono)", color: (m.gross_cost||0) < 0.95 ? "var(--accent)" : "var(--muted)" }}>
                    {((m.gross_cost||0)*100).toFixed(1)}¢
                  </td>
                  <td style={{ fontFamily:"var(--mono)", fontWeight:700,
                    color: (m.net_profit||0) > 0.05 ? "var(--accent)" : (m.net_profit||0) > 0 ? "var(--warn)" : "var(--danger)" }}>
                    {((m.net_profit||0)*100).toFixed(1)}¢
                  </td>
                  <td style={{ fontFamily:"var(--mono)" }}>${(m.max_profit||0).toFixed(0)}</td>
                  <td>
                    <span className={`am-tag ${m.signal === "EXECUTE" ? "green" : m.signal === "MARGINAL – fee language edge" ? "yellow" : "red"}`}>
                      {m.signal === "EXECUTE" ? "EXECUTE" : m.signal === "MARGINAL – fee language edge" ? "MARGINAL" : "NO EDGE"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data?.summary && (
            <div className="am-info" style={{ marginTop:14 }}>
              <strong>Mid vs VWAP:</strong> Mid price alapú látszólagos edge: <span style={{ color:"var(--warn)" }}>
                {data.summary.avg_mid_apparent_edge}%
              </span> → VWAP valódi edge: <span style={{ color:"var(--accent)" }}>
                {data.summary.avg_vwap_real_edge}%
              </span><br />
              A különbség a slippage – a mid price illúzióját kelti. A paper $0.05 minimum thresholdot használt.
            </div>
          )}
        </div>
      )}

      {!data && !loading && (
        <div className="am-info">
          <strong>VWAP Arbitrázs Kalkulátor</strong><br /><br />
          A cikk módszertana: mid price helyett <strong>VWAP-ot</strong> használ (valódi kitölthető ár).<br />
          Ha VWAP_yes + VWAP_no &lt; 1.0 - fee → garantált profit.<br /><br />
          Különbség: ha YES mid=0.48 és NO mid=0.48 → látszólag 4¢ edge.<br />
          De ha a YES ask VWAP=0.52 és NO ask VWAP=0.51 → valójában -3¢ veszteség.<br /><br />
          <strong>$0.05 minimum threshold</strong> – a paper ebből számolta a garantált profitot<br />
          (kisebb edge execution risk miatt eltűnik).
        </div>
      )}
    </div>
  );
}

// ─── LLM DEPENDENCY TAB ───────────────────────────────────────────────────────
function LLMDepTab() {
  const [data,    setData]    = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [qA,      setQA]      = useState("");
  const [qB,      setQB]      = useState("");

  const scanAuto = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${FN}/llm-dependency?action=scan`);
      const j = await r.json();
      if (j.ok) setData(j);
    } catch {}
    finally { setLoading(false); }
  }, []);

  const analyzePair = useCallback(async () => {
    if (!qA.trim() || !qB.trim()) return;
    setLoading(true);
    try {
      const r = await fetch(`${FN}/llm-dependency`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          market_a: { slug: "custom-a", question: qA },
          market_b: { slug: "custom-b", question: qB },
        }),
      });
      const j = await r.json();
      if (j.ok) setData({ custom: true, results: [j], dependencies: j.analysis?.has_dependency ? [j] : [] });
    } catch {}
    finally { setLoading(false); }
  }, [qA, qB]);

  const results = data?.results || [];
  const deps    = data?.dependencies || [];

  return (
    <div>
      {/* Manual pair input */}
      <div className="am-card" style={{ marginBottom:14 }}>
        <div className="am-ct">Kézi pár elemzés (Claude API)</div>
        <div style={{ display:"flex",flexDirection:"column",gap:8,marginBottom:10 }}>
          <input className="am-input" value={qA} onChange={e => setQA(e.target.value)}
            placeholder='Piac A kérdése: pl. "Will Trump win Pennsylvania?"' />
          <input className="am-input" value={qB} onChange={e => setQB(e.target.value)}
            placeholder='Piac B kérdése: pl. "Will Trump win the 2024 presidential election?"' />
        </div>
        <div style={{ display:"flex",gap:8 }}>
          <button className="am-btn primary" onClick={analyzePair} disabled={loading || !qA || !qB}>
            {loading ? "Claude elemez..." : "🔍 Függőség Elemzés"}
          </button>
          <button className="am-btn" onClick={scanAuto} disabled={loading}>
            {loading ? "..." : "⟳ Auto Scan (top piacok)"}
          </button>
        </div>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="am-card">
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
            <div className="am-ct" style={{ margin:0 }}>Elemzési eredmények</div>
            {!data?.custom && (
              <span style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)" }}>
                {deps.length} függőség / {results.length} pár
              </span>
            )}
          </div>

          {results.map((r: any, i: number) => {
            const a    = r.analysis || {};
            const hasDep = a.has_dependency;
            const conf = a.confidence || 0;
            return (
              <div key={i} className={`am-dep-card ${hasDep ? "dep" : "nodep"}`}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8 }}>
                  <span className={`am-tag ${hasDep ? "red" : "green"}`}>
                    {hasDep ? "⚠ FÜGGŐSÉG" : "✓ FÜGGETLEN"}
                  </span>
                  <span style={{ fontFamily:"var(--mono)",fontSize:11,
                    color: conf > 0.7 ? "var(--danger)" : conf > 0.4 ? "var(--warn)" : "var(--muted)" }}>
                    conf: {(conf*100).toFixed(0)}%
                  </span>
                </div>
                <div className="am-conf-bar">
                  <div className="am-conf-fill" style={{
                    width: `${conf*100}%`,
                    background: hasDep ? "var(--danger)" : "var(--accent)",
                  }} />
                </div>
                <div className="am-mq" style={{ marginTop:8 }}>A: {r.market_a?.question}</div>
                <div className="am-mq">B: {r.market_b?.question}</div>
                {hasDep && (
                  <div style={{ marginTop:10, fontFamily:"var(--mono)", fontSize:11, lineHeight:1.7 }}>
                    <span style={{ color:"var(--warn)" }}>Típus: {a.dependency_type} | {a.direction}</span><br />
                    <span style={{ color:"var(--muted)" }}>{a.constraint}</span><br />
                    <span style={{ color:"var(--accent2)" }}>Arb: {a.arbitrage_condition}</span><br />
                    <span style={{ color:"var(--muted)",fontSize:10 }}>{a.reasoning}</span>
                  </div>
                )}
                {r.error && (
                  <div style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--danger)",marginTop:8 }}>
                    Error: {r.error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!data && !loading && (
        <div className="am-info">
          <strong>LLM Dependency Detector</strong><br /><br />
          A cikk módszertana: DeepSeek-R1-32B kap két piac leírást, JSON-ban visszaadja<br />
          a logikai függőség típusát és az arbitrázs feltételét.<br /><br />
          Ha két piac logikailag összefügg (pl. A ⊂ B), akkor P(A) ≤ P(B) kötelező.<br />
          Ha ez nem teljesül → arbitrázs.<br /><br />
          Mi Claude Sonnet-et használunk. 81.45% accuracy komplex párokon<br />
          (a paper DeepSeek-R1 alapján mérte – Claude pontosabb lehet).<br /><br />
          <code>Auto Scan</code> top 30 piacot csoportosít és ellenőriz kategóriánként.<br />
          <code>Kézi elemzés</code> bármely két kérdést elfogad.
        </div>
      )}
    </div>
  );
}

// ─── POLYTOPE TAB ─────────────────────────────────────────────────────────────
function PolytopeTab() {
  // Kibővített constraint checker – implication chain + joint prob
  const [markets, setMarkets] = useState<{q: string; p: number}[]>([
    { q: "Will Trump win the presidency?", p: 0.45 },
    { q: "Will Trump win Pennsylvania?",   p: 0.38 },
    { q: "Will Republicans win Senate?",   p: 0.61 },
  ]);
  const [violations, setViolations] = useState<any[]>([]);

  const addMarket = () => setMarkets(ms => [...ms, { q: "", p: 0.5 }]);
  const updateMarket = (i: number, field: "q" | "p", val: string) => {
    setMarkets(ms => ms.map((m, idx) => idx === i ? { ...m, [field]: field === "p" ? parseFloat(val) : val } : m));
  };
  const removeMarket = (i: number) => setMarkets(ms => ms.filter((_, idx) => idx !== i));

  const analyze = () => {
    const viols: any[] = [];

    // Complement check
    for (const m of markets) {
      const total = m.p + (1 - m.p); // trivially 1.0 – csak demonstráció
      // Valóban: YES + NO mid price (de itt csak p van)
    }

    // Monotonicity: minden pár – ha valószínűleg A → B, akkor P(A) ≤ P(B)
    // Felhasználó maga jelöli meg a sorrendet (sorrend = implication)
    for (let i = 0; i < markets.length - 1; i++) {
      for (let j = i + 1; j < markets.length; j++) {
        const mA = markets[i], mB = markets[j];
        // Naïv heurisztika: ha mA.p > mB.p + 0.05, lehet monotonicity violation
        // (valódi implementáció LLM dependency detectort hívna)
        if (mA.p > mB.p + 0.05) {
          viols.push({
            type:        "POTENTIAL_MONOTONICITY",
            market_a:    mA.q,
            market_b:    mB.q,
            price_a:     mA.p,
            price_b:     mB.p,
            violation:   mA.p - mB.p,
            note:        "Ha A logikailag erősebb feltétel mint B, ez sértés lehet",
            action:      `SELL ${mA.q.slice(0,30)} | BUY ${mB.q.slice(0,30)}`,
          });
        }
      }
    }

    // Joint probability check: P(A ∩ B) ≤ min(P(A), P(B))
    // Ha bármely pár szorzata > min, az sértés
    for (let i = 0; i < markets.length; i++) {
      for (let j = i + 1; j < markets.length; j++) {
        const implied_joint = markets[i].p * markets[j].p;
        const max_joint     = Math.min(markets[i].p, markets[j].p);
        if (implied_joint > max_joint * 1.1) { // 10% tűrés
          // Ez nem feltétlenül sértés – csak ha van függőség
        }
      }
    }

    setViolations(viols);
  };

  return (
    <div>
      <div className="am-card" style={{ marginBottom:14 }}>
        <div className="am-ct">Marginal Polytope Constraint Checker</div>
        <div style={{ fontFamily:"var(--mono)",fontSize:11,color:"var(--muted)",marginBottom:12,lineHeight:1.7 }}>
          Add piacokat és adj meg YES árakat. Az elemző megkeresi a potenciális<br />
          monotonicity violation-öket. Az LLM tab-ban verifikálhatod a logikai függőséget.
        </div>

        {markets.map((m, i) => (
          <div key={i} style={{ display:"flex",gap:8,marginBottom:8,alignItems:"center" }}>
            <input className="am-input" value={m.q}
              onChange={e => updateMarket(i, "q", e.target.value)}
              placeholder="Piac kérdése..." style={{ flex:1 }} />
            <input className="am-input" type="number" min="0" max="1" step="0.01"
              value={m.p} onChange={e => updateMarket(i, "p", e.target.value)}
              style={{ width:80 }} />
            <button className="am-btn" onClick={() => removeMarket(i)} style={{ padding:"7px 10px" }}>✕</button>
          </div>
        ))}

        <div style={{ display:"flex",gap:8,marginTop:8 }}>
          <button className="am-btn" onClick={addMarket}>+ Piac</button>
          <button className="am-btn primary" onClick={analyze}>⟳ Elemzés</button>
        </div>
      </div>

      {violations.length > 0 ? (
        <div className="am-card">
          <div className="am-ct">Potenciális Violations ({violations.length})</div>
          {violations.map((v, i) => (
            <div key={i} style={{ background:"var(--surface2)",border:"1px solid var(--warn)",
              borderLeft:"3px solid var(--warn)",borderRadius:3,padding:14,marginBottom:10 }}>
              <div style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--warn)",fontWeight:700,marginBottom:8 }}>
                ⚠ {v.type}  |  Eltérés: {(v.violation*100).toFixed(1)}¢
              </div>
              <div style={{ fontFamily:"var(--mono)",fontSize:11,color:"var(--muted)",lineHeight:1.7 }}>
                A: <strong style={{ color:"var(--text)" }}>{v.market_a.slice(0,55)}</strong> = {(v.price_a*100).toFixed(0)}¢<br />
                B: <strong style={{ color:"var(--text)" }}>{v.market_b.slice(0,55)}</strong> = {(v.price_b*100).toFixed(0)}¢<br />
                <span style={{ color:"var(--muted)",fontSize:10 }}>{v.note}</span>
              </div>
              <div style={{ fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",
                background:"#0f1f00",padding:"6px 10px",borderRadius:2,marginTop:8 }}>
                → {v.action}
              </div>
              <div style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",marginTop:6 }}>
                ⚠ LLM Dependency tab-ban verifikáld mielőtt kereskedsz
              </div>
            </div>
          ))}
        </div>
      ) : markets.length > 0 && (
        <div className="am-info">
          Kattints az Elemzés gombra a constraint check futtatásához.
        </div>
      )}

      <div className="am-info" style={{ marginTop:14 }}>
        <strong>Marginal Polytope – a cikk alapján:</strong><br />
        Arbitrage-free árak a konvex burokban (M = conv(Z)) kell legyenek.<br />
        Minden kívüli pont exploitálható.<br /><br />
        <strong>Integer programming</strong> linearizálja az exponenciális keresést:<br />
        Pl. Duke vs Cornell: 2^14 = 16,384 kombináció → 3 lineáris constraint.<br /><br />
        <strong>Frank-Wolfe + Gurobi</strong> – ezt mi nem implementáljuk<br />
        (Gurobi licenc + 86M tranzakció szükséges). A LLM tab fedezi ezt.
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function ArbMatrixPanel({ bankroll }: { bankroll: number }) {
  const [tab, setTab] = useState("vwap");

  return (
    <>
      <style>{css}</style>
      <div className="am-wrap">
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:4 }}>
          <div>
            <div style={{ fontFamily:"var(--sans)",fontSize:18,fontWeight:800,letterSpacing:"-.02em",marginBottom:3 }}>
              Arbitrage Matrix
            </div>
            <div style={{ fontFamily:"var(--mono)",fontSize:11,color:"var(--muted)" }}>
              VWAP Arb • LLM Dependency Detector • Marginal Polytope
            </div>
          </div>
        </div>

        <div className="am-chip-row">
          {[
            ["vwap",     "A. VWAP Arb Scanner"],
            ["llm",      "B. LLM Dependency"],
            ["polytope", "C. Polytope Checker"],
          ].map(([id, lbl]) => (
            <div key={id} className={`am-chip ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}>{lbl}</div>
          ))}
        </div>

        {tab === "vwap"     && <VWAPTab     bankroll={bankroll} />}
        {tab === "llm"      && <LLMDepTab   />}
        {tab === "polytope" && <PolytopeTab />}
      </div>
    </>
  );
}
