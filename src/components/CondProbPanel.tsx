// src/components/CondProbPanel.tsx
// Tab 09 – Conditional Probability Matrix + Polymarket CLI info

import { useState, useEffect, useCallback } from "react";

const FN = "/.netlify/functions";

const css = `
.cp-wrap{display:flex;flex-direction:column;gap:15px}
.cp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.cp-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.cp-card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:18px}
.cp-ct{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:7px}
.cp-ct::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%;display:inline-block;flex-shrink:0}
.cp-topbar{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:4px}
.cp-big{font-family:var(--mono);font-size:32px;font-weight:700;letter-spacing:-.02em;line-height:1}
.cp-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:3px}
.ec-pos{color:var(--accent)}.ec-neg{color:var(--danger)}.ec-neu{color:var(--accent2)}.ec-warn{color:var(--warn)}
.cp-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:7px 13px;border-radius:2px;cursor:pointer;transition:all .2s;letter-spacing:.08em;text-transform:uppercase}
.cp-btn:hover{border-color:var(--accent);color:var(--accent)}
.cp-btn.primary{background:var(--accent);color:#0a0a0c;font-weight:700;border-color:var(--accent)}
.cp-btn.active{border-color:var(--accent);color:var(--accent)}
.cp-btn:disabled{opacity:.4;cursor:not-allowed}
.cp-chip-row{display:flex;gap:7px;margin-bottom:14px;flex-wrap:wrap}
.cp-chip{background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-family:var(--mono);font-size:10px;color:var(--muted);cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:.07em}
.cp-chip:hover,.cp-chip.active{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.cp-violation{background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:14px;margin-bottom:10px;border-left:3px solid}
.cp-violation.MONOTONICITY{border-left-color:#f1a035}
.cp-violation.COMPLEMENT{border-left-color:var(--danger)}
.cp-violation.CONDITIONAL{border-left-color:var(--accent2)}
.cp-violation:last-child{margin-bottom:0}
.cp-vtype{font-family:var(--mono);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}
.cp-vtype.MONOTONICITY{color:#f1a035}
.cp-vtype.COMPLEMENT{color:var(--danger)}
.cp-vtype.CONDITIONAL{color:var(--accent2)}
.cp-vdesc{font-family:var(--mono);font-size:11px;color:var(--text);margin-bottom:8px;line-height:1.6}
.cp-vaction{font-family:var(--mono);font-size:11px;color:var(--accent);background:#0f1f00;padding:6px 10px;border-radius:2px;margin-bottom:6px}
.cp-sev-bar{height:6px;background:var(--surface);border-radius:3px;overflow:hidden;margin-top:4px}
.cp-sev-fill{height:100%;border-radius:3px;transition:width .8s ease}
.cp-info{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:12px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7}
.cp-info strong{color:var(--text)}
.cp-info code{color:var(--accent2);font-size:10px}
.cp-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px}
.cp-row:last-child{border-bottom:none}
.cp-row .lbl{color:var(--muted);font-size:11px}
.cp-row .val{font-weight:700}
.cp-matrix{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11px;margin-top:8px}
.cp-matrix th{text-align:left;padding:6px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border)}
.cp-matrix td{padding:7px 8px;border-bottom:1px solid #151520}
.cp-demo-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:var(--surface2);border:1px solid var(--warn);border-radius:2px;font-family:var(--mono);font-size:10px;color:var(--warn)}
.cp-cli-cmd{background:#0a0a0c;border:1px solid var(--border);border-radius:3px;padding:10px 12px;font-family:var(--mono);font-size:11px;color:var(--accent2);margin:4px 0;cursor:pointer;transition:all .2s}
.cp-cli-cmd:hover{border-color:var(--accent2)}
@media(max-width:768px){.cp-grid2,.cp-grid3{grid-template-columns:1fr}}
`;

// ─── DEMO DATA ────────────────────────────────────────────────────────────────
const DEMO = {
  ok: true, group: "demo", markets_analyzed: 8, violations_found: 3, is_demo: true,
  violations: [
    {
      type: "MONOTONICITY", severity: 0.82, edge_cents: 9.0,
      market_a: "btc-120k-2025", market_b: "btc-100k-2025",
      question_a: "Will Bitcoin hit $120k in 2025?",
      question_b: "Will Bitcoin hit $100k in 2025?",
      price_a: 0.38, price_b: 0.29,
      description: "P(BTC>$120k) = 0.380 > P(BTC>$100k) = 0.290 – matematikailag lehetetlen",
      action: "SELL btc-120k YES @ 0.38 | BUY btc-100k YES @ 0.29",
    },
    {
      type: "COMPLEMENT", severity: 0.61, edge_cents: 5.0,
      market_a: "election-x", market_b: "election-x",
      question_a: "Will Candidate X win the election?",
      question_b: "Will Candidate X win the election?",
      price_a: 0.58, price_b: 0.47,
      description: "P(YES)+P(NO) = 1.050 ≠ 1.000 | Eltérés: 5.00¢",
      action: "SELL YES (0.58) + SELL NO (0.47)",
    },
    {
      type: "MONOTONICITY", severity: 0.35, edge_cents: 4.2,
      market_a: "fed-may-2025", market_b: "fed-q2-2025",
      question_a: "Will Fed cut in May 2025?",
      question_b: "Will Fed cut in Q2 2025?",
      price_a: 0.18, price_b: 0.138,
      description: "P(May cut) = 0.180 > P(Q2 cut) = 0.138 – May ⊂ Q2, tehát P(May) ≤ P(Q2)",
      action: "SELL fed-may YES @ 0.18 | BUY fed-q2 YES @ 0.14",
    },
  ],
};

const GROUPS = ["auto","btc","fed"];
const TYPE_COLOR: Record<string, string> = {
  MONOTONICITY: "var(--warn)",
  COMPLEMENT:   "var(--danger)",
  CONDITIONAL:  "var(--accent2)",
};

function sevColor(s: number) {
  if (s > 0.7) return "var(--danger)";
  if (s > 0.4) return "var(--warn)";
  return "var(--accent)";
}

export default function CondProbPanel({ bankroll }: { bankroll: number }) {
  const [data,    setData]    = useState<any>(DEMO);
  const [loading, setLoading] = useState(false);
  const [group,   setGroup]   = useState("auto");

  const scan = useCallback(async (g: string) => {
    setLoading(true);
    try {
      const r = await fetch(`${FN}/cond-prob-matrix?group=${g}`);
      const j = await r.json();
      // Csak akkor frissítünk ha tényleg van adat
      if (j.ok && j.markets_analyzed > 0) {
        setData({ ...j, is_demo: false });
      } else if (j.ok && j.markets_analyzed === 0) {
        // API valid de nincs piac – tartsuk a demo-t
        setData((prev: any) => ({ ...prev, is_demo: true }));
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { scan("auto"); }, []);

  const violations = data?.violations || [];
  const totalEdge  = violations.reduce((s: number, v: any) => s + v.edge_cents, 0);

  return (
    <>
      <style>{css}</style>
      <div className="cp-wrap">

        {/* Header */}
        <div className="cp-topbar">
          <div>
            <div style={{ fontFamily:"var(--sans)",fontSize:18,fontWeight:800,letterSpacing:"-.02em",marginBottom:3 }}>
              Conditional Probability Matrix
            </div>
            <div style={{ fontFamily:"var(--mono)",fontSize:11,color:"var(--muted)" }}>
              Mispricing detector • Monotonicity • Complement • Implication chains
            </div>
          </div>
          <div style={{ display:"flex",gap:8,alignItems:"center" }}>
            {data?.is_demo && <div className="cp-demo-badge">⚠ DEMO</div>}
            <button className="cp-btn primary" onClick={() => scan(group)} disabled={loading}>
              {loading ? "Scan..." : "⟳ Scan"}
            </button>
          </div>
        </div>

        {/* Group selector */}
        <div className="cp-chip-row">
          {GROUPS.map(g => (
            <div key={g} className={`cp-chip ${group === g ? "active" : ""}`}
              onClick={() => { setGroup(g); scan(g); }}>
              {g === "auto" ? "🔍 Auto (top 40)" : g.toUpperCase()}
            </div>
          ))}
        </div>

        {/* Stats */}
        <div className="cp-grid3">
          <div className="cp-card">
            <div className="cp-big ec-neg">{violations.length}</div>
            <div className="cp-lbl">Violation detektálva</div>
          </div>
          <div className="cp-card">
            <div className="cp-big ec-warn">{totalEdge.toFixed(1)}¢</div>
            <div className="cp-lbl">Összesített edge</div>
          </div>
          <div className="cp-card">
            <div className="cp-big ec-neu">{data?.markets_analyzed ?? 0}</div>
            <div className="cp-lbl">Piacok elemezve</div>
          </div>
        </div>

        {/* Violations */}
        <div className="cp-card">
          <div className="cp-ct">
            Probability Violations
            {violations.length > 0 && (
              <span style={{ marginLeft:"auto",fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)" }}>
                ⚠ Fee: ~2-4¢/oldal figyelembe veendő
              </span>
            )}
          </div>

          {violations.length === 0 ? (
            <div style={{ fontFamily:"var(--mono)",fontSize:11,color:"var(--muted)",padding:"16px 0",textAlign:"center" }}>
              ✓ Nincs detektált violation – piacok konzisztensek
            </div>
          ) : violations.map((v: any, i: number) => {
            // Kelly méretezés
            const p      = Math.min(0.9, v.severity);
            const payoff = v.edge_cents / 100;
            const kelly  = Math.max(0, (p * payoff - (1-p)) / payoff) * 0.25;
            const pos    = (bankroll * kelly).toFixed(2);

            return (
              <div key={i} className={`cp-violation ${v.type}`}>
                <div className={`cp-vtype ${v.type}`}>
                  {v.type === "MONOTONICITY" ? "📐 MONOTONICITY" :
                   v.type === "COMPLEMENT"   ? "⚖️ COMPLEMENT" :
                   "🔗 CONDITIONAL"} — Edge: {v.edge_cents.toFixed(1)}¢
                </div>

                {/* Severity bar */}
                <div className="cp-sev-bar">
                  <div className="cp-sev-fill" style={{
                    width: `${v.severity * 100}%`,
                    background: sevColor(v.severity),
                  }} />
                </div>

                <div className="cp-vdesc" style={{ marginTop: 10 }}>{v.description}</div>
                <div className="cp-vaction">→ {v.action}</div>

                <div style={{ display:"flex",gap:16,fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",marginTop:6 }}>
                  <span>Severity: <strong style={{ color: sevColor(v.severity) }}>{(v.severity*100).toFixed(0)}%</strong></span>
                  <span>¼-Kelly: <strong className="ec-pos">${pos}</strong></span>
                  {v.price_a && <span>A: <strong>{(v.price_a*100).toFixed(1)}¢</strong></span>}
                  {v.price_b && v.market_a !== v.market_b && <span>B: <strong>{(v.price_b*100).toFixed(1)}¢</strong></span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Violation types explanation + CLI */}
        <div className="cp-grid2">
          <div className="cp-card">
            <div className="cp-ct">Violation típusok</div>
            {[
              ["📐 MONOTONICITY", "Ha A erősebb feltétel mint B (A⊂B), akkor P(A) ≤ P(B) kötelező. Pl: P(BTC>120k) ≤ P(BTC>100k)","var(--warn)"],
              ["⚖️ COMPLEMENT",   "P(YES) + P(NO) = 1.000 kell. Ha eltér, valamelyik oldal mispriced.","var(--danger)"],
              ["🔗 CONDITIONAL",  "P(A∩B) ≤ min(P(A), P(B)). Joint event nem lehet valószínűbb mint a komponensek.","var(--accent2)"],
            ].map(([t,d,c]) => (
              <div key={t as string} style={{ marginBottom:12 }}>
                <div style={{ fontFamily:"var(--mono)",fontSize:10,color:c as string,fontWeight:700,marginBottom:3 }}>{t}</div>
                <div style={{ fontFamily:"var(--mono)",fontSize:11,color:"var(--muted)",lineHeight:1.6 }}>{d}</div>
              </div>
            ))}
          </div>

          <div className="cp-card">
            <div className="cp-ct">Polymarket CLI integráció</div>
            <div className="cp-info" style={{ marginBottom:12 }}>
              <strong>Telepítés (macOS/Linux):</strong><br />
              <code>brew tap Polymarket/polymarket-cli https://github.com/Polymarket/polymarket-cli</code><br />
              <code>brew install polymarket</code><br /><br />
              <strong>Vagy:</strong><br />
              <code>curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh</code>
            </div>

            <div style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",marginBottom:6,textTransform:"uppercase",letterSpacing:".08em" }}>
              Hasznos parancsok (wallet nélkül):
            </div>
            {[
              "polymarket markets search \"bitcoin\" --limit 5",
              "polymarket -o json clob midpoint <TOKEN_ID>",
              "polymarket clob book <TOKEN_ID>",
              "polymarket data leaderboard --period week --order-by pnl",
            ].map((cmd, i) => (
              <div key={i} className="cp-cli-cmd"
                onClick={() => navigator.clipboard?.writeText(cmd)}
                title="Kattints a másoláshoz">
                $ {cmd}
              </div>
            ))}

            <div style={{ fontFamily:"var(--mono)",fontSize:10,color:"var(--muted)",marginTop:10,lineHeight:1.7 }}>
              Python script integrálva:<br />
              <code>python conditional_prob_matrix.py --cli --scan-btc</code><br />
              <code>python conditional_prob_matrix.py --demo</code>
            </div>
          </div>
        </div>

      </div>
    </>
  );
}
