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
    edgeThreshold: parseFloat(process.env.WEATHER_EDGE_THRESHOLD || "0.12"),
    confidenceMin: parseFloat(process.env.WEATHER_CONFIDENCE_MIN || "0.65"),
    exitBeforeMin: parseInt(process.env.WEATHER_EXIT_BEFORE_MIN || "45", 10),
    maxPositionUSD: parseFloat(process.env.WEATHER_MAX_POSITION_USD || "25"),
    roundtripFeePct: 0.01,
    paperMode: process.env.PAPER_MODE !== "false",
  };
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
