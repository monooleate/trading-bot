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
  OpenPositionsCard,
  type ResultChip,
  type CriteriaGate,
  type OpenPositionRow,
  type OpenPositionRationale,
} from "../shared/TraderResults";
import { useTradeExport } from "../shared/useTradeExport";
import type { LiveReadinessReport } from "../shared/LiveReadinessBadge";

// Sports bot — registry-native bot (auto-trader/sports). MVP: contrarian
// fan-bias fade on Polymarket sports markets. Paper-mode-only by default.

interface SportsOpenDetail {
  market:        string;
  title:         string;
  league:        string;
  direction:     "YES" | "NO";
  size:          number;
  avgEntry:      number;
  openedAt:      string;
  endDate:       string;
  entryDecision: OpenPositionRationale | null;
}

interface SportsSessionSummary {
  startedAt:        string;
  paperMode:        boolean;
  stopped:          boolean;
  stoppedReason:    string | null;
  bankrollStart:    number;
  bankrollCurrent:  number;
  sessionPnL:       number;
  tradeCount:       number;
  openPositions:    number;
  simVersion?:      number;
  openDetails:      SportsOpenDetail[];
}

interface SportsRunResult {
  ok: boolean;
  action: string;
  category: string;
  paperMode?: boolean;
  marketsScanned?: number;
  results?: any[];
  session?: SportsSessionSummary;
  liveReadiness?: LiveReadinessReport;
  source?: "manual" | "cron";
  reason?: string;
  error?: string;
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default function SportsTrader({ bankroll }: { bankroll?: number }) {
  const { status, refresh } = useAutoTraderStatus<SportsSessionSummary>("sports");
  const { loading, error, lastResult, run, setError } =
    useTraderAction<SportsRunResult>("sports");
  const { exportTrades, exporting } = useTradeExport({ category: "sports" });
  const [healthRefresh, setHealthRefresh] = useState(0);

  const session = (status?.session as SportsSessionSummary) ?? lastResult?.session ?? null;
  const rs = status?.runStatus;
  const isRunning = loading || (rs?.isRunning ?? false);
  const display: SportsRunResult | null = lastResult ?? (rs?.lastResult as SportsRunResult | null) ?? null;
  const cronEnabled = status?.cronEnabled ?? true;

  const doAction = useCallback(async (action: string) => {
    setError(null);
    // Send bankroll on both reset (always) and run (so the first run on
    // a fresh session — e.g. after a simVersion bump — picks up the
    // user's UI bankroll value instead of the hardcoded $50 default).
    const extras = (action === "reset" || action === "run") && typeof bankroll === "number"
      ? { bankroll }
      : undefined;
    const r = await run(action, extras);
    if (r) setHealthRefresh((n) => n + 1);
    refresh();
  }, [run, refresh, setError, bankroll]);

  // 4-cellás layout a többi bot mintájára: Bankroll / Session PnL / Trades / Open
  const stats: TraderStat[] = session ? [
    { label: "Bankroll",    value: `$${session.bankrollCurrent.toFixed(2)}` },
    { label: "Session PnL", value: `${session.sessionPnL >= 0 ? "+" : ""}$${session.sessionPnL.toFixed(2)}`,
      tone: session.sessionPnL >= 0 ? "pos" : "neg" },
    { label: "Trades",      value: String(session.tradeCount) },
    { label: "Open",        value: String(session.openPositions) },
  ] : [];

  const alerts: TraderAlert[] = [];
  if (session?.stopped) alerts.push({ tone: "danger", text: `Stopped: ${session.stoppedReason || "unknown"}` });

  const controls: TraderControl[] = [
    { label: isRunning ? "Running..." : "Scan + Run", kind: "primary",   onClick: () => doAction("run"),    disabled: isRunning },
    { label: "Resume",                                kind: "secondary", onClick: () => doAction("resume"), disabled: isRunning, when: !!session?.stopped },
    { label: "Stop",                                  kind: "danger",    onClick: () => doAction("stop"),   disabled: isRunning, when: !session?.stopped },
    { label: "Refresh",                               kind: "secondary", onClick: refresh,                  disabled: isRunning },
  ];

  const sessionSummary = session ? [
    `Bankroll: <b>$${session.bankrollCurrent.toFixed(2)}</b> (start $${session.bankrollStart.toFixed(0)})`,
    `Trades closed: <b>${session.tradeCount}</b> · Open: <b>${session.openPositions}</b>`,
    `Session PnL: <b>${session.sessionPnL >= 0 ? "+" : ""}$${session.sessionPnL.toFixed(2)}</b>`,
    `Indult: <b>${new Date(session.startedAt).toLocaleString()}</b>`,
    typeof bankroll === "number"
      ? `Új bankroll: <b>$${bankroll.toFixed(2)}</b>`
      : "",
  ].filter(Boolean) : undefined;

  // Use the (truncated) question as the row "coin" label since sports
  // markets don't have a single-ticker concept like crypto. League label
  // goes into the spread slot as a secondary identifier.
  const openRows: OpenPositionRow[] = (session?.openDetails ?? []).map((p) => {
    const qShort = p.title.length > 60 ? p.title.slice(0, 57) + "…" : p.title;
    return {
      coin:       qShort,
      direction:  p.direction,
      sizeText:   `$${p.size.toFixed(2)}`,
      entryText:  `${(p.avgEntry * 100).toFixed(1)}¢`,
      spreadText: p.league !== "Other" ? p.league : undefined,
      ageText:    relativeAge(p.openedAt),
      rationale:  p.entryDecision ?? null,
    };
  });

  return (
    <TraderShell
      title="Sports Bot"
      subtitle="Contrarian fan-bias fade • Polymarket sports markets"
      mode={{ label: session?.paperMode ? "PAPER" : "LIVE", tone: session?.paperMode ? "paper" : "live" }}
      cron={{ enabled: cronEnabled, intervalLabel: "3 min", title: "Driven by auto-trader-multi-cron, every 3 min" }}
      isRunning={isRunning}
      lastSource={rs?.source ?? null}
      lastRunAt={rs?.lastRunAt ?? null}
      stats={stats}
      alerts={alerts}
      controls={controls}
      error={error}
      showLiveReadiness={false}
      showCalibration
      calibrationCategory="sports"
      refreshKey={healthRefresh}
      reset={{
        onReset: () => doAction("reset"),
        sessionSummary,
        disabled: isRunning,
        categoryLabel: "Sports Bot",
      }}
      onExportTrades={exportTrades}
      exportingTrades={exporting}
    >
      <OpenPositionsCard title="Open Positions" rows={openRows} />

      {display && display.results && display.results.length > 0 && (
        <ScanResultsCard
          headerText={`Last Run · ${display.marketsScanned ?? 0} markets scanned`}
          source={display.source ?? null}
        >
          {display.results.map((r: any, i: number) => {
            const chips: ResultChip[] = [];
            if (r.league)             chips.push({ label: r.league, title: "League" });
            if (typeof r.yesPrice === "number") {
              chips.push({ label: `YES ${(r.yesPrice * 100).toFixed(0)}¢`, title: "Current YES price" });
            }
            if (r.direction)          chips.push({ label: r.direction, tone: r.direction === "YES" ? "pos" : "neg", title: "Bet direction" });
            if (typeof r.size === "number") {
              chips.push({ label: `$${r.size.toFixed(2)}`, title: "Position size" });
            }
            if (typeof r.edge === "number") {
              const tone = r.edge >= 0.08 ? "pos" : r.edge >= 0.04 ? "warn" : "neg";
              chips.push({ label: `${(r.edge * 100).toFixed(1)}% edge`, tone, title: "Net edge after fees" });
            }

            const criteria: CriteriaGate[] = Array.isArray(r.gates) && r.gates.length > 0
              ? (r.gates as CriteriaGate[])
              : [];

            return (
              <ScanResultRow
                key={`${r.market}-${i}`}
                title={r.question || r.market}
                action={r.action}
                chips={chips}
                criteria={criteria}
                reason={r.reason || r.error}
                isErrorReason={!!r.error}
              />
            );
          })}
        </ScanResultsCard>
      )}
    </TraderShell>
  );
}
