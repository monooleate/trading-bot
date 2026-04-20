const CATEGORIES = [
  { id: "crypto",      label: "Crypto",      icon: "\u{1FA99}",       vol: "~18%", fee: "1.8%",   mode: "AUTO",  enabled: true },
  { id: "hyperliquid", label: "Hyperliquid", icon: "\u26A1",          vol: "perp", fee: "0.035%", mode: "AUTO",  enabled: true },
  { id: "sports",      label: "Sports",      icon: "\u26BD",          vol: "~39%", fee: "0.6%",   mode: "ALERT", enabled: false },
  { id: "politics",    label: "Politics",    icon: "\u{1F3DB}\uFE0F", vol: "~34%", fee: "~1%",    mode: "ALERT", enabled: false },
  { id: "weather",     label: "Weather",     icon: "\u{1F324}\uFE0F", vol: "~5%",  fee: "~?",     mode: "AUTO",  enabled: true },
  { id: "macro",       label: "Macro",       icon: "\u{1F4CA}",       vol: "~4%",  fee: "~?",     mode: "ALERT", enabled: false },
];

export default function HomePage() {
  const go = (id: string) => {
    window.location.href = `/trade/${id}`;
  };

  return (
    <div className="hp-wrap">
      <div className="hp-header">
        <div className="hp-logo">EDGE<span>/</span>CALC</div>
        <div className="hp-sub">Quantitative Polymarket Auto-Trader</div>
      </div>

      <div className="hp-grid">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className={`hp-card ${cat.enabled ? "" : "hp-disabled"}`}
            onClick={() => cat.enabled && go(cat.id)}
            disabled={!cat.enabled}
          >
            <span className="hp-icon">{cat.icon}</span>
            <span className="hp-label">{cat.label}</span>
            <div className="hp-meta">
              <span>vol: {cat.vol}</span>
              <span>fee: {cat.fee}</span>
            </div>
            <span className={`hp-badge ${cat.mode === "AUTO" ? "hp-badge-auto" : "hp-badge-alert"}`}>
              {cat.enabled ? cat.mode : "Soon"}
            </span>
          </button>
        ))}
      </div>

      <a href="/tools" className="hp-tools-link">
        Tools & Analysis &rarr;
      </a>

      <style>{`
        .hp-wrap {
          max-width: 800px;
          margin: 0 auto;
          padding: 4rem 1rem 2rem;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .hp-header {
          text-align: center;
          margin-bottom: 3rem;
        }
        .hp-logo {
          font-family: var(--mono);
          font-size: 24px;
          color: var(--accent);
          letter-spacing: .2em;
          text-transform: uppercase;
          margin-bottom: 6px;
        }
        .hp-logo span { color: var(--muted); }
        .hp-sub {
          font-family: var(--mono);
          font-size: 11px;
          color: var(--muted);
          letter-spacing: .15em;
          text-transform: uppercase;
        }
        .hp-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1rem;
          width: 100%;
          margin-bottom: 2rem;
        }
        .hp-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1.75rem 1rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          cursor: pointer;
          transition: border-color 0.15s, transform 0.1s;
        }
        .hp-card:hover:not(.hp-disabled) {
          border-color: var(--accent);
          transform: translateY(-2px);
        }
        .hp-disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .hp-icon { font-size: 2.2rem; }
        .hp-label {
          font-family: var(--sans);
          font-size: 1rem;
          font-weight: 600;
          color: var(--text);
        }
        .hp-meta {
          display: flex;
          gap: 0.75rem;
          font-family: var(--mono);
          font-size: 0.65rem;
          color: var(--muted);
        }
        .hp-badge {
          font-family: var(--mono);
          font-size: 0.6rem;
          padding: 2px 10px;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .hp-badge-auto {
          background: var(--accent);
          color: var(--bg);
          font-weight: 700;
        }
        .hp-badge-alert {
          background: var(--surface2);
          color: var(--muted);
          border: 1px solid var(--border);
        }
        .hp-tools-link {
          font-family: var(--mono);
          font-size: 0.75rem;
          color: var(--muted);
          text-decoration: none;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          transition: color 0.15s;
          margin-top: 1rem;
        }
        .hp-tools-link:hover { color: var(--accent); }
        @media (max-width: 600px) {
          .hp-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 400px) {
          .hp-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
