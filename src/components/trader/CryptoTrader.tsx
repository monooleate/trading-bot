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
  cryptoEntryCriteria,
  type ResultChip,
  type SignalArrow,
  type CriteriaGate,
  type PendingPositionLite,
  type OpenPositionRow,
  type OpenPositionRationale,
} from "../shared/TraderResults";
import { useTradeExport } from "../shared/useTradeExport";
import type { LiveReadinessReport } from "../shared/LiveReadinessBadge";
import RecommendationsCard from "../shared/RecommendationsCard";
import CryptoPriceTicker from "../shared/CryptoPriceTicker";

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
    momentum?: number | null;
    contrarian?: number | null;
    pairs_spread?: number | null;
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
  hasConditionId?: boolean;
  waitReason?: string;
}

function formatAgeAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h ago`;
}

interface PendingDiagnostic {
  market: string;
  conditionId: string | null;
  ageMin: number;
  gamma: {
    found: boolean;
    closed: boolean | null;
    outcomePrices: number[] | null;
    umaResolutionStatus: string | null;
  } | null;
  verdict: string;
  shouldClose: boolean;
}

interface ReconcileResult {
  ok: boolean;
  action: "reconciled";
  resolved: { market: string; exitPrice: number; pnl: number }[];
  stillPending: PendingDiagnostic[];
}

interface RunResult {
  ok: boolean;
  action: string;
  paperMode?: boolean;
  marketsScanned?: number;
  marketsConsidered?: number;
  results?: ScanResult[];
  droppedMarkets?: DroppedMarket[];
  // Reconcile-action returns a different payload shape — kept on RunResult
  // so the same useTraderAction hook handles it.
  resolved?: { market: string; exitPrice: number; pnl: number }[];
  stillPending?: PendingDiagnostic[];
  config?: {
    edgeThreshold:    number;
    maxKellyFraction: number;
    cooldownSeconds:  number;
    sessionLossLimit: number;
    minOpenInterest:  number;
    roundtripFeePct:  number;
    // 2026-05-11 audit additions — surfaced so the configLine can show
    // the current convergence/size thresholds the engine is using.
    minPositionSizeUSDC?:   number;
    combinerConfidenceMin?: number;
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
  ["momentum",       "MOM"],
  ["contrarian",     "CTR"],
  ["pairs_spread",   "PRS"],
] as const;

function pct(v: number | undefined, digits = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export default function CryptoTrader({ bankroll }: { bankroll?: number }) {
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
  const openDetails = ((status as any)?.openDetails ?? []) as Array<{
    market: string;
    title: string | null;
    direction: "YES" | "NO";
    size: number;
    avgEntry: number;
    shares: number;
    openedAt: string;
    endDate: string | null;
    marketPriceAtEntry: number | null;
    predictedProb: number | null;
    entryDecision: OpenPositionRationale | null;
    liveGates: any;
  }>;

  const doAction = useCallback(async (action: string) => {
    setError(null);
    // Reset takes the dashboard's current bankroll input as the new starting
    // bankroll. Other actions don't carry it (they don't mutate sizing).
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
  ] : [];

  const alerts: TraderAlert[] = [];
  if (session?.stopped) alerts.push({ tone: "danger", text: `Stopped: ${session.stoppedReason || "unknown"}` });

  const pendingCount = pending?.count ?? 0;
  const controls: TraderControl[] = [
    { label: isRunning ? "Scanning..." : "Run Scan", kind: "primary",   onClick: () => doAction("run"),    disabled: isRunning },
    { label: "⟳ Reconcile pending",                  kind: "info",      onClick: () => doAction("reconcile"), disabled: isRunning, when: pendingCount > 0, title: "Forces a Polymarket settlement pass + per-position Gamma diagnostic" },
    { label: "Stop",                                 kind: "danger",    onClick: () => doAction("stop"),   disabled: isRunning, when: !session?.stopped },
    { label: "Resume",                               kind: "secondary", onClick: () => doAction("resume"), disabled: isRunning, when: !!session?.stopped },
    { label: "Refresh",                              kind: "secondary", onClick: refresh,                  disabled: isRunning },
  ];

  const sessionSummary = session ? [
    `Bankroll most: <b>$${session.bankrollCurrent.toFixed(2)}</b> (start: $${session.bankrollStart.toFixed(2)})`,
    `Lezárt trade-ek: <b>${session.tradeCount}</b> · Session PnL: <b>${session.sessionPnL >= 0 ? "+" : ""}$${session.sessionPnL.toFixed(2)}</b>`,
    `Nyitott pozíciók: <b>${session.openPositions}</b>`,
    `Indult: <b>${new Date(session.startedAt).toLocaleString()}</b>`,
    typeof bankroll === "number"
      ? `Új starting bankroll a reset után: <b>$${bankroll.toFixed(2)}</b> (a fejléc Bankroll mezőjéből)`
      : "",
  ].filter(Boolean) : undefined;

  return (
    <TraderShell
      title="Crypto Auto-Trader"
      subtitle="BTC short markets (5m / 15m up/down) · signal-combiner: funding · orderflow · vol-div · apex · cond-prob · momentum · contrarian · pairs-spread + OB-imbalance gate"
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
      <CryptoPriceTicker symbols={["BTCUSDT"]} title="Spot reference" />
      <RecommendationsCard category="crypto" refreshKey={healthRefresh} />

      {openDetails.length > 0 && (
        <OpenPositionsCard
          title={`${openDetails.length} open position${openDetails.length > 1 ? "s" : ""} (still in trading window)`}
          rows={openDetails.map<OpenPositionRow>((p) => {
            const endsIn = p.endDate
              ? Math.max(0, new Date(p.endDate).getTime() - Date.now())
              : null;
            const endsText = endsIn === null
              ? "—"
              : endsIn > 86_400_000
              ? `ends in ${Math.floor(endsIn / 86_400_000)}d`
              : endsIn > 3_600_000
              ? `ends in ${Math.floor(endsIn / 3_600_000)}h ${Math.floor((endsIn % 3_600_000) / 60_000)}m`
              : `ends in ${Math.floor(endsIn / 60_000)}m`;
            return {
              coin:      p.title || p.market,
              direction: p.direction,
              entryText: `@${(p.avgEntry * 100).toFixed(0)}¢`,
              sizeText:  `$${p.size.toFixed(2)}`,
              spreadText: p.predictedProb !== null
                ? `pred ${(p.predictedProb * 100).toFixed(0)}%`
                : undefined,
              ageText:   endsText,
              // Pass the frozen-at-entry rationale so the row toggles open
              // a "Why?" panel. `null` (older position without snapshot)
              // still toggles, but renders the placeholder message.
              rationale: p.entryDecision ?? null,
              // "What would the bot say RIGHT NOW about this market" —
              // a fresh gate snapshot from the most recent scan tick.
              liveGates: p.liveGates ?? null,
            };
          })}
        />
      )}

      {pending && pending.count > 0 && (
        <PendingPositionsCard
          title={`${pending.count} pending paper position${pending.count > 1 ? "s" : ""} past endDate — awaiting Polymarket resolution`}
          positions={pending.positions.map<PendingPositionLite>((p) => ({
            primary: p.title || p.market,
            // Surfaces the per-position diagnostic so the operator can tell
            // a stuck "missing conditionId (legacy)" from a normal "UMA
            // window — typical 5–15 min".
            secondary: `expired ${formatAgeAgo(p.ageMs)}${p.waitReason ? ` · ${p.waitReason}` : ""}`,
            direction: p.direction,
            predictionText: p.predictedProb !== null
              ? `pred ${(p.predictedProb * 100).toFixed(0)}%`
              : undefined,
            sizeText: `$${p.size.toFixed(2)}`,
            whenText: p.hasConditionId === false
              ? "⚠ missing conditionId"
              : "awaiting Polymarket resolution",
            isReady: p.hasConditionId !== false,
          }))}
          footnote="Polymarket BTC up/down markets settle through UMA (oracle propose → 2h dispute window → finalize). Typical close 5min–4h after endDate. The resolver re-checks every 3 min and auto-closes once Gamma reports closed=true AND umaResolutionStatus=resolved AND outcomePrices ∈ {0,1}. Click '⟳ Reconcile pending' for a per-position live Gamma probe — it shows exactly which gate is still blocking."
        />
      )}

      {/* Reconcile diagnostic — only shown right after the user clicks
          "⟳ Reconcile pending". Lists each still-pending position with the
          actual Gamma state (closed flag, outcomePrices, UMA status) so the
          operator can pinpoint exactly why the resolver isn't closing it. */}
      {display && display.action === "reconciled" && (display.stillPending?.length || display.resolved?.length) && (
        <div className="ts-card">
          <h3 className="ts-card-head">
            <strong>Reconcile result</strong>
            {display.resolved && display.resolved.length > 0 && (
              <span className="ts-tag" style={{ color: "var(--accent)", borderColor: "var(--accent)" }}>
                {display.resolved.length} closed
              </span>
            )}
            {display.stillPending && display.stillPending.length > 0 && (
              <span className="ts-tag" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>
                {display.stillPending.length} still pending
              </span>
            )}
          </h3>
          {display.resolved?.map((r, i) => (
            <div key={`closed-${i}`} className="ts-row ts-row-pass">
              <div className="ts-row-main">
                <div className="ts-row-title">{r.market}</div>
                <div className="ts-row-reason">
                  Closed at {(r.exitPrice * 100).toFixed(0)}¢ · PnL {r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)}
                </div>
              </div>
              <span className="ts-row-action ts-act-closed">closed</span>
            </div>
          ))}
          {display.stillPending?.map((p, i) => (
            <div key={`pending-${i}`} className={`ts-row ts-row-${p.shouldClose ? "pass" : p.gamma === null || !p.gamma?.found ? "fail" : "skip"}`}>
              <div className="ts-row-main">
                <div className="ts-row-title">{p.market}</div>
                <div className="ts-row-chips">
                  <span className="ts-chip">age {p.ageMin}min</span>
                  {p.gamma?.closed != null && (
                    <span className={`ts-chip ts-chip-${p.gamma.closed ? "pos" : "neg"}`}>
                      closed: {String(p.gamma.closed)}
                    </span>
                  )}
                  {p.gamma?.outcomePrices && (
                    <span className="ts-chip" title="Gamma outcomePrices [YES, NO]">
                      op: [{p.gamma.outcomePrices.map((x) => x.toFixed(2)).join(", ")}]
                    </span>
                  )}
                  {p.gamma?.umaResolutionStatus && (
                    <span className={`ts-chip ts-chip-${p.gamma.umaResolutionStatus === "resolved" ? "pos" : "warn"}`}>
                      uma: {p.gamma.umaResolutionStatus}
                    </span>
                  )}
                  {!p.conditionId && (
                    <span className="ts-chip ts-chip-neg">no conditionId</span>
                  )}
                </div>
                <div className="ts-row-reason">{p.verdict}</div>
              </div>
              <span className="ts-row-action ts-act-skip">
                {p.shouldClose ? "ready" : "waiting"}
              </span>
            </div>
          ))}
        </div>
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
              chips.push({ label: `${r.activeSignals}/8 signals`, title: "Number of signal sources contributing this tick (out of 8: FR/VPIN/VOL/APEX/CP/MOM/CTR/PRS)" });
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

            // Backend now ships a per-row `gates: DecisionGate[]` covering
            // all 12 gates (2026-05-11 audit fix): session-loss /
            // active-signals / combiner-confidence / combiner-recommendation
            // / resolution-risk / cooldown / OI / entry-window / OB-imbalance
            // / net-edge / kelly-size-min / kelly-size-cap. The chip "X/Y
            // gates" renders uniformly. Fallback to the lighter mapper for
            // older payloads that pre-date the change.
            const criteria: CriteriaGate[] = Array.isArray((r as any).gates) && (r as any).gates.length > 0
              ? ((r as any).gates as CriteriaGate[])
              : cryptoEntryCriteria(r, display.config);

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
