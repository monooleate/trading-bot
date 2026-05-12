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
import { alertSessionStop, alertError } from "../shared/telegram.mts";
import { registerBot, type BotDefinition } from "../shared/bot-registry.mts";
import { getSportsConfig, getEffectiveSportsConfig, SPORTS_DEFAULT_BANKROLL, SPORTS_SIM_VERSION } from "./config.mts";
import { findSportsMarkets } from "./market-finder.mts";
import { makeSportsDecision } from "./decision-engine.mts";
import {
  loadSportsSession,
  saveSportsSession,
  resetSportsSession,
  stopSportsSession,
  resumeSportsSession,
  addOpenPosition,
} from "./session-manager.mts";
import { resolvePendingSportsPositions } from "./paper-resolver.mts";
import { markRunStart, markRunFinish, getSportsRunStatus } from "./run-state.mts";
import type { SportsPosition, SportsMarket } from "./types.mts";
import type { EntryDecisionSnapshot } from "../shared/types.mts";

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
  // User's bankroll-input wins on first-load (session never existed or
  // just got auto-archived by a simVersion bump). Once the session is
  // alive, loadSportsSession ignores `initialBankroll` and reads the
  // persisted bankrollCurrent — use Reset to change a live bankroll.
  let session = await loadSportsSession(
    config.paperMode,
    initialBankroll && initialBankroll > 0 ? initialBankroll : SPORTS_DEFAULT_BANKROLL,
  );

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

    const shares = decision.positionSizeUSDC / Math.max(decision.entryPrice, 0.01);

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
      avgEntry:           decision.entryPrice,
      costBasis:          decision.positionSizeUSDC,
      openedAt:           new Date().toISOString(),
      endDate:            m.endDate,
      league:             m.league,
      question:           m.question,
      marketPriceAtEntry: decision.direction === "YES" ? m.yesPrice : m.noPrice,
      predictedProb:      decision.direction === "YES" ? predicted : 1 - predicted,
      entryDecision,
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
  if (session.sessionLoss >= config.sessionLossLimit && !session.stopped) {
    session = stopSportsSession(session, `Session loss limit hit: -$${session.sessionLoss.toFixed(2)}`);
    await alertSessionStop(session.paperMode, session.stoppedReason || "", session as any).catch(() => {});
  }

  await saveSportsSession(session);

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

async function getSportsStatus(): Promise<any> {
  const config    = getSportsConfig();
  const session   = await loadSportsSession(config.paperMode, SPORTS_DEFAULT_BANKROLL);
  const runStatus = await getSportsRunStatus();
  return {
    ok: true,
    action:   "status",
    category: CATEGORY,
    session:  summarize(session),
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
  ui: {
    showLiveReadiness: false,    // no live mode yet
    showCalibration:   true,
    cronIntervalLabel: "3 min",
    flavor:            "prob",
  },
};

registerBot(botDefinition);

export { botDefinition, runSportsTrader, getSportsStatus, sportsReset, sportsStop, sportsResume };
