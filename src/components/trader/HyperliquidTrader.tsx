import { useState, useCallback, useEffect, useRef } from "react";

const FN = "/.netlify/functions/auto-trader-api";

interface HlSessionSummary {
  paperMode:         boolean;
  stopped:           boolean;
  stoppedReason:     string | null;
  pausedUntil:       string | null;
  bankrollStart:     number;
  bankrollCurrent:   number;
  sessionPnL:        number;
  sessionLoss:       number;
  tradeCount:        number;
  openPositions:     number;
  consecutiveLosses: number;
  startedAt:         string;
}

interface HlRunResult {
  ok: boolean;
  action: string;
  paperMode?: boolean;
  coinsScanned?: number;
  results?: any[];
  session?: HlSessionSummary;
  reason?: string;
  error?: string;
  source?: "manual" | "cron";
}

interface HlRunStatus {
  isRunning: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  source: "manual" | "cron" | null;
  ageSec: number | null;
  lastResult: any | null;
}

function formatAge(sec: number | null): string {
  if (sec === null || sec < 0) return "—";
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function HyperliquidTrader() {
  const [session, setSession] = useState<HlSessionSummary | null>(null);
  const [lastRun, setLastRun] = useState<HlRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<HlRunStatus | null>(null);
  const [cronEnabled, setCronEnabled] = useState<boolean>(true);
  // tick state forces re-render every second so the relative timestamp ages
  const [, setTick] = useState(0);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${FN}?action=status&category=hyperliquid`);
      const data = await res.json();
      if (data.ok) {
        setSession(data.session);
        if (data.runStatus) setRunStatus(data.runStatus);
        if (typeof data.cronEnabled === "boolean") setCronEnabled(data.cronEnabled);
      }
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    // Poll every 5s so cron-driven runs appear without a manual refresh.
    pollRef.current = setInterval(() => {
      fetchStatus();
      setTick(t => t + 1);
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  // Re-render once a second so "X minutes ago" stays current locally
  // without re-fetching the API.
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const doAction = useCallback(async (action: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(FN, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, category: "hyperliquid" }),
      });
      const data: HlRunResult = await res.json();
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
  const pnlSign  = (v: number) => v >= 0 ? "+" : "";

  const isRunning = loading || (runStatus?.isRunning ?? false);
  const lastSrc = runStatus?.source ?? null;
  const ageSec = runStatus?.lastRunAt
    ? Math.floor((Date.now() - new Date(runStatus.lastRunAt).getTime()) / 1000)
    : null;

  return (
    <div className="hl-wrap">
      <div className="hl-header">
        <h2 className="hl-title">Hyperliquid Perp Trader</h2>
        {session && (
          <span className={`hl-mode ${session.paperMode ? "hl-paper" : "hl-live"}`}>
            {session.paperMode ? "TESTNET" : "MAINNET"}
          </span>
        )}
        <div className="hl-status-cluster">
          <div className={`hl-pill hl-pill-${isRunning ? "live" : "idle"}`}>
            <span className="hl-pill-dot" />
            {isRunning ? `Scanning… (${runStatus?.source ?? "manual"})` : "Idle"}
          </div>
          <div className={`hl-pill hl-pill-${cronEnabled ? "cron-on" : "cron-off"}`}
               title="Driven by auto-trader-multi-cron, every 3 min">
            cron {cronEnabled ? "ON · 3 min" : "OFF"}
          </div>
          <div className="hl-pill hl-pill-mute" title={runStatus?.lastRunAt || "no runs yet"}>
            last {lastSrc ? `(${lastSrc})` : ""}: {formatAge(ageSec)}
          </div>
        </div>
      </div>

      <div className="hl-sub">
        Perp execution engine • BTC / ETH / SOL • signals reused from Polymarket combiner
      </div>

      {/* Session stats */}
      {session && (
        <div className="hl-stats">
          <div className="hl-stat">
            <span className="hl-stat-label">Bankroll</span>
            <span className="hl-stat-value">${session.bankrollCurrent.toFixed(2)}</span>
          </div>
          <div className="hl-stat">
            <span className="hl-stat-label">Session PnL</span>
            <span className="hl-stat-value" style={{ color: pnlColor(session.sessionPnL) }}>
              {pnlSign(session.sessionPnL)}${session.sessionPnL.toFixed(2)}
            </span>
          </div>
          <div className="hl-stat">
            <span className="hl-stat-label">Trades</span>
            <span className="hl-stat-value">{session.tradeCount}</span>
          </div>
          <div className="hl-stat">
            <span className="hl-stat-label">Open</span>
            <span className="hl-stat-value">{session.openPositions}</span>
          </div>
          <div className="hl-stat">
            <span className="hl-stat-label">Loss Streak</span>
            <span className="hl-stat-value" style={{ color: session.consecutiveLosses >= 2 ? "var(--warn)" : "var(--text)" }}>
              {session.consecutiveLosses}
            </span>
          </div>
          {session.pausedUntil && (
            <div className="hl-paused">
              Paused until {new Date(session.pausedUntil).toLocaleTimeString()} (consecutive losses)
            </div>
          )}
          {session.stopped && (
            <div className="hl-stopped">
              Stopped: {session.stoppedReason}
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="hl-controls">
        <button className="hl-btn hl-btn-primary" onClick={() => doAction("run")} disabled={isRunning}>
          {loading ? "Running..." : "Run Scan"}
        </button>
        <button className="hl-btn hl-btn-secondary" onClick={() => doAction("reset")} disabled={isRunning}>
          Reset
        </button>
        {session?.stopped || session?.pausedUntil ? (
          <button className="hl-btn hl-btn-secondary" onClick={() => doAction("resume")} disabled={isRunning}>
            Resume
          </button>
        ) : (
          <button className="hl-btn hl-btn-danger" onClick={() => doAction("stop")} disabled={isRunning}>
            Stop
          </button>
        )}
        <button className="hl-btn hl-btn-secondary" onClick={fetchStatus} disabled={isRunning}>
          Refresh
        </button>
      </div>

      {error && <div className="hl-error">{error}</div>}

      {/* Last run results */}
      {lastRun && lastRun.results && (
        <div className="hl-results">
          <h3 className="hl-results-title">
            Last Run: {lastRun.coinsScanned || 0} coins scanned
          </h3>
          {lastRun.results.map((r: any, i: number) => (
            <div key={i} className="hl-result-row">
              <span className="hl-result-coin">{r.coin}</span>
              {r.direction && (
                <span className={`hl-result-dir ${r.direction === "LONG" ? "hl-long" : "hl-short"}`}>
                  {r.direction}
                </span>
              )}
              <span className={`hl-result-action hl-action-${r.action}`}>{r.action}</span>
              {r.entry && (
                <span className="hl-result-entry">@${r.entry.toFixed(2)}</span>
              )}
              {r.pnl !== undefined && (
                <span className="hl-result-pnl" style={{ color: pnlColor(r.pnl) }}>
                  {pnlSign(r.pnl)}${r.pnl.toFixed(2)}
                </span>
              )}
              {r.reason && <span className="hl-result-reason">{r.reason}</span>}
            </div>
          ))}
        </div>
      )}

      <style>{`
        .hl-wrap { max-width: 760px; margin: 0 auto; padding: 1.5rem 1rem; }
        .hl-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.25rem; flex-wrap: wrap; }
        .hl-status-cluster { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .hl-pill {
          font-family: var(--mono); font-size: 0.62rem;
          padding: 3px 8px; border-radius: 12px;
          display: inline-flex; align-items: center; gap: 5px;
          border: 1px solid var(--border); background: var(--surface);
          text-transform: uppercase; letter-spacing: .04em;
        }
        .hl-pill-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
        .hl-pill-live { color: var(--accent); border-color: var(--accent); }
        .hl-pill-live .hl-pill-dot { background: var(--accent); animation: hl-pulse 1.4s ease-in-out infinite; }
        .hl-pill-idle { color: var(--muted); }
        .hl-pill-cron-on { color: var(--accent2); border-color: var(--accent2); }
        .hl-pill-cron-off { color: var(--muted); }
        .hl-pill-mute { color: var(--muted); }
        @keyframes hl-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.45; transform: scale(1.4); }
        }
        .hl-title { font-family: var(--sans); font-size: 1.25rem; color: var(--text); margin: 0; }
        .hl-sub { font-family: var(--mono); font-size: 0.7rem; color: var(--muted); margin-bottom: 1.5rem; letter-spacing: 0.05em; }
        .hl-mode { font-family: var(--mono); font-size: 0.65rem; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
        .hl-paper { background: var(--warn); color: var(--bg); font-weight: 700; }
        .hl-live  { background: var(--danger); color: #fff; font-weight: 700; }
        .hl-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.5rem; margin-bottom: 1.25rem; }
        .hl-stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem; text-align: center; }
        .hl-stat-label { display: block; font-family: var(--mono); font-size: 0.55rem; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.08em; }
        .hl-stat-value { font-family: var(--mono); font-size: 1rem; color: var(--text); }
        .hl-stopped { grid-column: 1 / -1; background: var(--danger); color: #fff; padding: 0.5rem; border-radius: 6px; font-family: var(--mono); font-size: 0.7rem; text-align: center; }
        .hl-paused { grid-column: 1 / -1; background: var(--warn); color: var(--bg); padding: 0.5rem; border-radius: 6px; font-family: var(--mono); font-size: 0.7rem; text-align: center; }
        .hl-controls { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
        .hl-btn { font-family: var(--mono); font-size: 0.7rem; padding: 0.5rem 1rem; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; transition: opacity 0.15s; letter-spacing: 0.05em; text-transform: uppercase; }
        .hl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .hl-btn-primary { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 700; }
        .hl-btn-secondary { background: var(--surface); color: var(--text); }
        .hl-btn-danger { background: transparent; color: var(--danger); border-color: var(--danger); }
        .hl-error { background: rgba(241,53,53,0.1); border: 1px solid var(--danger); border-radius: 6px; padding: 0.75rem; color: var(--danger); font-family: var(--mono); font-size: 0.75rem; margin-bottom: 1rem; }
        .hl-results { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
        .hl-results-title { font-family: var(--sans); font-size: 0.85rem; color: var(--muted); margin: 0 0 0.75rem; }
        .hl-result-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 0.72rem; flex-wrap: wrap; }
        .hl-result-row:last-child { border-bottom: none; }
        .hl-result-coin { font-weight: 700; color: var(--accent); min-width: 40px; }
        .hl-result-dir { font-size: 0.6rem; padding: 1px 6px; border-radius: 3px; letter-spacing: 0.08em; }
        .hl-long { background: rgba(200,241,53,0.15); color: var(--accent); }
        .hl-short { background: rgba(241,53,53,0.15); color: var(--danger); }
        .hl-result-action { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; }
        .hl-action-traded, .hl-action-position_opened { color: var(--accent); }
        .hl-action-skip { color: var(--muted); }
        .hl-action-error { color: var(--danger); }
        .hl-result-entry { color: var(--text); }
        .hl-result-pnl { font-weight: 700; margin-left: auto; }
        .hl-result-reason { color: var(--muted); font-size: 0.65rem; margin-left: auto; }
        @media (max-width: 600px) { .hl-stats { grid-template-columns: repeat(2, 1fr); } }
      `}</style>
    </div>
  );
}
