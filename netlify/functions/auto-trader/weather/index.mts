import { getStore } from "@netlify/blobs";
import { log } from "../shared/logger.mts";
import { alertError } from "../shared/telegram.mts";
import { findWeatherMarketsDetailed } from "./market-finder.mts";
import type { WeatherMarket, DroppedEvent } from "./market-finder.mts";
import { getStation, getSeason } from "./station-config.mts";
import { getForecast } from "./forecast-engine.mts";
import { detectModelLag } from "./model-lag-detector.mts";
import { matchBucket } from "./bucket-matcher.mts";
import { makeWeatherDecision, getWeatherConfig } from "./decision-engine.mts";
import type { WeatherTradeDecision, WeatherConfig } from "./decision-engine.mts";
import { placeBuyOrder } from "../crypto/execution.mts";
import {
  loadSession,
  saveSession,
  addOpenPosition,
} from "../crypto/session-manager.mts";
import type { MarketInfo, Position } from "../shared/types.mts";

const DEFAULT_BANKROLL = 100;

// ─── Run-state store (lastRunAt, isRunning, lastSummary) ──
//
// Surfaced in the UI so the user can see whether the trader is currently
// scanning and how long ago the last tick ran. Lives in Netlify Blobs so
// state survives across cron ticks and manual UI calls.

const RUN_STORE = "weather-runtime";
const RUN_KEY   = "v1";

interface RunState {
  startedAt:  string | null;   // set at the start of a run, cleared on finish
  lastRunAt:  string | null;   // ISO of most recent finished run
  lastResult: any | null;      // summary object from the last finished run
  source:     "manual" | "cron" | null;
}

async function loadRunState(): Promise<RunState> {
  try {
    const raw = await getStore(RUN_STORE).get(RUN_KEY);
    if (raw) return JSON.parse(raw as string);
  } catch {}
  return { startedAt: null, lastRunAt: null, lastResult: null, source: null };
}

async function saveRunState(s: RunState): Promise<void> {
  try { await getStore(RUN_STORE).set(RUN_KEY, JSON.stringify(s)); } catch {}
}

export async function getWeatherRunStatus(): Promise<{
  isRunning:  boolean;
  startedAt:  string | null;
  lastRunAt:  string | null;
  source:     "manual" | "cron" | null;
  ageSec:     number | null;     // seconds since lastRunAt
  lastResult: any | null;
}> {
  const s = await loadRunState();
  // Stale "running" guard: if the start-of-run flag is older than 90s, the
  // previous run probably crashed before clearing it. Treat as not-running.
  let isRunning = false;
  if (s.startedAt) {
    const ageMs = Date.now() - new Date(s.startedAt).getTime();
    isRunning = ageMs < 90_000;
  }
  const ageSec = s.lastRunAt
    ? Math.floor((Date.now() - new Date(s.lastRunAt).getTime()) / 1000)
    : null;
  return {
    isRunning,
    startedAt:  s.startedAt,
    lastRunAt:  s.lastRunAt,
    source:     s.source,
    ageSec,
    lastResult: s.lastResult,
  };
}

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

export async function runWeatherTrader(
  config: WeatherConfig,
  source: "manual" | "cron" = "manual",
) {
  // Mark "running" at the very start so the UI can show a live indicator.
  const startedAt = new Date().toISOString();
  await saveRunState({ ...(await loadRunState()), startedAt, source });

  // Wrap the body so we always clear the running flag even on early returns.
  let result: any;
  try {
    result = await runWeatherTraderInner(config);
  } catch (err: any) {
    result = { ok: false, action: "error", error: err.message, source };
  }

  await saveRunState({
    startedAt:  null,
    lastRunAt:  new Date().toISOString(),
    lastResult: result,
    source,
  });
  return { ...result, source, startedAt, finishedAt: new Date().toISOString() };
}

async function runWeatherTraderInner(config: WeatherConfig) {
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

  // 2. Find weather markets (+ dropped diagnostics)
  const { markets, dropped } = await findWeatherMarketsDetailed();
  if (markets.length === 0) {
    return {
      ok: true,
      action: "skipped",
      reason: "No active weather temperature markets found",
      droppedEvents: dropped.slice(0, 20),
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

      // 4. Get forecast (pass through pipeline knobs from effective config)
      const forecast = await getForecast(market.city, station, market.date, {
        applyCityOffset: config.applyCityOffset,
        forecastDays:    config.forecastDays > 0 ? config.forecastDays : undefined,
        useEnsemble:     config.useEnsemble,
      });

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
        // Reconcile a target buffer past endDate. Polymarket's settlement
        // window plus a 1h safety margin so the daily-max METAR observation
        // is in.
        const reconcileAfter = new Date(
          new Date(market.endDate).getTime() + 60 * 60_000,
        ).toISOString();

        const station = getStation(market.city)!;

        const position: Position = {
          market: market.slug,
          tokenId: decision.tokenId,
          direction: decision.direction,
          shares: buyOrder.filledShares,
          avgEntry: entryPrice,
          costBasis: decision.positionSizeUSDC,
          openedAt: new Date().toISOString(),
          buyOrderId: buyOrder.orderId,
          conditionId: market.conditionId,
          endDate: market.endDate,
          marketPriceAtEntry: decision.marketPrice,
          predictedProb: match.probability,
          category: "weather",
          weatherMeta: {
            city:           market.city,
            date:           market.date,
            stationIcao:    station.icao,
            bucketLabel:    decision.bucketLabel,
            bucketTempC:    match.bucket.tempC ?? 0,
            predictedMaxC:  forecast.predictedMaxC,
            rawGfsMaxC:     forecast.rawGfsMaxC,
            rawEcmwfMaxC:   forecast.rawEcmwfMaxC,
            rawNoaaMaxC:    forecast.rawNoaaMaxC,
            ensembleMaxC:   forecast.ensembleMaxC,
            reconcileAfter,
          },
        };
        updatedSession = addOpenPosition(updatedSession, position);

        // No more synthetic Bernoulli close. The position stays open until
        // the weather reconciler cron picks it up after `reconcileAfter` and
        // settles it with the actual METAR temperature.

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
          reconcileAfter,
          status: "pending_settlement",
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
    droppedEvents: dropped.slice(0, 20),
    config: {
      edgeThreshold:   config.edgeThreshold,
      confidenceMin:   config.confidenceMin,
      maxEdgeCap:      config.maxEdgeCap,
      applyCityOffset: config.applyCityOffset,
      useEnsemble:     config.useEnsemble,
    },
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

