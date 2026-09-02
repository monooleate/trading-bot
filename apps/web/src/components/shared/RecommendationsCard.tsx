import { useCallback, useEffect, useState } from "react";

// Coach-mode Recommendations Card.
//
// Fetches /.netlify/functions/recommendations-api?category=... and renders
// the per-bot suggestion list with one-click [Apply] / [Dismiss] buttons.
//
// Apply path: POST to /trader-settings with `{ [field]: suggestedValue }`.
// Reuses the same auth-protected endpoint the Settings tab writes to.
// Dismiss is local-state only (no persistence) — the recommendation will
// re-appear on the next page load if the underlying condition still holds,
// which is intentional: a dismissed-but-still-valid suggestion shouldn't
// vanish forever.

type Severity = "info" | "warn" | "action";
type Confidence = "low" | "medium" | "high";

export interface Recommendation {
  id:             string;
  field:          string | null;
  currentValue:   number | null;
  suggestedValue: number | null;
  severity:       Severity;
  confidence:     Confidence;
  title:          string;
  reasoning:      string;
  dataPoints:     Record<string, string | number>;
  applyLabel?:    string;
}

export interface RecommendationsResponse {
  ok:                 boolean;
  category:           string;
  generatedAt:        string;
  tradeCount:         number;
  closedTradeWindow:  string;
  halfLifeTradesUsed: number | null;
  recommendations:    Recommendation[];
  authed:             boolean;
}

interface Props {
  category: "crypto" | "weather" | "hyperliquid" | "funding-arb";
  /** Bumped by the parent to force a re-fetch (e.g. after a new closed trade). */
  refreshKey?: number;
  /** Default expanded? Defaults to true (visible by default). */
  defaultOpen?: boolean;
}

const REC_FN      = "/.netlify/functions/recommendations-api";
const SETTINGS_FN = "/.netlify/functions/trader-settings";

function sevTone(s: Severity): string {
  if (s === "action") return "rec-tone-action";
  if (s === "warn")   return "rec-tone-warn";
  return "rec-tone-info";
}

function confTone(c: Confidence): string {
  if (c === "high")   return "rec-conf-high";
  if (c === "medium") return "rec-conf-medium";
  return "rec-conf-low";
}

function formatVal(v: number | null): string {
  if (v === null) return "—";
  if (Math.abs(v) >= 100)  return v.toFixed(0);
  if (Math.abs(v) >= 10)   return v.toFixed(1);
  if (Math.abs(v) >= 1)    return v.toFixed(2);
  return v.toFixed(3);
}

export default function RecommendationsCard({ category, refreshKey, defaultOpen = true }: Props) {
  const [open, setOpen]         = useState(defaultOpen);
  const [data, setData]         = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [whyOpen, setWhyOpen]   = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState<string | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${REC_FN}?category=${category}`, { credentials: "include" });
      const j = (await r.json()) as RecommendationsResponse;
      if (j.ok) setData(j);
      else setError("Failed to load recommendations");
    } catch (e: any) {
      setError(e?.message || "network error");
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const applyRec = useCallback(async (rec: Recommendation) => {
    if (!rec.field || rec.suggestedValue === null) return;
    setApplying(rec.id);
    setApplyMsg(null);
    try {
      const r = await fetch(SETTINGS_FN, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [rec.field]: rec.suggestedValue }),
      });
      const j = await r.json();
      if (j.ok) {
        setApplyMsg(`✓ Alkalmazva: ${rec.field} → ${rec.suggestedValue}`);
        // Refresh recommendations after apply — the rule may no longer fire.
        await load();
      } else {
        setApplyMsg(`✗ Sikertelen: ${j.reason || "unknown"}`);
      }
    } catch (e: any) {
      setApplyMsg(`✗ Hálózati hiba: ${e?.message || "unknown"}`);
    } finally {
      setApplying(null);
    }
  }, [load]);

  const toggleWhy = (id: string) => {
    setWhyOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const visible = (data?.recommendations ?? []).filter((r) => !dismissed.has(r.id));
  const headerLabel = data
    ? `${visible.length} javaslat (${data.tradeCount} closed trade${data.closedTradeWindow !== "all" ? `, ${data.closedTradeWindow}` : ""})`
    : (loading ? "Coach mode: betöltés..." : "Coach mode");

  return (
    <div className="rec-card">
      <button
        type="button"
        className="rec-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="rec-title">📊 Coach mode — Recommendations</span>
        <span className="rec-count">{headerLabel}</span>
        <span className="rec-chevron">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="rec-body">
          {error && <div className="rec-error">⚠ {error}</div>}
          {applyMsg && <div className="rec-applied">{applyMsg}</div>}

          {data && data.halfLifeTradesUsed !== null && (
            <div className="rec-meta">
              IC time-decay: half-life {data.halfLifeTradesUsed} trade · refresh: {new Date(data.generatedAt).toLocaleTimeString()}
            </div>
          )}

          {visible.length === 0 && !loading && (
            <div className="rec-empty">
              Nincs aktív javaslat. {data?.tradeCount ? `${data.tradeCount} trade-en a jelenlegi konfiguráció megfelelő.` : "Várj több closed trade-re."}
            </div>
          )}

          {visible.map((rec) => {
            const why = whyOpen.has(rec.id);
            const isApplying = applying === rec.id;
            return (
              <div key={rec.id} className={`rec-row ${sevTone(rec.severity)}`}>
                <div className="rec-row-main">
                  <div className="rec-row-line">
                    <span className={`rec-conf-tag ${confTone(rec.confidence)}`} title={`Confidence: ${rec.confidence}`}>
                      {rec.confidence}
                    </span>
                    <span className="rec-row-title">{rec.title}</span>
                  </div>
                  {rec.field && (
                    <div className="rec-row-vals">
                      <code className="rec-field">{rec.field}</code>
                      <span className="rec-cur">{formatVal(rec.currentValue)}</span>
                      <span className="rec-arrow">→</span>
                      <span className="rec-sug">{formatVal(rec.suggestedValue)}</span>
                    </div>
                  )}
                  {why && (
                    <div className="rec-why">
                      <div className="rec-why-text">{rec.reasoning}</div>
                      <div className="rec-why-data">
                        {Object.entries(rec.dataPoints).map(([k, v]) => (
                          <span key={k} className="rec-dp">
                            <span className="rec-dp-k">{k}:</span>
                            <span className="rec-dp-v">{String(v)}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="rec-row-actions">
                  <button type="button" className="rec-btn rec-btn-why" onClick={() => toggleWhy(rec.id)}>
                    {why ? "Bezár" : "Why?"}
                  </button>
                  {rec.field && rec.suggestedValue !== null && (
                    <button
                      type="button"
                      className="rec-btn rec-btn-apply"
                      onClick={() => applyRec(rec)}
                      disabled={isApplying}
                    >
                      {isApplying ? "..." : (rec.applyLabel || "Apply")}
                    </button>
                  )}
                  <button type="button" className="rec-btn rec-btn-dismiss" onClick={() => dismiss(rec.id)}>
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}

          <div className="rec-foot">
            <button type="button" className="rec-btn rec-btn-refresh" onClick={() => void load()} disabled={loading}>
              {loading ? "..." : "↻ Frissítés"}
            </button>
            <span className="rec-foot-help">
              Apply = trader-settings POST (auth-protected, azonos a Settings tab mentésével). Dismiss = csak az aktuális nézetből rejti el; következő frissítéskor visszajön ha még érvényes.
            </span>
          </div>
        </div>
      )}

      <style>{`
        .rec-card {
          font-family: var(--mono);
          font-size: 11px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--surface);
          margin-bottom: 12px;
          overflow: hidden;
        }
        .rec-head {
          display: flex; align-items: center; gap: 10px;
          width: 100%; padding: 10px 14px;
          background: var(--surface2);
          border: none; cursor: pointer;
          color: var(--text);
          font: inherit; text-align: left;
        }
        .rec-head:hover { background: #1c1c25; }
        .rec-title { font-weight: 700; letter-spacing: 0.06em; }
        .rec-count { color: var(--muted); margin-left: auto; font-size: 10px; }
        .rec-chevron { color: var(--muted); }

        .rec-body { padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
        .rec-meta { font-size: 10px; color: var(--muted); }
        .rec-empty {
          padding: 12px;
          color: var(--muted);
          text-align: center;
          background: var(--surface2);
          border-radius: 3px;
          font-size: 10px;
        }
        .rec-error {
          background: rgba(241, 53, 53, 0.12);
          border: 1px solid rgba(241, 53, 53, 0.35);
          padding: 6px 8px;
          color: #ffb0b0;
          border-radius: 3px;
          font-size: 10px;
        }
        .rec-applied {
          background: rgba(200, 241, 53, 0.10);
          border: 1px solid rgba(200, 241, 53, 0.35);
          padding: 6px 8px;
          color: #c8f135;
          border-radius: 3px;
          font-size: 10px;
        }

        .rec-row {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          padding: 8px 10px;
          border-radius: 3px;
          background: var(--surface2);
          border-left: 3px solid var(--border);
        }
        .rec-tone-info   { border-left-color: var(--accent2); }
        .rec-tone-warn   { border-left-color: var(--warn); }
        .rec-tone-action { border-left-color: var(--accent); }

        .rec-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
        .rec-row-line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .rec-row-title { font-weight: 600; color: var(--text); }
        .rec-conf-tag {
          padding: 1px 6px;
          border-radius: 2px;
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          border: 1px solid currentColor;
        }
        .rec-conf-low    { color: var(--muted); }
        .rec-conf-medium { color: var(--accent2); }
        .rec-conf-high   { color: var(--accent); }

        .rec-row-vals {
          display: flex; gap: 8px; align-items: center;
          font-size: 10px; color: var(--muted);
          flex-wrap: wrap;
        }
        .rec-field {
          background: var(--bg); padding: 1px 5px; border-radius: 2px;
          color: var(--text); font-size: 10px;
        }
        .rec-cur   { color: var(--muted); }
        .rec-arrow { color: var(--muted); }
        .rec-sug   { color: var(--accent); font-weight: 600; }

        .rec-why {
          margin-top: 4px;
          padding: 8px;
          background: var(--bg);
          border-radius: 3px;
          font-size: 10px;
        }
        .rec-why-text { color: var(--text); line-height: 1.5; margin-bottom: 6px; }
        .rec-why-data { display: flex; flex-wrap: wrap; gap: 6px; }
        .rec-dp { background: var(--surface2); padding: 1px 5px; border-radius: 2px; font-size: 9px; }
        .rec-dp-k { color: var(--muted); margin-right: 4px; }
        .rec-dp-v { color: var(--text); font-weight: 600; }

        .rec-row-actions {
          display: flex; flex-direction: column; gap: 4px;
          flex-shrink: 0; align-items: stretch;
        }
        .rec-btn {
          font-family: var(--mono);
          font-size: 9.5px;
          padding: 4px 8px;
          border: 1px solid var(--border);
          background: var(--bg);
          color: var(--text);
          border-radius: 2px;
          cursor: pointer;
          white-space: nowrap;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          font-weight: 600;
        }
        .rec-btn:hover:not(:disabled) { background: var(--surface2); }
        .rec-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .rec-btn-apply   { border-color: var(--accent); color: var(--accent); }
        .rec-btn-apply:hover:not(:disabled) { background: rgba(200, 241, 53, 0.1); }
        .rec-btn-dismiss { color: var(--muted); }
        .rec-btn-why     { color: var(--accent2); border-color: var(--accent2); }

        .rec-foot {
          display: flex; gap: 8px; align-items: center;
          margin-top: 4px;
          padding-top: 8px;
          border-top: 1px solid var(--border);
        }
        .rec-foot-help { font-size: 9px; color: var(--muted); flex: 1; line-height: 1.4; }
        .rec-btn-refresh { font-size: 9px; }

        @media (max-width: 600px) {
          .rec-row { flex-direction: column; }
          .rec-row-actions { flex-direction: row; flex-wrap: wrap; }
          .rec-btn { flex: 1; min-width: 70px; }
        }
      `}</style>
    </div>
  );
}
