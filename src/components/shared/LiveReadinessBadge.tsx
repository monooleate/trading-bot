import { useEffect, useState } from "react";

// One-stop "is paper-mode validated enough to flip live?" verdict for every
// trader landing page. Renders the per-gate pass/fail rows plus a compact
// summary so the operator can see at a glance which thresholds are still
// short of the live-readiness criteria.
//
// Source: GET /.netlify/functions/auto-trader-api?action=status&category=…
// — that endpoint already calls computeLiveReadiness server-side.

export interface ReadinessGate {
  key:        string;
  label:      string;
  passed:     boolean;
  actual:     string;
  required:   string;
  applicable: boolean;
}

export interface LiveReadinessReport {
  category:    string;
  ready:       boolean;
  gatesPassed: number;
  gatesTotal:  number;
  gates:       ReadinessGate[];
  reason:      string;
  summary?: {
    tradeCount:   number;
    winRate:      number;
    maxAbsIC:     number;
    topSignal:    string | null;
    calibDev:     number;
    sharpe:       number;
    drawdownPct:  number;
  };
}

type Variant = "full" | "compact";

interface Props {
  category: "crypto" | "weather" | "hyperliquid" | "funding-arb" | "sports";
  variant?: Variant;
  // If supplied, skip the network call. Useful for the auto-trader status
  // payload which already carries `liveReadiness` per response.
  readiness?: LiveReadinessReport | null;
  refreshKey?: number;
}

const FN = "/.netlify/functions/auto-trader-api";

export default function LiveReadinessBadge({
  category,
  variant = "full",
  readiness: external,
  refreshKey,
}: Props) {
  const [data, setData] = useState<LiveReadinessReport | null>(external ?? null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (external) {
      setData(external);
      return;
    }
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${FN}?action=status&category=${category}`);
        const json = await res.json();
        if (!cancel && json.ok && json.liveReadiness) {
          setData(json.liveReadiness as LiveReadinessReport);
        }
      } catch { /* silent */ }
      finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, [category, external, refreshKey]);

  if (!data && loading) {
    return <div className="lrb lrb-loading">Live readiness…</div>;
  }
  if (!data) return null;

  const isCompact = variant === "compact";
  const tone = data.ready ? "ready" : "not-ready";

  return (
    <div className={`lrb lrb-${tone} ${isCompact ? "lrb-compact" : "lrb-full"}`}>
      <div className="lrb-head">
        <span className="lrb-dot" />
        <span className="lrb-label">{data.ready ? "LIVE-READY" : "PAPER ONLY"}</span>
        <span className="lrb-count">
          {data.gatesPassed}/{data.gatesTotal} gates
        </span>
      </div>
      {!isCompact && (
        <>
          <div className="lrb-reason">{data.reason}</div>
          <div className="lrb-gates">
            {data.gates.filter((g) => g.applicable).map((g) => (
              <div key={g.key} className={`lrb-gate ${g.passed ? "lrb-pass" : "lrb-fail"}`}>
                <span className="lrb-gate-mark">{g.passed ? "✓" : "✗"}</span>
                <span className="lrb-gate-label">{g.label}</span>
                <span className="lrb-gate-actual">{g.actual}</span>
                <span className="lrb-gate-req">need {g.required}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <style>{`
        .lrb {
          font-family: var(--mono);
          font-size: 11px;
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 10px 14px;
          margin-bottom: 12px;
          display: flex; flex-direction: column; gap: 6px;
        }
        .lrb-compact { padding: 6px 10px; font-size: 10px; margin-bottom: 8px; }
        .lrb-ready     { background: #0f1f00; border-color: #c8f135; color: #c8f135; }
        .lrb-not-ready { background: #1f1500; border-color: #f1a035; color: #f1a035; }
        .lrb-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .lrb-dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; box-shadow: 0 0 6px currentColor; }
        .lrb-label { font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
        .lrb-count { color: var(--muted); margin-left: auto; }
        .lrb-reason { color: var(--muted); font-size: 10px; }
        .lrb-gates { display: grid; grid-template-columns: 1fr; gap: 4px; margin-top: 4px; }
        .lrb-gate {
          display: grid;
          grid-template-columns: 18px 1fr auto auto;
          gap: 8px;
          font-size: 10px;
          padding: 4px 8px;
          border-radius: 3px;
          background: var(--surface2);
        }
        @media (max-width: 480px) {
          .lrb-gate {
            grid-template-columns: 18px 1fr;
            grid-template-areas:
              "mark label"
              "mark actual"
              "mark req";
            row-gap: 2px;
          }
          .lrb-gate-mark { grid-area: mark; }
          .lrb-gate-label { grid-area: label; }
          .lrb-gate-actual { grid-area: actual; text-align: left; font-size: 9.5px; }
          .lrb-gate-req { grid-area: req; text-align: left; font-size: 9px; }
          .lrb-head { flex-wrap: wrap; }
          .lrb-count { margin-left: 0; }
        }
        .lrb-pass .lrb-gate-mark { color: #c8f135; }
        .lrb-fail .lrb-gate-mark { color: #f13535; }
        .lrb-gate-label  { color: var(--text); }
        .lrb-gate-actual { color: var(--text); text-align: right; font-weight: 600; }
        .lrb-gate-req    { color: var(--muted); text-align: right; }
        .lrb-loading {
          padding: 6px 10px;
          font-family: var(--mono);
          font-size: 10px;
          color: var(--muted);
          margin-bottom: 8px;
        }
      `}</style>
    </div>
  );
}
