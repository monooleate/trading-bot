import { getStore } from "@netlify/blobs";
import { log } from "../shared/logger.mts";
import { alertError, alertLiveBlocked } from "../shared/telegram.mts";
import { computeLiveReadiness, shouldForcePaper, type LiveReadinessReport } from "../shared/live-readiness.mts";
import { findWeatherMarketsDetailed } from "./market-finder.mts";
import type { WeatherMarket, DroppedEvent, TemperatureBucket } from "./market-finder.mts";
import { getStation, getSeason } from "./station-config.mts";
import { getForecast } from "./forecast-engine.mts";
import { detectModelLag } from "./model-lag-detector.mts";
import { matchBucket, marketConsensusModalTempC } from "./bucket-matcher.mts";
import { makeWeatherDecision, getWeatherConfig, padWeatherGates } from "./decision-engine.mts";
import type { WeatherTradeDecision, WeatherConfig } from "./decision-engine.mts";
import { placeBuyOrder } from "../crypto/execution.mts";
import {
  loadSession,
  saveSession,
  addOpenPosition,
  PAPER_SIM_VERSION,
} from "../crypto/session-manager.mts";
import type { MarketInfo, Position, EntryDecisionSnapshot, SignalBreakdown } from "../shared/types.mts";

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
  // Drop lastResult if the snapshot was taken under an older paper-sim
  // version. Those results reference positions that have since been
  // archived by loadSession()'s auto-reset, so showing them as the
  // "current" run is misleading (UI showed 3 "traded" rows for a session
  // that had been wiped).
  let lastResult = s.lastResult;
  const snapshotSimV = lastResult?.session?.simVersion
    ?? lastResult?.liveReadiness?.summary?.simVersion
    ?? null;
  if (typeof snapshotSimV === "number" && snapshotSimV < PAPER_SIM_VERSION) {
    lastResult = null;
    // Persist the cleanup so the next poll doesn't re-evaluate the same
    // stale snapshot.
    try { await saveRunState({ ...s, lastResult: null }); } catch {}
  }
  return {
    isRunning,
    startedAt:  s.startedAt,
    lastRunAt:  s.lastRunAt,
    source:     s.source,
    ageSec,
    lastResult,
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
//
// Critical: weather events are negRisk groups where each bucket is its own
// sub-market with a distinct conditionId AND distinct YES/NO clob tokenIds.
// We pass the matched bucket directly so execution + settlement target the
// right sub-market — using the event-level conditionId (or only the YES
// token) settles or places against the WRONG bucket and silently mis-books
// PnL in paper mode / rejects in live mode.
function toMarketInfo(wm: WeatherMarket, bucket: TemperatureBucket): MarketInfo {
  return {
    slug: wm.slug,
    conditionId: bucket.conditionId,
    questionId: "",
    title: wm.title,
    clobTokenIds: [bucket.tokenId, bucket.noTokenId], // [YES, NO] of this bucket
    currentPrice: bucket.currentPrice,
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

async function runWeatherTraderInner(configIn: WeatherConfig) {
  // Mutable clone so the live-readiness gate can flip paperMode back to
  // true if the paper track record hasn't yet met validation thresholds.
  const config: WeatherConfig = { ...configIn };
  const session = await loadSession(config.paperMode, DEFAULT_BANKROLL, "weather");

  // Live-readiness gate: weather is prediction-driven (forecast-vs-bucket
  // probability), so the IC / calibration gates apply. Closed trades are
  // already in generic ClosedTrade shape since the weather reconciler
  // writes through the shared session-manager.
  let liveReadiness: LiveReadinessReport | null = null;
  try {
    let readyOv: any = {};
    try {
      const mod: any = await import("../../trader-settings.mts");
      readyOv = (await mod.loadRuntimeOverrides()) ?? {};
    } catch {}
    liveReadiness = computeLiveReadiness({
      category: "weather",
      session,
      simVersionExpected: null,
      thresholds: {
        minTrades:         readyOv.liveReadyMinTrades,
        minWinRate:        readyOv.liveReadyMinWinRate,
        minIC:             readyOv.liveReadyMinIC,
        maxCalibrationDev: readyOv.liveReadyMaxCalibDev,
        minSharpe:         readyOv.liveReadyMinSharpe,
        maxDrawdownPct:    readyOv.liveReadyMaxDrawdownPct,
      } as any,
    });
    const force = shouldForcePaper(config.paperMode, liveReadiness);
    if (force.forcePaper) {
      log("ERROR", true, { liveBlocked: true, category: "weather", reason: force.reason });
      const failed = liveReadiness.gates.filter((g) => g.applicable && !g.passed).map((g) => g.label);
      await alertLiveBlocked("weather", force.reason!, failed);
      config.paperMode = true;
    }
  } catch {}

  if (session.stopped) {
    return {
      ok: true,
      action: "skipped",
      reason: `Session stopped: ${session.stoppedReason}`,
      session: summarize(session),
      liveReadiness,
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
      liveReadiness,
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
      liveReadiness,
    };
  }

  let updatedSession = session;
  const results: any[] = [];

  // 3. Process each market
  const weatherMaxOpen = config.maxOpenPositions ?? 5;
  // Active positions only — past-reconcileAfter (pending settle) positions
  // are effectively done and shouldn't block new entries. The settle just
  // hasn't been booked yet because METAR/Gamma haven't reported. This is
  // a user-facing decision: "✓ ready to settle" rows in the pending card
  // do NOT count against this cap, only the still-trading rows do.
  const activeOpenCount = updatedSession.openPositions.filter((p) => {
    if (!p.weatherMeta) return true; // safety: count anything weather-less as active
    return new Date(p.weatherMeta.reconcileAfter).getTime() > Date.now();
  }).length;
  for (const market of markets.slice(0, 5)) {
    // Max-open-positions gate (Settings-tunable via weatherMaxOpenPositions).
    if (activeOpenCount >= weatherMaxOpen) {
      results.push({
        market: market.slug,
        action: "skip",
        reason: `Max active positions reached: ${activeOpenCount}/${weatherMaxOpen}`,
        gates: padWeatherGates([{
          label: "Max open positions",
          passed: false,
          actual: `${activeOpenCount}/${weatherMaxOpen}`,
          required: `< ${weatherMaxOpen}`,
          hint: "Csak az aktív (még trading-window-on belüli) pozíciókat számolja — a ✓ready-to-settle nem.",
        }]),
      });
      continue;
    }
    // Skip if already have a position. Synthetic single-gate failure so
    // the UI's "X/Y gates" chip still renders for these rows.
    if (updatedSession.openPositions.some((p) => p.market === market.slug)) {
      results.push({
        market: market.slug, action: "skip", reason: "Already has open position",
        // Padded to Y=6 for chip uniformity across rows.
        gates: padWeatherGates([{
          label: "Forecast confidence ≥ küszöb",
          passed: false,
          actual: "already open",
          required: "no open position",
          hint: "Egy piacra max 1 nyitott pozíció — más gate-ek ki sem értékelődnek.",
        }]),
      });
      continue;
    }

    try {
      const station = getStation(market.city);
      if (!station) {
        results.push({
          market: market.slug, action: "skip", reason: `Unknown city: ${market.city}`,
          gates: padWeatherGates([{
            label: "Forecast confidence ≥ küszöb",
            passed: false,
            actual: `unknown city: ${market.city || "—"}`,
            required: "mapped METAR station",
            hint: "A bot csak konfigurált METAR állomás alapján trade-elhet.",
          }]),
        });
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
      //
      // σ choice (2026-05-11 follow-up): when the 31-member GFS ensemble is
      // available, its empirical stddev is the right uncertainty estimate
      // for the matcher. Falls back to the cloud-cover heuristic when
      // ensemble fetch fails or returns fewer than 5 members. The 0.5°C
      // floor protects against ensemble agreement-overshoot (members
      // accidentally clustering into a tight σ doesn't mean the true
      // forecast skill is sub-half-a-degree).
      const ensembleSigma = forecast.ensembleDetail?.dailyMaxStdDev;
      const sigma =
        typeof ensembleSigma === "number" && Number.isFinite(ensembleSigma) && ensembleSigma > 0
          ? Math.max(0.5, ensembleSigma)
          : (forecast.cloudCoverPct > 60 ? 1.5 : 1.0);
      const match = matchBucket(forecast.predictedMaxC, market.outcomes, sigma);
      if (!match) {
        results.push({
          market: market.slug, city: market.city, action: "skip", reason: "No matching bucket",
          predictedTemp: forecast.predictedMaxC,
          confidence: forecast.confidence,
          gates: padWeatherGates([{
            label: "Forecast confidence ≥ küszöb",
            passed: forecast.confidence >= config.confidenceMin,
            actual:   `${(forecast.confidence * 100).toFixed(0)}%`,
            required: `≥ ${(config.confidenceMin * 100).toFixed(0)}%`,
            hint: "Az ensemble szórása alapján mért bizalmi szint.",
          }, {
            label: "Net edge ≥ küszöb",
            passed: false,
            actual: `pred ${forecast.predictedMaxC}°C, no nearby bucket`,
            required: "min 1 bucket within σ",
            hint: "A forecast hőmérséklet egyik szállított bucket center körül se illett be a σ-band-be.",
          }]),
        });
        continue;
      }

      // 6. Calculate time to resolution
      const endTime = new Date(market.endDate).getTime();
      const timeToResolutionMin = Math.max(0, (endTime - Date.now()) / 60000);

      // 7. Make decision
      // Market consensus modal: highest-priced bucket — what the crowd
      // thinks the daily max will be. Powers the disagreement gate.
      const marketModal = marketConsensusModalTempC(market.outcomes);
      const decision = makeWeatherDecision({
        forecast,
        match,
        modelLag,
        timeToResolutionMin,
        bankrollUSDC: updatedSession.bankrollCurrent,
        config,
        marketModalTempC: marketModal?.tempC ?? null,
        marketModalLabel: marketModal?.label ?? null,
      });

      if (!decision.shouldTrade) {
        results.push({
          market: market.slug, city: market.city, action: "skip", reason: decision.reason,
          predictedTemp: decision.predictedTemp,
          marketPrice: decision.marketPrice,
          modelProb: match.probability,
          edge: decision.edge,
          confidence: decision.confidence,
          direction: decision.direction,
          bucket: decision.bucketLabel,
          gates: decision.gates ?? [],
        });
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
      const marketInfo = toMarketInfo(market, match.bucket);
      const entryPrice = decision.direction === "YES"
        ? Math.min(decision.marketPrice + 0.01, 0.99)
        : Math.max(1 - decision.marketPrice + 0.01, 0.01);

      const buyOrder = await placeBuyOrder(
        marketInfo,
        decision.direction,
        entryPrice,
        decision.positionSizeUSDC,
        config.paperMode,
        true, // weather events are negRisk groups; CLOB routes differently
      );

      if (buyOrder.status === "FILLED") {
        // Reconcile a target buffer past endDate. Polymarket's settlement
        // window plus a 1h safety margin so the daily-max METAR observation
        // is in.
        const reconcileAfter = new Date(
          new Date(market.endDate).getTime() + 60 * 60_000,
        ).toISOString();

        const station = getStation(market.city)!;

        // Frozen entry-decision snapshot — same shape the crypto bot uses,
        // so the UI's `RationaleBlock` can render this without per-bot
        // branches. Weather is forecast-driven (no signal-combiner mix), but
        // we DO populate one signal: `forecast_edge = predictedProb -
        // marketPrice`. That gives the live-readiness IC gate a measurable
        // signal-vs-outcome correlation specific to weather. Without it the
        // gate could never pass since signalBreakdown was null and IC was
        // structurally 0 — blocking weather from ever reaching live mode.
        // NaN-safe: if either input is non-finite, leave forecast_edge null
        // so the IC computation skips this sample instead of polluting the
        // Pearson sum with NaN.
        const rawForecastEdge = match.probability - decision.marketPrice;
        const weatherSignals: SignalBreakdown = {
          funding_rate:    null,
          orderflow:       null,
          vol_divergence:  null,
          apex_consensus:  null,
          cond_prob:       null,
          momentum:        null,
          contrarian:      null,
          pairs_spread:    null,
          forecast_edge:   Number.isFinite(rawForecastEdge) ? rawForecastEdge : null,
        };
        const entryDecision: EntryDecisionSnapshot = {
          decidedAt:        new Date().toISOString(),
          finalProb:        match.probability,
          marketPrice:      decision.marketPrice,
          grossEdge:        decision.grossEdge ?? Math.abs(match.edge),
          netEdge:          decision.netEdge ?? decision.edge,
          feePct:           config.roundtripFeePct,
          direction:        decision.direction,
          kellyRaw:         decision.kellyRaw    ?? 0,
          kellyCapped:      decision.kellyCapped ?? 0,
          kellyCap:         decision.kellyCap    ?? 0.15,
          positionSizeUSDC: decision.positionSizeUSDC,
          entryPrice,
          activeSignals:    1,
          signalBreakdown:  weatherSignals,
          obImbalance:      null,
          gates:            decision.gates ?? [],
          reason:           decision.reason,
        };

        // For NO bets we must record the NO clob tokenId on the position
        // so any future close/redeem path operates on the right side.
        const positionTokenId = decision.direction === "YES"
          ? match.bucket.tokenId
          : match.bucket.noTokenId;

        const position: Position = {
          market: market.slug,
          tokenId: positionTokenId,
          direction: decision.direction,
          shares: buyOrder.filledShares,
          avgEntry: entryPrice,
          costBasis: decision.positionSizeUSDC,
          openedAt: new Date().toISOString(),
          buyOrderId: buyOrder.orderId,
          // Per-bucket conditionId so polymarket-resolver settles on the
          // matched sub-market — not the event's first bucket.
          conditionId: match.bucket.conditionId,
          endDate: market.endDate,
          marketPriceAtEntry: decision.marketPrice,
          predictedProb: match.probability,
          category: "weather",
          entryDecision,
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
          marketPrice: decision.marketPrice,
          modelProb: match.probability,
          edge: decision.edge,
          confidence: decision.confidence,
          reconcileAfter,
          status: "pending_settlement",
          gates: decision.gates ?? [],
        });
      } else {
        results.push({
          market: market.slug, city: market.city, action: "failed", reason: "Buy order not filled",
          predictedTemp: decision.predictedTemp,
          edge: decision.edge,
          confidence: decision.confidence,
          gates: decision.gates ?? [],
        });
      }
    } catch (err: any) {
      log("ERROR", config.paperMode, { market: market.slug, error: err.message });
      results.push({
        market: market.slug, action: "error", error: err.message,
        gates: padWeatherGates([{
          label: "Forecast confidence ≥ küszöb",
          passed: false,
          actual: `error: ${err.message}`,
          required: "no exception during scan",
        }]),
      });
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
    liveReadiness,
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

