import { useState, useCallback, useEffect, useRef } from "react";
import LiveReadinessBadge from "../shared/LiveReadinessBadge";

const FN = "/.netlify/functions/auto-trader-api";

interface RunResult {
  ok: boolean;
  action: string;
  category?: string;
  paperMode?: boolean;
  marketsScanned?: number;
  modelLag?: { age: number; hasLag: boolean };
  results?: any[];
  droppedEvents?: { slug: string; title: string; reason: string; vol24h: number }[];
  config?: {
    edgeThreshold: number;
    confidenceMin: number;
    maxEdgeCap: number;
    applyCityOffset: boolean;
    useEnsemble: boolean;
  };
  session?: any;
  reason?: string;
  error?: string;
  source?: "manual" | "cron";
  startedAt?: string;
  finishedAt?: string;
}

interface RunStatus {
  isRunning: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  source: "manual" | "cron" | null;
  ageSec: number | null;
  lastResult: any | null;
}

interface PendingPosition {
  market: string;
  city: string;
  date: string;
  bucket: string;
  direction: "YES" | "NO";
  size: number;
  predictedMaxC: number;
  reconcileAfter: string;
  isReady: boolean;
}

interface PendingResponse {
  count: number;
  nextReconcileAt: string | null;
  positions: PendingPosition[];
}

interface StatusResponse {
  ok: boolean;
  category: string;
  session: any;
  recentLogs: any[];
  runStatus?: RunStatus;
  cronEnabled?: boolean;
  pending?: PendingResponse;
}

function formatAge(sec: number | null): string {
  if (sec === null || sec < 0) return "—";
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "ready";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `in ${sec}s`;
  if (sec < 3600) return `in ${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `in ${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `in ${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export default function WeatherTrader() {
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  // tick state forces re-render every second so the relative timestamp ages
  const [, setTick] = useState(0);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Poll status every 5s while we're not actively running, every 1.5s while
  // a manual run is in flight (so the spinner clears promptly), and re-run
  // a status pull right after any user action.
  const pollStatus = useCallback(async () => {
    try {
      const r = await fetch(`${FN}?action=status&category=weather`);
      const j: StatusResponse = await r.json();
      setStatus(j);
    } catch {}
  }, []);

  useEffect(() => {
    pollStatus();
    pollRef.current = setInterval(() => {
      pollStatus();
      setTick(t => t + 1);
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollStatus]);

  // Re-render once a second so "X minutes ago" stays current without re-fetching.
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
        body: JSON.stringify({ action, category: "weather" }),
      });
      const data: RunResult = await res.json();
      setLastRun(data);
      if (!data.ok) setError(data.error || "Unknown error");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      pollStatus();
    }
  }, [pollStatus]);

  const doRun = useCallback(() => doAction("run"), [doAction]);

  const rs = status?.runStatus;
  const isRunning = loading || (rs?.isRunning ?? false);
  const lastSrc = rs?.source ?? null;
  const cronOn = !!status?.cronEnabled;
  // Recompute relative time from absolute timestamp on every render so the
  // tick effect above keeps it fresh without re-pulling the API.
  const ageSec = rs?.lastRunAt
    ? Math.floor((Date.now() - new Date(rs.lastRunAt).getTime()) / 1000)
    : null;

  // Display: if a fresh manual run completed in this UI session, show its
  // results. Otherwise fall back to the last persisted run from the server
  // (which includes background cron runs).
  const display: RunResult | null = lastRun ?? (rs?.lastResult as RunResult ?? null);

  return (
    <div className="wt-wrap">
      <div className="wt-header">
        <h2 className="wt-title">Weather Auto-Trader</h2>
        <span className="wt-mode">PAPER</span>
        <div className="wt-status-cluster">
          <div className={`wt-pill wt-pill-${isRunning ? "live" : "idle"}`}>
            <span className="wt-pill-dot" />
            {isRunning ? `Scanning… (${rs?.source ?? "manual"})` : "Idle"}
          </div>
          <div className={`wt-pill wt-pill-${cronOn ? "cron-on" : "cron-off"}`} title="Set in Settings tab">
            cron {cronOn ? "ON · 5 min" : "OFF"}
          </div>
          <div className="wt-pill wt-pill-mute" title={rs?.lastRunAt || "no runs yet"}>
            last {lastSrc ? `(${lastSrc})` : ""}: {formatAge(ageSec)}
          </div>
        </div>
      </div>

      <LiveReadinessBadge category="weather" />

      <div className="wt-info">
        Edge sources: GFS/ECMWF/NOAA blend, 31-member ensemble (opt-in), DEB per-city weights, METAR Fahrenheit rounding
      </div>

      <div className="wt-controls">
        <button className="wt-btn wt-btn-primary" onClick={doRun} disabled={isRunning}>
          {isRunning ? "Scanning..." : "Scan Weather Markets"}
        </button>
        <button className="wt-btn wt-btn-info" onClick={() => doAction("reconcile")} disabled={isRunning}
                title="Force a settlement pass on pending paper positions">
          ⟳ Reconcile pending
        </button>
        <button className="wt-btn" onClick={() => doAction("reset")} disabled={isRunning}>
          Reset
        </button>
        <button className="wt-btn wt-btn-danger" onClick={() => doAction("stop")} disabled={isRunning}>
          Stop
        </button>
      </div>

      {status?.pending && status.pending.count > 0 && (
        <div className="wt-pending">
          <div className="wt-pending-title">
            {status.pending.count} pending paper position{status.pending.count > 1 ? "s" : ""} — awaiting Polymarket settlement
          </div>
          <div className="wt-pending-list">
            {status.pending.positions.map((p, i) => {
              const msUntil = new Date(p.reconcileAfter).getTime() - Date.now();
              return (
                <div key={i} className={`wt-pending-row ${p.isReady ? "ready" : ""}`}>
                  <span className="wt-pending-city">{p.city}</span>
                  <span className="wt-pending-date">{p.date}</span>
                  <span className="wt-pending-bucket">{p.bucket}</span>
                  <span className={`wt-pending-dir wt-pending-dir-${p.direction}`}>{p.direction}</span>
                  <span className="wt-pending-pred">pred {p.predictedMaxC}°C</span>
                  <span className="wt-pending-size">${p.size.toFixed(2)}</span>
                  <span className="wt-pending-when">
                    {p.isReady ? "✓ ready to settle" : formatDuration(msUntil)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="wt-pending-foot">
            Source priority: <strong>Polymarket Gamma</strong> (authoritative) → METAR fallback after 6h
          </div>
        </div>
      )}

      {error && <div className="wt-error">{error}</div>}

      {display && (
        <div className="wt-results">
          <h3 className="wt-results-title">
            {display.action === "skipped"
              ? `Skipped: ${display.reason}`
              : `Scanned ${display.marketsScanned || 0} weather markets`}
            {display.modelLag && (
              <span className="wt-lag">
                Model age: {display.modelLag.age}min
                {display.modelLag.hasLag ? " (lag detected)" : ""}
              </span>
            )}
            {display.source && (
              <span className="wt-src">via {display.source}</span>
            )}
          </h3>

          {display.config && (
            <div className="wt-cfgline">
              edge≥{(display.config.edgeThreshold * 100).toFixed(1)}%, conf≥{(display.config.confidenceMin * 100).toFixed(0)}%, cap≤{(display.config.maxEdgeCap * 100).toFixed(0)}%
              {" · "}city_offset {display.config.applyCityOffset ? "ON" : "OFF"}
              {" · "}ensemble {display.config.useEnsemble ? "ON" : "OFF"}
            </div>
          )}

          {display.results?.map((r: any, i: number) => (
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

          {display.droppedEvents && display.droppedEvents.length > 0 && (
            <details className="wt-dropped">
              <summary>
                {display.droppedEvents.length} weather-like event dropped (coverage gap or schema issue)
              </summary>
              <div className="wt-dropped-list">
                {display.droppedEvents.map((d, i) => (
                  <div key={i} className="wt-dropped-row">
                    <span className={`wt-dropped-reason wt-dropped-${d.reason}`}>{d.reason}</span>
                    <span className="wt-dropped-title">{d.title}</span>
                    <span className="wt-dropped-vol">${Math.round(d.vol24h).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <style>{`
        .wt-wrap { max-width: 760px; margin: 0 auto; padding: 1.5rem 1rem; }
        .wt-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }
        .wt-title { font-family: var(--sans); font-size: 1.25rem; color: var(--text); margin: 0; }
        .wt-mode {
          font-family: var(--mono); font-size: 0.65rem; padding: 2px 8px;
          border-radius: 4px; background: var(--warn); color: var(--bg);
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .wt-status-cluster { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .wt-pill {
          font-family: var(--mono); font-size: 0.62rem;
          padding: 3px 8px; border-radius: 12px;
          display: inline-flex; align-items: center; gap: 5px;
          border: 1px solid var(--border); background: var(--surface);
          text-transform: uppercase; letter-spacing: .04em;
        }
        .wt-pill-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
        .wt-pill-live { color: var(--accent); border-color: var(--accent); }
        .wt-pill-live .wt-pill-dot { background: var(--accent); animation: wt-pulse 1.4s ease-in-out infinite; }
        .wt-pill-idle { color: var(--muted); }
        .wt-pill-idle .wt-pill-dot { background: var(--muted); }
        .wt-pill-cron-on { color: var(--accent2); border-color: var(--accent2); }
        .wt-pill-cron-off { color: var(--muted); }
        .wt-pill-mute { color: var(--muted); }
        @keyframes wt-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.45; transform: scale(1.4); }
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
        .wt-btn-info { background: transparent; color: var(--accent2); border-color: var(--accent2); }
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
          margin: 0 0 0.5rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
        }
        .wt-cfgline {
          font-family: var(--mono); font-size: 0.6rem; color: var(--muted);
          margin-bottom: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border);
        }
        .wt-lag {
          font-family: var(--mono); font-size: 0.65rem; color: var(--accent2);
          background: var(--surface2); padding: 2px 6px; border-radius: 3px;
        }
        .wt-src {
          font-family: var(--mono); font-size: 0.6rem; color: var(--muted);
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
        .wt-dropped { margin-top: 1rem; font-family: var(--mono); font-size: 0.65rem; }
        .wt-dropped summary { cursor: pointer; color: var(--muted); padding: 0.5rem 0; }
        .wt-dropped summary:hover { color: var(--text); }
        .wt-dropped-list { display: flex; flex-direction: column; gap: 4px; padding-top: 6px; }
        .wt-dropped-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
        .wt-dropped-reason { padding: 1px 5px; border-radius: 3px; background: var(--surface2); color: var(--warn); font-size: 0.55rem; text-transform: uppercase; min-width: 92px; text-align: center; }
        .wt-dropped-no-city-mapped, .wt-dropped-no-station { color: var(--warn); }
        .wt-dropped-expired { color: var(--muted); }
        .wt-dropped-title { flex: 1; color: var(--text); }
        .wt-dropped-vol { color: var(--muted); }
        .wt-pending {
          background: var(--surface); border: 1px solid var(--accent2);
          border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
        }
        .wt-pending-title {
          font-family: var(--mono); font-size: 0.75rem; color: var(--accent2);
          text-transform: uppercase; letter-spacing: .05em; margin-bottom: 0.75rem;
        }
        .wt-pending-list { display: flex; flex-direction: column; gap: 6px; }
        .wt-pending-row {
          display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
          font-family: var(--mono); font-size: 0.7rem;
          padding: 0.5rem; background: var(--surface2); border-radius: 4px;
          border-left: 3px solid var(--accent2);
        }
        .wt-pending-row.ready { border-left-color: var(--accent); }
        .wt-pending-city { font-weight: 600; color: var(--text); text-transform: capitalize; min-width: 90px; }
        .wt-pending-date { color: var(--muted); font-size: 0.6rem; }
        .wt-pending-bucket { background: var(--bg); padding: 1px 6px; border-radius: 3px; color: var(--text); }
        .wt-pending-dir { padding: 1px 6px; border-radius: 3px; font-size: 0.6rem; font-weight: 700; }
        .wt-pending-dir-YES { background: var(--accent); color: var(--bg); }
        .wt-pending-dir-NO  { background: var(--danger); color: #fff; }
        .wt-pending-pred { color: var(--accent2); }
        .wt-pending-size { color: var(--muted); font-weight: 600; margin-left: auto; }
        .wt-pending-when {
          font-family: var(--mono); font-size: 0.65rem; color: var(--warn);
          background: var(--bg); padding: 2px 6px; border-radius: 3px;
        }
        .wt-pending-row.ready .wt-pending-when { color: var(--accent); }
        .wt-pending-foot {
          margin-top: 0.75rem; font-family: var(--mono); font-size: 0.6rem;
          color: var(--muted); text-transform: uppercase; letter-spacing: .04em;
        }
      `}</style>
    </div>
  );
}
