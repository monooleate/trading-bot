import { useCallback, useState } from "react";
import TraderShell, {
  useAutoTraderStatus,
  useTraderAction,
  type TraderControl,
  type TraderStat,
  type TraderAlert,
} from "../shared/TraderShell";
import {
  ScanResultsCard,
  ScanResultRow,
  PendingPositionsCard,
  OpenPositionsCard,
  DroppedCard,
  weatherEntryCriteria,
  type ResultChip,
  type CriteriaGate,
  type PendingPositionLite,
  type OpenPositionRow,
  type OpenPositionRationale,
} from "../shared/TraderResults";
import { useTradeExport } from "../shared/useTradeExport";
import type { LiveReadinessReport } from "../shared/LiveReadinessBadge";

// Weather Auto-Trader (Polymarket high-temp markets, paper-only on Netlify).
// Same shell as the other 3 bots; the per-bot extras are the pending paper
// positions card (awaiting Polymarket / METAR settlement) and the dropped
// events explainer.

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
  liveReadiness?: LiveReadinessReport;
  reason?: string;
  error?: string;
  source?: "manual" | "cron";
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

function formatDuration(ms: number): string {
  if (ms <= 0) return "ready";
  const sec = Math.floor(ms / 1000);
  if (sec < 60)    return `in ${sec}s`;
  if (sec < 3600)  return `in ${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `in ${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `in ${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export default function WeatherTrader({ bankroll }: { bankroll?: number }) {
  const { status, refresh } = useAutoTraderStatus<any>("weather");
  const { loading, error, lastResult, run, setError } =
    useTraderAction<RunResult>("weather");
  const { exportTrades, exporting } = useTradeExport({ category: "weather" });
  const [healthRefresh, setHealthRefresh] = useState(0);

  const rs = status?.runStatus;
  const isRunning = loading || (rs?.isRunning ?? false);
  const display: RunResult | null = lastResult ?? (rs?.lastResult as RunResult | null) ?? null;
  const readiness = lastResult?.liveReadiness ?? (status as any)?.liveReadiness ?? null;
  const pending = (status as any)?.pending as { count: number; nextReconcileAt: string | null; positions: PendingPosition[] } | undefined;
  const openDetails = ((status as any)?.openDetails ?? []) as Array<{
    market: string;
    city: string;
    date: string;
    bucket: string;
    direction: "YES" | "NO";
    size: number;
    avgEntry: number;
    predictedMaxC: number;
    openedAt: string;
    reconcileAfter: string;
    entryDecision: OpenPositionRationale | null;
  }>;

  const doAction = useCallback(async (action: string) => {
    setError(null);
    // Reset takes the dashboard bankroll input as the new starting bankroll.
    const extras = action === "reset" && typeof bankroll === "number"
      ? { bankroll }
      : undefined;
    const r = await run(action, extras);
    if (r) setHealthRefresh((n) => n + 1);
    refresh();
  }, [run, refresh, setError, bankroll]);

  const controls: TraderControl[] = [
    { label: isRunning ? "Scanning..." : "Scan Weather Markets", kind: "primary", onClick: () => doAction("run"),       disabled: isRunning },
    { label: "⟳ Reconcile pending",                              kind: "info",    onClick: () => doAction("reconcile"), disabled: isRunning, title: "Force a settlement pass on pending paper positions" },
    { label: "Stop",                                             kind: "danger",  onClick: () => doAction("stop"),      disabled: isRunning },
  ];

  const session: any = (status?.session as any) ?? lastResult?.session ?? null;

  const stats: TraderStat[] = session ? [
    { label: "Bankroll",    value: `$${(session.bankrollCurrent ?? 0).toFixed(2)}` },
    { label: "Session PnL", value: `${(session.sessionPnL ?? 0) >= 0 ? "+" : ""}$${(session.sessionPnL ?? 0).toFixed(2)}`,
      tone: (session.sessionPnL ?? 0) >= 0 ? "pos" : "neg" },
    { label: "Trades",      value: String(session.tradeCount ?? 0) },
    { label: "Open",        value: String(session.openPositions ?? 0) },
  ] : [];

  const alerts: TraderAlert[] = [];
  if (session?.stopped) alerts.push({ tone: "danger", text: `Stopped: ${session.stoppedReason || "unknown"}` });

  const sessionSummary = session ? [
    `Bankroll most: <b>$${(session.bankrollCurrent ?? 0).toFixed(2)}</b>${session.bankrollStart !== undefined ? ` (start: $${session.bankrollStart.toFixed(2)})` : ""}`,
    `Lezárt trade-ek: <b>${session.tradeCount ?? 0}</b> · Session PnL: <b>${(session.sessionPnL ?? 0) >= 0 ? "+" : ""}$${(session.sessionPnL ?? 0).toFixed(2)}</b>`,
    `Nyitott pozíciók: <b>${session.openPositions ?? 0}</b> · Pending: <b>${pending?.count ?? 0}</b>`,
    `Indult: <b>${session.startedAt ? new Date(session.startedAt).toLocaleString() : "—"}</b>`,
    typeof bankroll === "number"
      ? `Új starting bankroll a reset után: <b>$${bankroll.toFixed(2)}</b> (a fejléc Bankroll mezőjéből)`
      : "",
  ].filter(Boolean) : undefined;

  return (
    <TraderShell
      title="Weather Auto-Trader"
      subtitle="Edge sources: GFS / ECMWF / NOAA blend, 31-member ensemble (opt-in), DEB per-city weights, METAR Fahrenheit rounding"
      mode={{ label: "PAPER", tone: "paper" }}
      cron={{ enabled: !!status?.cronEnabled, intervalLabel: "5 min", title: "Set in Settings tab (auto-trader-weather-cron */5 * * * *)" }}
      isRunning={isRunning}
      lastSource={rs?.source ?? null}
      lastRunAt={rs?.lastRunAt ?? null}
      stats={stats}
      alerts={alerts}
      controls={controls}
      error={error}
      showLiveReadiness
      liveReadinessCategory="weather"
      liveReadinessReport={readiness}
      showCalibration
      calibrationCategory="weather"
      refreshKey={healthRefresh}
      reset={{
        onReset: () => doAction("reset"),
        sessionSummary,
        disabled: isRunning,
        categoryLabel: "Weather Auto-Trader",
      }}
      onExportTrades={exportTrades}
      exportingTrades={exporting}
    >
      {openDetails.length > 0 && (
        <OpenPositionsCard
          title={`${openDetails.length} open weather position${openDetails.length > 1 ? "s" : ""} (still in trading window)`}
          rows={openDetails.map<OpenPositionRow>((p) => {
            const reconcileIn = Math.max(0, new Date(p.reconcileAfter).getTime() - Date.now());
            const inText =
              reconcileIn > 86_400_000 ? `settles in ${Math.floor(reconcileIn / 86_400_000)}d`
              : reconcileIn > 3_600_000 ? `settles in ${Math.floor(reconcileIn / 3_600_000)}h ${Math.floor((reconcileIn % 3_600_000) / 60_000)}m`
              : `settles in ${Math.floor(reconcileIn / 60_000)}m`;
            return {
              coin:      `${p.city.charAt(0).toUpperCase() + p.city.slice(1)} · ${p.bucket}`,
              direction: p.direction,
              entryText: `@${(p.avgEntry * 100).toFixed(0)}¢`,
              sizeText:  `$${p.size.toFixed(2)}`,
              spreadText: `pred ${p.predictedMaxC}°C · ${p.date}`,
              ageText:   inText,
              // Frozen-at-entry decision snapshot — toggles "Why?" panel.
              // null (older paper position pre-snapshot) renders the
              // "no data" placeholder, same as crypto.
              rationale: p.entryDecision ?? null,
            };
          })}
        />
      )}

      {pending && pending.count > 0 && (
        <PendingPositionsCard
          title={`${pending.count} pending paper position${pending.count > 1 ? "s" : ""} — awaiting Polymarket settlement`}
          positions={pending.positions.map<PendingPositionLite>((p) => {
            const msUntil = new Date(p.reconcileAfter).getTime() - Date.now();
            return {
              primary: p.city,
              secondary: p.date,
              bucket: p.bucket,
              direction: p.direction,
              predictionText: `pred ${p.predictedMaxC}°C`,
              sizeText: `$${p.size.toFixed(2)}`,
              whenText: p.isReady ? "✓ ready to settle" : formatDuration(msUntil),
              isReady: p.isReady,
            };
          })}
          footnote="Source priority: Polymarket Gamma (authoritative) → METAR fallback after 6h"
        />
      )}

      {display && (
        <ScanResultsCard
          headerText={
            display.action === "skipped"
              ? `Skipped: ${display.reason}`
              : `Scanned ${display.marketsScanned || 0} weather markets`
          }
          source={display.source ?? null}
          tags={display.modelLag ? [{
            text: `Model age: ${display.modelLag.age}min${display.modelLag.hasLag ? " (lag detected)" : ""}`,
            tone: display.modelLag.hasLag ? "warn" : "info",
          }] : undefined}
          configLine={display.config && (
            `edge≥${(display.config.edgeThreshold * 100).toFixed(1)}%, ` +
            `conf≥${(display.config.confidenceMin * 100).toFixed(0)}%, ` +
            `cap≤${(display.config.maxEdgeCap * 100).toFixed(0)}% · ` +
            `city_offset ${display.config.applyCityOffset ? "ON" : "OFF"} · ` +
            `ensemble ${display.config.useEnsemble ? "ON" : "OFF"}`
          ) || undefined}
        >
          {display.results?.map((r: any, i: number) => {
            const chips: ResultChip[] = [];
            if (r.predictedTemp !== undefined) {
              chips.push({ label: `pred ${r.predictedTemp}°C`, tone: "info", title: "Forecast max temperature for the bucket" });
            }
            if (r.bucket) {
              chips.push({ label: r.bucket, title: "Polymarket temperature bucket" });
            }
            if (r.marketPrice !== undefined) {
              chips.push({ label: `mp ${(r.marketPrice * 100).toFixed(0)}¢`, title: "Live market price" });
            }
            if (r.modelProb !== undefined || r.predictedProb !== undefined) {
              const mp = r.modelProb ?? r.predictedProb;
              chips.push({ label: `model ${(mp * 100).toFixed(0)}%`, title: "Model probability for YES" });
            }
            if (r.edge !== undefined) {
              const tone = r.edge >= 0.05 ? "pos" : r.edge >= 0 ? "warn" : "neg";
              chips.push({ label: `edge ${r.edge >= 0 ? "+" : ""}${(r.edge * 100).toFixed(1)}%`, tone, title: "Net edge after fees" });
            }
            if (r.direction) {
              chips.push({ label: r.direction, tone: r.direction === "YES" ? "pos" : "neg", outline: true });
            }
            if (r.confidence !== undefined) {
              chips.push({ label: `conf ${(r.confidence * 100).toFixed(0)}%`, title: "Forecast confidence" });
            }

            const extra = r.action === "position_opened" && r.size !== undefined && r.entry !== undefined
              ? `$${(+r.size).toFixed(2)} @ ${(r.entry * 100).toFixed(0)}¢`
              : undefined;

            // Backend ships full gate list per row (confidence / time-to-
            // settlement / model-freshness / net-edge / sanity-cap / kelly).
            // Fallback to the lighter mapper for older payloads.
            const criteria: CriteriaGate[] = Array.isArray((r as any).gates) && (r as any).gates.length > 0
              ? ((r as any).gates as CriteriaGate[])
              : weatherEntryCriteria(r, display.config);

            return (
              <ScanResultRow
                key={`${r.market || r.slug || "row"}-${i}`}
                title={r.title || r.market || r.slug || "—"}
                titleTip={r.market || r.slug}
                prefix={r.city ? r.city.charAt(0).toUpperCase() + r.city.slice(1) : undefined}
                action={r.action}
                chips={chips}
                criteria={criteria}
                extra={extra}
                reason={r.reason || r.error}
                isErrorReason={!!r.error}
              />
            );
          })}

          {display.droppedEvents && display.droppedEvents.length > 0 && (
            <DroppedCard
              summary={`${display.droppedEvents.length} weather-like event${display.droppedEvents.length === 1 ? "" : "s"} dropped (coverage gap or schema issue)`}
              rows={display.droppedEvents.map((d) => ({
                reason: d.reason,
                title: d.title,
                trailing: `$${Math.round(d.vol24h).toLocaleString()}`,
              }))}
            />
          )}
        </ScanResultsCard>
      )}
    </TraderShell>
  );
}
