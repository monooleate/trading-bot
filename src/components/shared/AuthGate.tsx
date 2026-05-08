// src/components/shared/AuthGate.tsx
//
// Wraps any trader/manipulation UI so that:
//   1. The browser-level read of /auth determines if we're logged in.
//   2. While we don't know yet (null) we render a tiny spinner.
//   3. Logged-out visitors see a small login overlay AND a read-only
//      summary of the children below it. This way someone can browse the
//      home page → click into /trade/<x>/ → see the public state without
//      being able to start/stop/reset anything.
//   4. Logged-in users see the children unchanged.
//
// Children get an `authed` prop so they can hide control buttons
// (Run / Reset / Stop / Resume) when not logged in. The backend already
// rejects those actions, but UX-wise we don't want the buttons visible
// at all unless they will work.

import { useEffect, useState, useCallback } from "react";

const FN = "/.netlify/functions";

export interface AuthState {
  authed: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

export function useAuthState(): AuthState {
  const [authed, setAuthed]   = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${FN}/auth`, { credentials: "include" });
      const j = await r.json().catch(() => ({}));
      setAuthed(!!j.ok);
    } catch {
      setAuthed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch(`${FN}/auth`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
    } catch {}
    setAuthed(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { authed, loading, refresh, logout };
}

interface Props {
  children: React.ReactNode | ((state: AuthState) => React.ReactNode);
  // When true, logged-out visitors see *only* the login form (no read-only
  // children below). Use for surfaces where the children themselves talk to
  // protected endpoints with no public fallback.
  strict?: boolean;
  title?: string;
  subtitle?: string;
}

export default function AuthGate({ children, strict, title, subtitle }: Props) {
  const auth = useAuthState();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!pw) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${FN}/auth`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", password: pw }),
      });
      const j = await r.json();
      if (j.ok) { setPw(""); await auth.refresh(); }
      else setErr("Hibás jelszó");
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (auth.loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
        Auth ellenőrzés…
      </div>
    );
  }

  const renderChildren = () =>
    typeof children === "function" ? (children as (s: AuthState) => React.ReactNode)(auth) : children;

  if (auth.authed) return <>{renderChildren()}</>;

  return (
    <>
      <style>{css}</style>
      <div className="ag-overlay">
        <div className="ag-card">
          <div className="ag-title">{title ?? "Bejelentkezés szükséges"}</div>
          <div className="ag-sub">{subtitle ?? "Trader manipulációhoz (indítás, megállítás, reset, paraméter állítás) belépés kell."}</div>
          <input
            className="ag-input"
            type="password"
            placeholder="Jelszó"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoFocus
          />
          <button className="ag-btn" onClick={submit} disabled={busy || !pw}>
            {busy ? "..." : "BELÉPÉS"}
          </button>
          {err && <div className="ag-err">{err}</div>}
        </div>
        {!strict && (
          <div className="ag-readonly-wrap">
            <div className="ag-readonly-hint">
              ▾ Az alábbi nézet read-only: státuszt és paper trade-eket láthatsz, de gomb (Run / Stop / Reset / Mentés) csak belépés után jelenik meg.
            </div>
            <div className="ag-readonly">
              {renderChildren()}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const css = `
.ag-overlay { display: flex; flex-direction: column; gap: 16px; padding: 22px 18px; }
.ag-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 4px; padding: 22px;
  max-width: 380px; margin: 0 auto;
  display: flex; flex-direction: column; gap: 10px;
}
.ag-title {
  font-family: var(--sans); font-size: 16px; font-weight: 700;
  text-align: center; color: var(--text);
}
.ag-sub {
  font-family: var(--mono); font-size: 10px;
  color: var(--muted); text-align: center;
  line-height: 1.6; margin-bottom: 6px;
}
.ag-input {
  background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); font-family: var(--mono); font-size: 13px;
  padding: 10px 12px; border-radius: 2px; outline: none;
}
.ag-input:focus { border-color: var(--accent); }
.ag-btn {
  background: var(--accent); color: var(--bg);
  border: none; padding: 10px 16px;
  font-family: var(--mono); font-size: 11px; font-weight: 700;
  border-radius: 2px; cursor: pointer;
  letter-spacing: .12em; text-transform: uppercase;
}
.ag-btn:disabled { opacity: .4; cursor: not-allowed; }
.ag-err {
  font-family: var(--mono); font-size: 11px;
  color: var(--danger);
  background: #1f0000; border-left: 3px solid var(--danger);
  padding: 6px 10px; border-radius: 2px;
}
.ag-readonly-wrap { width: 100%; max-width: 1100px; margin: 0 auto; }
.ag-readonly-hint {
  font-family: var(--mono); font-size: 10px;
  color: var(--muted); text-align: center;
  padding: 8px 12px; margin-bottom: 8px;
  background: var(--surface2); border: 1px dashed var(--border);
  border-radius: 2px;
}
.ag-readonly {
  position: relative; opacity: 0.85;
}
.ag-readonly button:not(.ag-btn):not(.ec-tab),
.ag-readonly input[type="number"]:not([readonly]),
.ag-readonly input[type="range"] {
  pointer-events: none;
  filter: grayscale(.6);
}
`;
