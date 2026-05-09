// Unified shell for every Auto-Trader category page.
//
// Renders the header (title + mode badge + status pill cluster), the
// optional CalibrationHealthBadge, the stats grid, alerts (stopped /
// paused), the action button row and any error banner. Per-category panels
// pass their own result cards as children.
//
// Why one shell: the four bots (crypto, weather, hyperliquid, funding-arb)
// were each rendering their own flavour of the same chrome with slightly
// different paddings, button labels and pill text. That made it hard to
// reason about live state at a glance. After this refactor the chrome is
// identical and only the data sections differ.

import { useEffect, useRef, useState, useCallback } from "react";
import CalibrationHealthBadge from "./CalibrationHealthBadge";
import LiveReadinessBadge, { type LiveReadinessReport } from "./LiveReadinessBadge";
import { traderShellCSS } from "./traderShellStyles";

type CalibrationCategory =
  | "crypto" | "weather" | "hyperliquid" | "funding-arb" | "all";

type LiveCategory = "crypto" | "weather" | "hyperliquid" | "funding-arb";

export interface TraderStat {
  label: string;
  value: string;
  /** Optional colour tint for the value. */
  tone?: "default" | "pos" | "neg" | "warn" | "info";
  /** Optional native title attr for hover tooltip. */
  title?: string;
}

export interface TraderAlert {
  tone: "danger" | "warn" | "info";
  text: string;
}

export interface TraderControl {
  label: string;
  kind: "primary" | "secondary" | "danger" | "info";
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** Render this button only when truthy — easier than callers conditionally
   *  building the array. */
  when?: boolean;
}

export interface TraderShellProps {
  title: string;
  /** Short one-line description shown under the header. */
  subtitle: string;
  mode: { label: string; tone: "paper" | "live" };
  cron: { enabled: boolean; intervalLabel: string; title?: string };
  isRunning: boolean;
  lastSource: "manual" | "cron" | null;
  /** ISO timestamp of last persisted run. */
  lastRunAt: string | null;
  stats?: TraderStat[];
  alerts?: TraderAlert[];
  controls: TraderControl[];
  error: string | null;
  /** When true, render the calibration health badge. */
  showCalibration?: boolean;
  calibrationCategory?: CalibrationCategory;
  /** When true, render the live-readiness badge. */
  showLiveReadiness?: boolean;
  liveReadinessCategory?: LiveCategory;
  /** Optional cached readiness report — when provided the badge renders
   *  without an extra fetch. */
  liveReadinessReport?: LiveReadinessReport | null;
  /** Bump to force both badges to re-fetch. */
  refreshKey?: number;
  children?: React.ReactNode;
}

function formatAge(sec: number | null): string {
  if (sec === null || sec < 0) return "—";
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function TraderShell({
  title,
  subtitle,
  mode,
  cron,
  isRunning,
  lastSource,
  lastRunAt,
  stats,
  alerts,
  controls,
  error,
  showCalibration,
  calibrationCategory,
  showLiveReadiness,
  liveReadinessCategory,
  liveReadinessReport,
  refreshKey,
  children,
}: TraderShellProps) {
  // Re-render once a second so the relative timestamp ages locally without
  // re-pulling the API.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const ageSec = lastRunAt
    ? Math.floor((Date.now() - new Date(lastRunAt).getTime()) / 1000)
    : null;

  const visibleControls = controls.filter((c) => c.when !== false);

  return (
    <div className="ts-wrap">
      <style>{traderShellCSS}</style>

      <div className="ts-header">
        <h2 className="ts-title">{title}</h2>
        <span className={`ts-mode ts-mode-${mode.tone}`}>{mode.label}</span>
        <div className="ts-status-cluster">
          <div className={`ts-pill ts-pill-${isRunning ? "live" : "idle"}`}>
            <span className="ts-pill-dot" />
            {isRunning ? `Scanning… (${lastSource ?? "manual"})` : "Idle"}
          </div>
          <div
            className={`ts-pill ts-pill-${cron.enabled ? "cron-on" : "cron-off"}`}
            title={cron.title || "Cron schedule"}
          >
            cron {cron.enabled ? `ON · ${cron.intervalLabel}` : "OFF"}
          </div>
          <div className="ts-pill ts-pill-mute" title={lastRunAt || "no runs yet"}>
            last {lastSource ? `(${lastSource})` : ""}: {formatAge(ageSec)}
          </div>
        </div>
      </div>

      {showLiveReadiness && (
        <LiveReadinessBadge
          category={liveReadinessCategory ?? "crypto"}
          variant="compact"
          readiness={liveReadinessReport ?? null}
          refreshKey={refreshKey}
        />
      )}

      {showCalibration && (
        <CalibrationHealthBadge
          category={calibrationCategory ?? "crypto"}
          days="30"
          variant="compact"
          refreshKey={refreshKey}
        />
      )}

      {subtitle && <div className="ts-subtitle">{subtitle}</div>}

      {stats && stats.length > 0 && (
        <div className="ts-stats">
          {stats.map((s) => (
            <div key={s.label} className="ts-stat" title={s.title}>
              <span className="ts-stat-label">{s.label}</span>
              <span
                className={`ts-stat-value${
                  s.tone && s.tone !== "default" ? ` ts-stat-${s.tone}` : ""
                }`}
              >
                {s.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {alerts && alerts.length > 0 && (
        <div className="ts-alerts">
          {alerts.map((a, i) => (
            <div key={i} className={`ts-alert ts-alert-${a.tone}`}>
              {a.text}
            </div>
          ))}
        </div>
      )}

      <div className="ts-controls">
        {visibleControls.map((c) => (
          <button
            key={c.label}
            className={`ts-btn ts-btn-${c.kind}`}
            onClick={c.onClick}
            disabled={c.disabled}
            title={c.title}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error && <div className="ts-error">{error}</div>}

      {children}
    </div>
  );
}

/* ─── Status hook ───────────────────────────────────────── */
//
// Identical 5-second polling logic across every per-bot panel — folded
// into a hook so the component bodies stay focused on rendering.

const FN = "/.netlify/functions/auto-trader-api";

export interface RunStatusBase {
  isRunning: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  source: "manual" | "cron" | null;
  ageSec: number | null;
  lastResult: any | null;
}

export interface StatusResponseBase<S = any> {
  ok: boolean;
  category: string;
  session: S;
  recentLogs: any[];
  runStatus?: RunStatusBase;
  cronEnabled?: boolean;
  pending?: any;
}

export function useAutoTraderStatus<S = any>(
  category: string,
  layer?: string,
) {
  const [status, setStatus] = useState<StatusResponseBase<S> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ action: "status", category });
      if (layer) qs.set("layer", layer);
      const r = await fetch(`${FN}?${qs.toString()}`);
      const j: StatusResponseBase<S> = await r.json();
      setStatus(j);
    } catch {
      /* swallow — UI just won't update this tick */
    }
  }, [category, layer]);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh]);

  return { status, refresh };
}

export interface ActionResponseBase {
  ok: boolean;
  error?: string;
  session?: any;
  [key: string]: any;
}

export function useTraderAction<R extends ActionResponseBase = ActionResponseBase>(
  category: string,
  layer?: string,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<R | null>(null);

  const run = useCallback(async (action: string): Promise<R | null> => {
    setLoading(true);
    setError(null);
    try {
      const body: any = { action, category };
      if (layer) body.layer = layer;
      const res = await fetch(FN, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: R = await res.json();
      setLastResult(data);
      if (!data.ok) setError(data.error || "Unknown error");
      return data;
    } catch (e: any) {
      setError(e?.message || String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [category, layer]);

  return { loading, error, lastResult, run, setError };
}
