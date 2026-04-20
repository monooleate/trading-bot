import { useState, useCallback, useEffect } from "react";

const FN = "/.netlify/functions/auto-trader-api";

interface SessionSummary {
  paperMode: boolean;
  stopped: boolean;
  stoppedReason: string | null;
  bankrollStart: number;
  bankrollCurrent: number;
  sessionPnL: number;
  sessionLoss: number;
  tradeCount: number;
  openPositions: number;
  startedAt: string;
}

interface RunResult {
  ok: boolean;
  action: string;
  paperMode?: boolean;
  marketsScanned?: number;
  results?: any[];
  session?: SessionSummary;
  reason?: string;
  error?: string;
}

export default function CryptoTrader() {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${FN}?action=status`);
      const data = await res.json();
      if (data.ok) setSession(data.session);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const doAction = useCallback(async (action: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data: RunResult = await res.json();
      setLastRun(data);
      if (data.session) setSession(data.session);
      if (!data.ok) setError(data.error || "Unknown error");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const pnlColor = (v: number) => v >= 0 ? "var(--accent)" : "var(--danger)";
  const pnlSign = (v: number) => v >= 0 ? "+" : "";

  return (
    <div className="ct-wrap">
      <div className="ct-header">
        <h2 className="ct-title">Crypto Auto-Trader</h2>
        {session && (
          <span className={`ct-mode ${session.paperMode ? "ct-paper" : "ct-live"}`}>
            {session.paperMode ? "PAPER" : "LIVE"}
          </span>
        )}
      </div>

      {/* Session stats */}
      {session && (
        <div className="ct-stats">
          <div className="ct-stat">
            <span className="ct-stat-label">Bankroll</span>
            <span className="ct-stat-value">${session.bankrollCurrent.toFixed(2)}</span>
          </div>
          <div className="ct-stat">
            <span className="ct-stat-label">Session PnL</span>
            <span className="ct-stat-value" style={{ color: pnlColor(session.sessionPnL) }}>
              {pnlSign(session.sessionPnL)}${session.sessionPnL.toFixed(2)}
            </span>
          </div>
          <div className="ct-stat">
            <span className="ct-stat-label">Trades</span>
            <span className="ct-stat-value">{session.tradeCount}</span>
          </div>
          <div className="ct-stat">
            <span className="ct-stat-label">Open</span>
            <span className="ct-stat-value">{session.openPositions}</span>
          </div>
          {session.stopped && (
            <div className="ct-stopped">
              Stopped: {session.stoppedReason}
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="ct-controls">
        <button className="ct-btn ct-btn-primary" onClick={() => doAction("run")} disabled={loading}>
          {loading ? "Running..." : "Run Scan"}
        </button>
        <button className="ct-btn ct-btn-secondary" onClick={() => doAction("reset")} disabled={loading}>
          Reset
        </button>
        <button className="ct-btn ct-btn-danger" onClick={() => doAction("stop")} disabled={loading}>
          Stop
        </button>
        <button className="ct-btn ct-btn-secondary" onClick={fetchStatus} disabled={loading}>
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && <div className="ct-error">{error}</div>}

      {/* Last run results */}
      {lastRun && lastRun.results && (
        <div className="ct-results">
          <h3 className="ct-results-title">
            Last Run: {lastRun.marketsScanned || 0} markets scanned
          </h3>
          {lastRun.results.map((r: any, i: number) => (
            <div key={i} className="ct-result-row">
              <span className="ct-result-market">{r.market}</span>
              <span className={`ct-result-action ct-action-${r.action}`}>{r.action}</span>
              {r.pnl !== undefined && (
                <span className="ct-result-pnl" style={{ color: pnlColor(r.pnl) }}>
                  {pnlSign(r.pnl)}${r.pnl.toFixed(2)}
                </span>
              )}
              {r.reason && <span className="ct-result-reason">{r.reason}</span>}
            </div>
          ))}
        </div>
      )}

      <style>{`
        .ct-wrap {
          max-width: 700px;
          margin: 0 auto;
          padding: 1.5rem 1rem;
        }
        .ct-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          margin-bottom: 1.5rem;
        }
        .ct-title {
          font-family: var(--sans);
          font-size: 1.25rem;
          color: var(--text);
          margin: 0;
        }
        .ct-mode {
          font-family: var(--mono);
          font-size: 0.65rem;
          padding: 2px 8px;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .ct-paper { background: var(--warn); color: var(--bg); }
        .ct-live  { background: var(--danger); color: #fff; }
        .ct-stats {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 0.75rem;
          margin-bottom: 1.5rem;
        }
        .ct-stat {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 0.75rem;
          text-align: center;
        }
        .ct-stat-label {
          display: block;
          font-family: var(--mono);
          font-size: 0.6rem;
          color: var(--muted);
          text-transform: uppercase;
          margin-bottom: 4px;
        }
        .ct-stat-value {
          font-family: var(--mono);
          font-size: 1.1rem;
          color: var(--text);
        }
        .ct-stopped {
          grid-column: 1 / -1;
          background: var(--danger);
          color: #fff;
          padding: 0.5rem;
          border-radius: 6px;
          font-family: var(--mono);
          font-size: 0.75rem;
          text-align: center;
        }
        .ct-controls {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 1.5rem;
          flex-wrap: wrap;
        }
        .ct-btn {
          font-family: var(--mono);
          font-size: 0.75rem;
          padding: 0.5rem 1rem;
          border: 1px solid var(--border);
          border-radius: 6px;
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .ct-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .ct-btn-primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
        .ct-btn-secondary { background: var(--surface); color: var(--text); }
        .ct-btn-danger { background: transparent; color: var(--danger); border-color: var(--danger); }
        .ct-error {
          background: rgba(241,53,53,0.1);
          border: 1px solid var(--danger);
          border-radius: 6px;
          padding: 0.75rem;
          color: var(--danger);
          font-family: var(--mono);
          font-size: 0.75rem;
          margin-bottom: 1rem;
        }
        .ct-results {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 1rem;
        }
        .ct-results-title {
          font-family: var(--sans);
          font-size: 0.85rem;
          color: var(--muted);
          margin: 0 0 0.75rem;
        }
        .ct-result-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.4rem 0;
          border-bottom: 1px solid var(--border);
          font-family: var(--mono);
          font-size: 0.7rem;
        }
        .ct-result-row:last-child { border-bottom: none; }
        .ct-result-market { color: var(--text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ct-result-action { text-transform: uppercase; font-size: 0.6rem; padding: 1px 6px; border-radius: 3px; }
        .ct-action-traded { background: var(--accent); color: var(--bg); }
        .ct-action-skip { background: var(--surface2); color: var(--muted); }
        .ct-action-error { background: var(--danger); color: #fff; }
        .ct-action-position_opened { background: var(--accent2); color: var(--bg); }
        .ct-result-pnl { font-weight: 600; }
        .ct-result-reason { color: var(--muted); font-size: 0.6rem; flex-shrink: 0; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        @media (max-width: 500px) {
          .ct-stats { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>
    </div>
  );
}
