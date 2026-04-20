import { useState, useCallback, useEffect } from "react";

const FN = "/.netlify/functions/auto-trader-api";

interface ArbOpenDetail {
  id:                 string;
  coin:               string;
  sizeUSDC:           number;
  spreadEntry:        number;
  accumulatedFunding: number;
  openedAt:           string;
}

interface ArbSessionSummary {
  paperMode:           boolean;
  stopped:             boolean;
  stoppedReason:       string | null;
  openPositions:       number;
  deployedCapital:     number;
  totalFundingAllTime: number;
  totalFundingToday:   number;
  fundingDate:         string;
  startedAt:           string;
  openDetails:         ArbOpenDetail[];
}

interface OpportunitySnapshot {
  coin:          string;
  spreadHourly:  number;    // in %, already × 100
  annualized:    number;
  viable:        boolean;
  reason:        string;
  openInterestM: number;
}

interface ArbRunResult {
  ok: boolean;
  action: string;
  paperMode?: boolean;
  coinsScanned?: number;
  results?: any[];
  opportunities?: OpportunitySnapshot[];
  session?: ArbSessionSummary;
  reason?: string;
  error?: string;
}

export default function FundingArbPanel() {
  const [session, setSession] = useState<ArbSessionSummary | null>(null);
  const [lastRun, setLastRun] = useState<ArbRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${FN}?action=status&category=hyperliquid&layer=arb`);
      const data = await res.json();
      if (data.ok) setSession(data.session);
    } catch (err: any) { setError(err.message); }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const doAction = useCallback(async (action: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, category: "hyperliquid", layer: "arb" }),
      });
      const data: ArbRunResult = await res.json();
      setLastRun(data);
      if (data.session) setSession(data.session);
      if (!data.ok) setError(data.error || "Unknown error");
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  const pnlColor = (v: number) => v >= 0 ? "var(--accent)" : "var(--danger)";

  return (
    <div className="fa-wrap">
      <div className="fa-header">
        <h2 className="fa-title">Funding Rate Arbitrage</h2>
        {session && (
          <span className={`fa-mode ${session.paperMode ? "fa-paper" : "fa-live"}`}>
            {session.paperMode ? "PAPER" : "LIVE"}
          </span>
        )}
      </div>
      <div className="fa-sub">
        Delta-neutral carry • SHORT Hyperliquid perp + LONG Binance spot
      </div>

      {session && (
        <div className="fa-stats">
          <div className="fa-stat">
            <span className="fa-stat-label">Open</span>
            <span className="fa-stat-value">{session.openPositions}</span>
          </div>
          <div className="fa-stat">
            <span className="fa-stat-label">Deployed</span>
            <span className="fa-stat-value">${session.deployedCapital.toFixed(0)}</span>
          </div>
          <div className="fa-stat">
            <span className="fa-stat-label">Today</span>
            <span className="fa-stat-value" style={{ color: pnlColor(session.totalFundingToday) }}>
              ${session.totalFundingToday.toFixed(2)}
            </span>
          </div>
          <div className="fa-stat">
            <span className="fa-stat-label">All-time</span>
            <span className="fa-stat-value" style={{ color: pnlColor(session.totalFundingAllTime) }}>
              ${session.totalFundingAllTime.toFixed(2)}
            </span>
          </div>
          {session.stopped && (
            <div className="fa-stopped">Stopped: {session.stoppedReason}</div>
          )}
        </div>
      )}

      <div className="fa-controls">
        <button className="fa-btn fa-btn-primary" onClick={() => doAction("run")} disabled={loading}>
          {loading ? "Running..." : "Scan + Run"}
        </button>
        <button className="fa-btn fa-btn-secondary" onClick={() => doAction("reset")} disabled={loading}>Reset</button>
        {session?.stopped
          ? <button className="fa-btn fa-btn-secondary" onClick={() => doAction("resume")} disabled={loading}>Resume</button>
          : <button className="fa-btn fa-btn-danger" onClick={() => doAction("stop")} disabled={loading}>Stop</button>}
        <button className="fa-btn fa-btn-secondary" onClick={fetchStatus} disabled={loading}>Refresh</button>
      </div>

      {error && <div className="fa-error">{error}</div>}

      {/* Open positions */}
      {session && session.openDetails && session.openDetails.length > 0 && (
        <div className="fa-section">
          <h3 className="fa-section-title">Open Positions</h3>
          {session.openDetails.map((p: ArbOpenDetail) => (
            <div key={p.id} className="fa-pos-row">
              <span className="fa-pos-coin">{p.coin}</span>
              <span className="fa-pos-size">${p.sizeUSDC.toFixed(0)}</span>
              <span className="fa-pos-spread">{p.spreadEntry.toFixed(4)}%/h</span>
              <span className="fa-pos-acc" style={{ color: pnlColor(p.accumulatedFunding) }}>
                +${p.accumulatedFunding.toFixed(2)}
              </span>
              <span className="fa-pos-age">{ageString(p.openedAt)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Opportunity snapshot from last run */}
      {lastRun?.opportunities && lastRun.opportunities.length > 0 && (
        <div className="fa-section">
          <h3 className="fa-section-title">Top Spreads (last scan)</h3>
          {lastRun.opportunities.map((o: OpportunitySnapshot) => (
            <div key={o.coin} className="fa-opp-row">
              <span className="fa-opp-coin">{o.coin}</span>
              <span className={`fa-opp-annualized ${o.viable ? "fa-viable" : ""}`}>
                {o.annualized.toFixed(1)}%/yr
              </span>
              <span className="fa-opp-hourly">{o.spreadHourly.toFixed(4)}%/h</span>
              <span className="fa-opp-oi">${o.openInterestM.toFixed(0)}M OI</span>
              <span className="fa-opp-reason">{o.reason}</span>
            </div>
          ))}
        </div>
      )}

      {/* Last run results */}
      {lastRun?.results && lastRun.results.length > 0 && (
        <div className="fa-section">
          <h3 className="fa-section-title">Last Run</h3>
          {lastRun.results.map((r: any, i: number) => (
            <div key={i} className="fa-run-row">
              <span className="fa-run-coin">{r.coin}</span>
              <span className={`fa-run-action fa-action-${r.action}`}>{r.action}</span>
              {r.sizeUSDC && <span className="fa-run-size">${r.sizeUSDC.toFixed(0)}</span>}
              {r.spreadAnnualized && <span className="fa-run-spread">{r.spreadAnnualized.toFixed(1)}%/yr</span>}
              {r.netPnl !== undefined && (
                <span className="fa-run-pnl" style={{ color: pnlColor(r.netPnl) }}>
                  ${r.netPnl.toFixed(2)}
                </span>
              )}
              {r.reason && <span className="fa-run-reason">{r.reason}</span>}
              {r.error  && <span className="fa-run-error">{r.error}</span>}
            </div>
          ))}
        </div>
      )}

      <style>{`
        .fa-wrap { max-width: 760px; margin: 0 auto; padding: 1.5rem 1rem; }
        .fa-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.25rem; }
        .fa-title { font-family: var(--sans); font-size: 1.25rem; color: var(--text); margin: 0; }
        .fa-sub { font-family: var(--mono); font-size: 0.7rem; color: var(--muted); margin-bottom: 1.25rem; letter-spacing: 0.05em; }
        .fa-mode { font-family: var(--mono); font-size: 0.65rem; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
        .fa-paper { background: var(--warn); color: var(--bg); }
        .fa-live  { background: var(--danger); color: #fff; }
        .fa-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; margin-bottom: 1rem; }
        .fa-stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem; text-align: center; }
        .fa-stat-label { display: block; font-family: var(--mono); font-size: 0.55rem; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.08em; }
        .fa-stat-value { font-family: var(--mono); font-size: 1rem; color: var(--text); }
        .fa-stopped { grid-column: 1 / -1; background: var(--danger); color: #fff; padding: 0.5rem; border-radius: 6px; font-family: var(--mono); font-size: 0.7rem; text-align: center; }
        .fa-controls { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
        .fa-btn { font-family: var(--mono); font-size: 0.7rem; padding: 0.5rem 1rem; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; letter-spacing: 0.05em; text-transform: uppercase; }
        .fa-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .fa-btn-primary { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 700; }
        .fa-btn-secondary { background: var(--surface); color: var(--text); }
        .fa-btn-danger { background: transparent; color: var(--danger); border-color: var(--danger); }
        .fa-error { background: rgba(241,53,53,0.1); border: 1px solid var(--danger); border-radius: 6px; padding: 0.6rem; color: var(--danger); font-family: var(--mono); font-size: 0.7rem; margin-bottom: 0.75rem; }
        .fa-section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.85rem; margin-bottom: 0.75rem; }
        .fa-section-title { font-family: var(--sans); font-size: 0.8rem; color: var(--muted); margin: 0 0 0.5rem; }
        .fa-pos-row, .fa-opp-row, .fa-run-row { display: flex; gap: 0.6rem; padding: 0.35rem 0; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 0.7rem; flex-wrap: wrap; align-items: center; }
        .fa-pos-row:last-child, .fa-opp-row:last-child, .fa-run-row:last-child { border-bottom: none; }
        .fa-pos-coin, .fa-opp-coin, .fa-run-coin { font-weight: 700; color: var(--accent); min-width: 40px; }
        .fa-pos-size, .fa-run-size { color: var(--text); }
        .fa-pos-spread, .fa-opp-hourly { color: var(--muted); }
        .fa-opp-annualized { color: var(--muted); }
        .fa-viable { color: var(--accent); font-weight: 700; }
        .fa-pos-acc, .fa-run-pnl { margin-left: auto; font-weight: 700; }
        .fa-pos-age { color: var(--muted); font-size: 0.6rem; }
        .fa-opp-oi { color: var(--muted); }
        .fa-opp-reason, .fa-run-reason { color: var(--muted); font-size: 0.62rem; width: 100%; opacity: 0.7; }
        .fa-run-action { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; }
        .fa-action-opened, .fa-action-closed { color: var(--accent); }
        .fa-action-skip { color: var(--muted); }
        .fa-action-error, .fa-action-close_error { color: var(--danger); }
        .fa-run-error { color: var(--danger); }
        @media (max-width: 600px) { .fa-stats { grid-template-columns: repeat(2, 1fr); } }
      `}</style>
    </div>
  );
}

function ageString(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h  = Math.floor(ms / 3_600_000);
  if (h < 1)    return `${Math.floor(ms / 60_000)}m`;
  if (h < 24)   return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
