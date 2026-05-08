import type { BucketMatch } from "./bucket-matcher.mts";
import type { ModelLagResult } from "./model-lag-detector.mts";
import type { ForecastResult } from "./forecast-engine.mts";

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

const noTrade = (reason: string): WeatherTradeDecision => ({
  shouldTrade: false,
  city: "", date: "", bucketLabel: "", direction: "YES",
  tokenId: "", predictedTemp: 0, marketPrice: 0,
  edge: 0, confidence: 0, modelLagMinutes: 0,
  positionSizeUSDC: 0, reason,
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

  // 1. Confidence check
  if (forecast.confidence < config.confidenceMin) {
    return noTrade(`Confidence ${(forecast.confidence * 100).toFixed(0)}% < min ${(config.confidenceMin * 100).toFixed(0)}%`);
  }

  // 2. Too close to resolution
  if (timeToResolutionMin < config.exitBeforeMin) {
    return noTrade(`Too close to resolution: ${timeToResolutionMin}min < ${config.exitBeforeMin}min`);
  }

  // 3. Model boundary check
  if (modelLag.nearBoundary) {
    return noTrade("Near model update boundary, waiting for new data");
  }

  // 4. Edge check (net of fees)
  const grossEdge = Math.abs(match.edge);
  const netEdge = grossEdge - config.roundtripFeePct;

  if (netEdge < config.edgeThreshold) {
    return noTrade(
      `Net edge ${(netEdge * 100).toFixed(1)}% < threshold ${(config.edgeThreshold * 100).toFixed(0)}% ` +
      `(gross ${(grossEdge * 100).toFixed(1)}% - fee ${(config.roundtripFeePct * 100).toFixed(1)}%)`,
    );
  }

  // 4b. Sanity cap. A 70% gross edge against a market that's 85% on a single
  // bucket is almost certainly model error (forecast bias, station mismatch,
  // wrong unit). Above the cap we refuse to trade and surface the reason so
  // the misbehaviour shows up in the run log.
  if (grossEdge > config.maxEdgeCap) {
    return noTrade(
      `Gross edge ${(grossEdge * 100).toFixed(1)}% > sanity cap ${(config.maxEdgeCap * 100).toFixed(0)}% ` +
      `— likely model error, not opportunity`,
    );
  }

  // 5. Direction
  const direction: "YES" | "NO" = match.edge > 0 ? "YES" : "NO";

  // 6. Position sizing (conservative Kelly for weather)
  const kellyFraction = netEdge * forecast.confidence * 0.25;
  const cappedKelly = Math.min(kellyFraction, 0.15);
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
    reason:
      `Edge ${(netEdge * 100).toFixed(1)}%, Conf ${(forecast.confidence * 100).toFixed(0)}%, ` +
      `Lag ${modelLag.lagMinutes}min, Pred ${forecast.predictedMaxC}°C → ${match.bucket.label}`,
  };
}
