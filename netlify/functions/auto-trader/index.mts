// netlify/functions/auto-trader/index.ts
// POST /.netlify/functions/auto-trader  { action: "run" | "status" | "reset" | "stop" }
// Scheduled: every 3 minutes (configure in netlify.toml)
//
// Main entry point for the EdgeCalc Auto-Trader.
// Sprint 1: only crypto category is active.

import type { Context } from "@netlify/functions";
import { checkAuth } from "../_auth-guard.ts";
import { CORS, getTraderConfig, getEffectiveTraderConfig, getEffectiveBtcExitConfig, getBtcExitConfig } from "./shared/config.mts";

// State-changing actions require a valid JWT cookie. Read-only `status` is
// public so the home page + per-venue dashboards can render without
// forcing login on every visitor.
//
// `run` is intentionally NOT in this set: the Netlify cron triggers
// `/auto-trader?action=run` every 3 min as an internal scheduled invocation
// without a cookie. Blocking `run` would silently disable the bot. Any
// abuse here is bounded — a `run` only fires the configured signal once
// against the existing session; it cannot mutate config or unblock a
// stopped session (those need `reset`/`resume`, which DO require auth).
const PROTECTED_ACTIONS = new Set(["reset", "stop", "resume"]);
import { log, getLogBuffer } from "./shared/logger.mts";
import { alertTradeOpen, alertTradeClosed, alertSessionStop, alertError, alertCalibrationNoise, alertLiveBlocked } from "./shared/telegram.mts";
import { computeLiveReadiness, shouldForcePaper, type LiveReadinessReport } from "./shared/live-readiness.mts";
import { PAPER_SIM_VERSION } from "./crypto/session-manager.mts";
import { findBtcMarkets } from "./crypto/btc-market-finder.mts";
import { aggregateSignals } from "./crypto/signal-aggregator.mts";
import { makeDecision, setCooldown } from "./crypto/decision-engine.mts";
import { placeBuyOrder } from "./crypto/execution.mts";
import { handleBuyLifecycle, handleSellLifecycle, checkExitConditions } from "./crypto/order-lifecycle.mts";
import { resolvePendingPaperPositions } from "./crypto/paper-resolver.mts";
import { fetchYesMidpoint } from "./crypto/live-price.mts";
import { markRunStart, markRunFinish, getCryptoRunStatus } from "./crypto/run-state.mts";
import {
  loadSession,
  saveSession,
  addOpenPosition,
  closePosition,
  stopSession,
  resetSession,
} from "./crypto/session-manager.mts";
import { computeCalibrationHealth } from "../edge-tracker/statistics.mts";
import type { SessionState, MarketInfo, SignalBreakdown, Position, EntryDecisionSnapshot } from "./shared/types.mts";
import { runWeatherTrader, getWeatherRunStatus } from "./weather/index.mts";
import { getWeatherConfig, getEffectiveWeatherConfig } from "./weather/decision-engine.mts";
import { runWeatherReconciler, getPendingPositions } from "./weather/reconciler.mts";
import {
  runHyperliquidTrader,
  getHlStatus,
  hlReset,
  hlStop,
  hlResume,
} from "./hyperliquid/index.mts";
import {
  runFundingArbLoop,
  getArbStatus,
  arbReset,
  arbStop,
  arbResume,
} from "./hyperliquid/funding-arb/index.mts";

const DEFAULT_BANKROLL = 150; // $150 USDC

// ─── Main handler ─────────────────────────────────────────

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    // Parse action + category (+ layer for hyperliquid)
    let action = "run";
    let category = "crypto";
    let layer = "directional";
    // Optional starting bankroll for reset — caller supplies the dashboard
    // input value here so reset mints a session with that bankroll instead
    // of falling back to the per-bot DEFAULT_BANKROLL.
    let bankrollOverride: number | undefined;
    // Netlify scheduled functions POST a body with `next_run` (ISO timestamp
    // of the next scheduled invocation). Detecting it here lets the run-state
    // tag direct cron ticks as "cron" even though netlify.toml doesn't let us
    // pin a `?source=cron` query string on the schedule.
    let isScheduledTick = false;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        action = body.action || "run";
        category = body.category || "crypto";
        layer = body.layer || "directional";
        if (typeof body.bankroll === "number" && Number.isFinite(body.bankroll)) {
          // Clamp into a sane range so a typo can't mint a million-dollar
          // session or a $0 one. Matches the min={10} on the dashboard input.
          bankrollOverride = Math.max(10, Math.min(1_000_000, body.bankroll));
        }
        if (typeof body.next_run === "string" && body.next_run.length > 0) {
          isScheduledTick = true;
        }
      } catch {
        action = "run";
      }
    } else if (req.method === "GET") {
      const url = new URL(req.url);
      action = url.searchParams.get("action") || "status";
      category = url.searchParams.get("category") || "crypto";
      layer = url.searchParams.get("layer") || "directional";
    }

    // Auth gate for state-changing actions (reset/stop/resume).
    if (PROTECTED_ACTIONS.has(action)) {
      const auth = await checkAuth(req);
      if (!auth.ok) return auth.error;
    }

    const config = getTraderConfig();

    // Route by category for all actions (each category has its own session)
    const cat = category === "weather"     ? "weather"
              : category === "hyperliquid" ? "hyperliquid"
              : "crypto";

    // Hyperliquid has its own self-contained dispatcher
    if (cat === "hyperliquid") {
      // `layer` selects between the directional trader and the funding-arb layer.
      // Default is directional for backwards compat; UI passes layer: "arb" for FR.
      if (layer === "arb") {
        switch (action) {
          case "run": {
            // ?source=cron lets the dispatcher tag the run-state as
            // cron-driven, so the UI status pill says "Scanning… (cron)".
            // Netlify scheduled invocations also count (`next_run` body).
            const url = new URL(req.url);
            const source: "manual" | "cron" =
              (url.searchParams.get("source") === "cron" || isScheduledTick) ? "cron" : "manual";
            return jsonResponse(await runFundingArbLoop(source));
          }
          case "status": return jsonResponse(await getArbStatus());
          case "reset":  return jsonResponse(await arbReset(bankrollOverride));
          case "stop":   return jsonResponse(await arbStop());
          case "resume": return jsonResponse(await arbResume());
          default:       return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
        }
      }

      switch (action) {
        case "run": {
          // Distinguish manual UI calls from the auto-trader-multi-cron
          // fan-out (or a direct Netlify schedule) so the live status pill
          // shows the right source.
          const url = new URL(req.url);
          const source: "manual" | "cron" =
            (url.searchParams.get("source") === "cron" || isScheduledTick) ? "cron" : "manual";
          return jsonResponse(await runHyperliquidTrader(undefined, source));
        }
        case "status": return jsonResponse(await getHlStatus());
        case "reset":  return jsonResponse(await hlReset(bankrollOverride));
        case "stop":   return jsonResponse(await hlStop());
        case "resume": return jsonResponse(await hlResume());
        default:       return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
      }
    }

    switch (action) {
      case "run":
        if (cat === "weather") {
          const wConfig = await getEffectiveWeatherConfig();
          // Same scheduled-vs-manual detection: weather has its own */5 cron
          // (`auto-trader-weather-cron`), but if anyone hits this dispatcher
          // with `category: "weather", action: "run"` from a schedule body,
          // tag it accordingly.
          const url = new URL(req.url);
          const source: "manual" | "cron" =
            (url.searchParams.get("source") === "cron" || isScheduledTick) ? "cron" : "manual";
          return jsonResponse(await runWeatherTrader(wConfig, source));
        }
        // The crypto trader records run-state itself so cron and manual
        // invocations both surface in the UI status pills. Three signals can
        // mark a run as cron-driven:
        //   1. ?source=cron query (multi-cron fan-out)
        //   2. internal _source override (legacy direct call)
        //   3. body.next_run from the Netlify scheduled invocation
        {
          const url = new URL(req.url);
          const source: "manual" | "cron" =
            (url.searchParams.get("source") === "cron"
              || (req as any)._source === "cron"
              || isScheduledTick)
              ? "cron"
              : "manual";
          return await runCryptoTrader(config, source);
        }
      case "status":
        return await getStatus(config, cat);
      case "reset":
        return await handleReset(config, cat, bankrollOverride);
      case "stop":
        return await handleStop(config, cat);
      case "reconcile":
        // Weather-only manual reconcile — let the user force a settlement
        // pass without waiting for the */15 cron tick.
        if (cat === "weather") {
          return jsonResponse(await runWeatherReconciler(config.paperMode));
        }
        return jsonResponse({ ok: false, error: "reconcile is weather-only" }, 400);
      default:
        return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
    }
  } catch (err: any) {
    log("ERROR", true, { error: err.message, stack: err.stack });
    await alertError(err.message);
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// ─── Crypto trader main loop ──────────────────────────────

async function runCryptoTrader(
  initialConfig: ReturnType<typeof getTraderConfig>,
  source: "manual" | "cron" = "manual",
) {
  // Mark "scanning" right away so the UI Idle→Scanning pill flips on the
  // very next status poll. Wrapped in try so a Blobs hiccup never blocks
  // the actual trade run.
  await markRunStart(source).catch(() => {});

  // Pull live overrides from the trader-settings store so paper-mode
  // tuning takes effect on the next cron tick without a redeploy.
  const baseConfig = await getEffectiveTraderConfig();
  // Mutable copy: the live-readiness gate below may flip paperMode back
  // to true if the session hasn't met validation thresholds yet.
  const config: typeof baseConfig = { ...baseConfig };
  const btcExit = await getEffectiveBtcExitConfig();
  // P1.3 OB-imbalance thresholds + market-finder knobs + live-readiness
  // thresholds (all override-able via /trader-settings). The paper-resolver
  // no longer takes any tunable: simVersion 3 closes paper positions only
  // on real Polymarket resolution, no simulator path.
  let obUp = 1.8, obDown = 0.55;
  let btcMinPriceBand      = 0.10;
  const readyOv: Record<string, number> = {};
  try {
    const mod: any = await import("../trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    if (typeof ov.obImbalanceUpRatio    === "number") obUp                 = ov.obImbalanceUpRatio;
    if (typeof ov.obImbalanceDownRatio  === "number") obDown               = ov.obImbalanceDownRatio;
    if (typeof ov.btcMinPriceBand       === "number") btcMinPriceBand      = ov.btcMinPriceBand;
    for (const k of ["liveReadyMinTrades", "liveReadyMinWinRate", "liveReadyMinIC", "liveReadyMaxCalibDev", "liveReadyMinSharpe", "liveReadyMaxDrawdownPct"]) {
      if (typeof ov[k] === "number") readyOv[k] = ov[k];
    }
  } catch {}
  let session = await loadSession(config.paperMode, DEFAULT_BANKROLL);

  // ─── Live-readiness gate ─────────────────────────────────
  // Even if PAPER_MODE=false is configured, the bot will not place real
  // money trades until the paper track record passes every applicable gate
  // (trade count, IC, calibration deviation, sharpe, drawdown, sim version,
  // session not stopped). When the gate trips we flip paperMode back to
  // true for this tick and fire a Telegram alarm once per session.
  const cryptoReadiness = computeLiveReadiness({
    category: "crypto",
    session,
    simVersionExpected: PAPER_SIM_VERSION,
    thresholds: {
      minTrades:         readyOv.liveReadyMinTrades,
      minWinRate:        readyOv.liveReadyMinWinRate,
      minIC:             readyOv.liveReadyMinIC,
      maxCalibrationDev: readyOv.liveReadyMaxCalibDev,
      minSharpe:         readyOv.liveReadyMinSharpe,
      maxDrawdownPct:    readyOv.liveReadyMaxDrawdownPct,
    } as any,
  });
  const cryptoForce = shouldForcePaper(config.paperMode, cryptoReadiness);
  if (cryptoForce.forcePaper) {
    config.paperMode = true;
    if (!session.calibrationAlertSentAt) {
      log("ERROR", true, { liveBlocked: true, category: "crypto", reason: cryptoForce.reason });
      const failed = cryptoReadiness.gates.filter((g) => g.applicable && !g.passed).map((g) => g.label);
      await alertLiveBlocked("crypto", cryptoForce.reason!, failed);
      session = { ...session, calibrationAlertSentAt: new Date().toISOString() };
      await saveSession(session);
    }
  }

  // Helper: persists the final result snapshot into the run-state store and
  // returns the HTTP response. Every early return below funnels through this
  // so the UI's "last run" pill always reflects what just happened. Also
  // embeds liveReadiness + the effective paperMode so the UI can render the
  // readiness badge from any of the cron tick payloads.
  const finish = async (payload: any, status = 200) => {
    const enriched = {
      ...payload,
      source,
      finishedAt: new Date().toISOString(),
      paperMode: config.paperMode,
      liveReadiness: cryptoReadiness,
    };
    await markRunFinish(enriched).catch(() => {});
    return jsonResponse(enriched, status);
  };

  // Resolve any open positions whose markets have resolved on Polymarket.
  // Both paper AND live: same Polymarket-settlement path (v3 invariant —
  // paper PnL == live PnL). Positions whose underlying market hasn't
  // published an outcome yet stay open. Live closes also book the PnL
  // into the session state, but on-chain USDC redemption needs a separate
  // /polymarket-redeem call (logged via PAPER_RESOLVED.requiresRedeem).
  if (session.openPositions.length > 0) {
    const r = await resolvePendingPaperPositions(session);
    session = r.session;
    if (r.resolutions.length > 0) {
      for (const res of r.resolutions) {
        const last = session.closedTrades[session.closedTrades.length - 1];
        if (last && last.market === res.market) {
          await alertTradeClosed(config.paperMode, last, session.sessionPnL, session.openPositions.length);
        }
      }
    }
  }

  // Live early-exit pass (TP / SL / hold-to-end): for live sessions only,
  // walk every still-open position, fetch current YES midpoint from CLOB,
  // and exit via handleSellLifecycle if checkExitConditions trips. Paper
  // mode INTENTIONALLY does not run this — paper PnL must equal eventual
  // settlement PnL, so an early-exit simulator would re-introduce the
  // halfway/Brownian artefacts the v3 contract removes.
  if (!config.paperMode && session.openPositions.length > 0) {
    const liveExitResults = await runLiveEarlyExits(session, btcExit);
    session = liveExitResults.session;
    for (const closed of liveExitResults.closed) {
      await alertTradeClosed(false, closed, session.sessionPnL, session.openPositions.length);
    }
  }

  // Calibration-noise alarm: when paper has accumulated ≥30 trades and every
  // signal still has |IC|<0.02, surface a Telegram alert (once per session)
  // and force-stop live sessions. Paper continues so the user can iterate.
  const health = computeCalibrationHealth(session.closedTrades, 30);
  if (health.shouldSuspendLive && !session.calibrationAlertSentAt) {
    log("CALIBRATION_ALARM", config.paperMode, {
      maxAbsIC: health.maxAbsIC,
      topSignal: health.topSignal,
      tradeCount: health.tradeCount,
      message: health.message,
    });
    await alertCalibrationNoise(config.paperMode, health.message, health.tradeCount, health.maxAbsIC);
    session = { ...session, calibrationAlertSentAt: new Date().toISOString() };
    if (!config.paperMode) {
      session = stopSession(session, `Calibration noise: ${health.message}`);
      await alertSessionStop(false, health.message, session);
      await saveSession(session);
      return await finish({
        ok: true,
        action: "stopped",
        reason: "calibration_noise",
        calibrationHealth: health,
        session: sessionSummary(session),
      });
    }
  }

  // Check if session is stopped
  if (session.stopped) {
    await saveSession(session);
    return await finish({
      ok: true,
      action: "skipped",
      reason: `Session stopped: ${session.stoppedReason}`,
      session: sessionSummary(session),
    });
  }

  // 1. Find active BTC markets (deep-OTM band filter applied)
  const markets = await findBtcMarkets(config.minOpenInterest, btcMinPriceBand);
  if (markets.length === 0) {
    return await finish({
      ok: true,
      action: "skipped",
      reason: "No active BTC Up/Down markets found",
      session: sessionSummary(session),
      config: traderConfigSummary(config, btcExit, btcMinPriceBand),
    });
  }

  let updatedSession = session;
  const results: any[] = [];
  // The scanner only acts on the top 3 markets per tick. Surface the rest
  // so the UI can still show "what else is out there" — same idea as
  // weather-trader's droppedEvents.
  const droppedMarkets = markets.slice(3).map((m) => ({
    slug: m.slug,
    title: m.title,
    currentPrice: m.currentPrice,
    volume24h: m.volume24h,
    endDate: m.endDate,
    reason: "below_top_3",
  }));

  // 2. Process each market
  for (const market of markets.slice(0, 3)) { // max 3 markets per run
    // Check session loss limit
    if (updatedSession.sessionLoss >= config.sessionLossLimit) {
      updatedSession = stopSession(updatedSession, "Session loss limit reached");
      await alertSessionStop(config.paperMode, "Session loss limit reached", updatedSession);
      break;
    }

    // Skip if already have an open position in this market
    if (updatedSession.openPositions.some((p) => p.market === market.slug)) {
      results.push({
        market: market.slug,
        title: market.title,
        action: "skip",
        reason: "Already has open position",
        marketPrice: market.currentPrice,
        endDate: market.endDate,
      });
      continue;
    }

    try {
      // 3. Aggregate signals
      const signal = await aggregateSignals(market.slug, { up: obUp, down: obDown });

      log("SIGNAL", config.paperMode, {
        market: market.slug,
        finalProb: signal.finalProb,
        marketPrice: market.currentPrice,
        edge: Math.abs(signal.finalProb - market.currentPrice),
        kelly: signal.kellyFraction,
        activeSignals: signal.activeSignals,
      });

      // 4. Make decision
      const decision = makeDecision(
        signal,
        market,
        updatedSession.bankrollCurrent,
        updatedSession.sessionLoss,
        config,
        btcExit,
      );

      // Common per-market context surfaced in the response so the UI can
      // explain *why* the bot acted the way it did, regardless of branch.
      const marketContext = {
        market: market.slug,
        title: market.title,
        marketPrice: market.currentPrice,
        predictedProb: signal.finalProb,
        edge: Math.abs(signal.finalProb - market.currentPrice),
        netEdge: decision.edge,
        direction: decision.direction,
        kelly: signal.kellyFraction,
        kellyUsed: decision.kellyUsed,
        activeSignals: signal.activeSignals,
        signalBreakdown: signal.signalBreakdown,
        obImbalance: signal.obImbalance ?? null,
        endDate: market.endDate,
      };

      if (!decision.shouldTrade) {
        log("DECISION_SKIP", config.paperMode, {
          market: market.slug,
          reason: decision.reason,
        });
        results.push({ ...marketContext, action: "skip", reason: decision.reason });
        continue;
      }

      log("DECISION_TRADE", config.paperMode, {
        market: market.slug,
        direction: decision.direction,
        size: decision.positionSizeUSDC,
        edge: decision.edge,
        kelly: decision.kellyUsed,
      });

      // 5. Execute buy
      const buyOrder = await placeBuyOrder(
        market,
        decision.direction,
        decision.entryPrice,
        decision.positionSizeUSDC,
        config.paperMode,
      );

      // 6. Handle buy lifecycle
      const position = await handleBuyLifecycle(buyOrder, market, config.paperMode);

      if (!position) {
        results.push({ ...marketContext, action: "failed", reason: "Buy order not filled" });
        continue;
      }

      // Build the full decision snapshot so the UI can answer "why did the
      // bot enter this?" later — every gate, the kelly math, the signal mix
      // and the OB imbalance are all preserved on the position record.
      const grossEdge = Math.abs(signal.finalProb - market.currentPrice);
      const entryDecision: EntryDecisionSnapshot = {
        decidedAt:        new Date().toISOString(),
        finalProb:        signal.finalProb,
        marketPrice:      market.currentPrice,
        grossEdge,
        netEdge:          decision.edge,
        feePct:           config.roundtripFeePct,
        direction:        decision.direction,
        kellyRaw:         signal.kellyFraction,
        kellyCapped:      decision.kellyUsed,
        kellyCap:         config.maxKellyFraction,
        positionSizeUSDC: decision.positionSizeUSDC,
        entryPrice:       decision.entryPrice,
        activeSignals:    signal.activeSignals,
        signalBreakdown:  signal.signalBreakdown,
        obImbalance:      signal.obImbalance ?? null,
        gates:            decision.gates ?? [],
        reason:           decision.reason,
      };

      // Attach resolver + live-exit metadata so the next cron tick can:
      //   - close this position via real Polymarket settlement (paper +
      //     live alike — paper-resolver path);
      //   - in live mode, also evaluate TP/SL via checkExitConditions and
      //     drive a CLOB sell through handleSellLifecycle. clobTokenIds
      //     is mandatory for the live early-exit path.
      const paperPosition: Position = {
        ...position,
        clobTokenIds:       market.clobTokenIds,
        conditionId:        market.conditionId,
        endDate:            market.endDate,
        marketPriceAtEntry: market.currentPrice,
        predictedProb:      signal.finalProb,
        signalBreakdown:    signal.signalBreakdown,
        category:           "crypto",
        entryDecision,
      };

      // 7. Update session with open position
      updatedSession = addOpenPosition(updatedSession, paperPosition);
      setCooldown(market.slug);

      // Format signal arrows for telegram
      const signalArrows = formatSignalArrows(signal.signalBreakdown);

      await alertTradeOpen(
        config.paperMode,
        market.title,
        decision.direction,
        decision.entryPrice,
        decision.positionSizeUSDC,
        updatedSession.bankrollCurrent + decision.positionSizeUSDC,
        decision.edge,
        decision.kellyUsed,
        signalArrows,
      );

      // 8. Position is now open. In both paper and live modes the exit is
      //    handled by a separate path that observes real market dynamics:
      //    - paper: resolvePendingPaperPositions (real Polymarket resolution
      //             or a Brownian-bridge fallback, neither of which uses
      //             finalProb — so signal IC stays meaningful)
      //    - live:  the existing sell-side lifecycle (TP/SL polling,
      //             emergency FOK, etc.)
      results.push({
        ...marketContext,
        action: "position_opened",
        entry: decision.entryPrice,
        size: decision.positionSizeUSDC,
        paperMode: config.paperMode,
      });
    } catch (err: any) {
      log("ERROR", config.paperMode, { market: market.slug, error: err.message });
      results.push({ market: market.slug, title: market.title, action: "error", error: err.message });
    }
  }

  // Save session state
  await saveSession(updatedSession);

  return await finish({
    ok: true,
    action: "run",
    paperMode: config.paperMode,
    marketsScanned: markets.length,
    marketsConsidered: Math.min(markets.length, 3),
    results,
    droppedMarkets,
    config: traderConfigSummary(config, btcExit, btcMinPriceBand),
    session: sessionSummary(updatedSession),
  });
}

// ─── Live early-exit pass (TP/SL/hold-to-end) ─────────────────────────
// Runs ONCE per cron tick, before the entry scanner, on every still-open
// LIVE position. For each position:
//   1. Pull the current YES midpoint from CLOB.
//   2. Run the pure checkExitConditions() against (TP, SL, hold-to-end).
//   3. If shouldExit → handleSellLifecycle() places a real GTC sell at
//      the position-side price; on timeout it falls back to FOK at best
//      bid via emergencySell.
//   4. Apply the resulting ClosedTrade to the session (closePosition
//      mutates bankroll + sessionPnL + sessionLoss + tradeCount).
//
// Paper mode does NOT call this — paper closes only at real Polymarket
// settlement (paper-resolver), which is the v3 "paper PnL == live PnL"
// invariant. Adding a paper TP/SL would re-introduce the kind of
// halfway-toward-prediction artefacts that v1/v2 produced.
// Max live exits to drive per cron tick. Each handleSellLifecycle poll loop
// is up to ~30s (GTC) + emergency FOK; processing too many serially would
// blow the Netlify scheduled-function budget. Positions skipped this tick
// are picked up next tick (cron is */3 min), and the settlement resolver
// closes them at outcome regardless.
const LIVE_EXIT_BUDGET_PER_TICK = 3;

async function runLiveEarlyExits(
  session: SessionState,
  btcExit: ReturnType<typeof getBtcExitConfig>,
): Promise<{ session: SessionState; closed: import("./shared/types.mts").ClosedTrade[] }> {
  let updated = session;
  const closed: import("./shared/types.mts").ClosedTrade[] = [];

  // Sort by endDate ASC so positions closest to settlement are evaluated
  // first — those have the tightest exit window.
  const queue = [...session.openPositions].sort((a, b) => {
    const ea = a.endDate ? new Date(a.endDate).getTime() : Infinity;
    const eb = b.endDate ? new Date(b.endDate).getTime() : Infinity;
    return ea - eb;
  }).slice(0, LIVE_EXIT_BUDGET_PER_TICK);

  for (const pos of queue) {
    // We need both YES + NO clob token ids to drive placeSellOrder. Skip
    // positions opened before clobTokenIds was added — the next
    // settlement-resolver tick will close them at outcome.
    if (!pos.clobTokenIds || pos.clobTokenIds.length !== 2) {
      log("ORDER_REJECTED", false, {
        market: pos.market,
        reason: "live_early_exit_skipped: missing clobTokenIds",
      });
      continue;
    }

    // Always resolve via the YES tokenId so the midpoint semantics are
    // unambiguous (positionPrice = NO ? 1 - mid : mid in checkExitConditions).
    const yesTokenId = pos.clobTokenIds[0];
    const yesMid = await fetchYesMidpoint(yesTokenId);
    if (yesMid === null) {
      log("ORDER_REJECTED", false, {
        market: pos.market,
        reason: "live_early_exit_skipped: no midpoint",
      });
      continue;
    }

    const minimalMarket: MarketInfo = {
      slug:          pos.market,
      conditionId:   pos.conditionId ?? "",
      questionId:    "",
      title:         pos.market,
      clobTokenIds:  pos.clobTokenIds,
      currentPrice:  yesMid,
      openInterest:  0,
      volume24h:     0,
      endDate:       pos.endDate ?? "",
      active:        true,
    };

    const decision = checkExitConditions(pos, minimalMarket, yesMid, Date.now(), btcExit);
    if (!decision.shouldExit) continue;

    const trade = await handleSellLifecycle(pos, minimalMarket, decision.exitPrice, false);
    // Carry over the entry context onto the closed trade (handleSellLifecycle
    // builds the bare PnL skeleton and doesn't see entryDecision/predictedProb).
    const enriched: import("./shared/types.mts").ClosedTrade = {
      ...trade,
      category:           pos.category ?? "crypto",
      predictedProb:      pos.predictedProb,
      marketPriceAtEntry: pos.marketPriceAtEntry,
      edgeAtEntry:
        pos.predictedProb !== undefined && pos.marketPriceAtEntry !== undefined
          ? Math.abs(pos.predictedProb - pos.marketPriceAtEntry)
          : undefined,
      signalBreakdown:    pos.signalBreakdown ?? null,
    };
    updated = closePosition(updated, pos.buyOrderId, enriched);
    closed.push(enriched);
    log("TRADE_CLOSED", false, {
      market: pos.market,
      reason: decision.reason,
      exitPrice: trade.exitPrice,
      pnl: Math.round(trade.pnl * 100) / 100,
    });
  }

  return { session: updated, closed };
}

// ─── Status endpoint ──────────────────────────────────────

async function getStatus(config: ReturnType<typeof getTraderConfig>, category: string = "crypto") {
  const session = await loadSession(config.paperMode, DEFAULT_BANKROLL, category);
  const base: any = {
    ok: true,
    action: "status",
    category,
    session: sessionSummary(session),
    recentLogs: getLogBuffer().slice(-20),
  };

  // Live-readiness gate verdict — surfaced for every category so each
  // trader page can render a uniform "READY / NOT READY" badge.
  let readyOv: any = {};
  try {
    const mod: any = await import("../trader-settings.mts");
    readyOv = (await mod.loadRuntimeOverrides()) ?? {};
  } catch {}
  const thresholds = {
    minTrades:         readyOv.liveReadyMinTrades,
    minWinRate:        readyOv.liveReadyMinWinRate,
    minIC:             readyOv.liveReadyMinIC,
    maxCalibrationDev: readyOv.liveReadyMaxCalibDev,
    minSharpe:         readyOv.liveReadyMinSharpe,
    maxDrawdownPct:    readyOv.liveReadyMaxDrawdownPct,
  } as any;
  base.liveReadiness = computeLiveReadiness({
    category: category as any,
    session,
    simVersionExpected: category === "crypto" ? PAPER_SIM_VERSION : null,
    thresholds,
  });

  // Surface weather-specific live status: lastRun timestamp, currently-
  // scanning flag, and the most recent run summary. Powers the UI badge.
  if (category === "weather") {
    base.runStatus = await getWeatherRunStatus();
    const wcfg = await getEffectiveWeatherConfig();
    base.cronEnabled = wcfg.cronEnabled;
    // Past-METAR-window positions awaiting settlement.
    base.pending = await getWeatherPendingForSettlement(config.paperMode);
    // Active positions still in the trading window (reconcileAfter in the future).
    base.openDetails = getWeatherOpenActive(session);
  } else if (category === "crypto") {
    // Same status payload shape as weather: the UI's status cluster reads
    // the same fields regardless of venue.
    base.runStatus   = await getCryptoRunStatus();
    base.cronEnabled = true; // crypto cron (auto-trader */3) is always on
    // Past-endDate paper positions awaiting Polymarket resolution. simVersion
    // 3 has no simulator fallback — positions stay open until Gamma publishes
    // outcomePrices ∈ {0,1}.
    base.pending = getCryptoPendingPositions(session);
    // Active positions still in the trading window.
    base.openDetails = getCryptoOpenActive(session);
  }
  return jsonResponse(base);
}

// Active (still-trading-window) open positions for the crypto bot.
function getCryptoOpenActive(session: SessionState) {
  const now = Date.now();
  return session.openPositions
    .filter((p) => !p.endDate || new Date(p.endDate).getTime() >= now)
    .map((p) => ({
      market:             p.market,
      title:              (p as any).title ?? null,
      direction:          p.direction,
      size:               p.costBasis,
      avgEntry:           p.avgEntry,
      shares:             p.shares,
      openedAt:           p.openedAt,
      endDate:            p.endDate ?? null,
      marketPriceAtEntry: p.marketPriceAtEntry ?? null,
      predictedProb:      p.predictedProb ?? null,
      entryDecision:      p.entryDecision ?? null,
    }))
    .sort((a, b) => (a.endDate ?? "").localeCompare(b.endDate ?? ""));
}

// Active (still-future-reconcile) weather positions and the past-METAR
// pending list — both are derived from the same session.openPositions array,
// split by reconcileAfter.
function getWeatherOpenActive(session: SessionState) {
  const now = Date.now();
  return session.openPositions
    .filter((p) => p.weatherMeta && new Date(p.weatherMeta.reconcileAfter).getTime() > now)
    .map((p) => ({
      market:        p.market,
      city:          p.weatherMeta!.city,
      date:          p.weatherMeta!.date,
      bucket:        p.weatherMeta!.bucketLabel,
      direction:     p.direction,
      size:          p.costBasis,
      avgEntry:      p.avgEntry,
      predictedMaxC: p.weatherMeta!.predictedMaxC,
      openedAt:      p.openedAt,
      reconcileAfter: p.weatherMeta!.reconcileAfter,
      entryDecision: p.entryDecision ?? null,
    }))
    .sort((a, b) => a.reconcileAfter.localeCompare(b.reconcileAfter));
}

async function getWeatherPendingForSettlement(paperMode: boolean) {
  const all = await getPendingPositions(paperMode);
  const ready = all.positions.filter((p: any) => p.isReady);
  return { count: ready.length, nextReconcileAt: ready[0]?.reconcileAfter ?? null, positions: ready };
}

// Pending paper-position view for the crypto bot.
//
// Lists open positions whose endDate has elapsed but Polymarket hasn't
// published a resolved outcome yet. Each */3 auto-trader cron tick re-queries
// Gamma; when the market settles the position closes on the next tick. There
// is no simulator fallback — a position can sit here for the full UMA
// resolution window (5–60 min typical, occasionally hours during disputes).
function getCryptoPendingPositions(session: SessionState) {
  const now = Date.now();
  const past = session.openPositions
    .filter((p) => p.endDate && new Date(p.endDate).getTime() < now)
    .map((p) => {
      const endTs = new Date(p.endDate!).getTime();
      return {
        market:             p.market,
        title:              (p as any).title ?? null,
        direction:          p.direction,
        size:               p.costBasis,
        endDate:            p.endDate!,
        marketPriceAtEntry: p.marketPriceAtEntry ?? null,
        predictedProb:      p.predictedProb ?? null,
        ageMs:              now - endTs,
      };
    })
    .sort((a, b) => a.endDate.localeCompare(b.endDate));
  return {
    count: past.length,
    nextReconcileAt: past[0]?.endDate ?? null,
    positions: past,
  };
}

// ─── Reset session ────────────────────────────────────────

async function handleReset(
  config: ReturnType<typeof getTraderConfig>,
  category: string = "crypto",
  bankrollOverride?: number,
) {
  // Per-category default: weather sessions historically started at $100,
  // crypto at $150. The dashboard input wins when supplied.
  const fallback = category === "weather" ? 100 : DEFAULT_BANKROLL;
  const bankroll = bankrollOverride ?? fallback;
  const session = resetSession(bankroll, config.paperMode);
  await saveSession(session, category);
  return jsonResponse({
    ok: true,
    action: "reset",
    category,
    session: sessionSummary(session),
  });
}

// ─── Stop session ─────────────────────────────────────────

async function handleStop(config: ReturnType<typeof getTraderConfig>, category: string = "crypto") {
  const session = await loadSession(config.paperMode, DEFAULT_BANKROLL, category);
  const stopped = stopSession(session, "Manual stop");
  await saveSession(stopped, category);
  await alertSessionStop(config.paperMode, "Manual stop", stopped);
  return jsonResponse({
    ok: true,
    action: "stopped",
    category,
    session: sessionSummary(stopped),
  });
}

// ─── Helpers ──────────────────────────────────────────────

function traderConfigSummary(
  config: ReturnType<typeof getTraderConfig>,
  btcExit: ReturnType<typeof getEffectiveBtcExitConfig> extends Promise<infer T> ? T : never,
  btcMinPriceBand: number,
) {
  return {
    edgeThreshold:    config.edgeThreshold,
    maxKellyFraction: config.maxKellyFraction,
    cooldownSeconds:  config.cooldownSeconds,
    sessionLossLimit: config.sessionLossLimit,
    minOpenInterest:  config.minOpenInterest,
    roundtripFeePct:  config.roundtripFeePct,
    paperMode:        config.paperMode,
    btcTpTarget:      btcExit.tpTarget,
    btcSlTarget:      btcExit.slTarget,
    btcMinPriceBand,
    btcEntryWindowStartMs: btcExit.entryWindowStartMs,
    btcEntryWindowEndMs:   btcExit.entryWindowEndMs,
  };
}

function sessionSummary(s: SessionState) {
  return {
    paperMode: s.paperMode,
    stopped: s.stopped,
    stoppedReason: s.stoppedReason,
    bankrollStart: s.bankrollStart,
    bankrollCurrent: Math.round(s.bankrollCurrent * 100) / 100,
    sessionPnL: Math.round(s.sessionPnL * 100) / 100,
    sessionLoss: Math.round(s.sessionLoss * 100) / 100,
    tradeCount: s.tradeCount,
    closedTrades: s.closedTrades.length,
    openPositions: s.openPositions.length,
    startedAt: s.startedAt,
    // simVersion is needed by run-state.mts:getCryptoRunStatus to invalidate
    // stale lastResult snapshots written under an older paper simulator.
    simVersion: s.simVersion ?? null,
  };
}

function formatSignalArrows(breakdown: SignalBreakdown): string {
  const arrows: string[] = [];
  if (breakdown.funding_rate   !== null) arrows.push(`FR${breakdown.funding_rate     > 0.5 ? "↑" : "↓"}`);
  if (breakdown.orderflow      !== null) arrows.push(`VPIN${breakdown.orderflow      > 0.5 ? "↑" : "↓"}`);
  if (breakdown.vol_divergence !== null) arrows.push(`VOL${breakdown.vol_divergence  > 0.5 ? "↑" : "↓"}`);
  if (breakdown.apex_consensus !== null) arrows.push(`APEX${breakdown.apex_consensus > 0.5 ? "↑" : "↓"}`);
  if (breakdown.cond_prob      !== null) arrows.push(`CP${breakdown.cond_prob        > 0.5 ? "↑" : "↓"}`);
  if (breakdown.momentum       !== null) arrows.push(`MOM${breakdown.momentum        > 0.5 ? "↑" : "↓"}`);
  if (breakdown.contrarian     !== null) arrows.push(`CTR${breakdown.contrarian      > 0.5 ? "↑" : "↓"}`);
  if (breakdown.pairs_spread   !== null) arrows.push(`PRS${breakdown.pairs_spread    > 0.5 ? "↑" : "↓"}`);
  return arrows.join(" ") || "–";
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS,
  });
}
