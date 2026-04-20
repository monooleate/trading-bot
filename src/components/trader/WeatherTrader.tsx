import { useState, useCallback, useEffect } from "react";

const FN = "/.netlify/functions/auto-trader-api";

interface RunResult {
  ok: boolean;
  action: string;
  category?: string;
  paperMode?: boolean;
  marketsScanned?: number;
  modelLag?: { age: number; hasLag: boolean };
  results?: any[];
  session?: any;
  reason?: string;
  error?: string;
}

export default function WeatherTrader() {
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doAction = useCallback(async (action: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, category: "weather" }),
      });
      const data: RunResult = await res.json();
      setLastRun(data);
      if (!data.ok) setError(data.error || "Unknown error");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const doRun = useCallback(() => doAction("run"), [doAction]);

  return (
    <div className="wt-wrap">
      <div className="wt-header">
        <h2 className="wt-title">Weather Auto-Trader</h2>
        <span className="wt-mode">PAPER</span>
      </div>

      <div className="wt-info">
        Edge sources: GFS/ECMWF model lag, METAR station offset, Fahrenheit rounding bias
      </div>

      <div className="wt-controls">
        <button className="wt-btn wt-btn-primary" onClick={doRun} disabled={loading}>
          {loading ? "Scanning..." : "Scan Weather Markets"}
        </button>
        <button className="wt-btn" onClick={() => doAction("reset")} disabled={loading}>
          Reset
        </button>
        <button className="wt-btn wt-btn-danger" onClick={() => doAction("stop")} disabled={loading}>
          Stop
        </button>
      </div>

      {error && <div className="wt-error">{error}</div>}

      {lastRun && (
        <div className="wt-results">
          <h3 className="wt-results-title">
            {lastRun.action === "skipped"
              ? `Skipped: ${lastRun.reason}`
              : `Scanned ${lastRun.marketsScanned || 0} weather markets`}
            {lastRun.modelLag && (
              <span className="wt-lag">
                Model age: {lastRun.modelLag.age}min
                {lastRun.modelLag.hasLag ? " (lag detected)" : ""}
              </span>
            )}
          </h3>

          {lastRun.results?.map((r: any, i: number) => (
            <div key={i} className="wt-result-row">
              <div className="wt-result-market">
                {r.city && <span className="wt-city">{r.city}</span>}
                <span className="wt-slug">{r.market}</span>
              </div>
              <span className={`wt-result-action wt-action-${r.action}`}>{r.action}</span>
              {r.predictedTemp !== undefined && (
                <span className="wt-temp">{r.predictedTemp}°C</span>
              )}
              {r.bucket && <span className="wt-bucket">{r.bucket}</span>}
              {r.edge !== undefined && (
                <span className="wt-edge" style={{ color: r.edge > 0 ? "var(--accent)" : "var(--danger)" }}>
                  {(r.edge * 100).toFixed(1)}%
                </span>
              )}
              {r.reason && <div className="wt-reason">{r.reason}</div>}
            </div>
          ))}
        </div>
      )}

      <style>{`
        .wt-wrap { max-width: 700px; margin: 0 auto; padding: 1.5rem 1rem; }
        .wt-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
        .wt-title { font-family: var(--sans); font-size: 1.25rem; color: var(--text); margin: 0; }
        .wt-mode {
          font-family: var(--mono); font-size: 0.65rem; padding: 2px 8px;
          border-radius: 4px; background: var(--warn); color: var(--bg);
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .wt-info {
          font-family: var(--mono); font-size: 0.7rem; color: var(--muted);
          margin-bottom: 1.5rem; padding: 0.75rem;
          background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
        }
        .wt-controls { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
        .wt-btn {
          font-family: var(--mono); font-size: 0.75rem; padding: 0.5rem 1rem;
          border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
        }
        .wt-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .wt-btn-primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
        .wt-btn-danger { background: transparent; color: var(--danger); border-color: var(--danger); }
        .wt-error {
          background: rgba(241,53,53,0.1); border: 1px solid var(--danger);
          border-radius: 6px; padding: 0.75rem; color: var(--danger);
          font-family: var(--mono); font-size: 0.75rem; margin-bottom: 1rem;
        }
        .wt-results {
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 1rem;
        }
        .wt-results-title {
          font-family: var(--sans); font-size: 0.85rem; color: var(--muted);
          margin: 0 0 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
        }
        .wt-lag {
          font-family: var(--mono); font-size: 0.65rem; color: var(--accent2);
          background: var(--surface2); padding: 2px 6px; border-radius: 3px;
        }
        .wt-result-row {
          display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;
          padding: 0.5rem 0; border-bottom: 1px solid var(--border);
          font-family: var(--mono); font-size: 0.7rem;
        }
        .wt-result-row:last-child { border-bottom: none; }
        .wt-result-market { flex: 1; min-width: 150px; }
        .wt-city {
          display: inline-block; font-weight: 600; color: var(--text);
          text-transform: capitalize; margin-right: 6px;
        }
        .wt-slug { color: var(--muted); font-size: 0.6rem; }
        .wt-result-action {
          text-transform: uppercase; font-size: 0.6rem; padding: 1px 6px; border-radius: 3px;
        }
        .wt-action-traded { background: var(--accent); color: var(--bg); }
        .wt-action-skip { background: var(--surface2); color: var(--muted); }
        .wt-action-error { background: var(--danger); color: #fff; }
        .wt-temp { color: var(--accent2); font-weight: 600; }
        .wt-bucket { color: var(--text); background: var(--surface2); padding: 1px 5px; border-radius: 3px; }
        .wt-edge { font-weight: 600; }
        .wt-reason { width: 100%; color: var(--muted); font-size: 0.6rem; padding-left: 0; }
      `}</style>
    </div>
  );
}
