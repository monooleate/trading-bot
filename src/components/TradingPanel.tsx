// src/components/TradingPanel.tsx
// Tab 05 – Belépés + Kereskedési panel (Bybit / Binance / Polymarket)

import { useState, useEffect, useCallback } from "react";

const FN = "/.netlify/functions";

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Balance  { coin: string; wallet_balance: number; available: number; usd_value?: number; unrealised_pnl?: number; }
interface Position { symbol: string; side: string; size: number; entry_price: number; mark_price: number; unrealised_pnl: number; leverage?: number; }
interface PMMarket { question: string; slug: string; yes_price: number; no_price: number; volume_24h: number; tokens: {outcome:string;token_id:string}[]; url: string; }

type Exchange = "bybit" | "binance";

// ─── STYLES ───────────────────────────────────────────────────────────────────
const css = `
.tp-login{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:70vh;gap:20px}
.tp-login-card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:36px 40px;width:100%;max-width:360px}
.tp-login-title{font-family:var(--sans);font-size:22px;font-weight:800;margin-bottom:4px;letter-spacing:-.02em;text-align:center}
.tp-login-sub{font-family:var(--mono);font-size:10px;color:var(--muted);text-align:center;margin-bottom:24px;text-transform:uppercase;letter-spacing:.1em}
.tp-input{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:14px;padding:10px 12px;border-radius:2px;outline:none;transition:border-color .2s;margin-bottom:12px}
.tp-input:focus{border-color:var(--accent)}
.tp-input::placeholder{color:var(--muted)}
.tp-btn-full{width:100%;background:var(--accent);border:none;color:#0a0a0c;font-family:var(--mono);font-size:12px;font-weight:700;padding:11px;border-radius:2px;cursor:pointer;letter-spacing:.1em;text-transform:uppercase;transition:background .2s}
.tp-btn-full:hover{background:#d4ff40}
.tp-btn-full:disabled{opacity:.5;cursor:not-allowed}
.tp-error{font-family:var(--mono);font-size:11px;color:var(--danger);text-align:center;margin-top:8px}
.tp-panel{display:flex;flex-direction:column;gap:16px}
.tp-topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.tp-exchange-row{display:flex;gap:8px;margin-bottom:16px}
.tp-ex-btn{background:var(--surface2);border:1px solid var(--border);color:var(--muted);font-family:var(--mono);font-size:11px;padding:6px 14px;border-radius:2px;cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:.08em}
.tp-ex-btn:hover,.tp-ex-btn.active{border-color:var(--accent);color:var(--accent);background:#0f1f00}
.tp-ex-btn.poly.active{border-color:var(--accent2);color:var(--accent2);background:#002a22}
.tp-section{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.15em;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:7px}
.tp-section::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%;display:inline-block}
.tp-tbl{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px}
.tp-tbl th{text-align:left;padding:6px 9px;font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.tp-tbl td{padding:8px 9px;border-bottom:1px solid #151520}
.tp-tbl tr:last-child td{border-bottom:none}
.ec-pos{color:var(--accent)}.ec-neg{color:var(--danger)}.ec-neu{color:var(--accent2)}.ec-warn{color:var(--warn)}
.tp-order-form{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.tp-order-form .full{grid-column:1/-1}
.tp-field label{display:block;font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}
.tp-field input,.tp-field select{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:13px;padding:8px 10px;border-radius:2px;outline:none;-webkit-appearance:none;appearance:none}
.tp-field input:focus,.tp-field select:focus{border-color:var(--accent)}
.tp-side-row{display:flex;gap:8px}
.tp-side-btn{flex:1;padding:8px;border-radius:2px;font-family:var(--mono);font-size:11px;font-weight:700;cursor:pointer;border:1px solid var(--border);background:var(--surface2);color:var(--muted);transition:all .2s;text-transform:uppercase}
.tp-side-btn.buy.active{background:#0f2000;border-color:var(--accent);color:var(--accent)}
.tp-side-btn.sell.active{background:#200000;border-color:var(--danger);color:var(--danger)}
.tp-verdict{padding:12px;border-radius:2px;font-family:var(--mono);font-size:11px;line-height:1.6;border-left:3px solid;margin-top:10px}
.tp-verdict.go{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.tp-verdict.stop{background:#1f0000;border-color:var(--danger);color:var(--danger)}
.tp-verdict.wait{background:#1f1400;border-color:var(--warn);color:var(--warn)}
.tp-tag{display:inline-block;padding:1px 6px;border-radius:2px;font-size:9px;font-family:var(--mono);background:var(--surface2);border:1px solid;text-transform:uppercase;letter-spacing:.07em}
.tp-tag.testnet{color:var(--warn);border-color:#332200;background:#1f1400}
.tp-tag.live{color:var(--accent);border-color:#1a3300;background:#0f2000}
.tp-info{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:12px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7}
.tp-info strong{color:var(--text)}
.tp-info code{color:var(--accent2);font-family:var(--mono)}
.tp-btn-sm{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:10px;padding:5px 10px;border-radius:2px;cursor:pointer;transition:all .2s;letter-spacing:.07em;text-transform:uppercase}
.tp-btn-sm:hover{border-color:var(--accent);color:var(--accent)}
.tp-btn-sm:disabled{opacity:.4;cursor:not-allowed}
.tp-pm-q{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tp-chip-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tp-chip{background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-family:var(--mono);font-size:10px;color:var(--muted);cursor:pointer;transition:all .2s;text-transform:uppercase}
.tp-chip:hover,.tp-chip.active{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
`;

// ─── API HELPERS ──────────────────────────────────────────────────────────────
async function apiGet(path: string) {
  const r = await fetch(`${FN}/${path}`, { credentials: "include" });
  return r.json();
}

async function apiPost(path: string, body: object) {
  const r = await fetch(`${FN}/${path}`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [pw, setPw]   = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pw) return;
    setBusy(true); setErr("");
    try {
      const data = await apiPost("auth", { action: "login", password: pw });
      if (data.ok) { onLogin(); }
      else         { setErr("Hibás jelszó"); }
    } catch { setErr("Kapcsolati hiba"); }
    finally { setBusy(false); }
  };

  return (
    <div className="tp-login">
      <div className="tp-login-card">
        <div className="tp-login-title">EdgeCalc</div>
        <div className="tp-login-sub">Trading Panel • Secure Access</div>
        <input className="tp-input" type="password" placeholder="Jelszó" value={pw}
          onChange={e => setPw(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()} autoFocus />
        <button className="tp-btn-full" onClick={submit} disabled={busy || !pw}>
          {busy ? "..." : "BELÉPÉS →"}
        </button>
        {err && <div className="tp-error">✗ {err}</div>}
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textAlign: "center", maxWidth: 320, lineHeight: 1.8 }}>
        Jelszó hash generálás:<br />
        <span style={{ color: "var(--accent2)" }}>node -e "console.log(require('crypto').createHash('sha256').update('jelszo').digest('hex'))"</span><br />
        Netlify env: <span style={{ color: "var(--accent)" }}>AUTH_PASSWORD_HASH</span>
      </div>
    </div>
  );
}

// ─── EXCHANGE PANEL (Bybit / Binance) ─────────────────────────────────────────
function ExchangePanel({ exchange }: { exchange: Exchange }) {
  const fn = exchange === "bybit" ? "bybit-trade" : "binance-trade";
  const [balances,  setBalances]  = useState<Balance[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [testnet,   setTestnet]   = useState(false);
  const [lastErr,   setLastErr]   = useState("");

  // Order form
  const [symbol,    setSymbol]    = useState("BTCUSDT");
  const [side,      setSide]      = useState<"BUY"|"SELL">("BUY");
  const [orderType, setOrderType] = useState<"Market"|"Limit">("Limit");
  const [qty,       setQty]       = useState("");
  const [price,     setPrice]     = useState("");
  const [orderMsg,  setOrderMsg]  = useState("");
  const [ordering,  setOrdering]  = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true); setLastErr("");
    try {
      const [bal, pos] = await Promise.all([
        apiGet(`${fn}?action=balance`),
        apiGet(`${fn}?action=positions`),
      ]);
      if (bal.ok) { setBalances(bal.balances || []); setTestnet(bal.testnet); }
      else setLastErr(bal.error || "Balance hiba");
      if (pos.ok) setPositions(pos.positions || []);
    } catch (e: any) { setLastErr(e.message); }
    finally { setLoading(false); }
  }, [fn]);

  useEffect(() => { loadData(); }, [exchange]);

  const placeOrder = async () => {
    if (!qty) return;
    setOrdering(true); setOrderMsg("");
    try {
      const body: any = {
        action: "order",
        symbol: symbol.toUpperCase(),
        side,
        orderType,
        qty: parseFloat(qty),
      };
      if (exchange === "binance") { body.type = orderType; body.quantity = body.qty; delete body.qty; }
      if (orderType === "Limit" && price) body.price = parseFloat(price);

      const data = await apiPost(fn, body);
      if (data.ok) setOrderMsg(`✓ Order leadva – ID: ${data.order_id}`);
      else         setOrderMsg(`✗ Hiba: ${data.error}`);
    } catch (e: any) { setOrderMsg(`✗ ${e.message}`); }
    finally { setOrdering(false); }
  };

  const totalUSD = balances.reduce((s, b) => s + (b.usd_value || b.wallet_balance), 0);
  const totalPnl = positions.reduce((s, p) => s + p.unrealised_pnl, 0);

  return (
    <div className="tp-panel">
      <div className="tp-topbar">
        <div>
          <span className={`tp-tag ${testnet ? "testnet" : "live"}`}>
            {testnet ? "TESTNET" : "LIVE"}
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginLeft: 10 }}>
            {exchange.toUpperCase()} Futures
          </span>
        </div>
        <button className="tp-btn-sm" onClick={loadData} disabled={loading}>{loading ? "..." : "⟳ Frissít"}</button>
      </div>

      {lastErr && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)", padding: "8px 12px", background: "#200000", borderRadius: 2, borderLeft: "3px solid var(--danger)" }}>✗ {lastErr}</div>}

      {/* Egyenleg */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: 18 }}>
        <div className="tp-section">Egyenleg</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 26, fontWeight: 700, color: "var(--accent)" }}>${totalUSD.toFixed(2)}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase", marginTop: 3 }}>Portfolio érték</div>
          </div>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 26, fontWeight: 700, color: totalPnl >= 0 ? "var(--accent)" : "var(--danger)" }}>
              {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase", marginTop: 3 }}>Nem realizált PnL</div>
          </div>
        </div>
        {balances.length > 0 && (
          <table className="tp-tbl">
            <thead><tr><th>Coin</th><th>Egyenleg</th><th>Szabad</th><th>USD érték</th></tr></thead>
            <tbody>
              {balances.map((b, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 700 }}>{b.coin}</td>
                  <td>{b.wallet_balance.toFixed(4)}</td>
                  <td className="ec-neu">{b.available.toFixed(4)}</td>
                  <td className="ec-pos">${(b.usd_value || b.wallet_balance).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pozíciók */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: 18 }}>
        <div className="tp-section">Nyitott pozíciók ({positions.length})</div>
        {positions.length === 0
          ? <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>Nincs nyitott pozíció</div>
          : (
            <table className="tp-tbl">
              <thead><tr><th>Symbol</th><th>Side</th><th>Méret</th><th>Entry</th><th>Mark</th><th>PnL</th><th>Lev.</th></tr></thead>
              <tbody>
                {positions.map((p, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 700 }}>{p.symbol}</td>
                    <td className={p.side === "Long" || p.side === "Buy" ? "ec-pos" : "ec-neg"}>{p.side}</td>
                    <td>{p.size}</td>
                    <td>${p.entry_price.toFixed(2)}</td>
                    <td>${p.mark_price.toFixed(2)}</td>
                    <td className={p.unrealised_pnl >= 0 ? "ec-pos" : "ec-neg"}>
                      {p.unrealised_pnl >= 0 ? "+" : ""}${p.unrealised_pnl.toFixed(2)}
                    </td>
                    <td>{p.leverage || "-"}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* Order form */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: 18 }}>
        <div className="tp-section">Order leadás</div>
        <div className="tp-order-form">
          <div className="tp-field full">
            <label>Symbol</label>
            <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="BTCUSDT" />
          </div>
          <div className="tp-field full">
            <label>Irány</label>
            <div className="tp-side-row">
              <button className={`tp-side-btn buy ${side === "BUY" ? "active" : ""}`} onClick={() => setSide("BUY")}>▲ BUY / LONG</button>
              <button className={`tp-side-btn sell ${side === "SELL" ? "active" : ""}`} onClick={() => setSide("SELL")}>▼ SELL / SHORT</button>
            </div>
          </div>
          <div className="tp-field">
            <label>Típus</label>
            <select value={orderType} onChange={e => setOrderType(e.target.value as any)}>
              <option value="Market">Market</option>
              <option value="Limit">Limit</option>
            </select>
          </div>
          <div className="tp-field">
            <label>Mennyiség (kontrak)</label>
            <input type="number" value={qty} onChange={e => setQty(e.target.value)} placeholder="0.001" min="0" step="0.001" />
          </div>
          {orderType === "Limit" && (
            <div className="tp-field full">
              <label>Ár (USD)</label>
              <input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="67000" />
            </div>
          )}
          <div className="full">
            <button className="tp-btn-full" onClick={placeOrder} disabled={ordering || !qty} style={{ marginTop: 4 }}>
              {ordering ? "KÜLDÉS..." : `${side} ${symbol} – ORDER LEADÁS`}
            </button>
          </div>
        </div>
        {orderMsg && (
          <div className={`tp-verdict ${orderMsg.startsWith("✓") ? "go" : "stop"}`} style={{ marginTop: 10 }}>{orderMsg}</div>
        )}
      </div>
    </div>
  );
}

// ─── POLYMARKET PANEL ─────────────────────────────────────────────────────────
function PolymarketPanel() {
  const [markets,  setMarkets]  = useState<PMMarket[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [selected, setSelected] = useState<PMMarket | null>(null);
  const [orderSide, setOrderSide] = useState<"BUY"|"SELL">("BUY");
  const [amount,   setAmount]   = useState("50");
  const [intentMsg,setIntentMsg] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiGet("polymarket-trade?action=markets&limit=20");
      if (data.ok) setMarkets(data.markets || []);
    } catch {}
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const getIntent = async () => {
    if (!selected) return;
    const token = selected.tokens.find(t => t.outcome === (orderSide === "BUY" ? "Yes" : "No"));
    if (!token) { setIntentMsg("✗ Token ID nem található"); return; }
    const price = orderSide === "BUY" ? selected.yes_price : selected.no_price;
    const data  = await apiPost("polymarket-trade", {
      action: "order_intent", token_id: token.token_id,
      side: orderSide, amount: parseFloat(amount), price,
    });
    if (data.ok) {
      setIntentMsg(`✓ Intent: python polymarket_trade.py --intent '${JSON.stringify(data.intent)}'`);
    } else {
      setIntentMsg(`✗ ${data.error}`);
    }
  };

  return (
    <div className="tp-panel">
      <div className="tp-topbar">
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
          Polymarket • Read-only + Intent generator
        </span>
        <button className="tp-btn-sm" onClick={load} disabled={loading}>{loading ? "..." : "⟳ Frissít"}</button>
      </div>

      <div className="tp-info">
        <strong>Kereskedési flow:</strong><br />
        1. Válassz piacot alább → order intent generálás<br />
        2. Másold a parancsot → futtasd lokálisan: <code>python polymarket_trade.py</code><br />
        <strong>Miért nem közvetlen order?</strong> A Polymarket ECDSA aláírás szerver oldalon private key tárolást igényelne – ez biztonsági kockázat. A Python script a <em>te gépeden</em> fut, a kulcs ott marad.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: markets.length && selected ? "1.2fr 1fr" : "1fr", gap: 15 }}>
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: 18 }}>
          <div className="tp-section">Top piacok ({markets.length})</div>
          <table className="tp-tbl">
            <thead><tr><th>Kérdés</th><th>YES</th><th>NO</th><th>Vol 24h</th></tr></thead>
            <tbody>
              {markets.map((m, i) => (
                <tr key={i} onClick={() => setSelected(m)} style={{ cursor: "pointer", background: selected?.slug === m.slug ? "var(--surface2)" : "" }}>
                  <td><div className="tp-pm-q">{m.question}</div></td>
                  <td className="ec-pos" style={{ fontWeight: 700 }}>{(m.yes_price * 100).toFixed(1)}¢</td>
                  <td className="ec-neg">{(m.no_price * 100).toFixed(1)}¢</td>
                  <td style={{ color: "var(--muted)" }}>${((m.volume_24h || 0) / 1000).toFixed(0)}k</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected && (
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 4, padding: 18 }}>
            <div className="tp-section">Trade Intent</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginBottom: 14, borderBottom: "1px solid var(--border)", paddingBottom: 10, lineHeight: 1.5 }}>{selected.question}</div>
            <div className="tp-side-row" style={{ marginBottom: 12 }}>
              <button className={`tp-side-btn buy ${orderSide === "BUY" ? "active" : ""}`} onClick={() => setOrderSide("BUY")}>▲ BUY YES ({(selected.yes_price * 100).toFixed(1)}¢)</button>
              <button className={`tp-side-btn sell ${orderSide === "SELL" ? "active" : ""}`} onClick={() => setOrderSide("SELL")}>▼ BUY NO ({(selected.no_price * 100).toFixed(1)}¢)</button>
            </div>
            <div className="tp-field" style={{ marginBottom: 12 }}>
              <label>Összeg (USDC)</label>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} min="1" />
            </div>
            <button className="tp-btn-full" onClick={getIntent}>INTENT GENERÁLÁS →</button>
            {intentMsg && (
              <div style={{ marginTop: 12, padding: 10, background: "var(--surface2)", borderRadius: 2, fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent2)", lineHeight: 1.8, wordBreak: "break-all", border: "1px solid var(--border)" }}>
                {intentMsg}
              </div>
            )}
            <a href={selected.url} target="_blank" rel="noopener noreferrer" style={{ display: "block", marginTop: 10, fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent2)", textDecoration: "none" }}>→ Megnyit Polymarketen ↗</a>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function TradingPanel() {
  const [authed,   setAuthed]   = useState<boolean | null>(null); // null = loading
  const [exchange, setExchange] = useState<Exchange | "polymarket">("bybit");

  // Auth állapot ellenőrzés mountkor
  useEffect(() => {
    fetch(`${FN}/auth`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setAuthed(d.ok))
      .catch(() => setAuthed(false));
  }, []);

  const logout = async () => {
    await apiPost("auth", { action: "logout" });
    setAuthed(false);
  };

  if (authed === null) return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "50vh", fontFamily: "var(--mono)", color: "var(--muted)" }}>
      Ellenőrzés...
    </div>
  );

  if (!authed) return (
    <>
      <style>{css}</style>
      <LoginScreen onLogin={() => setAuthed(true)} />
    </>
  );

  return (
    <>
      <style>{css}</style>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 20 }}>
          <div>
            <div style={{ fontFamily: "var(--sans)", fontSize: 18, fontWeight: 800, letterSpacing: "-.02em", marginBottom: 3 }}>Trading Panel</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>Bybit Futures • Binance Futures • Polymarket</div>
          </div>
          <button className="tp-btn-sm" onClick={logout} style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Kilépés</button>
        </div>

        <div className="tp-exchange-row">
          {(["bybit","binance","polymarket"] as const).map(ex => (
            <button key={ex} className={`tp-ex-btn ${ex === "polymarket" ? "poly" : ""} ${exchange === ex ? "active" : ""}`} onClick={() => setExchange(ex)}>
              {ex.charAt(0).toUpperCase() + ex.slice(1)}
            </button>
          ))}
        </div>

        {exchange === "bybit"      && <ExchangePanel exchange="bybit" />}
        {exchange === "binance"    && <ExchangePanel exchange="binance" />}
        {exchange === "polymarket" && <PolymarketPanel />}
      </div>
    </>
  );
}
