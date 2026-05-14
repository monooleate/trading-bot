// auto-trader/shared/live-readiness.mts
//
// Single-source-of-truth gate that decides whether a paper trader's track
// record is good enough to flip into live trading. Used by:
//
//   1. The cron loop of each trader (crypto, weather, hyperliquid,
//      hyperliquid funding-arb). When paperMode === false but readiness
//      fails, the loop force-flips paperMode back to true for that tick
//      and fires a Telegram alarm (once per session). This makes it
//      structurally impossible to accidentally trade live on an unproven
//      sim.
//
//   2. The /auto-trader-api status endpoint. Surfaced under
//      `liveReadiness` so the UI can render a per-gate badge.
//
//   3. Settings UI. Each trader has its own thresholds; defaults are
//      conservative and set in trader-settings.mts.
//
// What we test (for prediction-driven traders: crypto + weather):
//
//   - tradeCount       >= minTrades            (≥30 default)
//   - winRate          >= minWinRate           (50% default — we want
//                                              positive expectation,
//                                              relaxed for fee-laden venues)
//   - max |IC|         >= minIC                (0.05 default)
//   - calibration dev  <  maxCalibrationDev    (0.07 default)
//   - sharpe           >= minSharpe            (0.5 default)
//   - drawdownPct      <  maxDrawdownPct       (25% default)
//   - simVersion       == current PAPER_SIM_VERSION
//   - !session.stopped
//
// For the funding-arb trader the IC/calibration gates do not apply (the
// strategy is rate-driven, not prediction-driven). It uses tradeCount,
// sharpe, drawdown and session-state gates only.

import type { ClosedTrade, SessionState, Category } from "./types.mts";
import {
  computeSummary,
  computeCalibrationHealth,
} from "../../edge-tracker/statistics.mts";

export interface LiveReadinessThresholds {
  minTrades:         number;
  minWinRate:        number;       // 0..1
  minIC:             number;       // 0..1
  maxCalibrationDev: number;       // 0..1 — average |predicted - actual| over buckets
  minSharpe:         number;
  maxDrawdownPct:    number;       // % vs start bankroll (e.g. 25 = 25%)
}

export const DEFAULT_THRESHOLDS: LiveReadinessThresholds = {
  minTrades:         30,
  minWinRate:        0.50,
  minIC:             0.05,
  maxCalibrationDev: 0.07,
  minSharpe:         0.5,
  maxDrawdownPct:    25,
};

export interface ReadinessGate {
  key:    string;
  label:  string;
  passed: boolean;
  actual: string;
  required: string;
  // Whether this gate is even applicable to the trader (e.g. IC for
  // funding-arb is N/A). N/A gates don't count toward `ready`.
  applicable: boolean;
}

export interface LiveReadinessReport {
  category:           Category | "hyperliquid" | "funding-arb";
  ready:              boolean;          // every applicable gate passed
  gatesPassed:        number;
  gatesTotal:         number;
  gates:              ReadinessGate[];
  thresholds:         LiveReadinessThresholds;
  summary: {
    tradeCount:    number;
    winRate:       number;
    maxAbsIC:      number;
    topSignal:     string | null;
    calibDev:      number;
    sharpe:        number;
    drawdownPct:   number;
    sessionStopped: boolean;
    simVersion:    number | null;
    simVersionExpected: number | null;
  };
  reason: string;                       // one-line human-readable summary
  // Override state (set by `shouldForcePaper`, surfaced to the UI):
  // true means the operator has flipped `liveReadyOverrideEnabled=1` and
  // the bot is bypassing the readiness gate. Even when the gate would
  // have failed, the bot trades live.
  overrideActive?: boolean;
}

interface ComputeArgs {
  category: Category | "hyperliquid" | "funding-arb";
  session:  Pick<SessionState, "closedTrades" | "stopped" | "stoppedReason" | "simVersion" | "bankrollStart">;
  // Override stats source — useful for HL/funding-arb where ClosedTrade shape differs.
  // If omitted, statistics are computed from session.closedTrades directly.
  trades?: ClosedTrade[];
  // Bumped each time we change the paper simulator semantics. Pass the
  // expected version for prediction-driven traders so old paper data
  // doesn't qualify a new sim version. Pass null to skip this gate.
  simVersionExpected?: number | null;
  thresholds?: Partial<LiveReadinessThresholds>;
}

const PREDICTION_DRIVEN: Set<string> = new Set(["crypto", "weather"]);

export function computeLiveReadiness(args: ComputeArgs): LiveReadinessReport {
  // Callers typically build the thresholds object from the runtime-override
  // store, where every field is `undefined` until the operator sets it. A
  // naive spread would overwrite our defaults with those undefineds and then
  // `T.minWinRate.toFixed(0)` further down would throw. Strip undefined /
  // non-finite numbers before merging so the defaults always win for unset keys.
  const rawOv = (args.thresholds ?? {}) as Record<string, unknown>;
  const cleanOv: Partial<LiveReadinessThresholds> = {};
  for (const [k, v] of Object.entries(rawOv)) {
    if (typeof v === "number" && Number.isFinite(v)) (cleanOv as any)[k] = v;
  }
  const T: LiveReadinessThresholds = { ...DEFAULT_THRESHOLDS, ...cleanOv };
  const trades = args.trades ?? args.session.closedTrades ?? [];
  const start = args.session.bankrollStart > 0 ? args.session.bankrollStart : 100;
  const summary = computeSummary(trades, start);
  const ic = computeCalibrationHealth(trades, T.minTrades);

  const isPredictionDriven = PREDICTION_DRIVEN.has(args.category);
  const sessionStopped = !!args.session.stopped;
  const simVersion = args.session.simVersion ?? null;
  const simVersionExpected = args.simVersionExpected ?? null;

  const gates: ReadinessGate[] = [];

  gates.push({
    key:    "trade-count",
    label:  "Trade count",
    actual: `${summary.totalTrades}`,
    required: `≥ ${T.minTrades}`,
    passed: summary.totalTrades >= T.minTrades,
    applicable: true,
  });

  gates.push({
    key:    "win-rate",
    label:  "Win rate",
    actual: `${(summary.winRate * 100).toFixed(1)}%`,
    required: `≥ ${(T.minWinRate * 100).toFixed(0)}%`,
    passed: summary.winRate >= T.minWinRate,
    applicable: summary.totalTrades > 0,
  });

  gates.push({
    key:    "signal-ic",
    label:  "Signal IC (max)",
    actual: `${(ic.maxAbsIC * 100).toFixed(2)}%${ic.topSignal ? ` (${ic.topSignal})` : ""}`,
    required: `≥ ${(T.minIC * 100).toFixed(0)}%`,
    passed: ic.maxAbsIC >= T.minIC,
    applicable: isPredictionDriven,
  });

  gates.push({
    key:    "calibration-deviation",
    label:  "Calibration deviation",
    actual: `${(summary.calibrationDeviation * 100).toFixed(1)}%`,
    required: `< ${(T.maxCalibrationDev * 100).toFixed(0)}%`,
    passed: summary.calibrationDeviation < T.maxCalibrationDev,
    applicable: isPredictionDriven && summary.totalTrades >= 10,
  });

  gates.push({
    key:    "sharpe",
    label:  "Sharpe ratio",
    actual: summary.sharpeRatio.toFixed(2),
    required: `≥ ${T.minSharpe.toFixed(2)}`,
    passed: summary.sharpeRatio >= T.minSharpe,
    applicable: summary.totalTrades >= 10,
  });

  gates.push({
    key:    "max-drawdown",
    label:  "Max drawdown",
    actual: `${summary.maxDrawdownPct.toFixed(1)}%`,
    required: `< ${T.maxDrawdownPct.toFixed(0)}%`,
    passed: summary.maxDrawdownPct < T.maxDrawdownPct,
    applicable: summary.totalTrades > 0,
  });

  gates.push({
    key:    "session-active",
    label:  "Session active (not stopped)",
    actual: sessionStopped ? `stopped: ${args.session.stoppedReason ?? "—"}` : "active",
    required: "active",
    passed: !sessionStopped,
    applicable: true,
  });

  if (simVersionExpected !== null) {
    gates.push({
      key:    "sim-version",
      label:  "Paper sim version",
      actual: simVersion === null ? "unknown" : `v${simVersion}`,
      required: `= v${simVersionExpected}`,
      passed: simVersion === simVersionExpected,
      applicable: isPredictionDriven,
    });
  }

  const applicable = gates.filter((g) => g.applicable);
  const passed = applicable.filter((g) => g.passed);
  const ready = applicable.length > 0 && passed.length === applicable.length;

  let reason: string;
  if (ready) {
    reason = `Ready: ${passed.length}/${applicable.length} gates passed.`;
  } else {
    const failed = applicable.filter((g) => !g.passed).map((g) => g.label);
    reason = failed.length === 0
      ? "Not ready: insufficient data."
      : `Not ready: ${failed.join(", ")}`;
  }

  return {
    category: args.category,
    ready,
    gatesPassed: passed.length,
    gatesTotal: applicable.length,
    gates,
    thresholds: T,
    summary: {
      tradeCount:    summary.totalTrades,
      winRate:       summary.winRate,
      maxAbsIC:      ic.maxAbsIC,
      topSignal:     ic.topSignal,
      calibDev:      summary.calibrationDeviation,
      sharpe:        summary.sharpeRatio,
      drawdownPct:   summary.maxDrawdownPct,
      sessionStopped,
      simVersion,
      simVersionExpected,
    },
    reason,
  };
}

// Convenience: if the trader is configured for live mode but readiness is
// not OK, this returns the canonical paper-mode-fallback decision the cron
// path should enforce. Centralised here so all traders use the same rule.
//
// `overrideEnabled` (Settings → Live readiness → "Override readiness gate"):
// when true AND the bot is configured for live, skip the gate evaluation
// entirely. The report is annotated with `overrideActive=true` so the UI
// can surface this state, but the bot is NOT forced back to paper.
export function shouldForcePaper(
  configuredPaperMode: boolean,
  readiness: LiveReadinessReport,
  overrideEnabled: boolean = false,
): { forcePaper: boolean; reason: string | null; overrideActive: boolean } {
  if (configuredPaperMode) return { forcePaper: false, reason: null, overrideActive: false }; // already paper, nothing to enforce
  if (overrideEnabled) {
    readiness.overrideActive = true;
    return {
      forcePaper: false,
      reason: null,
      overrideActive: true,
    };
  }
  if (readiness.ready) return { forcePaper: false, reason: null, overrideActive: false };
  return {
    forcePaper: true,
    reason:
      `Live trading blocked by readiness gate: ${readiness.reason} ` +
      `(${readiness.gatesPassed}/${readiness.gatesTotal} gates passed)`,
    overrideActive: false,
  };
}
