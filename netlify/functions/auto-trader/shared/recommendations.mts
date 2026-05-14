// auto-trader/shared/recommendations.mts
//
// Per-bot Coach-mode recommendations engine.
//
// Reads each category's `closedTrades`, current effective Settings, and
// the persisted realized-IC calibration record, then produces a list of
// suggested parameter changes for the operator. Apply is a manual click —
// the engine NEVER mutates state. The Apply path goes through the existing
// auth-protected `trader-settings` POST endpoint (same surface as the
// Settings tab).
//
// Design principles:
//   1. Never recommend hard guardrails (Kelly fraction, sanity cap,
//      session-loss-limit, liveReadinessOverride) — these are operator-
//      only by design. The engine surfaces them as `info` if anomalous.
//   2. Always include `reasoning` + `dataPoints` so the operator can
//      sanity-check WHY the suggestion was made (avoids black-box drift).
//   3. Confidence label drives UI prominence: `high` = N is large enough
//      that the recommendation is statistically meaningful; `medium` =
//      worth showing but operator should verify; `low` = early signal,
//      include `info` severity only.
//   4. Below the per-recommendation MIN_TRADES, return early with a single
//      `insufficient-data` info item.

import type { ClosedTrade, SessionState } from "./types.mts";
import {
  computeSummary,
  computeSignalIC,
  computeCalibrationHealth,
} from "../../edge-tracker/statistics.mts";
import { computeRealizedICs } from "./signal-calibration.mts";

// ─── Public types ────────────────────────────────────────────────────────

export type RecommendationSeverity = "info" | "warn" | "action";
export type RecommendationConfidence = "low" | "medium" | "high";

export interface Recommendation {
  id:             string;                  // unique within a response (stable per-rule)
  /**
   * Settings SCHEMA field name. Apply POSTs `{ [field]: suggestedValue }`
   * to `/trader-settings`. If null, the recommendation is informational
   * only (no apply button) — e.g. "session has 5 consecutive losses,
   * consider Stop" kind of operator-attention items.
   */
  field:          string | null;
  currentValue:   number | null;
  suggestedValue: number | null;
  severity:       RecommendationSeverity;
  confidence:     RecommendationConfidence;
  title:          string;                  // short label rendered as the row title
  reasoning:      string;                  // 1-2 sentences explaining WHY
  dataPoints:     Record<string, string | number>;
  /** Action verb on the Apply button. Default: "Apply". */
  applyLabel?:    string;
}

export interface RecommendationsResponse {
  category:             RecommendationCategory;
  generatedAt:          string;
  tradeCount:           number;
  closedTradeWindow:    string;            // e.g. "all", "last 50", "last 100"
  recommendations:      Recommendation[];
  /** Echoes back the active half-life for transparency. null = uniform. */
  halfLifeTradesUsed:   number | null;
}

export type RecommendationCategory = "crypto" | "weather" | "hyperliquid" | "funding-arb";

// ─── Tunables ────────────────────────────────────────────────────────────

const MIN_TRADES_FOR_ANY_REC = 5;     // below this, return only insufficient-data
const MIN_TRADES_FOR_IC_RECS = 20;    // per-signal IC + Bonferroni rec
const MIN_TRADES_FOR_WR_RECS = 15;    // edge/confidence threshold rec
const DEFAULT_HALF_LIFE      = 50;    // exponential decay over ~50 trades

// ─── Helpers ─────────────────────────────────────────────────────────────

function round(value: number, digits: number = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Subset of trades for a "recent window" — chronologically last N. Used to
 * surface "in the last 50 trades, the bot was blocked X times" style stats
 * that depend on observable recent operator-visible state, not the full
 * history (which may include obsolete-preset trades).
 */
function recentTrades(trades: ClosedTrade[], n: number): ClosedTrade[] {
  if (trades.length <= n) return trades.slice();
  return [...trades]
    .sort((a, b) => new Date(a.closedAt ?? a.openedAt ?? 0).getTime() - new Date(b.closedAt ?? b.openedAt ?? 0).getTime())
    .slice(-n);
}

// ─── Per-category engines ────────────────────────────────────────────────

interface EngineArgs {
  trades:          ClosedTrade[];
  session:         Pick<SessionState, "bankrollStart" | "bankrollCurrent" | "stopped" | "stoppedReason" | "calibrationAlertSentAt">;
  effective:       Record<string, number>;          // current Settings effective values
  halfLifeTrades?: number | null;
}

// ── Crypto / HL Perp share the same 8-signal pipeline, just different
//    Settings field names. The engine is parameterised so both call into
//    the same shape with their own field map.
interface PredictionFieldMap {
  edgeThreshold:         string;
  combinerConfidenceMin: string;
  minActiveSignals:      string;
  maxOpenPositions:      string;
  cooldownSeconds:       string;
  sessionLossLimit:      string;
}

const CRYPTO_FIELDS: PredictionFieldMap = {
  edgeThreshold:         "edgeThreshold",
  combinerConfidenceMin: "combinerConfidenceMin",
  minActiveSignals:      "cryptoMinActiveSignals",
  maxOpenPositions:      "cryptoMaxOpenPositions",
  cooldownSeconds:       "cooldownSeconds",
  sessionLossLimit:      "sessionLossLimit",
};

const HL_FIELDS: PredictionFieldMap = {
  edgeThreshold:         "hlEdgeThresholdPaper",
  combinerConfidenceMin: "combinerConfidenceMin",  // shared across crypto + HL
  minActiveSignals:      "hlMinActiveSignals",
  maxOpenPositions:      "hlMaxOpenPositions",
  cooldownSeconds:       "hlCooldownSeconds",
  sessionLossLimit:      "hlSessionLossLimit",
};

/**
 * Recommendations for prediction-driven 8-signal bots (crypto + HL Perp).
 *
 * Rule set:
 *  R1: useRealizedIC — if N >= 30 and Bonferroni-good signal exists, suggest
 *      turning ON the realized-IC blend. Replaces static academic priors
 *      with measured values weighted by Bayes shrinkage.
 *  R2: combinerConfidenceMin — if average finalProb |Δ| from 0.5 across
 *      recent trades is high enough that the current gate accepts most
 *      decisions, leave as-is; if the gate filters >50% of would-be entries
 *      while WR > 50% on the ones that pass, suggest lowering.
 *  R3: edgeThreshold — based on observed PnL by edge bucket. If the
 *      threshold accepts trades with low net positive PnL, suggest
 *      raising; if there's evidence that edge slightly below the gate
 *      would still be net profitable, suggest lowering.
 *  R4: per-signal IC < weak threshold over N >= 20 — informational warning
 *      that this signal is currently noise. No suggested apply (operator
 *      decides via combiner code path).
 *  R5: drawdown trending — if max drawdown over recent window exceeds
 *      50% of the sessionLossLimit, suggest a soft pause warning (info).
 */
function recommendPrediction(
  args: EngineArgs,
  fields: PredictionFieldMap,
  isPredictionDriven: boolean = true,
): Recommendation[] {
  const recs: Recommendation[] = [];
  const trades = args.trades;
  const n = trades.length;

  // R1: realized-IC on/off
  if (n >= MIN_TRADES_FOR_IC_RECS) {
    const useRealizedIC = (args.effective.useRealizedIC ?? 0) >= 0.5;
    const halfLife = args.halfLifeTrades ?? null;
    const realized = computeRealizedICs(trades, halfLife ? { halfLifeTrades: halfLife } : {});
    let topSignal: string | null = null;
    let topAbsIC = 0;
    let topN = 0;
    for (const [name, cal] of Object.entries(realized)) {
      if (!cal) continue;
      if (Math.abs(cal.ic) > topAbsIC) {
        topAbsIC = Math.abs(cal.ic);
        topSignal = name;
        topN = cal.n;
      }
    }
    const health = computeCalibrationHealth(trades, 30);
    const isGood = health.status === "good" && topAbsIC >= health.goodThreshold;
    if (!useRealizedIC && isGood) {
      recs.push({
        id:             "rec-use-realized-ic",
        field:          "useRealizedIC",
        currentValue:   0,
        suggestedValue: 1,
        severity:       "action",
        confidence:     n >= 50 ? "high" : "medium",
        title:          `Kapcsold be a "Use realized IC" knob-ot (top signal "${topSignal}" mért IC ${pct(topAbsIC)})`,
        reasoning:
          `${n} closed trade alapján a(z) "${topSignal}" mért IC = ${pct(topAbsIC)}, ami ` +
          `meghaladja a Bonferroni-korrigált 'good' küszöböt (${pct(health.goodThreshold)}). ` +
          `Bayes-shrinkage blend (K=${args.effective.calibrationShrinkageK ?? 30}) kalibrálja a ` +
          `combiner-priorokat a tényleges paper track-record-hoz. Reverzibilis.`,
        dataPoints: {
          tradeCount:     n,
          topSignal:      topSignal ?? "—",
          topAbsIC:       round(topAbsIC, 3),
          goodThreshold:  round(health.goodThreshold, 3),
          signalSampleN:  topN,
        },
        applyLabel: "Bekapcsolás",
      });
    } else if (useRealizedIC && health.status === "noise") {
      recs.push({
        id:             "rec-disable-realized-ic",
        field:          "useRealizedIC",
        currentValue:   1,
        suggestedValue: 0,
        severity:       "warn",
        confidence:     "medium",
        title:          `Kapcsold ki a realized IC-t — minden signal noise tartományban`,
        reasoning:
          `${n} trade-en mind a 8 signal IC-je a Bonferroni-'weak' küszöb (${pct(health.weakThreshold)}) ` +
          `alatt van. A realized-IC blend ekkor nagyobb zajt visz be mint a statikus prior.`,
        dataPoints: {
          tradeCount:    n,
          maxAbsIC:      round(health.maxAbsIC, 3),
          weakThreshold: round(health.weakThreshold, 3),
          topSignal:     health.topSignal ?? "—",
        },
        applyLabel: "Kikapcsolás",
      });
    }

    // R4: per-signal noise warnings
    for (const [name, cal] of Object.entries(realized)) {
      if (!cal || cal.n < MIN_TRADES_FOR_IC_RECS) continue;
      if (cal.ic >= 0) continue;  // only flag actively counter-productive signals
      // SE per signal under H0: 1 / sqrt(n - 2). Two-sided 5% → z=1.96.
      const se = 1 / Math.sqrt(Math.max(1, cal.n - 2));
      if (Math.abs(cal.ic) < 1.96 * se) continue;  // not statistically meaningful
      recs.push({
        id:             `rec-signal-negative-${name}`,
        field:          null,
        currentValue:   round(cal.ic, 3),
        suggestedValue: null,
        severity:       "info",
        confidence:     cal.n >= 50 ? "medium" : "low",
        title:          `"${name}" signal mért IC = ${pct(cal.ic)} (anti-prediktív, ${cal.n} trade)`,
        reasoning:
          `Ez a signal aktívan ROSSZ irányba jelez. Ha továbbra is fennáll N=50+ után, ` +
          `érdemes lehet ezt a signalt kikapcsolni a combinerben (kézi kód-módosítás kell, ` +
          `nincs Settings-knob rá). Egyszeri eseményekből (Fed, halving) is jöhet — verify before action.`,
        dataPoints: {
          signalName:    name,
          measuredIC:    round(cal.ic, 3),
          sampleSize:    cal.n,
          stdErr:        round(se, 3),
        },
      });
    }
  }

  // R2: combinerConfidenceMin tuning
  if (n >= MIN_TRADES_FOR_WR_RECS) {
    const cur = args.effective[fields.combinerConfidenceMin] ?? 0.05;
    const summary = computeSummary(trades, args.session.bankrollStart || 100);
    if (n >= 30 && summary.winRate >= 0.55 && cur >= 0.05) {
      const suggested = Math.max(0.02, round(cur - 0.02, 3));
      if (suggested < cur) {
        recs.push({
          id:             "rec-confidence-lower",
          field:          fields.combinerConfidenceMin,
          currentValue:   round(cur, 3),
          suggestedValue: suggested,
          severity:       "action",
          confidence:     n >= 60 ? "high" : "medium",
          title:          `Csökkentsd a Combiner confidence min-t ${pct(cur)} → ${pct(suggested)}`,
          reasoning:
            `${n} trade-en a WR = ${pct(summary.winRate)} (≥55% küszöb felett) — a bot jó ` +
            `döntéseket hoz a jelenlegi gate-küszöb mellett, így alacsonyabb küszöb több ` +
            `paper-trade-volument enged be IC-validációhoz, anélkül hogy minőséget rontana.`,
          dataPoints: {
            tradeCount:  n,
            winRate:     pct(summary.winRate),
            avgPnl:      round(summary.avgPnlPerTrade, 2),
            sharpe:      round(summary.sharpeRatio, 2),
          },
        });
      }
    } else if (n >= 30 && summary.winRate < 0.45) {
      const suggested = Math.min(0.15, round(cur + 0.03, 3));
      if (suggested > cur) {
        recs.push({
          id:             "rec-confidence-raise",
          field:          fields.combinerConfidenceMin,
          currentValue:   round(cur, 3),
          suggestedValue: suggested,
          severity:       "warn",
          confidence:     n >= 60 ? "high" : "medium",
          title:          `Növeld a Combiner confidence min-t ${pct(cur)} → ${pct(suggested)}`,
          reasoning:
            `${n} trade-en WR = ${pct(summary.winRate)} (<45%) — a jelenlegi gate túl sok ` +
            `noise-szignált enged be. Szigorúbb küszöb csak a magasabb-konvergencia signalokat ` +
            `engedi át. Cross-check: ez akkor működik ha a vesztes trade-ek átlagos combiner ` +
            `confidence-e alacsonyabb mint a győzteseké.`,
          dataPoints: {
            tradeCount:  n,
            winRate:     pct(summary.winRate),
            avgPnl:      round(summary.avgPnlPerTrade, 2),
            sharpe:      round(summary.sharpeRatio, 2),
          },
        });
      }
    }

    // R3: edgeThreshold tuning — only if explicit edgeAtEntry data
    const tradesWithEdge = trades.filter((t) =>
      typeof t.edgeAtEntry === "number" && Number.isFinite(t.edgeAtEntry),
    );
    if (tradesWithEdge.length >= MIN_TRADES_FOR_WR_RECS) {
      const curEdge = args.effective[fields.edgeThreshold] ?? 0.12;
      // Bucket by 0.05-wide edge tranches; suggest moving threshold to the
      // first profitable bucket.
      const buckets = new Map<number, { pnl: number; n: number; wins: number }>();
      for (const t of tradesWithEdge) {
        const e = Math.max(0, t.edgeAtEntry as number);
        const bucket = Math.floor(e / 0.05) * 0.05;
        const cur = buckets.get(bucket) ?? { pnl: 0, n: 0, wins: 0 };
        cur.pnl  += t.pnl;
        cur.n    += 1;
        cur.wins += t.pnl > 0 ? 1 : 0;
        buckets.set(bucket, cur);
      }
      // Find the lowest bucket with positive average PnL AND >= 5 trades.
      const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
      let firstProfitable: number | null = null;
      for (const [edge, stats] of sortedBuckets) {
        if (stats.n >= 5 && stats.pnl / stats.n > 0) {
          firstProfitable = edge;
          break;
        }
      }
      if (firstProfitable !== null && Math.abs(firstProfitable - curEdge) >= 0.03) {
        const suggested = round(Math.max(0.02, firstProfitable), 3);
        if (Math.abs(suggested - curEdge) >= 0.03) {
          recs.push({
            id:             "rec-edge-threshold",
            field:          fields.edgeThreshold,
            currentValue:   round(curEdge, 3),
            suggestedValue: suggested,
            severity:       suggested < curEdge ? "info" : "warn",
            confidence:     tradesWithEdge.length >= 50 ? "medium" : "low",
            title:          `Edge threshold ${pct(curEdge)} → ${pct(suggested)}`,
            reasoning:
              `${tradesWithEdge.length} trade edge-eloszlása alapján a legalacsonyabb edge-bucket ` +
              `ahol az átlag PnL pozitív: ${pct(firstProfitable)}. A jelenlegi küszöb ${pct(curEdge)} ` +
              `${suggested < curEdge ? "túl konzervatív" : "túl laza"} — ${suggested < curEdge ? "alacsonyabb" : "magasabb"} küszöb ` +
              `${suggested < curEdge ? "több paper trade-et enged be" : "kiszűri a vesztes alacsony-edge tranche-okat"}.`,
            dataPoints: {
              tradeCount:        tradesWithEdge.length,
              firstProfitableEdge: pct(firstProfitable),
              currentEdge:       pct(curEdge),
            },
          });
        }
      }
    }
  }

  // R5: drawdown attention
  if (n >= 10 && !args.session.stopped) {
    const summary = computeSummary(trades, args.session.bankrollStart || 100);
    const lossLimitField = fields.sessionLossLimit;
    const lossLimit = args.effective[lossLimitField] ?? 20;
    const dd = summary.maxDrawdown;
    if (dd > lossLimit * 0.7) {
      recs.push({
        id:             "rec-drawdown-attention",
        field:          null,
        currentValue:   round(dd, 2),
        suggestedValue: null,
        severity:       dd > lossLimit ? "warn" : "info",
        confidence:     "high",
        title:          `Drawdown $${dd.toFixed(2)} közelíti a session-loss-limit-et ($${lossLimit})`,
        reasoning:
          `Az aktuális max drawdown ${pct(dd / Math.max(1, lossLimit))}-a a hard cap-nek. Ha ` +
          `el is éri, a session auto-stop-pal leáll. Megfontolandó: Loose preset → Normal, ` +
          `vagy szünet 1-2 órára (manuális Stop), míg a market-regime stabilizálódik.`,
        dataPoints: {
          currentDrawdown: round(dd, 2),
          sessionLossLimit: lossLimit,
          tradeCount:      n,
        },
      });
    }
  }

  return recs;
}

// ── Weather: single-signal `forecast_edge` + DEB already handles per-city
//    weights. Recommendations focus on the gate knobs that DEB DOESN'T
//    auto-tune: confidenceMin, edgeThreshold, useEnsemble.
function recommendWeather(args: EngineArgs): Recommendation[] {
  const recs: Recommendation[] = [];
  const trades = args.trades;
  const n = trades.length;

  if (n >= MIN_TRADES_FOR_WR_RECS) {
    const cur = args.effective["weatherEdgeThreshold"] ?? 0.12;
    const summary = computeSummary(trades, args.session.bankrollStart || 100);

    // Same pattern as crypto: bucket by edge tranche, find first profitable.
    const tradesWithEdge = trades.filter((t) =>
      typeof t.edgeAtEntry === "number" && Number.isFinite(t.edgeAtEntry),
    );
    if (tradesWithEdge.length >= 10) {
      const buckets = new Map<number, { pnl: number; n: number }>();
      for (const t of tradesWithEdge) {
        const e = Math.max(0, t.edgeAtEntry as number);
        const bucket = Math.floor(e / 0.05) * 0.05;
        const c = buckets.get(bucket) ?? { pnl: 0, n: 0 };
        c.pnl += t.pnl;
        c.n   += 1;
        buckets.set(bucket, c);
      }
      const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
      let firstProfitable: number | null = null;
      for (const [edge, stats] of sortedBuckets) {
        if (stats.n >= 3 && stats.pnl / stats.n > 0) {
          firstProfitable = edge;
          break;
        }
      }
      if (firstProfitable !== null && Math.abs(firstProfitable - cur) >= 0.03) {
        const suggested = round(Math.max(0.02, firstProfitable), 3);
        recs.push({
          id:             "rec-weather-edge-threshold",
          field:          "weatherEdgeThreshold",
          currentValue:   round(cur, 3),
          suggestedValue: suggested,
          severity:       suggested < cur ? "info" : "warn",
          confidence:     tradesWithEdge.length >= 30 ? "medium" : "low",
          title:          `Weather edge threshold ${pct(cur)} → ${pct(suggested)}`,
          reasoning:
            `${tradesWithEdge.length} weather trade edge-eloszlása alapján a legalacsonyabb ` +
            `profitábilis edge-bucket: ${pct(firstProfitable)}. ` +
            `${suggested < cur ? "Alacsonyabb küszöb több bucket-trade-et enged be." : "Szigorúbb küszöb kiszűri a noise-tartományt."}`,
          dataPoints: {
            tradeCount:          tradesWithEdge.length,
            firstProfitableEdge: pct(firstProfitable),
            currentEdge:         pct(cur),
            winRate:             pct(summary.winRate),
          },
        });
      }
    }

    // useEnsemble: if it's OFF and there are >=10 trades, suggest turning ON.
    // The 31-member GFS ensemble is empirically tighter than the deterministic
    // run + hardcoded σ; this is a one-way street unless the ensemble API
    // fails repeatedly.
    const useEns = (args.effective["weatherUseEnsemble"] ?? 1) >= 0.5;
    if (!useEns && n >= 10) {
      recs.push({
        id:             "rec-weather-ensemble-on",
        field:          "weatherUseEnsemble",
        currentValue:   0,
        suggestedValue: 1,
        severity:       "action",
        confidence:     "high",
        title:          `Kapcsold be a 31-tagú GFS ensemble-t`,
        reasoning:
          `Az ensemble empirikus σ-t ad a determinisztikus run + hardcoded σ helyett. ` +
          `A bucket-matcher Gauss-CDF-je így a valódi forecast-bizonytalanságot tükrözi. ` +
          `Open-Meteo ensemble API ingyenes, retry-tolerant. Default ON azóta hogy ` +
          `bevezettük 2026-05-11-én; csak akkor maradna OFF ha az API leesik.`,
        dataPoints: { tradeCount: n },
        applyLabel: "Bekapcsolás",
      });
    }
  }

  // R-Weather: confidenceMin tuning
  if (n >= MIN_TRADES_FOR_WR_RECS) {
    const summary = computeSummary(trades, args.session.bankrollStart || 100);
    const curConf = args.effective["weatherConfidenceMin"] ?? 0.65;
    if (n >= 25 && summary.winRate < 0.45 && curConf <= 0.70) {
      const suggested = Math.min(0.85, round(curConf + 0.05, 3));
      recs.push({
        id:             "rec-weather-confidence-raise",
        field:          "weatherConfidenceMin",
        currentValue:   round(curConf, 3),
        suggestedValue: suggested,
        severity:       "warn",
        confidence:     "medium",
        title:          `Növeld a weather confidence min-t ${pct(curConf)} → ${pct(suggested)}`,
        reasoning:
          `${n} trade WR = ${pct(summary.winRate)} (<45%) — a forecast confidence ` +
          `nincs jól szelektálva. Szigorúbb küszöb csak a magasabb ensemble-egyetértésű ` +
          `forecast-okra hagy trade-et nyitni.`,
        dataPoints: {
          tradeCount: n,
          winRate:    pct(summary.winRate),
          avgPnl:     round(summary.avgPnlPerTrade, 2),
        },
      });
    }
  }

  return recs;
}

// ── F-Arb: rate-driven, no IC. Recommendations focus on funding-spread
//    thresholds based on observed spread-decay timing.
function recommendFundingArb(args: EngineArgs): Recommendation[] {
  const recs: Recommendation[] = [];
  const trades = args.trades;
  const n = trades.length;

  if (n >= 5) {
    const summary = computeSummary(trades, args.session.bankrollStart || 100);
    const curMin = args.effective["frMinSpreadHourly"] ?? 0.0001;

    // If realized PnL per trade is consistently negative, the entry gate
    // is letting too thin a spread through. If the average net per-trade
    // is < -0.05% of position, suggest raising the min spread.
    const winRate = summary.winRate;
    if (n >= 10 && winRate < 0.50 && curMin < 0.0003) {
      const suggested = round(Math.min(0.0005, curMin + 0.0001), 5);
      recs.push({
        id:             "rec-farb-min-spread-raise",
        field:          "frMinSpreadHourly",
        currentValue:   round(curMin, 5),
        suggestedValue: suggested,
        severity:       "warn",
        confidence:     "medium",
        title:          `Növeld a min spread-küszöböt ${pct(curMin * 24 * 365)}/yr → ${pct(suggested * 24 * 365)}/yr`,
        reasoning:
          `${n} arb trade-en a WR = ${pct(winRate)} — a min-spread gate túl alacsonyan ` +
          `van, fee-laden margin után a vékony arb-ok elveszítik a hozamot. Magasabb ` +
          `küszöb kevesebb, de magasabb-margin pozíciókat enged.`,
        dataPoints: {
          tradeCount:    n,
          winRate:       pct(winRate),
          avgPnl:        round(summary.avgPnlPerTrade, 2),
          currentMinAnn: pct(curMin * 24 * 365),
        },
      });
    } else if (n >= 20 && winRate >= 0.65 && curMin >= 0.0001) {
      const suggested = round(Math.max(0.00005, curMin - 0.00003), 5);
      recs.push({
        id:             "rec-farb-min-spread-lower",
        field:          "frMinSpreadHourly",
        currentValue:   round(curMin, 5),
        suggestedValue: suggested,
        severity:       "action",
        confidence:     "medium",
        title:          `Csökkentsd a min spread-küszöböt — ${pct(winRate)} WR magas konfidenciát ad`,
        reasoning:
          `${n} trade WR ${pct(winRate)} (≥65%) — a stratégia masszívan profitábilis a ` +
          `jelenlegi küszöbnél. Alacsonyabb küszöb több arb-opportunity-t enged be, ` +
          `a marginot csak a fee-laden break-even határolja.`,
        dataPoints: {
          tradeCount:    n,
          winRate:       pct(winRate),
          avgPnl:        round(summary.avgPnlPerTrade, 2),
          currentMinAnn: pct(curMin * 24 * 365),
        },
      });
    }
  }

  // R-F-Arb: maxHoldDays — if the average hold time is well below the cap,
  // suggest lowering (releases capital faster).
  if (n >= 10) {
    const holds = trades
      .map((t) => {
        const o = new Date(t.openedAt ?? 0).getTime();
        const c = new Date(t.closedAt ?? 0).getTime();
        return Number.isFinite(o) && Number.isFinite(c) && c > o ? (c - o) / 86_400_000 : null;
      })
      .filter((h): h is number => h !== null);
    if (holds.length >= 5) {
      const avgHold = holds.reduce((s, h) => s + h, 0) / holds.length;
      const curMax = args.effective["frMaxHoldDays"] ?? 14;
      if (avgHold * 2 < curMax && curMax > 3) {
        const suggested = Math.max(3, Math.round(avgHold * 2));
        if (suggested < curMax) {
          recs.push({
            id:             "rec-farb-max-hold-lower",
            field:          "frMaxHoldDays",
            currentValue:   curMax,
            suggestedValue: suggested,
            severity:       "info",
            confidence:     "low",
            title:          `Csökkentsd a max hold-time-ot ${curMax}d → ${suggested}d`,
            reasoning:
              `Az átlag hold-idő ${avgHold.toFixed(1)} nap (${holds.length} trade), ami a ` +
              `jelenlegi max hold ${curMax} napjának kevesebb mint fele. Az alacsonyabb cap ` +
              `gyorsabban felszabadítja a tőkét új opportunity-kre.`,
            dataPoints: {
              tradeCount:      holds.length,
              avgHoldDays:     round(avgHold, 2),
              currentMaxDays:  curMax,
            },
          });
        }
      }
    }
  }

  return recs;
}

// ─── Public dispatch ─────────────────────────────────────────────────────

export function generateRecommendations(
  category: RecommendationCategory,
  args: EngineArgs,
): Recommendation[] {
  const n = args.trades.length;
  if (n < MIN_TRADES_FOR_ANY_REC) {
    return [{
      id:             "rec-insufficient-data",
      field:          null,
      currentValue:   null,
      suggestedValue: null,
      severity:       "info",
      confidence:     "low",
      title:          `Túl kevés closed trade a javaslatokhoz (${n} / ${MIN_TRADES_FOR_ANY_REC} min.)`,
      reasoning:
        `A recommendations engine min. ${MIN_TRADES_FOR_ANY_REC} closed paper trade-et igényel ` +
        `mielőtt érdemi javaslatot adhat. Addig a default presetek (Loose / Normal / Strict) ` +
        `a megfelelő tuning-felület.`,
      dataPoints: {
        currentTradeCount: n,
        minRequired:       MIN_TRADES_FOR_ANY_REC,
      },
    }];
  }

  switch (category) {
    case "crypto":      return recommendPrediction(args, CRYPTO_FIELDS, true);
    case "hyperliquid": return recommendPrediction(args, HL_FIELDS,     true);
    case "weather":     return recommendWeather(args);
    case "funding-arb": return recommendFundingArb(args);
  }
}

export { DEFAULT_HALF_LIFE };
