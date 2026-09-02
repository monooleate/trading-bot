import { useState } from "react";
import { dashboardCSS } from "./dashboardStyles";

interface Props {
  tabs: [string, string][];
  defaultTab?: string;
  /** Used to scope the bankroll input per-bot. Funding-arb shares the
   *  `hyperliquid` key since the F-Arb session draws from HL's bankroll. */
  category?: string;
  children: (tab: string, bankroll: number) => React.ReactNode;
}

// Per-bot default starting bankroll. Mirrors the server-side fallbacks in
// auto-trader/index.mts (crypto $150, weather $100) and hyperliquid/config
// ($200). Funding-arb shares the HL bucket.
const DEFAULT_BANKROLL: Record<string, number> = {
  crypto:        150,
  weather:       100,
  hyperliquid:   200,
  "funding-arb": 200,
};

// Maps the visible category to the localStorage key used for the bankroll
// input. Funding-arb and Hyperliquid share the same key — the F-Arb session
// has no bankroll of its own; arbReset writes the value into the HL session
// (capital pool is shared).
function storageKeyFor(category?: string): string {
  if (category === "funding-arb") return "ec_bankroll_hyperliquid";
  return category ? `ec_bankroll_${category}` : "ec_bankroll";
}

export default function DashboardShell({ tabs, defaultTab, category, children }: Props) {
  const [tab, setTab] = useState(defaultTab || tabs[0]?.[0] || "");
  const [bankroll, setBankroll] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_BANKROLL[category ?? ""] ?? 200;
    const key = storageKeyFor(category);
    const saved = localStorage.getItem(key);
    if (saved) return +saved;
    // One-time migration from the legacy single-bot key. If someone bumped
    // their bankroll before the per-bot keys existed, carry that value over
    // so the UI doesn't reset on first load after this rollout.
    const legacy = localStorage.getItem("ec_bankroll");
    if (legacy) return +legacy;
    return DEFAULT_BANKROLL[category ?? ""] ?? 200;
  });

  const updateBankroll = (v: number) => {
    setBankroll(v);
    if (typeof window !== "undefined") {
      localStorage.setItem(storageKeyFor(category), String(v));
    }
  };

  const labelText = category
    ? `Bankroll · ${category === "funding-arb" ? "hyperliquid (shared)" : category}`
    : "Bankroll";

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
            <span
              style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", textTransform: "uppercase" }}
              title={category === "funding-arb"
                ? "Funding-Arb has no bankroll of its own — capital is drawn from the directional HL session. Reset HL or F-Arb with a new bankroll to apply (HL session must be empty)."
                : `Bankroll for the ${category ?? "current"} bot. Persists per-bot in localStorage.`}
            >
              {labelText}:
            </span>
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
