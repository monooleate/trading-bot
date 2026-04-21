import { log } from "../shared/logger.mts";
import { alertError } from "../shared/telegram.mts";
import { findWeatherMarkets } from "./market-finder.mts";
import type { WeatherMarket } from "./market-finder.mts";
import { getStation, getSeason } from "./station-config.mts";
import { getForecast } from "./forecast-engine.mts";
import { detectModelLag } from "./model-lag-detector.mts";
import { matchBucket } from "./bucket-matcher.mts";
import { makeWeatherDecision, getWeatherConfig } from "./decision-engine.mts";
import { recordDebSample } from "./deb.mts";
import type { WeatherTradeDecision, WeatherConfig } from "./decision-engine.mts";
import { placeBuyOrder } from "../crypto/execution.mts";
import {
  loadSession,
  saveSession,
  addOpenPosition,
  closePosition,
  resetSession,
  stopSession,
} from "../crypto/session-manager.mts";
import type { MarketInfo, Position, ClosedTrade } from "../shared/types.mts";

const DEFAULT_BANKROLL = 100;

// ─── Telegram weather alerts ──────────────────────────────

async function sendWeatherAlert(
  decision: WeatherTradeDecision,
  paper: boolean,
): Promise<void> {
  // Use the shared telegram module but with weather-specific format
  // For now just log — full Telegram formatting in next iteration
  log("SIGNAL", paper, {
    type: "weather",
    city: decision.city,
    date: decision.date,
    bucket: decision.bucketLabel,
    predictedTemp: decision.predictedTemp,
    marketPrice: decision.marketPrice,
    edge: decision.edge,
    confidence: decision.confidence,
    modelLag: decision.modelLagMinutes,
  });
}

// ─── Convert WeatherMarket to MarketInfo for execution ────

function toMarketInfo(wm: WeatherMarket, tokenId: string): MarketInfo {
  return {
    slug: wm.slug,
    conditionId: wm.conditionId,
    questionId: "",
    title: wm.title,
    clobTokenIds: [tokenId, ""], // YES token, NO not used directly
    currentPrice: wm.outcomes.find((o) => o.tokenId === tokenId)?.currentPrice || 0.5,
    openInterest: 0,
    volume24h: wm.volume24h,
    endDate: wm.endDate,
    active: true,
  };
}

// ─── Main weather trading loop ────────────────────────────

export async function runWeatherTrader(config: WeatherConfig) {
  const session = await loadSession(config.paperMode, DEFAULT_BANKROLL, "weather");

  if (session.stopped) {
    return {
      ok: true,
      action: "skipped",
      reason: `Session stopped: ${session.stoppedReason}`,
      session: summarize(session),
    };
  }

  // 1. Check model lag
  const modelLag = detectModelLag();
  if (modelLag.nearBoundary) {
    return {
      ok: true,
      action: "skipped",
      reason: "Near model update boundary, waiting",
      modelLag,
      session: summarize(session),
    };
  }

  // 2. Find weather markets
  const markets = await findWeatherMarkets();
  if (markets.length === 0) {
    return {
      ok: true,
      action: "skipped",
      reason: "No active weather temperature markets found",
      session: summarize(session),
    };
  }

  let updatedSession = session;
  const results: any[] = [];

  // 3. Process each market
  for (const market of markets.slice(0, 5)) {
    // Skip if already have a position
    if (updatedSession.openPositions.some((p) => p.market === market.slug)) {
      results.push({ market: market.slug, action: "skip", reason: "Already has open position" });
      continue;
    }

    try {
      const station = getStation(market.city);
      if (!station) {
        results.push({ market: market.slug, action: "skip", reason: `Unknown city: ${market.city}` });
        continue;
      }

      // 4. Get forecast
      const forecast = await getForecast(market.city, station, market.date);

      log("SIGNAL", config.paperMode, {
        type: "weather_forecast",
        city: market.city,
        date: market.date,
        predicted: forecast.predictedMaxC,
        gfs: forecast.rawGfsMaxC,
        ecmwf: forecast.rawEcmwfMaxC,
        noaa: forecast.rawNoaaMaxC,
        confidence: forecast.confidence,
        cloud: forecast.cloudCoverPct,
      });

      // 5. Match to bucket
      const sigma = forecast.cloudCoverPct > 60 ? 1.5 : 1.0;
      const match = matchBucket(forecast.predictedMaxC, market.outcomes, sigma);
      if (!match) {
        results.push({ market: market.slug, action: "skip", reason: "No matching bucket" });
        continue;
      }

      // 6. Calculate time to resolution
      const endTime = new Date(market.endDate).getTime();
      const timeToResolutionMin = Math.max(0, (endTime - Date.now()) / 60000);

      // 7. Make decision
      const decision = makeWeatherDecision({
        forecast,
        match,
        modelLag,
        timeToResolutionMin,
        bankrollUSDC: updatedSession.bankrollCurrent,
        config,
      });

      if (!decision.shouldTrade) {
        results.push({ market: market.slug, city: market.city, action: "skip", reason: decision.reason });
        continue;
      }

      await sendWeatherAlert(decision, config.paperMode);

      log("DECISION_TRADE", config.paperMode, {
        type: "weather",
        market: market.slug,
        city: decision.city,
        bucket: decision.bucketLabel,
        direction: decision.direction,
        edge: decision.edge,
        size: decision.positionSizeUSDC,
      });

      // 8. Execute
      const marketInfo = toMarketInfo(market, decision.tokenId);
      const entryPrice = decision.direction === "YES"
        ? Math.min(decision.marketPrice + 0.01, 0.99)
        : Math.max(1 - decision.marketPrice + 0.01, 0.01);

      const buyOrder = await placeBuyOrder(
        marketInfo,
        decision.direction,
        entryPrice,
        decision.positionSizeUSDC,
        config.paperMode,
      );

      if (buyOrder.status === "FILLED" || (config.paperMode && buyOrder.status === "FILLED")) {
        const position: Position = {
          market: market.slug,
          tokenId: decision.tokenId,
          direction: decision.direction,
          shares: buyOrder.filledShares,
          avgEntry: entryPrice,
          costBasis: decision.positionSizeUSDC,
          openedAt: new Date().toISOString(),
          buyOrderId: buyOrder.orderId,
        };
        updatedSession = addOpenPosition(updatedSession, position);

        // Paper mode: simulate close based on predicted probability
        if (config.paperMode) {
          // match.probability is our model's P(WIN) for this bucket
          const winProb = Math.max(0, Math.min(1, match.probability));
          const isWin = Math.random() < winProb;
          const exitPrice = isWin ? 1.0 : 0.0;
          const proceeds = position.shares * exitPrice;
          const pnl = proceeds - position.costBasis;

          const trade: ClosedTrade = {
            market: market.slug,
            direction: decision.direction,
            entryPrice,
            exitPrice,
            shares: position.shares,
            pnl,
            pnlPct: (pnl / position.costBasis) * 100,
            openedAt: position.openedAt,
            closedAt: new Date().toISOString(),
            // Edge Tracker metadata
            category: "weather",
            predictedProb: winProb,
            marketPriceAtEntry: decision.marketPrice,
            edgeAtEntry: decision.edge,
            signalBreakdown: null,  // weather uses different signals
          };

          updatedSession = closePosition(updatedSession, position.buyOrderId, trade);

          // DEB feedback: record per-model accuracy. In paper mode we draw a
          // synthetic "actual" from a Gaussian around the ensemble so the DEB
          // pipeline is exercised; real settlement temp will replace this in
          // live mode via a separate reconciliation job (TODO).
          try {
            const syntheticActual = forecast.ensembleMaxC + randNormal() * 1.0;
            await recordDebSample(
              market.city,
              market.date,
              parseFloat(syntheticActual.toFixed(2)),
              {
                gfs:   forecast.rawGfsMaxC,
                ecmwf: forecast.rawEcmwfMaxC,
                noaa:  forecast.rawNoaaMaxC,
              },
            );
          } catch {
            // DEB is best-effort — never block the trade close on it
          }
        }

        results.push({
          market: market.slug,
          city: market.city,
          action: "traded",
          bucket: decision.bucketLabel,
          direction: decision.direction,
          entry: entryPrice,
          size: decision.positionSizeUSDC,
          predictedTemp: decision.predictedTemp,
          edge: decision.edge,
          confidence: decision.confidence,
        });
      } else {
        results.push({ market: market.slug, action: "failed", reason: "Buy order not filled" });
      }
    } catch (err: any) {
      log("ERROR", config.paperMode, { market: market.slug, error: err.message });
      results.push({ market: market.slug, action: "error", error: err.message });
    }
  }

  await saveSession(updatedSession, "weather");

  return {
    ok: true,
    action: "run",
    category: "weather",
    paperMode: config.paperMode,
    marketsScanned: markets.length,
    modelLag: { age: modelLag.modelAge, hasLag: modelLag.hasLag },
    results,
    session: summarize(updatedSession),
  };
}

function summarize(s: any) {
  return {
    paperMode: s.paperMode,
    stopped: s.stopped,
    bankrollCurrent: Math.round(s.bankrollCurrent * 100) / 100,
    sessionPnL: Math.round(s.sessionPnL * 100) / 100,
    tradeCount: s.tradeCount,
    openPositions: s.openPositions.length,
  };
}

// Box-Muller transform — unit-variance gaussian for paper-mode DEB feedback
function randNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
