// src/components/SignalCombinerPanel.tsx
// Tab 10 – Signal Combiner (Fundamental Law of Active Management)
// IR = IC × √N

import { useState, useEffect, useCallback, useRef } from "react";

const FN = "/.netlify/functions";

const css = `
.sc-wrap{display:flex;flex-direction:column;gap:15px}
.sc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.sc-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.sc-grid5{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.sc-card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:18px}
.sc-ct{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:7px}
.sc-ct::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%;display:inline-block;flex-shrink:0}
.sc-big{font-family:var(--mono);font-size:36px;font-weight:700;letter-spacing:-.03em;line-height:1}
.sc-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:3px}
.ec-pos{color:var(--accent)}.ec-neg{color:var(--danger)}.ec-neu{color:var(--accent2)}.ec-warn{color:var(--warn)}
.sc-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:7px 13px;border-radius:2px;cursor:pointer;transition:all .2s;letter-spacing:.08em;text-transform:uppercase}
.sc-btn:hover{border-color:var(--accent);color:var(--accent)}
.sc-btn.primary{background:var(--accent);color:#0a0a0c;font-weight:700;border-color:var(--accent)}
.sc-btn:disabled{opacity:.4;cursor:not-allowed}
.sc-action{padding:20px;border-radius:4px;text-align:center;border:2px solid}
.sc-action.BUY_YES{background:#0a1800;border-color:var(--accent)}
.sc-action.BUY_NO{background:#1a0000;border-color:var(--danger)}
.sc-action.WAIT{background:#1a1a00;border-color:var(--warn)}
.sc-action.WATCH{background:#001020;border-color:var(--accent2)}
.sc-signal-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
.sc-signal-row:last-child{border-bottom:none}
.sc-sig-name{font-family:var(--mono);font-size:11px;width:130px;flex-shrink:0;color:var(--muted)}
.sc-sig-bar-wrap{flex:1;height:18px;background:var(--surface2);border-radius:2px;overflow:hidden;position:relative}
.sc-sig-bar{height:100%;position:absolute;top:0;transition:all .8s ease}
.sc-sig-val{font-family:var(--mono);font-size:11px;font-weight:700;width:52px;text-align:right;flex-shrink:0}
.sc-sig-weight{font-family:var(--mono);font-size:10px;color:var(--muted);width:40px;text-align:right;flex-shrink:0}
.sc-prob-gauge{position:relative;height:40px;background:var(--surface2);border-radius:4px;overflow:hidden;margin:12px 0}
.sc-gauge-fill{position:absolute;top:0;bottom:0;background:linear-gradient(90deg,var(--danger),var(--warn),var(--accent));opacity:.3}
.sc-gauge-needle{position:absolute;top:0;bottom:0;width:3px;background:var(--text);border-radius:2px;transition:left .8s ease}
.sc-gauge-center{position:absolute;top:0;bottom:0;width:1px;background:var(--border);left:50%}
.sc-gauge-label{position:absolute;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:13px;font-weight:700}
.sc-formula{background:#0a0a0c;border:1px solid var(--border);border-radius:3px;padding:10px 14px;font-family:var(--mono);font-size:12px;color:var(--accent2);margin:8px 0}
.sc-info{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:12px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7}
.sc-info strong{color:var(--text)}
.sc-demo{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:var(--surface2);border:1px solid var(--warn);border-radius:2px;font-family:var(--mono);font-size:10px;color:var(--warn)}
.sc-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px}
.sc-row:last-child{border-bottom:none}
.sc-row .lbl{color:var(--muted);font-size:11px}
.sc-row .val{font-weight:700}
@media(max-width:900px){.sc-grid5{grid-template-columns:1fr 1fr}.sc-grid3,.sc-grid2{grid-template-columns:1fr}}
`;

const DEMO = {
  ok: true, is_demo: true,
  combined_probability: 0.623,
  edge_pct: 12.3,
  active_signals: 5,
  signal_weights: {
    vol_divergence: 0.17,
    orderflow:      0.24,
    apex_consensus: 0.22,
    cond_prob:      0.20,
    funding_rate:   0.17,
  },
  raw_signals: {
    vol_divergence: 0.42,
    orderflow:      0.71,
    apex_consensus: 0.68,
    cond_prob:      0.61,
    funding_rate:   0.58,
  },
  fundamental_law: {
    avg_ic: 0.07, n_signals: 5, effective_n: 3.0, ir: 0.1565,
    formula: "IR = IC × √N = 0.070 × √5 = 0.157",
  },
  kelly: {
    full: 0.082, quarter: 0.014, cv_edge: 0.825,
    note: "¼-Kelly empirikus, CV_edge korrekció alkalmazva",
  },
  recommendation: {
    action: "BUY_YES", confidence: "MEDIUM",
    rationale: "IR=0.157 | p=62.3% | ¼-Kelly=1.4% bankroll",
  },
  methodology: "Grinold-Kahn Fundamental Law of Active Management.",
};

const SIGNAL_META: Record<string, { label: string; tab: string; color: string; ic: number }> = {
  vol_divergence: { label: "Vol Divergence",  tab: "Tab 07", color: "var(--accent2)", ic: 0.06 },
  orderflow:      { label: "Order Flow",       tab: "Tab 06", color: "var(--warn)",    ic: 0.09 },
  apex_consensus: { label: "Apex Consensus",   tab: "Tab 08", color: "var(--accent)",  ic: 0.08 },
  cond_prob:      { label: "Cond. Prob",        tab: "Tab 09", color: "#f16535",        ic: 0.07 },
  funding_rate:   { label: "Funding Rate",      tab: "Tab 03", color: "#a78bfa",        ic: 0.05 },
  momentum:       { label: "Momentum",          tab: "K.3.1",  color: "#f1c435",        ic: 0.06 },
  contrarian:     { label: "Contrarian",         tab: "K.10.3", color: "#35f1a0",        ic: 0.05 },
  pairs_spread:   { label: "Pairs Spread",      tab: "K.3.8",  color: "#f135a0",        ic: 0.07 },
};

function actionClass(action: string): string {
  if (action.includes("YES"))  return "BUY_YES";
  if (action.includes("NO"))   return "BUY_NO";
  if (action === "WAIT")       return "WAIT";
  return "WATCH";
}

function actionColor(cls: string): string {
  if (cls === "BUY_YES") return "var(--accent)";
  if (cls === "BUY_NO")  return "var(--danger)";
  if (cls === "WAIT")    return "var(--warn)";
  return "var(--accent2)";
}

export default function SignalCombinerPanel({ bankroll }: { bankroll: number }) {
  const [data,    setData]    = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [auto,    setAuto]    = useState(false);
  const [slug,    setSlug]    = useState("");
  const [markets, setMarkets] = useState<any[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const analyze = useCallback(async (marketSlug?: string) => {
    setLoading(true);
    try {
      const qs = marketSlug ? `?slug=${encodeURIComponent(marketSlug)}` : "";
      const r = await window.fetch(`${FN}/signal-combiner${qs}`);
      const j = await r.json();
      if (j.ok) setData(j);
    } catch {}
    finally { setLoading(false); }
  }, []);

  // Load markets list for picker
  useEffect(() => {
    (async () => {
      try {
        const r = await window.fetch(`${FN}/polymarket-proxy?limit=15`);
        const j = await r.json();
        if (j.ok && Array.isArray(j.markets)) setMarkets(j.markets);
      } catch {}
    })();
    analyze();
  }, []);

  useEffect(() => {
    if (auto) timerRef.current = setInterval(() => analyze(slug), 3 * 60 * 1000);
    else if (timerRef.current) clearInterval(timerRef.current);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [auto, analyze, slug]);

  const p        = data?.combined_probability ?? 0.5;
  const edge     = data?.edge_pct ?? 0;
  const weights  = data?.signal_weights ?? {};
  const raw      = data?.raw_signals ?? {};
  const fl       = data?.fundamental_law ?? {};
  const kelly    = data?.kelly ?? {};
  const rec      = data?.recommendation ?? {};
  const actCls   = actionClass(rec.action || "WAIT");
  const actColor = actionColor(actCls);
  const pos      = ((kelly.quarter ?? 0) * bankroll).toFixed(2);

  return (
    <>
      <style>{css}</style>
      <div className="sc-wrap">

        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end" }}>
          <div>
            <div style={{ fontFamily:"var(--sans)",fontSize:18,fontWeight:800,letterSpacing:"-.02em",marginBottom:3 }}>
              Signal Combiner
            </div>
            <div style={{ fontFamily:"var(--mono)",fontSize:11,color:"var(--muted)" }}>
              Fundamental Law of Active Management • IR = IC × √N • Grinold-Kahn
            </div>
          </div>
          <div style={{ display:"flex",gap:8,alignItems:"center" }}>
            {loading && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>Loading...</div>}
            <button className={`sc-btn ${auto?"active":""}`} onClick={() => setAuto(a=>!a)}>
              {auto ? "⏸ Auto 3m" : "▶ Auto"}
            </button>
            <button className="sc-btn" onClick={() => setShowPicker(p => !p)}>
              {showPicker ? "✕ Bezár" : "⊕ Piac"}
            </button>
            <button className="sc-btn primary" onClick={() => analyze(slug)} disabled={loading}>
              {loading ? "..." : "⟳ Combine"}
            </button>
          </div>
        </div>

        {/* Market Picker */}
        {showPicker && (
          <div className="sc-card" style={{ maxHeight: 280, overflowY: "auto" }}>
            <div className="sc-ct">Piac kiválasztása</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px", fontSize: 10, color: "var(--muted)" }}>Piac</th>
                  <th style={{ textAlign: "right", padding: "4px 8px", fontSize: 10, color: "var(--muted)" }}>YES</th>
                  <th style={{ textAlign: "right", padding: "4px 8px", fontSize: 10, color: "var(--muted)" }}>Vol 24h</th>
                </tr>
              </thead>
              <tbody>
                {markets.map((m: any, i: number) => (
                  <tr key={i}
                    style={{ borderBottom: "1px solid #151520", cursor: "pointer", background: slug === m.slug ? "#0f1f00" : "transparent" }}
                    onClick={() => { setSlug(m.slug); setShowPicker(false); analyze(m.slug); }}>
                    <td style={{ padding: "6px 8px", color: slug === m.slug ? "var(--accent)" : "var(--text)" }}>
                      {(m.question || "").slice(0, 50)}{(m.question || "").length > 50 ? "..." : ""}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: m.yes_price > 0.6 ? "var(--accent)" : m.yes_price < 0.4 ? "var(--danger)" : "var(--muted)" }}>
                      {(m.yes_price * 100).toFixed(0)}¢
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--muted)" }}>
                      ${(m.volume_24h / 1000000).toFixed(1)}M
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Selected Market Info */}
        {data?.market && (
          <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 3, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <a href={data.market.url} target="_blank" rel="noopener noreferrer"
                style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: "var(--text)", textDecoration: "none", borderBottom: "1px dashed var(--border)" }}>
                {data.market.question}
              </a>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
                YES: {(data.market.yes_price * 100).toFixed(1)}¢ • NO: {(data.market.no_price * 100).toFixed(1)}¢ • Vol: ${(data.market.volume_24h / 1000000).toFixed(1)}M
              </div>
            </div>
            {slug && (
              <button className="sc-btn" onClick={() => { setSlug(""); analyze(""); }} style={{ fontSize: 9 }}>
                Auto
              </button>
            )}
          </div>
        )}

        {/* Action Box */}
        <div className={`sc-action ${actCls}`}>
          <div style={{ fontFamily:"var(--mono)",fontSize:11,color:actColor,letterSpacing:".15em",textTransform:"uppercase",marginBottom:8 }}>
            {rec.confidence || "—"} CONFIDENCE
          </div>
          <div style={{ fontFamily:"var(--sans)",fontSize:28,fontWeight:800,color:actColor,marginBottom:8 }}>
            {rec.action || "WAIT"}
          </div>
          <div style={{ fontFamily:"var(--mono)",fontSize:11,color:"var(--muted)" }}>
            {rec.rationale || "—"}
          </div>
          {rec.action?.includes("BUY") && (
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ fontFamily:"var(--mono)",fontSize:14,fontWeight:700,color:actColor }}>
                Pozíció: ${pos} ({((kelly.quarter??0)*100).toFixed(1)}% bankroll)
              </div>
              <button className="sc-btn" style={{ fontSize: 10, padding: "5px 10px" }}
                onClick={async () => {
                  try {
                    await window.fetch(`${FN}/trade-logger`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "log",
                        market_slug: data?.market?.slug || "",
                        market_question: data?.market?.question || "",
                        side: rec.action,
                        entry_price: rec.action?.includes("YES") ? data?.market?.yes_price : data?.market?.no_price,
                        size_usdc: parseFloat(pos),
                        signal_p: p,
                        kelly_used: kelly.quarter || 0,
                        ir_at_trade: fl.ir || 0,
                        signal_details: raw,
                      }),
                    });
                    alert("Trade logged!");
                  } catch { alert("Logging failed"); }
                }}>
                Log Trade
              </button>
            </div>
          )}
        </div>

        {/* 3 metrika */}
        <div className="sc-grid3">
          <div className="sc-card">
            <div className="sc-big" style={{ color: p > 0.6 ? "var(--accent)" : p < 0.4 ? "var(--danger)" : "var(--warn)" }}>
              {(p*100).toFixed(1)}%
            </div>
            <div className="sc-lbl">Combined Probability</div>
            <div style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",marginTop:8 }}>
              Edge: {edge >= 0 ? "+" : ""}{edge.toFixed(1)}% a 50%-tól
            </div>
          </div>
          <div className="sc-card">
            <div className="sc-big ec-neu">{(fl.ir||0).toFixed(3)}</div>
            <div className="sc-lbl">Information Ratio</div>
            <div style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",marginTop:8 }}>
              {fl.n_signals||0} jel • {fl.effective_n||0} eff. N
            </div>
          </div>
          <div className="sc-card">
            <div className="sc-big ec-pos">{((kelly.quarter??0)*100).toFixed(1)}%</div>
            <div className="sc-lbl">¼-Kelly pozíció</div>
            <div style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",marginTop:8 }}>
              CV_edge: {((kelly.cv_edge??0)*100).toFixed(0)}% korrekció
            </div>
          </div>
        </div>

        {/* Probability gauge */}
        <div className="sc-card">
          <div className="sc-ct">Combined Probability Gauge</div>
          <div className="sc-prob-gauge">
            <div className="sc-gauge-fill" style={{ width:"100%" }} />
            <div className="sc-gauge-center" />
            <div className="sc-gauge-needle" style={{ left:`${p*100}%` }} />
            <span className="sc-gauge-label" style={{
              left: `${p*100}%`, transform:"translateX(-50%) translateY(-50%)",
              color: p > 0.6 ? "var(--accent)" : p < 0.4 ? "var(--danger)" : "var(--warn)",
            }}>
              {(p*100).toFixed(1)}%
            </span>
          </div>
          <div style={{ display:"flex",justifyContent:"space-between",fontFamily:"var(--mono)",fontSize:9,color:"var(--border)" }}>
            <span style={{ color:"var(--danger)" }}>NO 0%</span>
            <span>50% (no edge)</span>
            <span style={{ color:"var(--accent)" }}>YES 100%</span>
          </div>
          <div className="sc-formula" style={{ marginTop:12 }}>
            {fl.formula || "IR = IC × √N"}
          </div>
        </div>

        {/* Signal weights */}
        <div className="sc-card">
          <div className="sc-ct">Individual Signals → Weighted Combination</div>
          {Object.entries(SIGNAL_META).map(([key, meta]) => {
            const rawVal = raw[key];
            const weight = weights[key] || 0;
            const hasData = rawVal !== null && rawVal !== undefined;
            const prob   = hasData ? rawVal : 0.5;
            const pct    = prob * 100;

            return (
              <div key={key} className="sc-signal-row">
                <div className="sc-sig-name">
                  <div style={{ color:meta.color,fontWeight:700,fontSize:10 }}>{meta.label}</div>
                  <div style={{ fontSize:9,color:"var(--border)" }}>{meta.tab} • IC={meta.ic}</div>
                </div>

                <div className="sc-sig-bar-wrap">
                  {/* Center line */}
                  <div style={{ position:"absolute",top:0,bottom:0,width:1,background:"var(--border)",left:"50%",zIndex:1 }} />
                  {hasData ? (
                    <div className="sc-sig-bar" style={{
                      left:   prob >= 0.5 ? "50%" : `${pct}%`,
                      width:  `${Math.abs(pct - 50)}%`,
                      background: meta.color,
                      opacity: 0.7,
                    }} />
                  ) : (
                    <div style={{ position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
                      fontFamily:"var(--mono)",fontSize:9,color:"var(--border)" }}>N/A</div>
                  )}
                </div>

                <div className="sc-sig-val" style={{ color: hasData ? (prob>0.55?"var(--accent)":prob<0.45?"var(--danger)":"var(--muted)") : "var(--border)" }}>
                  {hasData ? `${pct.toFixed(0)}%` : "—"}
                </div>
                <div className="sc-sig-weight">
                  w={weight > 0 ? weight.toFixed(2) : "—"}
                </div>
              </div>
            );
          })}
        </div>

        {/* Kelly + theory */}
        <div className="sc-grid2">
          <div className="sc-card">
            <div className="sc-ct">Kelly Számítás</div>
            <div className="sc-row"><span className="lbl">Full Kelly</span>
              <span className="val ec-warn">{((kelly.full??0)*100).toFixed(1)}%</span></div>
            <div className="sc-row"><span className="lbl">¼-Kelly (empirikus)</span>
              <span className="val ec-pos">${pos}</span></div>
            <div className="sc-row"><span className="lbl">CV_edge korrekció</span>
              <span className="val ec-neg">-{((kelly.cv_edge??0)*100).toFixed(0)}%</span></div>
            <div className="sc-row"><span className="lbl">Aktív jelzések</span>
              <span className="val">{data?.active_signals ?? 0} / 5</span></div>
            <div className="sc-row"><span className="lbl">Eff. független N</span>
              <span className="val ec-neu">{fl.effective_n ?? 0}</span></div>
            <div style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",marginTop:10,lineHeight:1.7 }}>
              f_empirical = f_kelly × (1 − CV_edge)<br />
              CV_edge = szimulált edge-variabilitás
            </div>
          </div>

          <div className="sc-info">
            <strong>Fundamental Law of Active Management</strong><br />
            Grinold & Kahn (1994)<br /><br />
            IR = IC × √N<br />
            Ha IC=0.07 és N=5 → IR = 0.157<br />
            50 korrelálatlan jel esetén → IR = 0.495<br /><br />
            <strong>Miért nem elég egy jel:</strong><br />
            Intézményi jelzések IC = 0.05-0.15 között vannak.
            Egyetlen jel legjobb esetben is 85%-ot téved.
            A kombináció √N-nel skálázza az IR-t.<br /><br />
            <strong>Cross-sectional demeaning:</strong><br />
            Eltávolítja a jelzések közös komponensét –
            csak az egymástól független információ számít.
          </div>
        </div>

      </div>
    </>
  );
}
