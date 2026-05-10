import type { BucketMatch } from "./bucket-matcher.mts";
import type { ModelLagResult } from "./model-lag-detector.mts";
import type { ForecastResult } from "./forecast-engine.mts";
import type { DecisionGate } from "../shared/types.mts";

export interface WeatherConfig {
  edgeThreshold: number;      // 0.12 = 12%
  confidenceMin: number;      // 0.65
  exitBeforeMin: number;      // 45 minutes before resolution
  maxPositionUSD: number;     // 25
  roundtripFeePct: number;    // 0.01 = 1%
  paperMode: boolean;
  // Sanity-check: gross edges above this almost certainly indicate model
  // error rather than real opportunity (e.g. predicting 24°C against an
  // 85%-on-26°C market consensus is suspicious, not edge).
  maxEdgeCap: number;         // 0.40 = 40%
  // Forecast pipeline knobs (passed through to getForecast).
  applyCityOffset: boolean;   // default false — see forecast-engine.mts
  forecastDays: number;       // 0 = auto-compute from target date
  useEnsemble: boolean;       // default false (env USE_ENSEMBLE)
  // Cron-driven background runs from the scheduled wrapper.
  cronEnabled: boolean;       // default false (manual-only)
}

export interface WeatherTradeDecision {
  shouldTrade: boolean;
  city: string;
  date: string;
  bucketLabel: string;
  direction: "YES" | "NO";
  tokenId: string;
  predictedTemp: number;
  marketPrice: number;
  edge: number;
  confidence: number;
  modelLagMinutes: number;
  positionSizeUSDC: number;
  reason: string;
  // Mirrors crypto/decision-engine: ordered gate list so the UI's "Why?"
  // popover can render the same pass/fail layout for every bot.
  gates?: DecisionGate[];
  // Sizing breakdown (raw vs capped Kelly fraction). Surfaced on the
  // entry-decision snapshot so the UI can show "raw → capped".
  kellyRaw?: number;
  kellyCapped?: number;
  kellyCap?: number;            // 0.15 hard cap for weather
  // Gross edge before fees, useful for the rationale grid.
  grossEdge?: number;
  netEdge?: number;
}

export function getWeatherConfig(): WeatherConfig {
  return {
    edgeThreshold:   parseFloat(process.env.WEATHER_EDGE_THRESHOLD  || "0.12"),
    confidenceMin:   parseFloat(process.env.WEATHER_CONFIDENCE_MIN  || "0.65"),
    exitBeforeMin:   parseInt(process.env.WEATHER_EXIT_BEFORE_MIN   || "45", 10),
    maxPositionUSD:  parseFloat(process.env.WEATHER_MAX_POSITION_USD || "25"),
    roundtripFeePct: 0.01,
    paperMode:       process.env.PAPER_MODE !== "false",
    maxEdgeCap:      parseFloat(process.env.WEATHER_MAX_EDGE_CAP    || "0.40"),
    applyCityOffset: process.env.WEATHER_APPLY_CITY_OFFSET === "true",
    forecastDays:    parseInt(process.env.WEATHER_FORECAST_DAYS     || "0", 10),
    useEnsemble:     (process.env.USE_ENSEMBLE || "").toLowerCase() === "true",
    cronEnabled:     process.env.WEATHER_CRON_ENABLED === "true",
  };
}

/**
 * Effective config = env defaults merged with runtime Blobs overrides.
 * Lazily imports trader-settings to avoid a circular dependency at init.
 * Falls back to env-only on any read error so the trader always runs.
 */
export async function getEffectiveWeatherConfig(): Promise<WeatherConfig> {
  const env = getWeatherConfig();
  try {
    const mod: any = await import("../../trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    return {
      ...env,
      edgeThreshold:   ov.weatherEdgeThreshold   ?? env.edgeThreshold,
      confidenceMin:   ov.weatherConfidenceMin   ?? env.confidenceMin,
      exitBeforeMin:   ov.weatherExitBeforeMin   ?? env.exitBeforeMin,
      maxPositionUSD:  ov.weatherMaxPositionUSD  ?? env.maxPositionUSD,
      maxEdgeCap:      ov.weatherMaxEdgeCap      ?? env.maxEdgeCap,
      applyCityOffset: ov.weatherApplyCityOffset !== undefined
        ? ov.weatherApplyCityOffset >= 0.5 : env.applyCityOffset,
      forecastDays:    ov.weatherForecastDays    ?? env.forecastDays,
      useEnsemble:     ov.weatherUseEnsemble !== undefined
        ? ov.weatherUseEnsemble >= 0.5 : env.useEnsemble,
      cronEnabled:     ov.weatherCronEnabled !== undefined
        ? ov.weatherCronEnabled >= 0.5 : env.cronEnabled,
    };
  } catch {
    return env;
  }
}

const KELLY_CAP = 0.15;

const noTrade = (reason: string, gates: DecisionGate[]): WeatherTradeDecision => ({
  shouldTrade: false,
  city: "", date: "", bucketLabel: "", direction: "YES",
  tokenId: "", predictedTemp: 0, marketPrice: 0,
  edge: 0, confidence: 0, modelLagMinutes: 0,
  positionSizeUSDC: 0, reason,
  gates,
});

export function makeWeatherDecision(params: {
  forecast: ForecastResult;
  match: BucketMatch;
  modelLag: ModelLagResult;
  timeToResolutionMin: number;
  bankrollUSDC: number;
  config: WeatherConfig;
}): WeatherTradeDecision {
  const { forecast, match, modelLag, timeToResolutionMin, bankrollUSDC, config } = params;

  // Gate accumulator — every check pushes its pass/fail row so the popover
  // can render the same shape as the crypto bot, including failed runs.
  const gates: DecisionGate[] = [];

  // 1. Confidence check
  const confOk = forecast.confidence >= config.confidenceMin;
  gates.push({
    label: "Forecast confidence ≥ küszöb",
    passed: confOk,
    actual:   `${(forecast.confidence * 100).toFixed(0)}%`,
    required: `≥ ${(config.confidenceMin * 100).toFixed(0)}%`,
    hint: "Az ensemble szórása alapján mért bizalmi szint. Cloud cover > 60% esetén automatikusan szigorúbb σ-val matchel.",
  });
  if (!confOk) {
    return noTrade(
      `Confidence ${(forecast.confidence * 100).toFixed(0)}% < min ${(config.confidenceMin * 100).toFixed(0)}%`,
      gates,
    );
  }

  // 2. Too close to resolution
  const timeOk = timeToResolutionMin >= config.exitBeforeMin;
  gates.push({
    label: "Idő a settlementig ≥ küszöb",
    passed: timeOk,
    actual:   `${timeToResolutionMin.toFixed(0)}min`,
    required: `≥ ${config.exitBeforeMin}min`,
    hint: "Túl közeli endDate-en nem lenne idő reagálni egy modell-frissítésre.",
  });
  if (!timeOk) {
    return noTrade(
      `Too close to resolution: ${timeToResolutionMin}min < ${config.exitBeforeMin}min`,
      gates,
    );
  }

  // 3. Model boundary check
  const modelOk = !modelLag.nearBoundary;
  gates.push({
    label: "Forecast model frissesség",
    passed: modelOk,
    actual:   modelLag.nearBoundary ? "near update boundary" : `lag ${modelLag.lagMinutes}min`,
    required: "no boundary",
    hint: "GFS/ECMWF futás határán lévő forecast még ingadozhat — kihagyjuk a tickek közti zajt.",
  });
  if (!modelOk) {
    return noTrade("Near model update boundary, waiting for new data", gates);
  }

  // 4. Edge check (net of fees)
  const grossEdge = Math.abs(match.edge);
  const netEdge = grossEdge - config.roundtripFeePct;
  const edgeOk = netEdge >= config.edgeThreshold;
  gates.push({
    label: "Net edge ≥ küszöb",
    passed: edgeOk,
    actual:   `${netEdge >= 0 ? "+" : ""}${(netEdge * 100).toFixed(2)}% (gross ${(grossEdge * 100).toFixed(2)}% − fees ${(config.roundtripFeePct * 100).toFixed(2)}%)`,
    required: `≥ ${(config.edgeThreshold * 100).toFixed(1)}%`,
    hint: "|matchProb − bucketPrice| − roundtrip fees, signed.",
  });
  if (!edgeOk) {
    return noTrade(
      `Net edge ${(netEdge * 100).toFixed(1)}% < threshold ${(config.edgeThreshold * 100).toFixed(0)}% ` +
      `(gross ${(grossEdge * 100).toFixed(1)}% - fee ${(config.roundtripFeePct * 100).toFixed(1)}%)`,
      gates,
    );
  }

  // 4b. Sanity cap. A 70% gross edge against a market that's 85% on a single
  // bucket is almost certainly model error (forecast bias, station mismatch,
  // wrong unit). Above the cap we refuse to trade and surface the reason so
  // the misbehaviour shows up in the run log.
  const sanityOk = grossEdge <= config.maxEdgeCap;
  gates.push({
    label: "Sanity cap (gross edge ≤ cap)",
    passed: sanityOk,
    actual:   `${(grossEdge * 100).toFixed(1)}%`,
    required: `≤ ${(config.maxEdgeCap * 100).toFixed(0)}%`,
    hint: "Túl nagy gross edge tipikusan modell-hiba (rossz station, °F→°C, city-offset bug).",
  });
  if (!sanityOk) {
    return noTrade(
      `Gross edge ${(grossEdge * 100).toFixed(1)}% > sanity cap ${(config.maxEdgeCap * 100).toFixed(0)}% ` +
      `— likely model error, not opportunity`,
      gates,
    );
  }

  // 5. Direction
  const direction: "YES" | "NO" = match.edge > 0 ? "YES" : "NO";

  // 6. Position sizing (conservative Kelly for weather)
  const kellyFraction = netEdge * forecast.confidence * 0.25;
  const cappedKelly = Math.min(kellyFraction, KELLY_CAP);
  gates.push({
    label: "Kelly méret ≤ cap",
    passed: cappedKelly <= KELLY_CAP,
    actual:   `${(cappedKelly * 100).toFixed(2)}%`,
    required: `≤ ${(KELLY_CAP * 100).toFixed(1)}%`,
    hint: "¼-Kelly × confidence + 15% hard cap, plus a maxPositionUSD floor.",
  });

  const positionSize = Math.min(
    bankrollUSDC * cappedKelly,
    config.maxPositionUSD,
  );

  return {
    shouldTrade: true,
    city: forecast.city,
    date: forecast.date,
    bucketLabel: match.bucket.label,
    direction,
    tokenId: match.bucket.tokenId,
    predictedTemp: forecast.predictedMaxC,
    marketPrice: match.bucket.currentPrice,
    edge: netEdge,
    confidence: forecast.confidence,
    modelLagMinutes: modelLag.lagMinutes,
    positionSizeUSDC: Math.round(positionSize * 100) / 100,
    gates,
    kellyRaw:    kellyFraction,
    kellyCapped: cappedKelly,
    kellyCap:    KELLY_CAP,
    grossEdge,
    netEdge,
    reason:
      `Edge ${(netEdge * 100).toFixed(1)}%, Conf ${(forecast.confidence * 100).toFixed(0)}%, ` +
      `Lag ${modelLag.lagMinutes}min, Pred ${forecast.predictedMaxC}°C → ${match.bucket.label}`,
  };
}
