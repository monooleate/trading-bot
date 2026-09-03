// netlify/functions/auto-trader/sports/index.mts
//
// Sports bot main entry — registry-native from day one. Implements the
// `BotDefinition` contract so the dispatcher in `auto-trader/index.mts`
// can route via `dispatchToRegistry()` without any switch-case edit.
//
// Strategy MVP: contrarian fan-bias fade on Polymarket sports markets.
// When a market is priced at fan-extreme (YES > 0.85 or YES < 0.15) the
// bot takes the opposite side with a quarter-Kelly position and tight
// gates (max 3 open, $20 per pos, $30 session loss limit).
//
// Paper-mode-only by default (`SPORTS_PAPER_MODE` env). No live execution
// path yet — that's a future session once the paper track-record exists.

import { log } from "../shared/logger.mts";
import { loadPaperNeverStop, isAutoStopReason } from "../shared/paper-never-stop.mts";
import { alertSessionStop, alertError } from "../shared/telegram.mts";
import { registerBot, type BotDefinition } from "../shared/bot-registry.mts";
import { getSportsConfig, getEffectiveSportsConfig, SPORTS_DEFAULT_BANKROLL, SPORTS_SIM_VERSION } from "./config.mts";
import { getEffectiveFillOpts } from "../shared/config.mts";
import { fetchClobBook } from "../shared/clob-book.mts";
import { simulateDepthFill, fallbackFill, isFillValid } from "@core/fill-model.mts";
import { findSportsMarkets } from "./market-finder.mts";
import { makeSportsDecision } from "./decision-engine.mts";
import {
  loadSportsSession,
  saveSportsSession,
  resetSportsSession,
  stopSportsSession,
  resumeSportsSession,
  topupSportsSession,
  addOpenPosition,
} from "./session-manager.mts";
import { resolvePendingSportsPositions } from "./paper-resolver.mts";
import { probeProvisionalOutcome } from "../shared/provisional-outcome.mts";
import { markRunStart, markRunFinish, getSportsRunStatus } from "./run-state.mts";
import { appendPredictions, reconcileLedger } from "@core/prediction-ledger.mts";
import type { SportsPosition, SportsMarket } from "./types.mts";
import type { EntryDecisionSnapshot } from "@core/types.mts";

const CATEGORY = "sports" as const;

// ─── Main run loop ────────────────────────────────────────────────────

async function runSportsTrader(
  source: "manual" | "cron",
  initialBankroll?: number,
): Promise<any> {
  await markRunStart(source).catch(() => {});

  // Pull runtime Settings overrides every tick — Loose/Normal/Strict
  // preset propagates to the next scan without redeploy.
  const config = await getEffectiveSportsConfig();
  // Depth-aware paper fill options (B49 #1 / T7) — fetched once per tick.
  // Default OFF → legacy full fill at entryPrice (zero behaviour change).
  const fillOpts = await getEffectiveFillOpts();
  // Paper "never stop" valve (2026-09-01) — resolved once per tick. Raise the
  // loss-limit to +Infinity in paper so the session-loss auto-stop never trips
  // (keeps a running sports session alive). A MANUAL stop still sticks — the
  // self-heal below only clears AUTOMATIC stops, so a bot the operator halted
  // by hand (sports has no live edge) stays down. Live mode untouched.
  const paperNeverStop = await loadPaperNeverStop();
  if (config.paperMode && paperNeverStop) {
    config.sessionLossLimit = Number.POSITIVE_INFINITY;
  }
  // User's bankroll-input wins on first-load (session never existed or
  // just got auto-archived by a simVersion bump). Once the session is
  // alive, loadSportsSession ignores `initialBankroll` and reads the
  // persisted bankrollCurrent — use Reset to change a live bankroll.
  let session = await loadSportsSession(
    config.paperMode,
    initialBankroll && initialBankroll > 0 ? initialBankroll : SPORTS_DEFAULT_BANKROLL,
  );

  // Auto-recover from a loss-limit stop once the limit is disabled (default
  // in paper). Mirrors the HL consecutive-loss auto-recovery (Sprint 42G):
  // turning the guard off should un-stick a session it previously stopped,
  // without requiring a manual resume. Only un-stops loss-limit stops — a
  // manual stop stays stopped.
  if (
    session.stopped &&
    !config.sessionLossLimitEnabled &&
    (session.stoppedReason || "").startsWith("Session loss limit")
  ) {
    session = resumeSportsSession(session);
    await saveSportsSession(session);
    log("PAUSE_AUTORECOVER", session.paperMode, {
      category: CATEGORY,
      reason: "Session loss limit disabled — auto-resumed",
    });
  }

  // Paper "never stop" safety valve (2026-09-01): in paper mode, self-heal an
  // AUTOMATIC (loss-limit) stop so the bot resumes without a manual resume. A
  // MANUAL stop ("Manual stop") is preserved — so a bot the operator halted by
  // hand (e.g. sports, which has no live edge) stays down. Live mode ignored.
  if (config.paperMode && paperNeverStop && session.stopped && isAutoStopReason(session.stoppedReason)) {
    session = resumeSportsSession(session);
    await saveSportsSession(session);
    log("PAUSE_AUTORECOVER", session.paperMode, {
      category: CATEGORY,
      paperNeverStop: true,
      clearedStop: session.stoppedReason,
    });
  }

  if (session.stopped) {
    const result = {
      ok: true,
      action: "skipped" as const,
      category: CATEGORY,
      reason: `Session stopped: ${session.stoppedReason}`,
      paperMode: session.paperMode,
      source,
      session: summarize(session),
    };
    await markRunFinish(result).catch(() => {});
    return result;
  }

  // ─── 1. Settle any pending positions ─────────────────────────────
  const resolveOut = await resolvePendingSportsPositions(session);
  session = resolveOut.session;

  // ─── 2. Discover sports markets ──────────────────────────────────
  let markets: SportsMarket[] = [];
  try {
    markets = await findSportsMarkets({
      minVolume24h:       config.minVolume24h,
      minHoursToEnd:      config.minHoursToEnd,
      maxHoursToEnd:      config.maxHoursToEnd,
      maxMarkets:         30,
      // Mutex-events filter: only binary moneyline events qualify
      // for contrarian fan-bias fade (2026-05-11 (k) sim v2).
      maxMarketsPerEvent: config.maxMarketsPerEvent,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    log("ERROR", session.paperMode, { category: CATEGORY, step: "market-finder", error: msg });
    await alertError(`[sports] market-finder failed: ${msg}`).catch(() => {});
  }

  // ─── 3. Evaluate each market ─────────────────────────────────────
  const results: any[] = [];
  for (const m of markets) {
    // Skip markets where we already hold a position (uniqueness gate).
    const alreadyOpen = session.openPositions.some((p) => p.conditionId === m.conditionId);
    if (alreadyOpen) {
      results.push({
        market: m.slug, league: m.league, action: "skip",
        reason: "already-open",
      });
      continue;
    }

    const decision = makeSportsDecision({
      market: m,
      bankroll: session.bankrollCurrent,
      openCount: session.openPositions.length,
      config,
      // Cross-position outcome-sum gate (2026-05-14e). Passing the full
      // openPositions array lets the engine block any new YES that would
      // push Σ P(YES) within the same eventSlug over 1.0 (no betting on
      // every outcome of one game).
      openPositions: session.openPositions,
    });

    if (!decision.shouldTrade) {
      results.push({
        market:   m.slug,
        league:   m.league,
        question: m.question,
        action:   "skip",
        reason:   decision.reason,
        yesPrice: m.yesPrice,
        gates:    decision.gates,
      });
      continue;
    }

    // Paper-mode entry. Live mode (SPORTS_PAPER_MODE=false) is intentionally
    // not wired yet — there's no track record to justify real-money trades.
    if (!config.paperMode) {
      results.push({
        market: m.slug, league: m.league, action: "skip",
        reason: "live mode not yet wired for sports — paper only",
        gates:  decision.gates,
      });
      continue;
    }

    // Fill: legacy full fill unless the depth-aware model is ON (B49 #1 / T7).
    let shares    = decision.positionSizeUSDC / Math.max(decision.entryPrice, 0.01);
    let avgEntry  = decision.entryPrice;
    let costBasis = decision.positionSizeUSDC;
    if (fillOpts.enabled) {
      const tokenId = decision.direction === "YES" ? m.yesTokenId : m.noTokenId;
      const book = await fetchClobBook(tokenId);
      let res =
        book && book.asks.length > 0
          ? simulateDepthFill(book.asks, decision.positionSizeUSDC, { participationCap: fillOpts.participationCap })
          : null;
      if (!res || !res.ok) res = fallbackFill(decision.entryPrice, decision.positionSizeUSDC, 0.02);
      if (res.ok && isFillValid(res.filledShares, res.vwap, 5)) {
        shares = res.filledShares; avgEntry = res.vwap; costBasis = res.filledUsdc;
      } else {
        results.push({
          market: m.slug, league: m.league, action: "skip",
          reason: "market too thin for a valid fill (fill model)", gates: decision.gates,
        });
        continue;
      }
    }

    // Build the EntryDecisionSnapshot the unified UI rationale popover reads.
    const predicted = decision.direction === "YES"
      ? 0.5 + (m.yesPrice - 0.5) * 0.55
      : 1 - (0.5 + (m.yesPrice - 0.5) * 0.55);
    const entryDecision: EntryDecisionSnapshot = {
      decidedAt:        new Date().toISOString(),
      flavor:           "prob",
      finalProb:        decision.direction === "YES" ? predicted : 1 - predicted,
      marketPrice:      decision.direction === "YES" ? m.yesPrice : m.noPrice,
      grossEdge:        decision.edge + config.roundtripFeePct,
      netEdge:          decision.edge,
      feePct:           config.roundtripFeePct,
      direction:        decision.direction,
      kellyRaw:         decision.kellyUsed * 4,   // un-quarter for display
      kellyCapped:      decision.kellyUsed,
      kellyCap:         config.maxKellyFraction,
      positionSizeUSDC: decision.positionSizeUSDC,
      entryPrice:       decision.entryPrice,
      activeSignals:    1,                         // only one "signal" — fan-extreme
      signalBreakdown:  null,
      obImbalance:      null,
      gates:            decision.gates,
      reason:           decision.reason,
    };

    const position: SportsPosition = {
      market:             m.slug,
      conditionId:        m.conditionId,
      yesTokenId:         m.yesTokenId,
      noTokenId:          m.noTokenId,
      direction:          decision.direction,
      shares,
      avgEntry,
      costBasis,
      openedAt:           new Date().toISOString(),
      endDate:            m.endDate,
      league:             m.league,
      question:           m.question,
      marketPriceAtEntry: decision.direction === "YES" ? m.yesPrice : m.noPrice,
      predictedProb:      decision.direction === "YES" ? predicted : 1 - predicted,
      entryDecision,
      eventSlug:          m.eventSlug,
    };
    session = addOpenPosition(session, position);

    log("ORDER_FILLED", session.paperMode, {
      category:  CATEGORY,
      market:    m.slug,
      league:    m.league,
      direction: decision.direction,
      size:      decision.positionSizeUSDC,
      entry:     decision.entryPrice,
      edge:      decision.edge,
    });

    results.push({
      market:        m.slug,
      league:        m.league,
      question:      m.question,
      action:        "traded",
      direction:     decision.direction,
      size:          decision.positionSizeUSDC,
      entry:         decision.entryPrice,
      edge:          decision.edge,
      predictedProb: predicted,
      gates:         decision.gates,
    });
  }

  // ─── 4. Session loss limit guard ─────────────────────────────────
  // Only enforced when enabled (default OFF in paper, ON in live — toggle via
  // the `sportsSessionLossLimitEnabled` Settings knob). Paper is for unbounded
  // experimentation, so a $30 daily stop just gets in the way there.
  if (config.sessionLossLimitEnabled && session.sessionLoss >= config.sessionLossLimit && !session.stopped) {
    session = stopSportsSession(session, `Session loss limit hit: -$${session.sessionLoss.toFixed(2)}`);
    await alertSessionStop(session.paperMode, session.stoppedReason || "", session as any).catch(() => {});
  }

  await saveSportsSession(session);

  // Prediction ledger (B50 #9): sports markets are binary Polymarket markets that
  // resolve — so, like crypto/weather, log every scanned market's forecast (taken
  // + skipped) + Gamma-reconcile past-endDate skipped outcomes. Unbiased proper-
  // scoring / walk-forward substrate; fills with real Shin fair-values once the
  // B37 odds-feed lands. Stamped with the active-config fingerprint (#4).
  // Best-effort — never breaks the tick.
  let sportsCfgHash = "default";
  try { const sm: any = await import("@api/routes/trader-settings.mts"); sportsCfgHash = await sm.currentConfigFingerprint(); } catch {}
  await appendPredictions("sports", results, markets, session.closedTrades, undefined, sportsCfgHash);
  await reconcileLedger("sports");

  const result = {
    ok: true,
    action: "run" as const,
    category: CATEGORY,
    paperMode: session.paperMode,
    source,
    marketsScanned: markets.length,
    resolutions: resolveOut.resolutions,
    results,
    session: summarize(session),
  };
  await markRunFinish(result).catch(() => {});
  return result;
}

// ─── Status / control handlers ───────────────────────────────────────

function summarize(s: any) {
  // Convert SportsSessionState → BotSessionBase + sports-specific extras
  return {
    startedAt:        s.startedAt,
    paperMode:        s.paperMode,
    stopped:          s.stopped,
    stoppedReason:    s.stoppedReason,
    bankrollStart:    s.bankrollStart,
    bankrollCurrent:  parseFloat(s.bankrollCurrent.toFixed(2)),
    sessionPnL:       parseFloat(s.sessionPnL.toFixed(2)),
    tradeCount:       s.closedTrades?.length ?? 0,
    openPositions:    s.openPositions?.length ?? 0,
    simVersion:       s.simVersion ?? SPORTS_SIM_VERSION,
    // Sports-specific extras for the OpenPositionsCard
    openDetails: (s.openPositions ?? []).map((p: SportsPosition) => ({
      market:        p.market,
      title:         p.question,
      league:        p.league,
      direction:     p.direction,
      size:          p.costBasis,
      avgEntry:      p.avgEntry,
      openedAt:      p.openedAt,
      endDate:       p.endDate,
      entryDecision: p.entryDecision,
    })),
  };
}

// Past-endDate sports positions awaiting Polymarket (UMA) resolution, each
// enriched with a provisional won/lost from the market's CURRENT outcomePrices.
async function getSportsPending(session: any) {
  const now = Date.now();
  const past = (session.openPositions ?? []).filter(
    (p: SportsPosition) => p.endDate && new Date(p.endDate).getTime() < now,
  );
  const positions = await Promise.all(past.map(async (p: SportsPosition) => {
    const ageMs = now - new Date(p.endDate!).getTime();
    return {
      market:             p.market,
      title:              p.question,
      league:             p.league,
      direction:          p.direction,
      size:               p.costBasis,
      endDate:            p.endDate,
      ageMs,
      hasConditionId:     !!p.conditionId,
      provisionalOutcome: await probeProvisionalOutcome(p.conditionId, p.direction),
    };
  }));
  positions.sort((a: any, b: any) => String(a.endDate).localeCompare(String(b.endDate)));
  return { count: positions.length, nextReconcileAt: positions[0]?.endDate ?? null, positions };
}

async function getSportsStatus(): Promise<any> {
  const config    = getSportsConfig();
  const session   = await loadSportsSession(config.paperMode, SPORTS_DEFAULT_BANKROLL);
  const runStatus = await getSportsRunStatus();
  return {
    ok: true,
    action:   "status",
    category: CATEGORY,
    session:  summarize(session),
    pending:  await getSportsPending(session),
    runStatus,
    cronEnabled: true,        // wired via auto-trader-multi-cron
  };
}

async function sportsReset(bankrollOverride?: number): Promise<any> {
  const config  = getSportsConfig();
  const bankroll = bankrollOverride ?? SPORTS_DEFAULT_BANKROLL;
  const session = resetSportsSession(config.paperMode, bankroll);
  await saveSportsSession(session);
  return { ok: true, action: "reset", category: CATEGORY, session: summarize(session) };
}

async function sportsStop(): Promise<any> {
  const config  = getSportsConfig();
  const loaded  = await loadSportsSession(config.paperMode, SPORTS_DEFAULT_BANKROLL);
  const stopped = stopSportsSession(loaded, "Manual stop");
  await saveSportsSession(stopped);
  await alertSessionStop(stopped.paperMode, "Manual stop", stopped as any).catch(() => {});
  return { ok: true, action: "stopped", category: CATEGORY, session: summarize(stopped) };
}

async function sportsResume(): Promise<any> {
  const config  = getSportsConfig();
  const loaded  = await loadSportsSession(config.paperMode, SPORTS_DEFAULT_BANKROLL);
  const resumed = resumeSportsSession(loaded);
  await saveSportsSession(resumed);
  return { ok: true, action: "resumed", category: CATEGORY, session: summarize(resumed) };
}

async function sportsTopup(amount?: number): Promise<any> {
  const config = getSportsConfig();
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Topup amount must be a positive number", category: CATEGORY };
  }
  const loaded   = await loadSportsSession(config.paperMode, SPORTS_DEFAULT_BANKROLL);
  const toppedUp = topupSportsSession(loaded, amount);
  await saveSportsSession(toppedUp);
  return { ok: true, action: "topup", category: CATEGORY, session: summarize(toppedUp), amountApplied: amount };
}

// ─── Registry registration ───────────────────────────────────────────

const botDefinition: BotDefinition = {
  category: CATEGORY,
  label:    "Sports",
  subtitle: "Contrarian fan-bias fade • Polymarket sports markets",
  venue:    "Polymarket",
  run:      ({ source, bankrollOverride }) => runSportsTrader(source, bankrollOverride),
  getStatus: getSportsStatus,
  reset:    sportsReset,
  stop:     sportsStop,
  resume:   sportsResume,
  topup:    sportsTopup,
  ui: {
    showLiveReadiness: false,    // no live mode yet
    showCalibration:   true,
    cronIntervalLabel: "3 min",
    flavor:            "prob",
  },
};

registerBot(botDefinition);

export { botDefinition, runSportsTrader, getSportsStatus, sportsReset, sportsStop, sportsResume };
