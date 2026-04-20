import { useState } from "react";

interface Category {
  id: string;
  label: string;
  icon: string;
  vol: string;
  fee: string;
  mode: string;
  enabled: boolean;
}

const CATEGORIES: Category[] = [
  { id: "crypto",   label: "Crypto",   icon: "\u{1FA99}", vol: "~18% vol",  fee: "1.8%", mode: "AUTO",  enabled: true },
  { id: "sports",   label: "Sports",   icon: "\u26BD",    vol: "~39% vol",  fee: "0.6%", mode: "ALERT", enabled: false },
  { id: "politics", label: "Politics", icon: "\u{1F3DB}\uFE0F", vol: "~34% vol",  fee: "~1%",  mode: "ALERT", enabled: false },
  { id: "macro",    label: "Macro",    icon: "\u{1F4CA}", vol: "~9% vol",   fee: "~?",   mode: "ALERT", enabled: false },
];

interface Props {
  onSelect: (category: string) => void;
}

export default function CategorySelector({ onSelect }: Props) {
  return (
    <div className="cs-wrap">
      <h2 className="cs-title">Select Strategy Category</h2>
      <div className="cs-grid">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className={`cs-card ${cat.enabled ? "" : "cs-disabled"}`}
            onClick={() => cat.enabled && onSelect(cat.id)}
            disabled={!cat.enabled}
          >
            <span className="cs-icon">{cat.icon}</span>
            <span className="cs-label">{cat.label}</span>
            <div className="cs-meta">
              <span>{cat.vol}</span>
              <span>fee: {cat.fee}</span>
            </div>
            <span className={`cs-badge ${cat.mode === "AUTO" ? "cs-badge-auto" : "cs-badge-alert"}`}>
              {cat.enabled ? cat.mode : "Soon"}
            </span>
          </button>
        ))}
      </div>

      <style>{`
        .cs-wrap {
          max-width: 700px;
          margin: 0 auto;
          padding: 2rem 1rem;
        }
        .cs-title {
          font-family: var(--sans);
          font-size: 1.25rem;
          color: var(--text);
          margin-bottom: 1.5rem;
          text-align: center;
        }
        .cs-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1rem;
        }
        .cs-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1.5rem 1rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          cursor: pointer;
          transition: border-color 0.15s, transform 0.1s;
        }
        .cs-card:hover:not(.cs-disabled) {
          border-color: var(--accent);
          transform: translateY(-2px);
        }
        .cs-disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .cs-icon {
          font-size: 2rem;
        }
        .cs-label {
          font-family: var(--sans);
          font-size: 1rem;
          font-weight: 600;
          color: var(--text);
        }
        .cs-meta {
          display: flex;
          gap: 0.75rem;
          font-family: var(--mono);
          font-size: 0.7rem;
          color: var(--muted);
        }
        .cs-badge {
          font-family: var(--mono);
          font-size: 0.65rem;
          padding: 2px 8px;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .cs-badge-auto {
          background: var(--accent);
          color: var(--bg);
        }
        .cs-badge-alert {
          background: var(--surface2);
          color: var(--muted);
          border: 1px solid var(--border);
        }
        @media (max-width: 500px) {
          .cs-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
