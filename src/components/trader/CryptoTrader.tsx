import { useState, useCallback, useEffect, useRef } from "react";
import CalibrationHealthBadge from "../shared/CalibrationHealthBadge";

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

// Per-market context returned by /auto-trader run. Mirrors the
// `marketContext` the backend builds for every scanned market — every field
// is optional because some result rows (e.g. "already has open position",
// "buy order failed") only carry a partial picture.
interface ScanResult {
  market: string;
  title?: string;
  action: "skip" | "position_opened" | "failed" | "error" | "traded";
  reason?: string;
  error?: string;
  marketPrice?: number;
  predictedProb?: number;
  edge?: number;
  netEdge?: number;
  direction?: "YES" | "NO";
  kelly?: number;
  kellyUsed?: number;
  activeSignals?: number;
  signalBreakdown?: {
    funding_rate?: number | null;
    orderflow?: number | null;
    vol_divergence?: number | null;
    apex_consensus?: number | null;
    cond_prob?: number | null;
  } | null;
  obImbalance?: { ratio: number; direction: "UP" | "DOWN" | "NEUTRAL" } | null;
  endDate?: string;
  entry?: number;
  size?: number;
  pnl?: number;
  paperMode?: boolean;
}

interface DroppedMarket {
  slug: string;
  title: string;
  currentPrice: number;
  volume24h: number;
  endDate: string;
  reason: string;
}

interface RunResult {
  ok: boolean;
  action: string;
  paperMode?: boolean;
  marketsScanned?: number;
  marketsConsidered?: number;
  results?: ScanResult[];
  droppedMarkets?: DroppedMarket[];
  config?: {
    edgeThreshold:    number;
    maxKellyFraction: number;
    cooldownSeconds:  number;
    sessionLossLimit: number;
    minOpenInterest:  number;
    roundtripFeePct:  number;
    paperMode:        boolean;
    btcTpTarget:      number;
    btcSlTarget:      number;
    btcMinPriceBand:  number;
    btcEntryWindowStartMs: number;
    btcEntryWindowEndMs:   number;
  };
  session?: SessionSummary;
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
  lastResult: RunResult | null;
}

interface StatusResponse {
  ok: boolean;
  category: string;
  session: SessionSummary;
  recentLogs: any[];
  runStatus?: RunStatus;
  cronEnabled?: boolean;
}

function formatAge(sec: number | null): string {
  if (sec === null || sec < 0) return "—";
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function pct(v: number | undefined, digits = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

// Render a single signal score as an arrow (↑ if > 0.5, ↓ if < 0.5, · if null).
function signalArrow(name: string, score: number | null | undefined): string {
  const short = ({
    funding_rate: "FR",
    orderflow: "VPIN",
    vol_divergence: "VOL",
    apex_consensus: "APEX",
    cond_prob: "CP",
  } as Record<string, string>)[name] || name.toUpperCase();
  if (score === null || score === undefined) return `${short}·`;
  return `${short}${score > 0.5 ? "↑" : "↓"}`;
}

export default function CryptoTrader() {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  // Bumped after every state-changing action so the badge re-fetches fresh
  // calibration data once a new trade closes.
  const [healthRefresh, setHealthRefresh] = useState(0);
  // tick state forces re-render every second so the relative timestamp ages
  const [, setTick] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollStatus = useCallback(async () => {
    try {
      const r = await fetch(`${FN}?action=status&category=crypto`);
      const j: StatusResponse = await r.json();
      setStatus(j);
      if (j.session) setSession(j.session);
    } catch {}
  }, []);

  useEffect(() => {
    pollStatus();
    pollRef.current = setInterval(() => {
      pollStatus();
      setTick((t) => t + 1);
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollStatus]);

  // Re-render once a second so "X minutes ago" stays current without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
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
        body: JSON.stringify({ action, category: "crypto" }),
      });
      const data: RunResult = await res.json();
      setLastRun(data);
      if (data.session) setSession(data.session);
      if (!data.ok) setError(data.error || "Unknown error");
      setHealthRefresh((n) => n + 1);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      pollStatus();
    }
  }, [pollStatus]);

  const pnlColor = (v: number) => (v >= 0 ? "var(--accent)" : "var(--danger)");
  const pnlSign  = (v: number) => (v >= 0 ? "+" : "");

  const rs = status?.runStatus;
  const isRunning = loading || (rs?.isRunning ?? false);
  const lastSrc   = rs?.source ?? null;
  const cronOn    = !!status?.cronEnabled;
  const ageSec    = rs?.lastRunAt
    ? Math.floor((Date.now() - new Date(rs.lastRunAt).getTime()) / 1000)
    : null;

  // Display: a fresh manual run takes priority; otherwise show what the
  // server last persisted (which includes background cron runs).
  const display: RunResult | null = lastRun ?? rs?.lastResult ?? null;

  return (
    <div className="ct-wrap">
      <div className="ct-header">
        <h2 className="ct-title">Crypto Auto-Trader</h2>
        {session && (
          <span className={`ct-mode ${session.paperMode ? "ct-paper" : "ct-live"}`}>
            {session.paperMode ? "PAPER" : "LIVE"}
          </span>
        )}
        <div className="ct-status-cluster">
          <div className={`ct-pill ct-pill-${isRunning ? "live" : "idle"}`}>
            <span className="ct-pill-dot" />
            {isRunning ? `Scanning… (${rs?.source ?? "manual"})` : "Idle"}
          </div>
          <div className={`ct-pill ct-pill-${cronOn ? "cron-on" : "cron-off"}`} title="Configured in netlify.toml (auto-trader */3 * * * *)">
            cron {cronOn ? "ON · 3 min" : "OFF"}
          </div>
          <div className="ct-pill ct-pill-mute" title={rs?.lastRunAt || "no runs yet"}>
            last {lastSrc ? `(${lastSrc})` : ""}: {formatAge(ageSec)}
          </div>
        </div>
      </div>

      {/* Calibration health — paper signal verdict, fetched from edge-tracker.
          Lives at the top so the operator sees noise/calibrated status before
          deciding to Run / go live. Auto-refreshes after every action. */}
      <CalibrationHealthBadge
        category="crypto"
        days="30"
        variant="compact"
        refreshKey={healthRefresh}
      />

      <div className="ct-info">
        BTC short markets (5m / 15m up/down) · signal-combiner: funding · orderflow · vol-div · apex · cond-prob · OB-imbalance gate
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
        <button className="ct-btn ct-btn-primary" onClick={() => doAction("run")} disabled={isRunning}>
          {isRunning ? "Scanning..." : "Run Scan"}
        </button>
        <button className="ct-btn ct-btn-secondary" onClick={() => doAction("reset")} disabled={isRunning}>
          Reset
        </button>
        <button className="ct-btn ct-btn-danger" onClick={() => doAction("stop")} disabled={isRunning}>
          Stop
        </button>
        <button className="ct-btn ct-btn-secondary" onClick={pollStatus} disabled={isRunning}>
          Refresh
        </button>
      </div>

      {error && <div className="ct-error">{error}</div>}

      {display && (display.results || display.reason) && (
        <div className="ct-results">
          <h3 className="ct-results-title">
            {display.action === "skipped"
              ? `Skipped: ${display.reason}`
              : `Scanned ${display.marketsScanned ?? 0} BTC up/down markets · evaluated top ${display.marketsConsidered ?? Math.min(display.marketsScanned ?? 0, 3)}`}
            {display.source && <span className="ct-src">via {display.source}</span>}
          </h3>

          {display.config && (
            <div className="ct-cfgline">
              edge≥{pct(display.config.edgeThreshold)}, kelly≤{pct(display.config.maxKellyFraction)},
              SL@{(display.config.btcSlTarget * 100).toFixed(0)}¢ · TP@{(display.config.btcTpTarget * 100).toFixed(0)}¢,
              entry-band [{pct(display.config.btcMinPriceBand, 0)}, {pct(1 - display.config.btcMinPriceBand, 0)}],
              fees {pct(display.config.roundtripFeePct, 1)}
            </div>
          )}

          {display.results?.map((r: ScanResult, i: number) => (
            <ScanResultRow key={`${r.market}-${i}`} r={r} />
          ))}

          {display.droppedMarkets && display.droppedMarkets.length > 0 && (
            <details className="ct-dropped">
              <summary>
                {display.droppedMarkets.length} further BTC market{display.droppedMarkets.length === 1 ? "" : "s"} below the top 3 (not evaluated this tick)
              </summary>
              <div className="ct-dropped-list">
                {display.droppedMarkets.map((d, i) => (
                  <div key={i} className="ct-dropped-row">
                    <span className="ct-dropped-reason">{d.reason}</span>
                    <span className="ct-dropped-title">{d.title}</span>
                    <span className="ct-dropped-price">{(d.currentPrice * 100).toFixed(0)}¢</span>
                    <span className="ct-dropped-vol">${Math.round(d.volume24h).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <style>{styles}</style>
    </div>
  );
}

// Renders one market row in the scan results: market, action chip, prediction
// summary, signal arrows, and the decision reason or trade size depending on
// the action.
function ScanResultRow({ r }: { r: ScanResult }) {
  const dirColor =
    r.direction === "YES" ? "var(--accent)" :
    r.direction === "NO"  ? "var(--danger)" :
    "var(--muted)";
  const edgeColor =
    r.netEdge !== undefined && r.netEdge >= 0.05 ? "var(--accent)" :
    r.netEdge !== undefined && r.netEdge >= 0    ? "var(--warn)"   :
    "var(--danger)";
  return (
    <div className="ct-result-row">
      <div className="ct-result-market">
        <div className="ct-result-title" title={r.market}>
          {r.title || r.market}
        </div>
        <div className="ct-result-meta">
          {r.marketPrice !== undefined && (
            <span className="ct-meta-pill">mp {(r.marketPrice * 100).toFixed(0)}¢</span>
          )}
          {r.predictedProb !== undefined && (
            <span className="ct-meta-pill">model {(r.predictedProb * 100).toFixed(0)}%</span>
          )}
          {r.netEdge !== undefined && (
            <span className="ct-meta-pill" style={{ color: edgeColor }}>
              edge {r.netEdge >= 0 ? "+" : ""}{(r.netEdge * 100).toFixed(1)}%
            </span>
          )}
          {r.direction && (
            <span className="ct-meta-pill" style={{ color: dirColor, borderColor: dirColor }}>
              {r.direction}
            </span>
          )}
          {r.kellyUsed !== undefined && r.kellyUsed > 0 && (
            <span className="ct-meta-pill">kelly {(r.kellyUsed * 100).toFixed(1)}%</span>
          )}
          {r.activeSignals !== undefined && (
            <span className="ct-meta-pill">{r.activeSignals}/5 signals</span>
          )}
          {r.obImbalance && (
            <span
              className="ct-meta-pill"
              title={`Binance top-10 bid/ask = ${r.obImbalance.ratio.toFixed(2)}`}
            >
              OB {r.obImbalance.direction === "UP" ? "↑" :
                  r.obImbalance.direction === "DOWN" ? "↓" : "·"}
            </span>
          )}
        </div>
        {r.signalBreakdown && (
          <div className="ct-result-signals">
            {(["funding_rate", "orderflow", "vol_divergence", "apex_consensus", "cond_prob"] as const).map((name) => (
              <span
                key={name}
                className={`ct-sig ${(r.signalBreakdown as any)?.[name] === null || (r.signalBreakdown as any)?.[name] === undefined ? "ct-sig-off" : ""}`}
              >
                {signalArrow(name, (r.signalBreakdown as any)?.[name])}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className={`ct-result-action ct-action-${r.action}`}>
        {r.action.replace(/_/g, " ")}
      </span>
      {r.action === "position_opened" && r.entry !== undefined && (
        <span className="ct-result-size">
          ${r.size?.toFixed(2)} @ {(r.entry * 100).toFixed(0)}¢
        </span>
      )}
      {r.pnl !== undefined && (
        <span
          className="ct-result-pnl"
          style={{ color: r.pnl >= 0 ? "var(--accent)" : "var(--danger)" }}
        >
          {r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)}
        </span>
      )}
      {(r.reason || r.error) && (
        <div className="ct-reason">{r.reason || r.error}</div>
      )}
    </div>
  );
}

const styles = `
.ct-wrap { max-width: 760px; margin: 0 auto; padding: 1.5rem 1rem; }
.ct-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }
.ct-title { font-family: var(--sans); font-size: 1.25rem; color: var(--text); margin: 0; }
.ct-mode {
  font-family: var(--mono); font-size: 0.65rem; padding: 2px 8px;
  border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;
}
.ct-paper { background: var(--warn); color: var(--bg); }
.ct-live  { background: var(--danger); color: #fff; }

.ct-status-cluster { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ct-pill {
  font-family: var(--mono); font-size: 0.62rem;
  padding: 3px 8px; border-radius: 12px;
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); background: var(--surface);
  text-transform: uppercase; letter-spacing: .04em;
}
.ct-pill-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.ct-pill-live { color: var(--accent); border-color: var(--accent); }
.ct-pill-live .ct-pill-dot { background: var(--accent); animation: ct-pulse 1.4s ease-in-out infinite; }
.ct-pill-idle { color: var(--muted); }
.ct-pill-idle .ct-pill-dot { background: var(--muted); }
.ct-pill-cron-on { color: var(--accent2); border-color: var(--accent2); }
.ct-pill-cron-off { color: var(--muted); }
.ct-pill-mute { color: var(--muted); }
@keyframes ct-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.45; transform: scale(1.4); }
}

.ct-info {
  font-family: var(--mono); font-size: 0.7rem; color: var(--muted);
  margin-bottom: 1rem; padding: 0.6rem 0.75rem;
  background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
}

.ct-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin-bottom: 1rem; }
.ct-stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; text-align: center; }
.ct-stat-label { display: block; font-family: var(--mono); font-size: 0.6rem; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
.ct-stat-value { font-family: var(--mono); font-size: 1.1rem; color: var(--text); }
.ct-stopped { grid-column: 1 / -1; background: var(--danger); color: #fff; padding: 0.5rem; border-radius: 6px; font-family: var(--mono); font-size: 0.75rem; text-align: center; }

.ct-controls { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
.ct-btn { font-family: var(--mono); font-size: 0.75rem; padding: 0.5rem 1rem; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; transition: opacity 0.15s; }
.ct-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ct-btn-primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.ct-btn-secondary { background: var(--surface); color: var(--text); }
.ct-btn-danger { background: transparent; color: var(--danger); border-color: var(--danger); }

.ct-error { background: rgba(241,53,53,0.1); border: 1px solid var(--danger); border-radius: 6px; padding: 0.75rem; color: var(--danger); font-family: var(--mono); font-size: 0.75rem; margin-bottom: 1rem; }

.ct-results { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
.ct-results-title { font-family: var(--sans); font-size: 0.85rem; color: var(--muted); margin: 0 0 0.5rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.ct-src { font-family: var(--mono); font-size: 0.6rem; color: var(--muted); background: var(--surface2); padding: 2px 6px; border-radius: 3px; }
.ct-cfgline { font-family: var(--mono); font-size: 0.6rem; color: var(--muted); margin-bottom: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }

.ct-result-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--border);
  font-family: var(--mono);
  font-size: 0.7rem;
}
.ct-result-row:last-child { border-bottom: none; }
.ct-result-market { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ct-result-title { color: var(--text); font-weight: 600; font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-result-meta { display: flex; flex-wrap: wrap; gap: 4px; }
.ct-meta-pill {
  font-size: 0.6rem; padding: 1px 6px; border-radius: 3px;
  background: var(--surface2); color: var(--text);
  border: 1px solid var(--border);
}
.ct-result-signals { display: flex; gap: 6px; flex-wrap: wrap; }
.ct-sig { color: var(--accent2); font-size: 0.6rem; }
.ct-sig-off { color: var(--muted); opacity: 0.5; }
.ct-result-action { text-transform: uppercase; font-size: 0.6rem; padding: 2px 7px; border-radius: 3px; align-self: start; }
.ct-action-traded { background: var(--accent); color: var(--bg); }
.ct-action-position_opened { background: var(--accent2); color: var(--bg); }
.ct-action-skip { background: var(--surface2); color: var(--muted); }
.ct-action-error, .ct-action-failed { background: var(--danger); color: #fff; }
.ct-result-size { font-family: var(--mono); font-size: 0.65rem; color: var(--accent2); align-self: start; }
.ct-result-pnl { font-weight: 600; align-self: start; }
.ct-reason { grid-column: 1 / -1; color: var(--muted); font-size: 0.6rem; padding-top: 4px; }

.ct-dropped { margin-top: 1rem; font-family: var(--mono); font-size: 0.65rem; }
.ct-dropped summary { cursor: pointer; color: var(--muted); padding: 0.5rem 0; }
.ct-dropped summary:hover { color: var(--text); }
.ct-dropped-list { display: flex; flex-direction: column; gap: 4px; padding-top: 6px; }
.ct-dropped-row { display: grid; grid-template-columns: 110px 1fr 50px 80px; align-items: center; gap: 8px; padding: 4px 0; }
.ct-dropped-reason { padding: 1px 5px; border-radius: 3px; background: var(--surface2); color: var(--warn); font-size: 0.55rem; text-transform: uppercase; text-align: center; }
.ct-dropped-title { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-dropped-price { color: var(--accent2); text-align: right; }
.ct-dropped-vol { color: var(--muted); text-align: right; }

@media (max-width: 500px) {
  .ct-stats { grid-template-columns: repeat(2, 1fr); }
  .ct-result-row { grid-template-columns: 1fr; }
  .ct-result-action, .ct-result-size, .ct-result-pnl { align-self: auto; }
}
`;
