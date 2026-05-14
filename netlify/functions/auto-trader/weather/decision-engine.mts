import type { BucketMatch } from "./bucket-matcher.mts";
import type { ModelLagResult } from "./model-lag-detector.mts";
import type { ForecastResult } from "./forecast-engine.mts";
import type { DecisionGate, Position } from "../shared/types.mts";

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
  useEnsemble: boolean;       // default true since 2026-05-11
  // Cron-driven background runs from the scheduled wrapper.
  cronEnabled: boolean;       // default false (manual-only)
  // Skip trades where the bot's prediction disagrees with the market's
  // consensus modal bucket by more than this many °C — a soft alpha-vs-
  // model-error filter. Default 2.0°C ≈ 3.6°F.
  marketDisagreeMaxC: number; // default 2.0
  // Max simultaneously-open weather positions. Caps the scan loop.
  maxOpenPositions: number;   // default 5
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
  // USE_ENSEMBLE defaults to true (2026-05-11): the 31-member GFS ensemble
  // gives empirically-calibrated σ instead of the hardcoded 1.0/1.5 fallback,
  // so we want it on by default. Operators can still flip it off with
  // USE_ENSEMBLE=false or via Settings tab if Open-Meteo's ensemble endpoint
  // becomes unreliable.
  const useEnsembleEnv = (process.env.USE_ENSEMBLE || "").toLowerCase();
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
    useEnsemble:     useEnsembleEnv === "false" ? false : true,
    // Default ON (2026-05-14d): paper mode-ban biztonságos, math validálva.
    // A 4 bot közül csak ennek volt explicit cron-gate-je — most aszimmetria
    // megszűnt, mind a 4 default-ban tüzel. Csak `WEATHER_CRON_ENABLED=false`
    // env-var vagy Settings-knob OFF kapcsolja le (vészhelyzeti pause).
    cronEnabled:     process.env.WEATHER_CRON_ENABLED === "false" ? false : true,
    // Market-consensus disagreement gate: skip when the bot's prediction
    // differs from the highest-priced bucket's centre by more than this
    // threshold (°C). Default 2.0°C → ~3.6°F → typically 1-2 buckets of drift
    // before we treat it as model error rather than alpha.
    marketDisagreeMaxC: parseFloat(process.env.WEATHER_DISAGREE_MAX_C || "2.0"),
    maxOpenPositions:   parseInt(process.env.WEATHER_MAX_OPEN_POSITIONS || "5", 10),
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
      marketDisagreeMaxC: ov.weatherMarketDisagreeMaxC ?? env.marketDisagreeMaxC,
      maxOpenPositions:   ov.weatherMaxOpenPositions   ?? env.maxOpenPositions,
    };
  } catch {
    return env;
  }
}

const KELLY_CAP = 0.15;

// Canonical labels for weather-bot gates. Used by the engine when fully
// evaluating + by the runner to pad early-exit rows so every scan row
// reports the same Y on the unified "X/Y gates" chip.
export const WEATHER_GATE_LABELS = [
  "Forecast confidence ≥ küszöb",
  "Idő a settlementig ≥ küszöb",
  "Forecast model frissesség",
  "Net edge ≥ küszöb",
  "Sanity cap (gross edge ≤ cap)",
  "Market disagreement ≤ küszöb",
  "Kelly méret ≤ cap",
  // Cross-position consistency (2026-05-14e). Blocks an entry that would
  // push the sum of YES-side predicted probabilities over 1.0 on the same
  // (city, date) negRisk event. Bucket-markets in one event are mutually
  // exclusive, so Σ P(YES) > 1 is a model contradiction — both bets can't
  // be right.
  "Monotonicitás (egyéb nyitott pozíciók)",
] as const;

export function padWeatherGates(evaluated: DecisionGate[]): DecisionGate[] {
  const have = new Set(evaluated.map((g) => g.label));
  const out  = [...evaluated];
  for (const label of WEATHER_GATE_LABELS) {
    if (!have.has(label)) {
      out.push({ label, passed: false, actual: "not evaluated", required: "—" });
    }
  }
  return out;
}

// Evaluates the full ordered gate list for one (forecast × bucket) pair.
// Like the crypto engine, it does NOT short-circuit — every gate is added
// to the list and shouldTrade is `gates.every(g => g.passed)`. That keeps
// the UI's "X/Y gates" chip uniform across rows.
export function makeWeatherDecision(params: {
  forecast: ForecastResult;
  match: BucketMatch;
  modelLag: ModelLagResult;
  timeToResolutionMin: number;
  bankrollUSDC: number;
  config: WeatherConfig;
  // Highest-priced bucket centre (°C) from the market — proxy for the
  // crowd's consensus modal forecast. Optional: if missing, the gate
  // returns "not evaluated" (passed=true) so behaviour degrades gracefully.
  marketModalTempC?: number | null;
  marketModalLabel?: string | null;
  // Already-open weather positions in the session — fed into the
  // cross-position consistency gate (2026-05-14e). Defaults to empty
  // so existing callers keep working until they pass the array.
  openPositions?: Position[];
}): WeatherTradeDecision {
  const { forecast, match, modelLag, timeToResolutionMin, bankrollUSDC, config, marketModalTempC, marketModalLabel } = params;
  const openPositions: Position[] = params.openPositions ?? [];

  const gates: DecisionGate[] = [];
  const reasons: string[] = [];

  // 1. Confidence
  const confOk = forecast.confidence >= config.confidenceMin;
  gates.push({
    label: "Forecast confidence ≥ küszöb",
    passed: confOk,
    actual:   `${(forecast.confidence * 100).toFixed(0)}%`,
    required: `≥ ${(config.confidenceMin * 100).toFixed(0)}%`,
    hint: "Az ensemble szórása alapján mért bizalmi szint. Cloud cover > 60% esetén automatikusan szigorúbb σ-val matchel.",
  });
  if (!confOk) reasons.push(`Confidence ${(forecast.confidence * 100).toFixed(0)}% < min ${(config.confidenceMin * 100).toFixed(0)}%`);

  // 2. Time-to-resolution
  const timeOk = timeToResolutionMin >= config.exitBeforeMin;
  gates.push({
    label: "Idő a settlementig ≥ küszöb",
    passed: timeOk,
    actual:   `${timeToResolutionMin.toFixed(0)}min`,
    required: `≥ ${config.exitBeforeMin}min`,
    hint: "Túl közeli endDate-en nem lenne idő reagálni egy modell-frissítésre.",
  });
  if (!timeOk) reasons.push(`Too close to resolution: ${timeToResolutionMin}min < ${config.exitBeforeMin}min`);

  // 3. Model boundary
  const modelOk = !modelLag.nearBoundary;
  gates.push({
    label: "Forecast model frissesség",
    passed: modelOk,
    actual:   modelLag.nearBoundary ? "near update boundary" : `lag ${modelLag.lagMinutes}min`,
    required: "no boundary",
    hint: "GFS/ECMWF futás határán lévő forecast még ingadozhat — kihagyjuk a tickek közti zajt.",
  });
  if (!modelOk) reasons.push("Near model update boundary, waiting for new data");

  // 4. Net edge ≥ threshold
  const grossEdge = Math.abs(match.edge);
  const netEdge   = grossEdge - config.roundtripFeePct;
  const direction: "YES" | "NO" = match.edge > 0 ? "YES" : "NO";
  const edgeOk = netEdge >= config.edgeThreshold;
  gates.push({
    label: "Net edge ≥ küszöb",
    passed: edgeOk,
    actual:   `${netEdge >= 0 ? "+" : ""}${(netEdge * 100).toFixed(2)}% (gross ${(grossEdge * 100).toFixed(2)}% − fees ${(config.roundtripFeePct * 100).toFixed(2)}%)`,
    required: `≥ ${(config.edgeThreshold * 100).toFixed(1)}%`,
    hint: "|matchProb − bucketPrice| − roundtrip fees, signed.",
  });
  if (!edgeOk) reasons.push(
    `Net edge ${(netEdge * 100).toFixed(1)}% < threshold ${(config.edgeThreshold * 100).toFixed(0)}% ` +
    `(gross ${(grossEdge * 100).toFixed(1)}% - fee ${(config.roundtripFeePct * 100).toFixed(1)}%)`,
  );

  // 5. Sanity cap (gross edge ≤ cap)
  const sanityOk = grossEdge <= config.maxEdgeCap;
  gates.push({
    label: "Sanity cap (gross edge ≤ cap)",
    passed: sanityOk,
    actual:   `${(grossEdge * 100).toFixed(1)}%`,
    required: `≤ ${(config.maxEdgeCap * 100).toFixed(0)}%`,
    hint: "Túl nagy gross edge tipikusan modell-hiba (rossz station, °F→°C, city-offset bug).",
  });
  if (!sanityOk) reasons.push(
    `Gross edge ${(grossEdge * 100).toFixed(1)}% > sanity cap ${(config.maxEdgeCap * 100).toFixed(0)}% ` +
    `— likely model error, not opportunity`,
  );

  // 6. Market-consensus disagreement
  // -----------------------------------------------------------------------
  // If the model predicts a temperature far from where the crowd is pricing
  // the modal bucket, that's a flag — the bot might have a better view, or
  // it might be a station/offset/°F bug. We treat >2°C disagreement as
  // model-error and skip the trade. Soft fail: passes when market modal is
  // unknown (tail buckets without parseable centre, missing data).
  const disagreePresent = typeof marketModalTempC === "number" && Number.isFinite(marketModalTempC);
  const disagreeC = disagreePresent ? Math.abs(forecast.predictedMaxC - marketModalTempC!) : 0;
  const disagreeOk = !disagreePresent || disagreeC <= config.marketDisagreeMaxC;
  gates.push({
    label: "Market disagreement ≤ küszöb",
    passed: disagreeOk,
    actual:   disagreePresent
      ? `|${forecast.predictedMaxC.toFixed(1)}°C − ${marketModalTempC!.toFixed(1)}°C (${marketModalLabel || "?"})| = ${disagreeC.toFixed(1)}°C`
      : "no market modal",
    required: `≤ ${config.marketDisagreeMaxC.toFixed(1)}°C`,
    hint: "Ha a botpredikció >2°C-kal eltér a market modális bucketjétől, valószínűbb modellhiba, mint alfa.",
  });
  if (!disagreeOk) reasons.push(
    `Market disagreement ${disagreeC.toFixed(1)}°C > ${config.marketDisagreeMaxC.toFixed(1)}°C ` +
    `(bot ${forecast.predictedMaxC.toFixed(1)}°C vs market modal ${marketModalTempC!.toFixed(1)}°C)`,
  );

  // 7. Kelly cap (informational — Math.min always satisfies the cap, but
  // surfacing the actual value lets the operator see how close we are).
  //
  // Proper binary-payoff Kelly using the bucket's market price.
  // Previously: `netEdge × confidence × 0.25` heuristic — ignored the
  // bucket price entirely, undersizing deep-OTM tail bets by ~3-5×.
  // Now: f = (p*b − q)/b, b = (1/bucketPrice) − 1, then confidence-scaled.
  // Direction-aware: YES side uses match.probability vs bucketPrice,
  // NO side uses (1 − match.probability) vs (1 − bucketPrice).
  const bucketPrice = match.bucket.currentPrice;
  const probYes     = (typeof (match as any).probability === "number")
    ? (match as any).probability
    : bucketPrice + match.edge;  // fallback: matchProb = bucketPrice + edge
  const probSide  = direction === "YES" ? probYes : 1 - probYes;
  const priceSide = direction === "YES" ? bucketPrice : 1 - bucketPrice;
  const safePrice = Math.max(0.01, Math.min(0.99, priceSide));
  const b = (1 / safePrice) - 1;
  const rawKelly = b > 0 ? Math.max(0, (probSide * b - (1 - probSide)) / b) : 0;
  // ¼-Kelly + confidence shrinkage. Confidence is a noisy signal so we
  // dampen Kelly by it (acts as a Bayesian shrinkage toward 0).
  const kellyFraction = rawKelly * forecast.confidence * 0.25;
  const cappedKelly   = Math.min(kellyFraction, KELLY_CAP);
  gates.push({
    label: "Kelly méret ≤ cap",
    passed: cappedKelly <= KELLY_CAP,
    actual:   `${(cappedKelly * 100).toFixed(2)}%`,
    required: `≤ ${(KELLY_CAP * 100).toFixed(1)}%`,
    hint: "¼-Kelly × confidence + 15% hard cap, plus a maxPositionUSD floor.",
  });

  // 8. Cross-position consistency (2026-05-14e). Polymarket weather events
  // are negRisk groups: all sub-buckets in one (city, date) event are
  // mutually exclusive, so Σ P(YES) across our YES positions in that group
  // must be ≤ 1.0. The bot's own model is the source of truth here —
  // `predictedProb` on each open position is the YES-side prob the
  // forecast assigned at entry. Block any new YES that would push the
  // running sum over 1.0.
  //
  // Soft pass: gate only applies to YES candidates. NO positions are
  // safe (P(NO) = 1 − P(YES_bucket), but they don't accumulate). For YES
  // candidates with no same-group open positions, the gate reports "n/a".
  const cityDateKey = `${forecast.city}::${forecast.date}`;
  if (direction === "YES") {
    let sumExisting = 0;
    let countSameGroup = 0;
    for (const p of openPositions) {
      if (p.category !== "weather") continue;
      if (p.direction !== "YES") continue;
      const meta = p.weatherMeta;
      const pp = typeof p.predictedProb === "number" && Number.isFinite(p.predictedProb)
        ? p.predictedProb
        : null;
      if (!meta || pp === null) continue;
      if (`${meta.city}::${meta.date}` !== cityDateKey) continue;
      sumExisting += pp;
      countSameGroup += 1;
    }
    const candProb = match.probability;
    const projected = sumExisting + candProb;
    const consistent = projected <= 1.0 + 1e-6;
    gates.push({
      label: "Monotonicitás (egyéb nyitott pozíciók)",
      passed: consistent,
      actual: countSameGroup === 0
        ? `n/a (nincs YES pozíció ${forecast.city} ${forecast.date}-re)`
        : `Σ P(YES) ${forecast.city} ${forecast.date}: ${(sumExisting * 100).toFixed(0)}% + ${(candProb * 100).toFixed(0)}% = ${(projected * 100).toFixed(0)}%`,
      required: "Σ P(YES) ≤ 100%",
      hint: "Egy negRisk weather event bucket-jei kölcsönösen kizárják egymást — Σ P(YES) > 100% modell-ellentmondás.",
    });
    if (!consistent) reasons.push(
      `Cross-position monotonicity: Σ P(YES) ${(sumExisting * 100).toFixed(0)}% + ${(candProb * 100).toFixed(0)}% = ${(projected * 100).toFixed(0)}% > 100% ` +
      `(${forecast.city} ${forecast.date})`,
    );
  } else {
    gates.push({
      label: "Monotonicitás (egyéb nyitott pozíciók)",
      passed: true,
      actual: "n/a (NO oldal, bucket-ek kizárása nem akkumulál)",
      required: "—",
      hint: "Csak YES-oldal kandidátusoknál értelmezett. NO oldali pozíciók nem összegződnek bucket-szétdaraboláson.",
    });
  }

  const allPassed = gates.every((g) => g.passed);

  if (!allPassed) {
    return {
      shouldTrade: false,
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
      positionSizeUSDC: 0,
      reason: reasons[0] ?? "Gate failure",
      gates,
      kellyRaw:    kellyFraction,
      kellyCapped: cappedKelly,
      kellyCap:    KELLY_CAP,
      grossEdge,
      netEdge,
    };
  }

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
