import { useState } from "react";
import { dashboardCSS } from "./dashboardStyles";

interface Props {
  tabs: [string, string][];
  defaultTab?: string;
  children: (tab: string, bankroll: number) => React.ReactNode;
}

export default function DashboardShell({ tabs, defaultTab, children }: Props) {
  const [tab, setTab] = useState(defaultTab || tabs[0]?.[0] || "");
  const [bankroll, setBankroll] = useState(() => {
    if (typeof window === "undefined") return 200;
    const saved = localStorage.getItem("ec_bankroll");
    return saved ? +saved : 200;
  });

  const updateBankroll = (v: number) => {
    setBankroll(v);
    localStorage.setItem("ec_bankroll", String(v));
  };

  return (
    <>
      <style>{dashboardCSS}</style>
      <div style={{ background: "var(--bg)", minHeight: "100vh", color: "var(--text)" }}>
        <div className="ec-header">
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <a href="/" className="ec-home-link">&larr; Home</a>
            <div className="ec-logo">
              EDGE<span>/</span>CALC <span>// auto-trader v1</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase" }}>Bankroll:</span>
            <input
              type="number"
              value={bankroll}
              onChange={(e) => updateBankroll(+e.target.value)}
              min={10}
              style={{
                background: "var(--surface2)",
                border: "1px solid var(--border)",
                color: "var(--accent)",
                fontFamily: "var(--mono)",
                fontSize: 13,
                padding: "4px 8px",
                borderRadius: 2,
                outline: "none",
                width: 82,
                textAlign: "right",
              }}
            />
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)" }}>USD</span>
          </div>
        </div>
        {tabs.length > 1 && (
          <div className="ec-tabs">
            {tabs.map(([id, lbl]) => (
              <button
                key={id}
                className={`ec-tab ${tab === id ? "active" : ""}`}
                onClick={() => setTab(id)}
              >
                {lbl}
              </button>
            ))}
          </div>
        )}
        <div className="ec-content">{children(tab, bankroll)}</div>
      </div>
    </>
  );
}
