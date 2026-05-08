import { useEffect, useState } from "react";

// Renders the paper-mode calibration verdict (good / weak / noise / insufficient)
// for a given category. Used on every trader landing page so the operator sees
// signal health alongside live stats — no tab-switch required.
//
// Data source: GET /.netlify/functions/edge-tracker?mode=paper&category=…
// — that endpoint already computes `calibrationHealth` (see
// netlify/functions/edge-tracker/statistics.mts:computeCalibrationHealth).

export interface CalibrationHealth {
  status: "good" | "weak" | "noise" | "insufficient";
  maxAbsIC: number;
  topSignal: string | null;
  tradeCount: number;
  shouldSuspendLive: boolean;
  message: string;
}

type Variant = "full" | "compact";

interface Props {
  category?: "crypto" | "weather" | "hyperliquid" | "funding-arb" | "all";
  days?: string;
  variant?: Variant;
  // Optional: pass already-fetched health to skip the network call. Useful
  // when EdgeTrackerPanel has the data and just wants to render the badge.
  health?: CalibrationHealth | null;
  refreshKey?: number; // bump to force a re-fetch
}

const PALETTE = {
  good:         { bg: "#0f1f00", border: "#c8f135", fg: "#c8f135", label: "CALIBRATED",   glyph: "●" },
  weak:         { bg: "#1f1500", border: "#f1a035", fg: "#f1a035", label: "WEAK SIGNALS", glyph: "●" },
  noise:        { bg: "#1f0808", border: "#f13535", fg: "#f13535", label: "NOISE",        glyph: "●" },
  insufficient: { bg: "#16161c", border: "#666680", fg: "#9090a0", label: "WARMING UP",   glyph: "○" },
} as const;

export default function CalibrationHealthBadge({
  category = "crypto",
  days = "30",
  variant = "full",
  health: external,
  refreshKey,
}: Props) {
  const [data, setData] = useState<CalibrationHealth | null>(external ?? null);
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
        const qs = `?mode=paper&category=${category}&days=${days}`;
        const res = await fetch(`/.netlify/functions/edge-tracker${qs}`);
        const json = await res.json();
        if (!cancel && json.ok && json.calibrationHealth) {
          setData(json.calibrationHealth as CalibrationHealth);
        }
      } catch {
        // silent — badge just doesn't render
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [category, days, external, refreshKey]);

  if (!data && loading) {
    return <div className="chb chb-loading">Calibration health…</div>;
  }
  if (!data) return null;

  const p = PALETTE[data.status];
  const isCompact = variant === "compact";

  return (
    <div
      className={`chb ${isCompact ? "chb-compact" : "chb-full"}`}
      style={{ background: p.bg, borderColor: p.border, color: p.fg }}
      title={data.message}
    >
      <span className="chb-dot">{p.glyph}</span>
      <span className="chb-label">{p.label}</span>
      <span className="chb-detail">
        max |IC| <strong>{(data.maxAbsIC * 100).toFixed(2)}%</strong>
        {data.topSignal ? ` (${data.topSignal.replace(/_/g, " ")})` : ""}
        &nbsp;•&nbsp; {data.tradeCount} trades
        {data.shouldSuspendLive && !isCompact ? " — live trading auto-suspended" : ""}
      </span>
      {!isCompact && <span className="chb-msg">{data.message}</span>}

      <style>{`
        .chb {
          display: grid;
          align-items: center;
          padding: 10px 14px;
          border: 1px solid var(--border);
          border-radius: 4px;
          font-family: var(--mono);
          font-size: 11px;
          margin-bottom: 14px;
        }
        .chb-full {
          grid-template-columns: auto auto 1fr;
          column-gap: 12px;
          row-gap: 4px;
        }
        .chb-compact {
          grid-template-columns: auto auto 1fr;
          column-gap: 10px;
          padding: 6px 10px;
          font-size: 10px;
          margin-bottom: 8px;
        }
        .chb-dot { font-size: 14px; line-height: 1; }
        .chb-compact .chb-dot { font-size: 11px; }
        .chb-label { font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
        .chb-detail { color: var(--muted); justify-self: end; text-align: right; }
        .chb-msg { grid-column: 1 / -1; color: var(--muted); font-size: 10px; }
        .chb-loading {
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
