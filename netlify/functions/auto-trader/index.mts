// netlify/functions/auto-trader/index.ts
// POST /.netlify/functions/auto-trader  { action: "run" | "status" | "reset" | "stop" }
// Scheduled: every 3 minutes (configure in netlify.toml)
//
// Main entry point for the EdgeCalc Auto-Trader.
// Sprint 1: only crypto category is active.

import type { Context } from "@netlify/functions";
import { checkAuth } from "../_auth-guard.ts";
import { CORS, getTraderConfig, getEffectiveTraderConfig, getEffectiveBtcExitConfig } from "./shared/config.mts";

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
import { handleBuyLifecycle } from "./crypto/order-lifecycle.mts";
import { resolvePendingPaperPositions } from "./crypto/paper-resolver.mts";
import { markRunStart, markRunFinish, getCryptoRunStatus } from "./crypto/run-state.mts";
import {
  loadSession,
  saveSession,
  addOpenPosition,
  stopSession,
  resetSession,
} from "./crypto/session-manager.mts";
import { computeCalibrationHealth } from "../edge-tracker/statistics.mts";
import type { SessionState, MarketInfo, SignalBreakdown, Position } from "./shared/types.mts";
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
    if (req.method === "POST") {
      try {
        const body = await req.json();
        action = body.action || "run";
        category = body.category || "crypto";
        layer = body.layer || "directional";
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
          case "run":    return jsonResponse(await runFundingArbLoop());
          case "status": return jsonResponse(await getArbStatus());
          case "reset":  return jsonResponse(await arbReset());
          case "stop":   return jsonResponse(await arbStop());
          case "resume": return jsonResponse(await arbResume());
          default:       return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
        }
      }

      switch (action) {
        case "run": {
          // Distinguish manual UI calls from the auto-trader-multi-cron
          // fan-out so the live status pill shows the right source.
          const url = new URL(req.url);
          const source: "manual" | "cron" =
            url.searchParams.get("source") === "cron" ? "cron" : "manual";
          return jsonResponse(await runHyperliquidTrader(undefined, source));
        }
        case "status": return jsonResponse(await getHlStatus());
        case "reset":  return jsonResponse(await hlReset());
        case "stop":   return jsonResponse(await hlStop());
        case "resume": return jsonResponse(await hlResume());
        default:       return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
      }
    }

    switch (action) {
      case "run":
        if (cat === "weather") {
          const wConfig = await getEffectiveWeatherConfig();
          return jsonResponse(await runWeatherTrader(wConfig, "manual"));
        }
        // The crypto trader records run-state itself so cron and manual
        // invocations both surface in the UI status pills. Source defaults
        // to "manual" — the cron caller passes `?source=cron`.
        {
          const url = new URL(req.url);
          const source: "manual" | "cron" =
            (url.searchParams.get("source") === "cron" || (req as any)._source === "cron")
              ? "cron"
              : "manual";
          return await runCryptoTrader(config, source);
        }
      case "status":
        return await getStatus(config, cat);
      case "reset":
        return await handleReset(config, cat);
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
  // P1.3 OB-imbalance thresholds + paper-resolver / market-finder knobs +
  // live-readiness thresholds (all override-able via /trader-settings).
  let obUp = 1.8, obDown = 0.55;
  let paperFallbackAfterMs = 30 * 60 * 1000;
  let paperBrownianSigma   = 0.45;
  let btcMinPriceBand      = 0.10;
  const readyOv: Record<string, number> = {};
  try {
    const mod: any = await import("../trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    if (typeof ov.obImbalanceUpRatio    === "number") obUp                 = ov.obImbalanceUpRatio;
    if (typeof ov.obImbalanceDownRatio  === "number") obDown               = ov.obImbalanceDownRatio;
    if (typeof ov.paperFallbackAfterMs  === "number") paperFallbackAfterMs = ov.paperFallbackAfterMs;
    if (typeof ov.paperBrownianSigma    === "number") paperBrownianSigma   = ov.paperBrownianSigma;
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

  // Resolve any open paper positions whose markets have ended. Real
  // Polymarket resolution is preferred; the Brownian-bridge fallback is
  // only used after `paperFallbackAfterMs` ms past endDate and is itself
  // independent of `finalProb`, so the IC computation remains meaningful.
  if (config.paperMode && session.openPositions.length > 0) {
    const r = await resolvePendingPaperPositions(session, {
      tpTarget:        btcExit.tpTarget,
      slTarget:        btcExit.slTarget,
      fallbackAfterMs: paperFallbackAfterMs,
      brownianSigma:   paperBrownianSigma,
    });
    session = r.session;
    if (r.resolutions.length > 0) {
      // Best-effort Telegram for closed paper trades — re-use the existing helper.
      for (const res of r.resolutions) {
        const last = session.closedTrades[session.closedTrades.length - 1];
        if (last && last.market === res.market) {
          await alertTradeClosed(true, last, session.sessionPnL, session.openPositions.length);
        }
      }
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

      // Attach paper-resolver metadata so the next cron tick can close this
      // position using real Polymarket resolution data (or, after a stale
      // window, the finalProb-independent Brownian-bridge fallback).
      const paperPosition: Position = {
        ...position,
        conditionId:        market.conditionId,
        endDate:            market.endDate,
        marketPriceAtEntry: market.currentPrice,
        predictedProb:      signal.finalProb,
        signalBreakdown:    signal.signalBreakdown,
        category:           "crypto",
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
    // Pending paper positions awaiting Polymarket settlement / METAR fallback.
    base.pending = await getPendingPositions(config.paperMode);
  } else if (category === "crypto") {
    // Same status payload shape as weather: the UI's status cluster reads
    // the same fields regardless of venue.
    base.runStatus   = await getCryptoRunStatus();
    base.cronEnabled = true; // crypto cron (auto-trader */3) is always on
  }
  return jsonResponse(base);
}

// ─── Reset session ────────────────────────────────────────

async function handleReset(config: ReturnType<typeof getTraderConfig>, category: string = "crypto") {
  const session = resetSession(DEFAULT_BANKROLL, config.paperMode);
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
  };
}

function formatSignalArrows(breakdown: SignalBreakdown): string {
  const arrows: string[] = [];
  if (breakdown.funding_rate !== null) arrows.push(`FR${breakdown.funding_rate > 0.5 ? "↑" : "↓"}`);
  if (breakdown.orderflow !== null) arrows.push(`VPIN${breakdown.orderflow > 0.5 ? "↑" : "↓"}`);
  if (breakdown.vol_divergence !== null) arrows.push(`VOL${breakdown.vol_divergence > 0.5 ? "↑" : "↓"}`);
  if (breakdown.apex_consensus !== null) arrows.push(`APEX${breakdown.apex_consensus > 0.5 ? "↑" : "↓"}`);
  if (breakdown.cond_prob !== null) arrows.push(`CP${breakdown.cond_prob > 0.5 ? "↑" : "↓"}`);
  return arrows.join(" ") || "–";
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS,
  });
}
