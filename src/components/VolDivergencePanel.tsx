// src/components/VolDivergencePanel.tsx
// Tab 07 – BTC Volatility Harvester: Implied vs Realized Vol + Locked Profit

import { useState, useEffect, useCallback, useRef } from "react";

const FN = "/.netlify/functions";

const css = `
.vd-wrap{display:flex;flex-direction:column;gap:15px}
.vd-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.vd-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.vd-card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:18px}
.vd-ct{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:7px}
.vd-ct::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%;display:inline-block;flex-shrink:0}
.vd-big{font-family:var(--mono);font-size:34px;font-weight:700;letter-spacing:-.03em;line-height:1}
.vd-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:3px}
.vd-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px}
.vd-row:last-child{border-bottom:none}
.vd-row .lbl{color:var(--muted);font-size:11px}
.vd-row .val{font-weight:700}
.ec-pos{color:var(--accent)}.ec-neg{color:var(--danger)}.ec-neu{color:var(--accent2)}.ec-warn{color:var(--warn)}
.vd-verdict{padding:13px;border-radius:2px;font-family:var(--mono);font-size:12px;line-height:1.6;border-left:3px solid;font-weight:700}
.vd-verdict.green{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.vd-verdict.yellow{background:#1f1400;border-color:var(--warn);color:var(--warn)}
.vd-verdict.red{background:#1f0000;border-color:var(--danger);color:var(--danger)}
.vd-verdict.blue{background:#001a2a;border-color:var(--accent2);color:var(--accent2)}
.vd-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:7px 13px;border-radius:2px;cursor:pointer;transition:all .2s;letter-spacing:.08em;text-transform:uppercase}
.vd-btn:hover{border-color:var(--accent);color:var(--accent)}
.vd-btn.primary{background:var(--accent);color:#0a0a0c;font-weight:700;border-color:var(--accent)}
.vd-btn:disabled{opacity:.4;cursor:not-allowed}
.vd-bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.vd-bar-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);width:36px;text-align:right;flex-shrink:0}
.vd-bar-track{flex:1;height:16px;background:var(--surface2);border-radius:2px;overflow:hidden;position:relative}
.vd-bar-fill{height:100%;border-radius:2px;transition:width .8s ease}
.vd-bar-val{position:absolute;right:6px;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:10px;font-weight:700;color:var(--bg)}
.vd-bar-val.out{right:auto;left:calc(100%+5px);color:var(--text)}
.vd-spread-gauge{position:relative;height:60px;background:var(--surface2);border-radius:4px;overflow:hidden;margin:10px 0}
.vd-spread-fill{position:absolute;top:0;bottom:0;transition:all .8s ease;border-radius:2px}
.vd-spread-center{position:absolute;top:0;bottom:0;width:2px;background:var(--border);left:50%}
.vd-spread-label{position:absolute;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:12px;font-weight:700}
.vd-tbl{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11px}
.vd-tbl th{text-align:left;padding:6px 9px;font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.vd-tbl td{padding:7px 9px;border-bottom:1px solid #151520;vertical-align:middle}
.vd-tbl tr:last-child td{border-bottom:none}
.vd-tag{display:inline-block;padding:2px 7px;border-radius:2px;font-size:10px;font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.vd-tag.green{background:#0f2000;color:var(--accent);border:1px solid #1a3300}
.vd-tag.yellow{background:#1f1400;color:var(--warn);border:1px solid #332200}
.vd-tag.red{background:#200000;color:var(--danger);border:1px solid #330000}
.vd-info{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:12px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7}
.vd-info strong{color:var(--text)}
.vd-info code{color:var(--accent2)}
.vd-locked-highlight{background:#0a1f00;border:1px solid var(--accent);border-radius:4px;padding:16px;margin-bottom:4px}
.vd-topbar{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:4px}
.vd-price-big{font-family:var(--mono);font-size:22px;font-weight:700;color:var(--text)}
.vd-mq{max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vd-demo-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:var(--surface2);border:1px solid var(--warn);border-radius:2px;font-family:var(--mono);font-size:10px;color:var(--warn)}
@media(max-width:768px){.vd-grid2,.vd-grid3{grid-template-columns:1fr}}
`;

// ─── DEMO DATA ────────────────────────────────────────────────────────────────
const DEMO: any = {
  ok: true, is_demo: true,
  btc_price: 67245.50,
  realized_vol: {
    rv_5m: 8.2, rv_15m: 9.1, rv_30m: 11.8,
    unit: "annualized %",
  },
  implied_vol: { avg_iv: 34.2, markets: 3 },
  vol_spread: {
    spread_15m: 25.1, spread_30m: 22.4,
    signal: "MODERATE_PREMIUM – elevated implied vol",
    interpretation: "Enyhe vol prémium – piaci félelem beárazva",
  },
  polymarket_btc_markets: [
    { question: "Will BTC go UP in the next 15 minutes?", slug: "btc-up-demo",
      yes_price: 0.54, no_price: 0.51, implied_vol: 3.42,
      locked_profit: { yes_price: 0.54, no_price: 0.51, gross_cost: 1.05, estimated_fee: 0.021, net_profit: -0.071, net_pct: -7.1, has_edge: false, signal: "NO_EDGE" },
      url: "https://polymarket.com" },
    { question: "Will BTC go DOWN in the next 15 minutes?", slug: "btc-down-demo",
      yes_price: 0.48, no_price: 0.49, implied_vol: 0.28,
      locked_profit: { yes_price: 0.48, no_price: 0.49, gross_cost: 0.97, estimated_fee: 0.0194, net_profit: 0.0106, net_pct: 1.06, has_edge: true, signal: "MARGINAL_EDGE" },
      url: "https://polymarket.com" },
  ],
  edge_summary: { locked_profit_count: 1, best_net_profit: 0.0106, fee_note: "Becsült taker fee: 2%/oldal" },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function spreadClass(spread: number) {
  if (spread > 50) return "red";
  if (spread > 20) return "yellow";
  if (spread < -10) return "blue";
  return "green";
}

function rvColor(rv: number) {
  if (rv > 30) return "var(--danger)";
  if (rv > 15) return "var(--warn)";
  return "var(--accent)";
}

function ivColor(iv: number, rv: number) {
  const spread = iv - rv;
  if (spread > 50) return "var(--danger)";
  if (spread > 20) return "var(--warn)";
  return "var(--accent2)";
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function VolDivergencePanel() {
  const [data,        setData]        = useState<any>(null);
  const [loading,     setLoading]     = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdate,  setLastUpdate]  = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch(`${FN}/vol-divergence`);
      const json = await res.json();
      if (json.ok) {
        setData(json);
        setLastUpdate(new Date().toLocaleTimeString("hu-HU"));
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(fetchData, 120000); // 2 perc
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, fetchData]);

  const rv    = data?.realized_vol   || {};
  const iv    = data?.implied_vol    || {};
  const vs    = data?.vol_spread     || {};
  const mks   = data?.polymarket_btc_markets || [];
  const edge  = data?.edge_summary   || {};
  const price = data?.btc_price      || 0;

  const rv15  = rv.rv_15m  || 0;
  const rv30  = rv.rv_30m  || 0;
  const avgIV = iv.avg_iv  || 0;
  const spread15 = vs.spread_15m || 0;

  const edgeMarkets = mks.filter((m: any) => m.locked_profit?.has_edge);

  return (
    <>
      <style>{css}</style>
      <div className="vd-wrap">

        {/* Header */}
        <div className="vd-topbar">
          <div>
            <div style={{ fontFamily: "var(--sans)", fontSize: 18, fontWeight: 800, letterSpacing: "-.02em", marginBottom: 3 }}>
              Volatility Harvester
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
              BTC Implied vs Realized Vol • Locked Profit Scanner
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {loading && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>Loading...</div>}
            {lastUpdate && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>{lastUpdate}</span>}
            <button className="vd-btn" onClick={() => setAutoRefresh(a => !a)}
              style={{ borderColor: autoRefresh ? "var(--accent)" : undefined, color: autoRefresh ? "var(--accent)" : undefined }}>
              {autoRefresh ? "⏸ Auto" : "▶ Auto 2m"}
            </button>
            <button className="vd-btn primary" onClick={fetchData} disabled={loading}>
              {loading ? "..." : "⟳ Frissít"}
            </button>
          </div>
        </div>

        {/* BTC ár + vol spread summary */}
        <div className={`vd-verdict ${spreadClass(spread15)}`}>
          BTC: ${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          {" · "}
          IV: {avgIV.toFixed(1)}%  RV(15m): {rv15.toFixed(1)}%
          {" · "}
          Spread: {spread15 > 0 ? "+" : ""}{spread15.toFixed(1)}%
          {" · "}
          {vs.interpretation || "—"}
        </div>

        {/* Locked profit highlight ha van */}
        {edgeMarkets.length > 0 && (() => {
          const best = edgeMarkets.reduce((a: any, b: any) =>
            a.locked_profit.net_profit > b.locked_profit.net_profit ? a : b);
          const lp = best.locked_profit;
          return (
            <div className="vd-locked-highlight">
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".15em", marginBottom: 8 }}>
                🎯 LOCKED PROFIT LEHETŐSÉG DETEKTÁLVA
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
                <div><div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 700, color: "var(--accent)" }}>${lp.net_profit.toFixed(4)}</div><div className="vd-lbl">Net profit/pár</div></div>
                <div><div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 700 }}>{lp.net_pct.toFixed(2)}%</div><div className="vd-lbl">Return</div></div>
                <div><div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 700, color: "var(--danger)" }}>{lp.yes_price.toFixed(2)}</div><div className="vd-lbl">YES ár</div></div>
                <div><div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 700, color: "var(--danger)" }}>{lp.no_price.toFixed(2)}</div><div className="vd-lbl">NO ár</div></div>
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                ⚠ Mid árak! Valódi ask jellemzően 1-3¢ magasabb oldalanként.
                {" "}{best.question?.slice(0, 60)}
              </div>
            </div>
          );
        })()}

        {/* 3 metrika kártya */}
        <div className="vd-grid3">

          {/* Realized Vol */}
          <div className="vd-card">
            <div className="vd-ct">Realized Volatility</div>
            <div className="vd-big" style={{ color: rvColor(rv15) }}>
              {rv15.toFixed(1)}%
            </div>
            <div className="vd-lbl">15 perces ablak</div>
            <div style={{ height: 1, background: "var(--border)", margin: "12px 0" }} />
            {[["5m", rv.rv_5m], ["15m", rv.rv_15m], ["30m", rv.rv_30m]].map(([label, val]: any) => (
              <div key={label} className="vd-bar-row">
                <div className="vd-bar-lbl">{label}</div>
                <div className="vd-bar-track">
                  <div className="vd-bar-fill" style={{
                    width: `${Math.min((val || 0) * 2, 100)}%`,
                    background: rvColor(val || 0),
                    opacity: 0.8,
                  }}>
                    {(val || 0) > 8 && <span className="vd-bar-val">{(val || 0).toFixed(1)}%</span>}
                  </div>
                  {(val || 0) <= 8 && <span className="vd-bar-val out">{(val || 0).toFixed(1)}%</span>}
                </div>
              </div>
            ))}
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 10 }}>
              Forrás: Binance 1m klines • close-to-close log return
            </div>
          </div>

          {/* Implied Vol */}
          <div className="vd-card">
            <div className="vd-ct">Implied Volatility</div>
            <div className="vd-big" style={{ color: ivColor(avgIV, rv15) }}>
              {avgIV.toFixed(1)}%
            </div>
            <div className="vd-lbl">Polymarket BTC kontraktokból</div>
            <div style={{ height: 1, background: "var(--border)", margin: "12px 0" }} />
            <div className="vd-row"><span className="lbl">Elemzett kontraktok</span><span className="val">{iv.markets ?? mks.length}</span></div>
            <div className="vd-row"><span className="lbl">Vol prémium (15m)</span>
              <span className={`val ${spread15 > 20 ? "ec-warn" : spread15 > 0 ? "ec-pos" : "ec-neg"}`}>
                {spread15 > 0 ? "+" : ""}{spread15.toFixed(1)}%
              </span>
            </div>
            <div className="vd-row"><span className="lbl">Vol prémium (30m)</span>
              <span className={`val ${(vs.spread_30m || 0) > 0 ? "ec-pos" : "ec-neg"}`}>
                {(vs.spread_30m || 0) > 0 ? "+" : ""}{(vs.spread_30m || 0).toFixed(1)}%
              </span>
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
              Naïv binary approximation – közelítő érték
            </div>
          </div>

          {/* Vol Spread Gauge */}
          <div className="vd-card">
            <div className="vd-ct">Vol Spread (IV – RV)</div>
            <div className="vd-big" style={{
              color: spread15 > 50 ? "var(--danger)" : spread15 > 20 ? "var(--warn)" : spread15 < -10 ? "var(--accent2)" : "var(--accent)"
            }}>
              {spread15 > 0 ? "+" : ""}{spread15.toFixed(1)}%
            </div>
            <div className="vd-lbl">15 perces spread</div>

            {/* Gauge */}
            <div className="vd-spread-gauge" style={{ marginTop: 14 }}>
              <div className="vd-spread-center" />
              {spread15 >= 0 ? (
                <div className="vd-spread-fill" style={{
                  left: "50%", width: `${Math.min(spread15 / 2, 50)}%`,
                  background: spread15 > 50 ? "var(--danger)" : spread15 > 20 ? "var(--warn)" : "var(--accent)",
                  opacity: 0.7,
                }} />
              ) : (
                <div className="vd-spread-fill" style={{
                  right: "50%", width: `${Math.min(Math.abs(spread15) / 2, 50)}%`,
                  background: "var(--accent2)", opacity: 0.7,
                }} />
              )}
              <span className="vd-spread-label" style={{
                left: spread15 >= 0 ? "52%" : "auto",
                right: spread15 < 0 ? "52%" : "auto",
                color: "var(--text)",
              }}>
                {spread15 > 0 ? "+" : ""}{spread15.toFixed(1)}%
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 9, color: "var(--muted)", marginBottom: 12 }}>
              <span style={{ color: "var(--accent2)" }}>IV &lt; RV</span>
              <span>0</span>
              <span style={{ color: "var(--warn)" }}>+50% IV prémium</span>
            </div>

            <div className="vd-row"><span className="lbl">Signal</span>
              <span className={`vd-tag ${spread15 > 50 ? "red" : spread15 > 20 ? "yellow" : "green"}`}>
                {spread15 > 50 ? "SELL VOL" : spread15 > 20 ? "ELEVATED" : spread15 < -10 ? "BUY VOL" : "NORMAL"}
              </span>
            </div>
          </div>
        </div>

        {/* Polymarket kontraktok táblázat */}
        <div className="vd-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div className="vd-ct" style={{ margin: 0 }}>BTC Kontraktok – Locked Profit Scan</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>
              {edge.fee_note}
            </div>
          </div>

          {mks.length === 0 ? (
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", padding: "12px 0" }}>
              Nincs BTC kontraktadat – kattints a Frissít gombra
            </div>
          ) : (
            <table className="vd-tbl">
              <thead>
                <tr>
                  <th>Kérdés</th>
                  <th>YES</th><th>NO</th>
                  <th>Gross</th><th>Fee</th><th>Net</th>
                  <th>Signal</th>
                </tr>
              </thead>
              <tbody>
                {mks.map((m: any, i: number) => {
                  const lp = m.locked_profit || {};
                  return (
                    <tr key={i}>
                      <td><div className="vd-mq">{m.question}</div></td>
                      <td style={{ fontWeight: 700, color: "var(--danger)" }}>{((lp.yes_price || 0) * 100).toFixed(1)}¢</td>
                      <td style={{ fontWeight: 700, color: "var(--danger)" }}>{((lp.no_price  || 0) * 100).toFixed(1)}¢</td>
                      <td style={{ color: lp.gross_cost > 1 ? "var(--danger)" : "var(--accent)" }}>
                        {((lp.gross_cost || 0) * 100).toFixed(1)}¢
                      </td>
                      <td style={{ color: "var(--muted)" }}>{((lp.estimated_fee || 0) * 100).toFixed(2)}¢</td>
                      <td style={{ fontWeight: 700, color: lp.net_profit > 0 ? "var(--accent)" : "var(--danger)" }}>
                        {lp.net_profit > 0 ? "+" : ""}{((lp.net_profit || 0) * 100).toFixed(2)}¢
                      </td>
                      <td>
                        <span className={`vd-tag ${lp.has_edge ? "green" : "red"}`}>
                          {lp.has_edge ? "EDGE" : "NO EDGE"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Vol spread értelmezés + fee figyelmeztetés */}
        <div className="vd-grid2">
          <div className="vd-card">
            <div className="vd-ct">Stratégia logika</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", lineHeight: 2 }}>
              {[
                { cond: "IV – RV > 50%",  act: "🔴 VOL CRUSH várható – sell both sides", col: "var(--danger)" },
                { cond: "IV – RV > 20%",  act: "🟠 Emelt prémium – pozíció mérlegelés", col: "#f16535" },
                { cond: "YES+NO < $1-fee", act: "🟢 LOCKED PROFIT – vedd meg mindkét oldalt", col: "var(--accent)" },
                { cond: "YES+NO > $1+fee", act: "🔴 NINCS EDGE – fee felzabálja a nyereséget", col: "var(--danger)" },
                { cond: "IV ≈ RV",         act: "⚪ NORMÁL – nincs szignifikáns edge", col: "var(--muted)" },
              ].map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 3 }}>
                  <span style={{ color: "var(--border)", width: 130, flexShrink: 0 }}>{r.cond}</span>
                  <span style={{ color: r.col }}>{r.act}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="vd-info">
            <strong>⚠ Kritikus figyelmeztetés:</strong><br />
            A táblázatban látható árak <strong>mid árak</strong>, nem ask árak.<br />
            Valódi belépési cost = ask = mid + spread/2 (jellemzően +1-3¢/oldal).<br />
            Ha a mid alapján YES+NO = $0.97, az ask alapján valójában<br />
            ~$0.99-1.03 lehet – az edge eltűnhet vagy negatívvá válhat.<br /><br />
            <strong>Python CLI:</strong><br />
            <code>python vol_divergence.py --demo</code><br />
            <code>python vol_divergence.py --watch</code><br />
            <code>python vol_divergence.py --json</code>
          </div>
        </div>

      </div>
    </>
  );
}
