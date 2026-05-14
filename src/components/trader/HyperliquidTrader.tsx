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
  hlEntryCriteria,
  type ResultChip,
  type CriteriaGate,
  type OpenPositionRow,
  type OpenPositionRationale,
} from "../shared/TraderResults";
import { useTradeExport } from "../shared/useTradeExport";
import type { LiveReadinessReport } from "../shared/LiveReadinessBadge";
import RecommendationsCard from "../shared/RecommendationsCard";
import CryptoPriceTicker from "../shared/CryptoPriceTicker";
import { hyperliquidTradeUrl } from "../shared/marketLinks";

// Hyperliquid Perp Trader (BTC / ETH / SOL on Hyperliquid testnet by default).
// Mirrors the rest of the bots through TraderShell and the shared cards.
// Per-bot extras: 5-stat grid with consecutive-loss streak, paused-until
// alert, and a Resume control when the cooldown / hard stop is engaged.

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
  liveReadiness?: LiveReadinessReport;
  reason?: string;
  error?: string;
  source?: "manual" | "cron";
}

export default function HyperliquidTrader({ bankroll }: { bankroll?: number }) {
  const { status, refresh } = useAutoTraderStatus<HlSessionSummary>("hyperliquid");
  const { loading, error, lastResult, run, setError } =
    useTraderAction<HlRunResult>("hyperliquid");
  const { exportTrades, exporting } = useTradeExport({ category: "hyperliquid" });
  const [healthRefresh, setHealthRefresh] = useState(0);

  const session = (status?.session as HlSessionSummary) ?? lastResult?.session ?? null;
  const rs = status?.runStatus;
  const isRunning = loading || (rs?.isRunning ?? false);
  const display: HlRunResult | null = lastResult ?? (rs?.lastResult as HlRunResult | null) ?? null;
  const readiness = lastResult?.liveReadiness ?? (status as any)?.liveReadiness ?? null;
  const cronEnabled = status?.cronEnabled ?? true;
  const openDetails = ((status as any)?.openDetails ?? []) as Array<{
    coin: string;
    direction: "LONG" | "SHORT";
    sizeUSDC: number;
    sizeCoins: number;
    entryPrice: number;
    leverage: number;
    tpPrice: number;
    slPrice: number;
    openedAt: string;
    edgeAtEntry: number | null;
    predictedProb: number | null;
    entryDecision: OpenPositionRationale | null;
    liveGates: any;
  }>;

  function ageString(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000)    return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
    return `${Math.floor(ms / 86_400_000)}d`;
  }

  const doAction = useCallback(async (action: string) => {
    setError(null);
    // Reset takes the dashboard bankroll input as the new starting bankroll.
    // The funding-arb layer borrows this same pool — resetting HL with a new
    // bankroll therefore also changes the F-Arb capital cap.
    const extras = action === "reset" && typeof bankroll === "number"
      ? { bankroll }
      : undefined;
    const r = await run(action, extras);
    if (r) setHealthRefresh((n) => n + 1);
    refresh();
  }, [run, refresh, setError, bankroll]);

  const stats: TraderStat[] = session ? [
    { label: "Bankroll",    value: `$${session.bankrollCurrent.toFixed(2)}` },
    { label: "Session PnL", value: `${session.sessionPnL >= 0 ? "+" : ""}$${session.sessionPnL.toFixed(2)}`,
      tone: session.sessionPnL >= 0 ? "pos" : "neg" },
    { label: "Trades",      value: String(session.tradeCount) },
    { label: "Open",        value: String(session.openPositions) },
    { label: "Loss Streak", value: String(session.consecutiveLosses),
      tone: session.consecutiveLosses >= 2 ? "warn" : "default" },
  ] : [];

  const alerts: TraderAlert[] = [];
  if (session?.pausedUntil) {
    alerts.push({
      tone: "warn",
      text: `Paused until ${new Date(session.pausedUntil).toLocaleTimeString()} (consecutive losses cooldown)`,
      action: {
        label: "Cancel pause",
        onClick: () => doAction("resume"),
        disabled: isRunning,
        title: "Manuálisan törli a consecutive-loss pause-t és újra engedélyezi a HL bot futását. Az anti-revenge guard idejét a Settings → Consecutive loss pause állítja.",
      },
    });
  }
  if (session?.stopped) {
    alerts.push({
      tone: "danger",
      text: `Stopped: ${session.stoppedReason || "unknown"}`,
      action: {
        label: "Resume",
        onClick: () => doAction("resume"),
        disabled: isRunning,
        title: "Törli a manual-stop flag-et és újraindítja a botot a következő tickre.",
      },
    });
  }

  const isCooldownOrStopped = !!(session?.stopped || session?.pausedUntil);

  const controls: TraderControl[] = [
    { label: isRunning ? "Running..." : "Run Scan", kind: "primary",   onClick: () => doAction("run"),    disabled: isRunning },
    { label: "Resume",                              kind: "secondary", onClick: () => doAction("resume"), disabled: isRunning, when: isCooldownOrStopped },
    { label: "Stop",                                kind: "danger",    onClick: () => doAction("stop"),   disabled: isRunning, when: !isCooldownOrStopped },
    { label: "Refresh",                             kind: "secondary", onClick: refresh,                  disabled: isRunning },
  ];

  const sessionSummary = session ? [
    `Bankroll most: <b>$${session.bankrollCurrent.toFixed(2)}</b> (start: $${session.bankrollStart.toFixed(2)})`,
    `Lezárt trade-ek: <b>${session.tradeCount}</b> · Session PnL: <b>${session.sessionPnL >= 0 ? "+" : ""}$${session.sessionPnL.toFixed(2)}</b>`,
    `Nyitott pozíciók: <b>${session.openPositions}</b> · Loss streak: <b>${session.consecutiveLosses}</b>`,
    `Indult: <b>${new Date(session.startedAt).toLocaleString()}</b>`,
    typeof bankroll === "number"
      ? `Új starting bankroll a reset után: <b>$${bankroll.toFixed(2)}</b> (a fejléc Bankroll mezőjéből — Funding-Arb is ebből húz)`
      : "",
  ].filter(Boolean) : undefined;

  return (
    <TraderShell
      title="Hyperliquid Perp Trader"
      subtitle="Perp execution engine • BTC / ETH / SOL • signals reused from Polymarket combiner"
      mode={{ label: session?.paperMode ? "TESTNET" : "MAINNET", tone: session?.paperMode ? "paper" : "live" }}
      cron={{ enabled: cronEnabled, intervalLabel: "3 min", title: "Driven by auto-trader-multi-cron, every 3 min" }}
      isRunning={isRunning}
      lastSource={rs?.source ?? null}
      lastRunAt={rs?.lastRunAt ?? null}
      stats={stats}
      alerts={alerts}
      controls={controls}
      error={error}
      showLiveReadiness
      liveReadinessCategory="hyperliquid"
      liveReadinessReport={readiness}
      showCalibration
      calibrationCategory="hyperliquid"
      refreshKey={healthRefresh}
      reset={{
        onReset: () => doAction("reset"),
        sessionSummary,
        disabled: isRunning,
        categoryLabel: "Hyperliquid Perp Trader",
      }}
      onExportTrades={exportTrades}
      exportingTrades={exporting}
    >
      <CryptoPriceTicker symbols={["BTCUSDT", "ETHUSDT", "SOLUSDT"]} title="Spot reference" />
      <RecommendationsCard category="hyperliquid" refreshKey={healthRefresh} />

      {openDetails.length > 0 && (
        <OpenPositionsCard
          title={`${openDetails.length} open perp position${openDetails.length > 1 ? "s" : ""}`}
          rows={openDetails.map<OpenPositionRow>((p) => ({
            coin:       p.coin,
            // HL paper positions live on testnet — testnet UI URL.
            // Live positions land on the mainnet app.
            link:       hyperliquidTradeUrl(p.coin, !!session?.paperMode),
            direction:  p.direction,
            entryText:  `@$${p.entryPrice.toFixed(2)}`,
            sizeText:   `$${p.sizeUSDC.toFixed(0)} · ${p.leverage}× lev`,
            spreadText: `TP $${p.tpPrice.toFixed(2)} / SL $${p.slPrice.toFixed(2)}`,
            ageText:    ageString(p.openedAt),
            // Frozen-at-entry rationale popover ("Why?"). Same shape as
            // crypto and weather; null = pre-snapshot legacy position.
            rationale:  p.entryDecision ?? null,
            liveGates:  p.liveGates ?? null,
          }))}
        />
      )}

      {display && display.results && display.results.length > 0 && (
        <ScanResultsCard
          headerText={`Scanned ${display.coinsScanned ?? 0} coins`}
          source={display.source ?? null}
        >
          {display.results.map((r: any, i: number) => {
            const chips: ResultChip[] = [];
            if (r.direction) {
              chips.push({
                label: r.direction,
                tone: r.direction === "LONG" ? "pos" : "neg",
                outline: true,
              });
            }
            if (r.entry !== undefined && r.entry !== null) {
              chips.push({ label: `@$${Number(r.entry).toFixed(2)}`, title: "Entry price" });
            }
            if (r.size !== undefined) {
              chips.push({ label: `size ${Number(r.size).toFixed(4)}`, title: "Position size in coin units" });
            }
            if (r.notionalUSD !== undefined) {
              chips.push({ label: `$${Number(r.notionalUSD).toFixed(0)} notional`, tone: "info" });
            }
            if (r.leverage !== undefined) {
              chips.push({ label: `${r.leverage}× lev`, tone: "info" });
            }
            if (r.predictedProb !== undefined) {
              chips.push({ label: `model ${(r.predictedProb * 100).toFixed(0)}%`, title: "Combined signal probability" });
            }
            if (r.edge !== undefined) {
              const tone = r.edge >= 0.05 ? "pos" : r.edge >= 0 ? "warn" : "neg";
              chips.push({ label: `edge ${r.edge >= 0 ? "+" : ""}${(r.edge * 100).toFixed(1)}%`, tone });
            }

            const pnlText = r.pnl !== undefined ? `${r.pnl >= 0 ? "+" : ""}$${Number(r.pnl).toFixed(2)}` : undefined;
            // Backend now ships a per-row `gates: DecisionGate[]` for every
            // scan result (cooldown / signal / vol / session / edge / size).
            // Fallback to the lighter client-side mapper if a legacy payload
            // arrives without gates so older deploys keep rendering.
            const criteria: CriteriaGate[] = Array.isArray(r.gates) && r.gates.length > 0
              ? (r.gates as CriteriaGate[])
              : hlEntryCriteria(r, undefined);

            return (
              <ScanResultRow
                key={`${r.coin}-${i}`}
                title={r.coin}
                link={hyperliquidTradeUrl(r.coin, !!session?.paperMode)}
                action={r.action}
                chips={chips}
                criteria={criteria}
                pnl={pnlText}
                pnlValue={r.pnl}
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
