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
  OpportunitiesCard,
  arbEntryCriteria,
  type ResultChip,
  type CriteriaGate,
  type OpenPositionRow,
  type OpenPositionRationale,
  type OpportunityRowLite,
} from "../shared/TraderResults";
import { useTradeExport } from "../shared/useTradeExport";
import type { LiveReadinessReport } from "../shared/LiveReadinessBadge";
import RecommendationsCard from "../shared/RecommendationsCard";
import CryptoPriceTicker from "../shared/CryptoPriceTicker";
import { hyperliquidTradeUrl } from "../shared/marketLinks";

// Funding-Rate Arbitrage layer (delta-neutral: short HL perp + long Binance
// spot). Same TraderShell + reusable cards as the rest of the auto-traders;
// the per-bot extras here are the open-position list and the
// last-scan opportunity snapshot.

interface ArbOpenDetail {
  id:                 string;
  coin:               string;
  sizeUSDC:           number;
  spreadEntry:        number;
  accumulatedFunding: number;
  openedAt:           string;
  entryDecision:      OpenPositionRationale | null;
  liveGates?:         any;
}

interface ArbSessionSummary {
  paperMode:           boolean;
  stopped:             boolean;
  stoppedReason:       string | null;
  openPositions:       number;
  closedTradesCount?:  number;       // 2026-05-10 (j): backend-supplied for stats parity
  deployedCapital:     number;
  totalFundingAllTime: number;
  totalFundingToday:   number;
  fundingDate:         string;
  startedAt:           string;
  bankrollShared?:      number | null; // 2026-05-10 (j): HL session bankroll (shared)
  bankrollSharedStart?: number | null; // 2026-05-10 (j): HL starting bankroll
  openDetails:         ArbOpenDetail[];
}

interface OpportunitySnapshot {
  coin:          string;
  spreadHourly:  number;    // already × 100
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
  liveReadiness?: LiveReadinessReport;
  reason?: string;
  error?: string;
  source?: "manual" | "cron";
}

function ageString(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h  = Math.floor(ms / 3_600_000);
  if (h < 1)  return `${Math.floor(ms / 60_000)}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default function FundingArbPanel({ bankroll }: { bankroll?: number }) {
  const { status, refresh } = useAutoTraderStatus<ArbSessionSummary>("hyperliquid", "arb");
  const { loading, error, lastResult, run, setError } =
    useTraderAction<ArbRunResult>("hyperliquid", "arb");
  const { exportTrades, exporting } = useTradeExport({ category: "funding-arb" });
  const [healthRefresh, setHealthRefresh] = useState(0);

  const session = (status?.session as ArbSessionSummary) ?? lastResult?.session ?? null;
  const rs = status?.runStatus;
  const isRunning = loading || (rs?.isRunning ?? false);
  const display: ArbRunResult | null = lastResult ?? (rs?.lastResult as ArbRunResult | null) ?? null;
  const readiness = lastResult?.liveReadiness ?? (status as any)?.liveReadiness ?? null;
  const cronEnabled = status?.cronEnabled ?? true;

  const doAction = useCallback(async (action: string) => {
    setError(null);
    // F-Arb session has no bankroll of its own — capital is drawn from the
    // shared HL session. arbReset() applies the override to the HL session
    // ONLY when no perp positions are open; otherwise it logs a skip reason.
    const extras = action === "reset" && typeof bankroll === "number"
      ? { bankroll }
      : undefined;
    const r = await run(action, extras);
    if (r) setHealthRefresh((n) => n + 1);
    refresh();
  }, [run, refresh, setError, bankroll]);

  // Parity with the other 4 bots: Bankroll / Session PnL / Trades / Open.
  // F-Arb has no bankroll of its own — the backend includes the shared HL
  // session bankroll. "Session PnL" maps to totalFundingAllTime since
  // delta-neutral arb's only PnL component is funding accrual. Today's
  // funding + deployed capital still appear in the bot's open-positions
  // card and reset summary, so no info is lost.
  const stats: TraderStat[] = session ? [
    {
      label: "Bankroll (HL)",
      value: typeof session.bankrollShared === "number"
        ? `$${session.bankrollShared.toFixed(2)}`
        : "—",
    },
    {
      label: "Session PnL",
      value: `${session.totalFundingAllTime >= 0 ? "+" : ""}$${session.totalFundingAllTime.toFixed(2)}`,
      tone: session.totalFundingAllTime >= 0 ? "pos" : "neg",
    },
    {
      label: "Trades",
      value: String(session.closedTradesCount ?? 0),
    },
    {
      label: "Open",
      value: String(session.openPositions),
    },
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
    `Open positions: <b>${session.openPositions}</b> · Deployed: <b>$${session.deployedCapital.toFixed(0)}</b>`,
    `Today funding: <b>${session.totalFundingToday >= 0 ? "+" : ""}$${session.totalFundingToday.toFixed(2)}</b>`,
    `All-time funding: <b>${session.totalFundingAllTime >= 0 ? "+" : ""}$${session.totalFundingAllTime.toFixed(2)}</b>`,
    `Indult: <b>${new Date(session.startedAt).toLocaleString()}</b>`,
    typeof bankroll === "number"
      ? `Új shared bankroll (HL session): <b>$${bankroll.toFixed(2)}</b> — csak akkor érvényesül, ha nincs nyitott HL perp pozíció.`
      : "",
  ].filter(Boolean) : undefined;

  const openRows: OpenPositionRow[] = (session?.openDetails ?? []).map((p) => ({
    coin:       p.coin,
    // F-Arb pozíció = SHORT HL perp + LONG Binance spot. A HL perp leg az
    // ami a botban élő pozíció (a Binance leg passive hedge), így a venue
    // link a HL trade page-re mutat. Paper-mode = testnet UI.
    link:       hyperliquidTradeUrl(p.coin, !!session?.paperMode),
    sizeText:   `$${p.sizeUSDC.toFixed(0)}`,
    spreadText: `${p.spreadEntry.toFixed(4)}%/h`,
    pnlText:    `${p.accumulatedFunding >= 0 ? "+" : ""}$${p.accumulatedFunding.toFixed(2)}`,
    pnlValue:   p.accumulatedFunding,
    ageText:    ageString(p.openedAt),
    // Spread-flavor rationale popover ("Why?"). null = pre-snapshot
    // legacy position; renders the unified "no data" placeholder.
    rationale:  p.entryDecision ?? null,
    liveGates:  p.liveGates ?? null,
  }));

  const oppRows: OpportunityRowLite[] = (display?.opportunities ?? []).map((o) => ({
    coin:           o.coin,
    annualizedText: `${o.annualized.toFixed(1)}%/yr`,
    hourlyText:     `${o.spreadHourly.toFixed(4)}%/h`,
    oiText:         `$${o.openInterestM.toFixed(0)}M OI`,
    reason:         o.reason,
    viable:         o.viable,
  }));

  return (
    <TraderShell
      title="Funding Rate Arbitrage"
      subtitle="Delta-neutral carry • SHORT Hyperliquid perp + LONG Binance spot"
      mode={{ label: session?.paperMode ? "PAPER" : "LIVE", tone: session?.paperMode ? "paper" : "live" }}
      cron={{ enabled: cronEnabled, intervalLabel: "3 min", title: "Driven by auto-trader-multi-cron, every 3 min" }}
      isRunning={isRunning}
      lastSource={rs?.source ?? null}
      lastRunAt={rs?.lastRunAt ?? null}
      stats={stats}
      alerts={alerts}
      controls={controls}
      error={error}
      showLiveReadiness
      liveReadinessCategory="funding-arb"
      liveReadinessReport={readiness}
      showCalibration
      calibrationCategory="funding-arb"
      refreshKey={healthRefresh}
      reset={{
        onReset: () => doAction("reset"),
        sessionSummary,
        disabled: isRunning,
        categoryLabel: "Funding Rate Arbitrage",
      }}
      topup={{
        onTopup: (amount) => run("topup", { amount }).then(() => refresh()),
        currentBankroll: session?.bankrollShared ?? undefined,
        disabled: isRunning,
        categoryLabel: "Funding Rate Arbitrage (shared HL bankroll)",
      }}
      onExportTrades={exportTrades}
      exportingTrades={exporting}
    >
      <CryptoPriceTicker symbols={["BTCUSDT", "ETHUSDT", "SOLUSDT"]} title="Spot reference" />
      <RecommendationsCard category="funding-arb" refreshKey={healthRefresh} />

      <OpenPositionsCard title="Open Positions" rows={openRows} />
      <OpportunitiesCard title="Top Spreads (last scan)" rows={oppRows} />

      {display && display.results && display.results.length > 0 && (
        <ScanResultsCard
          headerText={`Last Run · ${display.coinsScanned ?? 0} coins scanned`}
          source={display.source ?? null}
        >
          {display.results.map((r: any, i: number) => {
            const chips: ResultChip[] = [];
            if (r.sizeUSDC !== undefined)         chips.push({ label: `$${Number(r.sizeUSDC).toFixed(0)}`, title: "Notional size" });
            if (r.spreadAnnualized !== undefined) {
              const ann = Number(r.spreadAnnualized);
              const tone = ann >= 30 ? "pos" : ann >= 5 ? "warn" : "neg";
              chips.push({ label: `${ann.toFixed(1)}%/yr`, tone, title: "Spread annualised" });
            }
            if (r.spreadHourly !== undefined)     chips.push({ label: `${Number(r.spreadHourly).toFixed(4)}%/h`, title: "Hourly funding spread" });
            if (r.openInterestM !== undefined)    chips.push({ label: `OI $${Number(r.openInterestM).toFixed(0)}M`, tone: "info", title: "Hyperliquid open interest in USD" });

            const pnlText = r.netPnl !== undefined ? `${r.netPnl >= 0 ? "+" : ""}$${Number(r.netPnl).toFixed(2)}` : undefined;
            // Backend now attaches a per-row `gates: DecisionGate[]` covering
            // spread / break-even / OI / uniqueness / position-count /
            // capital-cap. Fallback path keeps older payloads rendering.
            const criteria: CriteriaGate[] = Array.isArray(r.gates) && r.gates.length > 0
              ? (r.gates as CriteriaGate[])
              : arbEntryCriteria(r, undefined);

            return (
              <ScanResultRow
                key={`${r.coin}-${i}`}
                title={r.coin}
                link={hyperliquidTradeUrl(r.coin, !!session?.paperMode)}
                action={r.action}
                chips={chips}
                criteria={criteria}
                pnl={pnlText}
                pnlValue={r.netPnl}
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
