// src/components/SettingsPanel.tsx
//
// Auth-protected runtime trader settings UI.
// Reads /trader-settings (returns schema + effective values + saved
// overrides + authed flag), lets the owner adjust each parameter via a
// slider/number input, and POSTs the diff back. POST is rejected by the
// backend without a valid JWT cookie, so the form below is the only
// surface that needs to enforce auth client-side.

import { useState, useEffect, useCallback } from "react";

const FN = "/.netlify/functions";

interface FieldSpec {
  default: number;
  min: number;
  max: number;
  label: string;
  step: number;
  unit: string;
}

interface ServerResponse {
  ok: boolean;
  schema: Record<string, FieldSpec>;
  effective: Record<string, number>;
  overrides: Record<string, number>;
  authed: boolean;
}

const FIELD_GROUPS: { title: string; keys: string[] }[] = [
  { title: "Risk & sizing", keys: ["edgeThreshold", "maxKellyFraction", "sessionLossLimit", "cooldownSeconds"] },
  { title: "BTC short markets (P1.2 — korai exit)", keys: ["btcTpTarget", "btcSlTarget", "btcEntryWindowStartMs", "btcEntryWindowEndMs", "btcHoldToEndCutoffMs"] },
  { title: "Order book imbalance (P1.3 — előkészítés)", keys: ["obImbalanceUpRatio", "obImbalanceDownRatio"] },
];

function formatVal(v: number, unit: string): string {
  if (unit === "frac") return (v * 100).toFixed(2) + "%";
  if (unit === "price") return v.toFixed(2);
  if (unit === "ratio") return v.toFixed(2) + "×";
  if (unit === "ms") return (v / 1000).toFixed(0) + "s";
  if (unit === "sec") return v >= 60 ? (v / 60).toFixed(1) + "m" : v + "s";
  if (unit === "USD") return "$" + v;
  return String(v);
}

export default function SettingsPanel() {
  const [data, setData] = useState<ServerResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [pw, setPw] = useState("");

  const load = useCallback(async () => {
    setMsg(null);
    try {
      const r = await fetch(`${FN}/trader-settings`, { credentials: "include" });
      const j: ServerResponse = await r.json();
      setData(j);
      setDraft(j.effective);
    } catch (e: any) {
      setMsg({ kind: "err", text: e.message });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const login = async () => {
    if (!pw) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${FN}/auth`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", password: pw }),
      });
      const j = await r.json();
      if (j.ok) { setPw(""); await load(); }
      else setMsg({ kind: "err", text: "Hibás jelszó" });
    } catch (e: any) { setMsg({ kind: "err", text: e.message }); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    await fetch(`${FN}/auth`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    await load();
  };

  const save = async () => {
    if (!data) return;
    setBusy(true); setMsg(null);
    const dirty: Record<string, number> = {};
    for (const k of Object.keys(data.schema)) {
      if (draft[k] !== data.effective[k]) dirty[k] = draft[k];
    }
    if (Object.keys(dirty).length === 0) {
      setMsg({ kind: "info", text: "Nincs változás." });
      setBusy(false);
      return;
    }
    try {
      const r = await fetch(`${FN}/trader-settings`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dirty),
      });
      const j = await r.json();
      if (j.ok) {
        setMsg({ kind: "ok", text: `Mentve: ${Object.keys(dirty).length} paraméter` });
        await load();
      } else {
        setMsg({ kind: "err", text: j.reason || "Hiba mentésnél" });
      }
    } catch (e: any) { setMsg({ kind: "err", text: e.message }); }
    finally { setBusy(false); }
  };

  const resetAll = async () => {
    if (!confirm("Minden override-ot törölni? Vissza az env-default értékekre.")) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${FN}/trader-settings`, { method: "DELETE", credentials: "include" });
      const j = await r.json();
      if (j.ok) {
        setMsg({ kind: "ok", text: "Override-ok törölve" });
        await load();
      } else setMsg({ kind: "err", text: j.reason || "Hiba reset-nél" });
    } catch (e: any) { setMsg({ kind: "err", text: e.message }); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="set-loading">Betöltés...</div>;

  if (!data.authed) {
    return (
      <>
        <style>{css}</style>
        <div className="set-login">
          <div className="set-login-card">
            <div className="set-login-title">Beállítások</div>
            <div className="set-login-sub">Bejelentkezés szükséges a paraméterek módosításához</div>
            <input
              className="set-input"
              type="password"
              placeholder="Jelszó"
              value={pw}
              onChange={e => setPw(e.target.value)}
              onKeyDown={e => e.key === "Enter" && login()}
              autoFocus
            />
            <button className="set-btn-primary" onClick={login} disabled={busy || !pw}>
              {busy ? "..." : "BELÉPÉS"}
            </button>
            {msg && <div className={`set-msg set-msg-${msg.kind}`}>{msg.text}</div>}
          </div>
          <div className="set-readonly-hint">
            A jelenlegi (env-default) értékek alább olvashatók, módosításhoz belépés kell.
          </div>
          <ReadOnlyView data={data} />
        </div>
      </>
    );
  }

  return (
    <>
      <style>{css}</style>
      <div className="set-root">
        <div className="set-header">
          <div>
            <div className="set-title">Auto-trader paraméterek</div>
            <div className="set-sub">Runtime override-ok — Netlify Blobs, env defaults felülírása</div>
          </div>
          <div className="set-actions">
            <button className="set-btn-ghost" onClick={resetAll} disabled={busy}>↺ Reset alapértékek</button>
            <button className="set-btn-ghost" onClick={logout}>Kijelentkezés</button>
            <button className="set-btn-primary" onClick={save} disabled={busy}>{busy ? "..." : "💾 Mentés"}</button>
          </div>
        </div>

        {msg && <div className={`set-msg set-msg-${msg.kind}`}>{msg.text}</div>}

        {FIELD_GROUPS.map(group => (
          <div key={group.title} className="set-group">
            <div className="set-group-title">{group.title}</div>
            <div className="set-grid">
              {group.keys.map(k => {
                const spec = data.schema[k];
                if (!spec) return null;
                const cur = draft[k] ?? data.effective[k];
                const isOverride = data.overrides[k] !== undefined;
                const dirty = cur !== data.effective[k];
                return (
                  <div key={k} className={`set-field ${dirty ? "dirty" : ""} ${isOverride ? "override" : ""}`}>
                    <div className="set-field-label">
                      {spec.label}
                      {isOverride && <span className="set-tag">override</span>}
                      {dirty && <span className="set-tag set-tag-dirty">változatlan-mentve</span>}
                    </div>
                    <div className="set-field-row">
                      <input
                        type="range"
                        min={spec.min}
                        max={spec.max}
                        step={spec.step}
                        value={cur}
                        onChange={e => setDraft({ ...draft, [k]: parseFloat(e.target.value) })}
                      />
                      <input
                        type="number"
                        min={spec.min}
                        max={spec.max}
                        step={spec.step}
                        value={cur}
                        onChange={e => setDraft({ ...draft, [k]: parseFloat(e.target.value) })}
                        className="set-num"
                      />
                      <span className="set-formatted">{formatVal(cur, spec.unit)}</span>
                    </div>
                    <div className="set-range-hint">
                      tartomány: {formatVal(spec.min, spec.unit)} … {formatVal(spec.max, spec.unit)}
                      {" · "}env-default: {formatVal(spec.default, spec.unit)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ReadOnlyView({ data }: { data: ServerResponse }) {
  return (
    <div className="set-readonly">
      {FIELD_GROUPS.map(group => (
        <div key={group.title} className="set-group">
          <div className="set-group-title">{group.title}</div>
          <div className="set-grid">
            {group.keys.map(k => {
              const spec = data.schema[k];
              if (!spec) return null;
              return (
                <div key={k} className="set-field readonly">
                  <div className="set-field-label">{spec.label}</div>
                  <div className="set-formatted">{formatVal(data.effective[k], spec.unit)}</div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

const css = `
.set-root, .set-login { padding: 14px; font-family: var(--sans); }
.set-loading { padding: 30px; text-align: center; color: var(--muted); font-family: var(--mono); }
.set-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; }
.set-title { font-size:18px; font-weight:700; }
.set-sub { font-family: var(--mono); font-size:10px; color:var(--muted); margin-top:2px; text-transform:uppercase; letter-spacing:.06em; }
.set-actions { display:flex; gap:8px; }
.set-btn-primary { background: var(--accent); color: #000; border:none; padding:8px 14px; font-family:var(--mono); font-size:11px; font-weight:700; border-radius:2px; cursor:pointer; text-transform:uppercase; letter-spacing:.06em; }
.set-btn-primary:disabled { opacity:.4; cursor:not-allowed; }
.set-btn-ghost { background: var(--surface2); color: var(--text); border:1px solid var(--border); padding:8px 14px; font-family:var(--mono); font-size:11px; border-radius:2px; cursor:pointer; }
.set-btn-ghost:hover { background:var(--surface); }
.set-group { background:var(--surface); border:1px solid var(--border); border-radius:4px; padding:16px; margin-bottom:14px; }
.set-group-title { font-family:var(--mono); font-size:11px; color:var(--accent); text-transform:uppercase; letter-spacing:.08em; margin-bottom:14px; }
.set-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
@media (max-width: 760px) { .set-grid { grid-template-columns:1fr; } }
.set-field { background:var(--surface2); border:1px solid var(--border); border-radius:3px; padding:11px; }
.set-field.dirty { border-color: var(--warn); }
.set-field.override { border-left:3px solid var(--accent2); }
.set-field-label { font-family:var(--sans); font-size:13px; font-weight:600; color:var(--text); margin-bottom:7px; display:flex; align-items:center; gap:7px; }
.set-tag { font-family:var(--mono); font-size:9px; background:var(--accent2); color:#000; padding:1px 5px; border-radius:2px; text-transform:uppercase; letter-spacing:.05em; }
.set-tag-dirty { background: var(--warn); }
.set-field-row { display:flex; align-items:center; gap:10px; }
.set-field-row input[type=range] { flex:1; accent-color: var(--accent); }
.set-num { background:var(--bg); border:1px solid var(--border); color:var(--text); font-family:var(--mono); font-size:12px; padding:4px 6px; border-radius:2px; width:80px; }
.set-formatted { font-family:var(--mono); font-size:12px; color:var(--accent); min-width:60px; text-align:right; font-weight:700; }
.set-range-hint { font-family:var(--mono); font-size:9px; color:var(--muted); margin-top:5px; text-transform:uppercase; letter-spacing:.04em; }
.set-msg { font-family:var(--mono); font-size:11px; padding:7px 10px; border-radius:2px; margin-bottom:12px; }
.set-msg-ok { background:#0a2010; color:var(--accent); border-left:3px solid var(--accent); }
.set-msg-err { background:#200000; color:var(--danger); border-left:3px solid var(--danger); }
.set-msg-info { background:#101620; color:var(--accent2); border-left:3px solid var(--accent2); }
.set-login { display:flex; flex-direction:column; align-items:center; gap:18px; }
.set-login-card { background:var(--surface); border:1px solid var(--border); border-radius:4px; padding:24px; width:100%; max-width:340px; display:flex; flex-direction:column; gap:10px; }
.set-login-title { font-size:18px; font-weight:700; text-align:center; }
.set-login-sub { font-family:var(--mono); font-size:10px; color:var(--muted); text-align:center; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }
.set-input { background:var(--surface2); border:1px solid var(--border); color:var(--text); font-family:var(--mono); font-size:13px; padding:10px; border-radius:2px; outline:none; }
.set-input:focus { border-color:var(--accent); }
.set-readonly-hint { font-family:var(--mono); font-size:10px; color:var(--muted); text-align:center; max-width:480px; }
.set-readonly { width:100%; max-width:780px; opacity:.7; pointer-events:none; }
.set-field.readonly { padding:9px 11px; }
.set-field.readonly .set-formatted { font-size:14px; margin-top:3px; text-align:left; }
`;
