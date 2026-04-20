// netlify/functions/auto-trader/index.ts
// POST /.netlify/functions/auto-trader  { action: "run" | "status" | "reset" | "stop" }
// Scheduled: every 3 minutes (configure in netlify.toml)
//
// Main entry point for the EdgeCalc Auto-Trader.
// Sprint 1: only crypto category is active.

import type { Context } from "@netlify/functions";
import { CORS, getTraderConfig } from "./shared/config.mts";
import { log, getLogBuffer } from "./shared/logger.mts";
import { alertTradeOpen, alertTradeClosed, alertSessionStop, alertError } from "./shared/telegram.mts";
import { findBtcMarkets } from "./crypto/btc-market-finder.mts";
import { aggregateSignals } from "./crypto/signal-aggregator.mts";
import { makeDecision, setCooldown } from "./crypto/decision-engine.mts";
import { placeBuyOrder } from "./crypto/execution.mts";
import { handleBuyLifecycle, handleSellLifecycle } from "./crypto/order-lifecycle.mts";
import {
  loadSession,
  saveSession,
  addOpenPosition,
  closePosition,
  stopSession,
  resetSession,
} from "./crypto/session-manager.mts";
import type { SessionState, MarketInfo, SignalBreakdown } from "./shared/types.mts";
import { runWeatherTrader } from "./weather/index.mts";
import { getWeatherConfig } from "./weather/decision-engine.mts";
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
        case "run":    return jsonResponse(await runHyperliquidTrader());
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
          const wConfig = getWeatherConfig();
          return jsonResponse(await runWeatherTrader(wConfig));
        }
        return await runCryptoTrader(config);
      case "status":
        return await getStatus(config, cat);
      case "reset":
        return await handleReset(config, cat);
      case "stop":
        return await handleStop(config, cat);
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

async function runCryptoTrader(config: ReturnType<typeof getTraderConfig>) {
  const session = await loadSession(config.paperMode, DEFAULT_BANKROLL);

  // Check if session is stopped
  if (session.stopped) {
    return jsonResponse({
      ok: true,
      action: "skipped",
      reason: `Session stopped: ${session.stoppedReason}`,
      session: sessionSummary(session),
    });
  }

  // 1. Find active BTC markets
  const markets = await findBtcMarkets(config.minOpenInterest);
  if (markets.length === 0) {
    return jsonResponse({
      ok: true,
      action: "skipped",
      reason: "No active BTC Up/Down markets found",
      session: sessionSummary(session),
    });
  }

  let updatedSession = session;
  const results: any[] = [];

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
      results.push({ market: market.slug, action: "skip", reason: "Already has open position" });
      continue;
    }

    try {
      // 3. Aggregate signals
      const signal = await aggregateSignals(market.slug);

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
      );

      if (!decision.shouldTrade) {
        log("DECISION_SKIP", config.paperMode, {
          market: market.slug,
          reason: decision.reason,
        });
        results.push({ market: market.slug, action: "skip", reason: decision.reason });
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
        results.push({ market: market.slug, action: "failed", reason: "Buy order not filled" });
        continue;
      }

      // 7. Update session with open position
      updatedSession = addOpenPosition(updatedSession, position);
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

      // 8. In paper mode, immediately simulate sell at resolved price
      if (config.paperMode) {
        // Simulate: market resolves at final_prob (simplified paper logic)
        const exitPrice = simulatePaperExit(signal.finalProb, market.currentPrice, decision.direction);

        const trade = await handleSellLifecycle(
          position,
          market,
          exitPrice,
          config.paperMode,
        );

        // Enrich trade with Edge Tracker metadata
        trade.category = "crypto";
        trade.predictedProb = signal.finalProb;
        trade.marketPriceAtEntry = market.currentPrice;
        trade.edgeAtEntry = decision.edge;
        trade.signalBreakdown = signal.signalBreakdown;

        updatedSession = closePosition(updatedSession, position.buyOrderId, trade);

        await alertTradeClosed(
          config.paperMode,
          trade,
          updatedSession.sessionPnL,
          updatedSession.openPositions.length,
        );

        results.push({
          market: market.slug,
          action: "traded",
          direction: decision.direction,
          entry: decision.entryPrice,
          exit: exitPrice,
          pnl: trade.pnl,
          edge: decision.edge,
        });
      } else {
        results.push({
          market: market.slug,
          action: "position_opened",
          direction: decision.direction,
          entry: decision.entryPrice,
          size: decision.positionSizeUSDC,
        });
      }
    } catch (err: any) {
      log("ERROR", config.paperMode, { market: market.slug, error: err.message });
      results.push({ market: market.slug, action: "error", error: err.message });
    }
  }

  // Save session state
  await saveSession(updatedSession);

  return jsonResponse({
    ok: true,
    action: "run",
    paperMode: config.paperMode,
    marketsScanned: markets.length,
    results,
    session: sessionSummary(updatedSession),
  });
}

// ─── Status endpoint ──────────────────────────────────────

async function getStatus(config: ReturnType<typeof getTraderConfig>, category: string = "crypto") {
  const session = await loadSession(config.paperMode, DEFAULT_BANKROLL, category);
  return jsonResponse({
    ok: true,
    action: "status",
    category,
    session: sessionSummary(session),
    recentLogs: getLogBuffer().slice(-20),
  });
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

function simulatePaperExit(
  finalProb: number,
  marketPrice: number,
  direction: "YES" | "NO",
): number {
  // Paper mode simulation: price moves halfway toward our predicted probability
  // This is conservative — real markets may move more or less
  if (direction === "YES") {
    return Math.min(0.99, marketPrice + (finalProb - marketPrice) * 0.5);
  } else {
    const noPrice = 1 - marketPrice;
    const noPredicted = 1 - finalProb;
    return Math.min(0.99, noPrice + (noPredicted - noPrice) * 0.5);
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS,
  });
}
