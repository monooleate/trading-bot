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
  DroppedCard,
  cryptoEntryCriteria,
  type ResultChip,
  type SignalArrow,
  type PendingPositionLite,
} from "../shared/TraderResults";
import { useTradeExport } from "../shared/useTradeExport";
import type { LiveReadinessReport } from "../shared/LiveReadinessBadge";

// Crypto Auto-Trader (BTC short markets, 5m / 15m up-down). All chrome —
// header, badges, status pills, stats grid, controls — comes from
// <TraderShell>. The custom slot below renders the per-tick scan results
// using the shared <ScanResultsCard> + <ScanResultRow> language so every
// chip and signal arrow looks identical to the other 3 bots.

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

interface PendingPosition {
  market: string;
  title: string | null;
  direction: "YES" | "NO";
  size: number;
  endDate: string;
  marketPriceAtEntry: number | null;
  predictedProb: number | null;
  ageMs: number;
}

function formatAgeAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h ago`;
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
  liveReadiness?: LiveReadinessReport;
  reason?: string;
  error?: string;
  source?: "manual" | "cron";
  startedAt?: string;
  finishedAt?: string;
}

const SIGNAL_ORDER = [
  ["funding_rate",   "FR"],
  ["orderflow",      "VPIN"],
  ["vol_divergence", "VOL"],
  ["apex_consensus", "APEX"],
  ["cond_prob",      "CP"],
] as const;

function pct(v: number | undefined, digits = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export default function CryptoTrader() {
  const { status, refresh } = useAutoTraderStatus<SessionSummary>("crypto");
  const { loading, error, lastResult, run, setError } =
    useTraderAction<RunResult>("crypto");
  const { exportTrades, exporting } = useTradeExport({ category: "crypto" });
  const [healthRefresh, setHealthRefresh] = useState(0);

  const session = (status?.session as SessionSummary) ?? lastResult?.session ?? null;
  const rs = status?.runStatus;
  const isRunning = loading || (rs?.isRunning ?? false);
  const display = lastResult ?? (rs?.lastResult as RunResult | null) ?? null;
  const readiness = lastResult?.liveReadiness ?? (status as any)?.liveReadiness ?? null;
  const pending = (status as any)?.pending as
    | { count: number; nextReconcileAt: string | null; positions: PendingPosition[] }
    | undefined;

  const doAction = useCallback(async (action: string) => {
    setError(null);
    const r = await run(action);
    if (r) setHealthRefresh((n) => n + 1);
    refresh();
  }, [run, refresh, setError]);

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
    { label: isRunning ? "Scanning..." : "Run Scan", kind: "primary",   onClick: () => doAction("run"),    disabled: isRunning },
    { label: "Stop",                                 kind: "danger",    onClick: () => doAction("stop"),   disabled: isRunning, when: !session?.stopped },
    { label: "Resume",                               kind: "secondary", onClick: () => doAction("resume"), disabled: isRunning, when: !!session?.stopped },
    { label: "Refresh",                              kind: "secondary", onClick: refresh,                  disabled: isRunning },
  ];

  const sessionSummary = session ? [
    `Bankroll most: <b>$${session.bankrollCurrent.toFixed(2)}</b> (start: $${session.bankrollStart.toFixed(2)})`,
    `Lezárt trade-ek: <b>${session.tradeCount}</b> · Session PnL: <b>${session.sessionPnL >= 0 ? "+" : ""}$${session.sessionPnL.toFixed(2)}</b>`,
    `Nyitott pozíciók: <b>${session.openPositions}</b>`,
    `Indult: <b>${new Date(session.startedAt).toLocaleString()}</b>`,
  ] : undefined;

  return (
    <TraderShell
      title="Crypto Auto-Trader"
      subtitle="BTC short markets (5m / 15m up/down) · signal-combiner: funding · orderflow · vol-div · apex · cond-prob · OB-imbalance gate"
      mode={{ label: session?.paperMode ? "PAPER" : "LIVE", tone: session?.paperMode ? "paper" : "live" }}
      cron={{ enabled: !!status?.cronEnabled, intervalLabel: "3 min", title: "Configured in netlify.toml (auto-trader */3 * * * *)" }}
      isRunning={isRunning}
      lastSource={rs?.source ?? null}
      lastRunAt={rs?.lastRunAt ?? null}
      stats={stats}
      alerts={alerts}
      controls={controls}
      error={error}
      showLiveReadiness
      liveReadinessCategory="crypto"
      liveReadinessReport={readiness}
      showCalibration
      calibrationCategory="crypto"
      refreshKey={healthRefresh}
      reset={{
        onReset: () => doAction("reset"),
        sessionSummary,
        disabled: isRunning,
        categoryLabel: "Crypto Auto-Trader",
      }}
      onExportTrades={exportTrades}
      exportingTrades={exporting}
    >
      {pending && pending.count > 0 && (
        <PendingPositionsCard
          title={`${pending.count} pending paper position${pending.count > 1 ? "s" : ""} past endDate — awaiting Polymarket resolution`}
          positions={pending.positions.map<PendingPositionLite>((p) => ({
            primary: p.title || p.market,
            secondary: `expired ${formatAgeAgo(p.ageMs)}`,
            direction: p.direction,
            predictionText: p.predictedProb !== null
              ? `pred ${(p.predictedProb * 100).toFixed(0)}%`
              : undefined,
            sizeText: `$${p.size.toFixed(2)}`,
            whenText: "awaiting Polymarket resolution",
            isReady: true,
          }))}
          footnote="simVersion 3: paper positions close only on real Gamma outcomePrices. UMA resolution typical 5–60 min, longer during disputes."
        />
      )}

      {display && (display.results || display.reason) && (
        <ScanResultsCard
          headerText={
            display.action === "skipped"
              ? `Skipped: ${display.reason}`
              : `Scanned ${display.marketsScanned ?? 0} BTC up/down markets · evaluated top ${display.marketsConsidered ?? Math.min(display.marketsScanned ?? 0, 3)}`
          }
          source={display.source ?? null}
          configLine={display.config && (
            `edge≥${pct(display.config.edgeThreshold)}, kelly≤${pct(display.config.maxKellyFraction)}, ` +
            `SL@${(display.config.btcSlTarget * 100).toFixed(0)}¢ · TP@${(display.config.btcTpTarget * 100).toFixed(0)}¢, ` +
            `entry-band [${pct(display.config.btcMinPriceBand, 0)}, ${pct(1 - display.config.btcMinPriceBand, 0)}], ` +
            `fees ${pct(display.config.roundtripFeePct, 1)}`
          ) || undefined}
        >
          {display.results?.map((r, i) => {
            const chips: ResultChip[] = [];
            if (r.marketPrice !== undefined) {
              chips.push({ label: `mp ${(r.marketPrice * 100).toFixed(0)}¢`, title: `Live market price ${(r.marketPrice * 100).toFixed(2)}¢` });
            }
            if (r.predictedProb !== undefined) {
              chips.push({ label: `model ${(r.predictedProb * 100).toFixed(0)}%`, title: "Combined model probability for YES" });
            }
            if (r.netEdge !== undefined) {
              const tone = r.netEdge >= 0.05 ? "pos" : r.netEdge >= 0 ? "warn" : "neg";
              chips.push({ label: `edge ${r.netEdge >= 0 ? "+" : ""}${(r.netEdge * 100).toFixed(1)}%`, tone, title: "Net edge after fees (model − market)" });
            }
            if (r.direction) {
              chips.push({ label: r.direction, tone: r.direction === "YES" ? "pos" : "neg", outline: true });
            }
            if (r.kellyUsed !== undefined && r.kellyUsed > 0) {
              chips.push({ label: `kelly ${(r.kellyUsed * 100).toFixed(1)}%`, tone: "info", title: "¼-Kelly fraction of bankroll" });
            }
            if (r.activeSignals !== undefined) {
              chips.push({ label: `${r.activeSignals}/5 signals`, title: "Number of signal sources contributing this tick" });
            }
            if (r.obImbalance) {
              const arrow = r.obImbalance.direction === "UP" ? "↑" : r.obImbalance.direction === "DOWN" ? "↓" : "·";
              chips.push({ label: `OB ${arrow}`, tone: "info", title: `Binance top-10 bid/ask ratio = ${r.obImbalance.ratio.toFixed(2)}` });
            }

            const signals: SignalArrow[] = r.signalBreakdown
              ? SIGNAL_ORDER.map(([key, label]) => ({
                  name: label,
                  score: (r.signalBreakdown as any)?.[key],
                }))
              : [];

            const criteria = cryptoEntryCriteria(r, display.config);

            const extra = r.action === "position_opened" && r.entry !== undefined && r.size !== undefined
              ? `$${r.size.toFixed(2)} @ ${(r.entry * 100).toFixed(0)}¢`
              : undefined;
            const pnlText = r.pnl !== undefined ? `${r.pnl >= 0 ? "+" : ""}$${r.pnl.toFixed(2)}` : undefined;

            return (
              <ScanResultRow
                key={`${r.market}-${i}`}
                title={r.title || r.market}
                titleTip={r.market}
                action={r.action}
                chips={chips}
                signals={signals}
                criteria={criteria}
                extra={extra}
                pnl={pnlText}
                pnlValue={r.pnl}
                reason={r.reason || r.error}
                isErrorReason={!!r.error}
              />
            );
          })}

          {display.droppedMarkets && display.droppedMarkets.length > 0 && (
            <DroppedCard
              summary={`${display.droppedMarkets.length} further BTC market${display.droppedMarkets.length === 1 ? "" : "s"} below the top 3 (not evaluated this tick)`}
              rows={display.droppedMarkets.map((d) => ({
                reason: d.reason,
                title: d.title,
                meta: `${(d.currentPrice * 100).toFixed(0)}¢`,
                trailing: `$${Math.round(d.volume24h).toLocaleString()}`,
              }))}
            />
          )}
        </ScanResultsCard>
      )}
    </TraderShell>
  );
}
