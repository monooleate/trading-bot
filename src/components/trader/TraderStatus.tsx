import { useState } from "react";
import CategorySelector from "./CategorySelector";
import CryptoTrader from "./CryptoTrader";

export default function TraderStatus() {
  const [category, setCategory] = useState<string | null>(null);

  if (!category) {
    return <CategorySelector onSelect={setCategory} />;
  }

  if (category === "crypto") {
    return (
      <div>
        <button
          className="ts-back"
          onClick={() => setCategory(null)}
        >
          &larr; Back
        </button>
        <CryptoTrader />
        <style>{`
          .ts-back {
            font-family: var(--mono);
            font-size: 0.7rem;
            color: var(--muted);
            background: none;
            border: none;
            cursor: pointer;
            padding: 0.5rem 1rem;
          }
          .ts-back:hover { color: var(--text); }
        `}</style>
      </div>
    );
  }

  // Other categories: placeholder
  return (
    <div style={{ textAlign: "center", padding: "3rem", color: "var(--muted)", fontFamily: "var(--mono)" }}>
      <p>{category.toUpperCase()} strategy coming soon.</p>
      <button
        className="ts-back"
        onClick={() => setCategory(null)}
      >
        &larr; Back
      </button>
      <style>{`
        .ts-back {
          font-family: var(--mono);
          font-size: 0.7rem;
          color: var(--muted);
          background: none;
          border: none;
          cursor: pointer;
          padding: 0.5rem 1rem;
        }
        .ts-back:hover { color: var(--text); }
      `}</style>
    </div>
  );
}
