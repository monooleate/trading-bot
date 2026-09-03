// packages/core/src/promotion-gate.mts
//
// Promotion gate — model-discovery-training §3 / roadmap #1 (sprints.md B50).
// Pure, portable (zero I/O).
//
// WHY: the system ALREADY computes proper scores, walk-forward Brier-skill vs the
// market, PSR/MinTRL/DSR, and Platt/AdaHedge challenger deltas — but every one of
// those is advisory display. Knob changes and default-OFF flips still get
// promoted on eyeballed PnL, which on dozens of fat-tailed trades is noise (the
// "profit sits on 4 longshots" pathology). This module turns the scattered
// metrics into ONE pre-registered, numeric verdict —
//   PROMOTE / HOLD / INSUFFICIENT_DATA —
// judged PRIMARILY on proper scores (calibration skill + beating the market price
// out-of-sample), with the Sharpe/DSR side as SECONDARY confirmation. That is
// exactly the objective-function switch (PnL/Sharpe → proper score) the discovery
// calls the cheapest, highest-leverage change.
//
// Advisory only: it changes NO trading behaviour. Its job is to make the bar
// EXPLICIT and version-controlled instead of living in an operator's head. The
// thresholds below ARE the pre-registered gate — changing them is itself a
// research decision (and, like any knob change, a DSR trial).
//
// Objective-function stance (why proper score is hard, Sharpe is advisory): on
// tens–hundreds of trades a PnL/Sharpe difference is usually NOT measurable
// (MinTRL), while a proper score aggregates every scored prediction (incl.
// skipped) → far larger effective N, far lower variance, and it is what the
// Kelly sizing actually consumes. So the hard gates are proper-score / beats-the-
// -market; PSR/DSR/MinTRL are surfaced as confirmation, not as blockers.

// ─── Pre-registered thresholds (THE gate) ───────────────────────────────────
export const PROMOTION_THRESHOLDS = {
  minScoredN:       30,    // proper-score sample floor (below → INSUFFICIENT_DATA)
  minBrierSkill:    0,     // must beat always-predict-base-rate (>0)
  wfMinResolved:    10,    // walk-forward gates only evaluable above this ledger depth
  minWfBrierSkill:  0,     // must beat the MARKET price out-of-sample (>0)
  minWfConsistency: 0.6,   // ≥60% of walk-forward blocks positive (edge not one window)
  maxWfDayShare:    0.5,   // ≤50% of resolved predictions from one day (anti-cluster)
  minChallenger:    0,     // a proposed ON-flip must lower Brier out-of-sample (>0)
  // Secondary / advisory (surfaced, never blocks a PROMOTE):
  minPsr:           0.95,  // fat-tail-aware significance
  minDsr:           0.95,  // trial-deflated significance (config-hunting penalty)
} as const;

export type PromotionDecision = "PROMOTE" | "HOLD" | "INSUFFICIENT_DATA";

export interface GateCheck {
  label: string;
  kind: "hard" | "advisory";   // hard blocks PROMOTE; advisory is surfaced only
  passed: boolean;
  actual: string;
  required: string;
  hint: string;
}

export interface PromotionGateInput {
  // Proper scoring (computeProperScores) — the PRIMARY objective.
  scoredN: number;
  brierSkillScore: number;     // >0 ⇒ beats always-predict-base-rate
  logSkillScore: number;
  // Walk-forward vs the market price (computeWalkForward).
  wfBrierSkill: number;        // >0 ⇒ model beats market price OOS
  wfConsistency: number;       // fraction of blocks with positive skill
  wfMaxDayShare: number;       // 1 ⇒ all one correlated cluster
  wfNResolved: number;
  // Sharpe-side (summary + DSR) — SECONDARY confirmation only.
  psr: number;                 // P(true SR > 0) ∈ [0,1]
  dsr: number;                 // deflated Sharpe (trial-aware) ∈ [0,1]
  minTrl: number;              // trades needed for SR significance (large sentinel = ∞)
  tradeN: number;              // # closed trades (for the MinTRL comparison)
  nTrials: number;             // config trials tried so far (context for the deflation)
  // Optional challenger: "would flipping THIS default-OFF knob ON help?"
  // Feed calibrationEval / onlineWeightsEval brierImprovement here.
  challenger?: {
    label: string;
    applicable: boolean;
    brierImprovement: number;  // >0 ⇒ challenger lowers Brier out-of-sample
  };
}

export interface PromotionGateResult {
  decision: PromotionDecision;
  checks: GateCheck[];
  hardPassed: number;
  hardTotal: number;
  headline: string;
  detail: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Evaluate the promotion gate from already-computed forward metrics. Pure.
 *
 * Decision logic:
 *   • scoredN < minScoredN                       → INSUFFICIENT_DATA (can't judge)
 *   • all HARD checks pass                       → PROMOTE
 *   • otherwise                                  → HOLD (failing hard checks named)
 *
 * Walk-forward gates are only treated as HARD when the ledger has ≥ wfMinResolved
 * resolved predictions; below that they degrade to a single advisory note (so
 * ledger-less bots — F-arb/sports — and young ledgers don't false-fail). PSR/DSR/
 * MinTRL are always advisory: proper score is the objective, Sharpe is confirmation.
 */
export function evaluatePromotionGate(input: PromotionGateInput): PromotionGateResult {
  const T = PROMOTION_THRESHOLDS;
  const checks: GateCheck[] = [];

  // — Hard: sample adequacy (proper-score floor) —
  const sampleOk = input.scoredN >= T.minScoredN;
  checks.push({
    label: "Sample adequacy",
    kind: "hard",
    passed: sampleOk,
    actual: `n=${input.scoredN} scored`,
    required: `≥ ${T.minScoredN}`,
    hint: sampleOk ? "Enough scored predictions to judge forecast quality."
                   : "Too few scored predictions — proper scores are noise below this floor.",
  });

  // — Hard: calibration skill vs base-rate (proper score) —
  const brierOk = input.brierSkillScore > T.minBrierSkill;
  checks.push({
    label: "Brier skill vs base-rate",
    kind: "hard",
    passed: brierOk,
    actual: pct(input.brierSkillScore),
    required: "> 0%",
    hint: brierOk ? "Forecast beats always-predict-the-base-rate."
                  : "Forecast does NOT beat the base rate — no calibration edge to promote.",
  });

  // — Hard (only if ledger deep enough): beats the market price OOS —
  const wfEvaluable = input.wfNResolved >= T.wfMinResolved;
  if (wfEvaluable) {
    const wfSkillOk = input.wfBrierSkill > T.minWfBrierSkill;
    checks.push({
      label: "Beats market (out-of-sample)",
      kind: "hard",
      passed: wfSkillOk,
      actual: pct(input.wfBrierSkill),
      required: "> 0%",
      hint: wfSkillOk ? "Model probabilities beat the market price on the ledger."
                      : "Market price is the better forecast — the bot has no edge over the price it trades.",
    });
    const consOk = input.wfConsistency >= T.minWfConsistency;
    checks.push({
      label: "Walk-forward consistency",
      kind: "hard",
      passed: consOk,
      actual: pct(input.wfConsistency),
      required: `≥ ${pct(T.minWfConsistency)}`,
      hint: consOk ? "Edge holds across most time blocks, not one lucky window."
                   : "Edge concentrated in a minority of blocks — likely a regime artifact.",
    });
    const clusterOk = input.wfMaxDayShare <= T.maxWfDayShare;
    checks.push({
      label: "Not one correlated cluster",
      kind: "hard",
      passed: clusterOk,
      actual: `max day ${pct(input.wfMaxDayShare)}`,
      required: `≤ ${pct(T.maxWfDayShare)}`,
      hint: clusterOk ? "Resolved predictions spread across days."
                      : "Most predictions resolved on one day (a strike ladder / same-city buckets) — correlated, effective-N far below nominal.",
    });
  } else {
    checks.push({
      label: "Beats market (out-of-sample)",
      kind: "advisory",
      passed: false,
      actual: `${input.wfNResolved} resolved`,
      required: `≥ ${T.wfMinResolved}`,
      hint: "Ledger too thin (or no market baseline, e.g. F-arb/sports) — market-baseline gate not yet evaluable.",
    });
  }

  // — Optional challenger: would flipping this default-OFF knob ON help? —
  if (input.challenger) {
    const c = input.challenger;
    if (c.applicable) {
      const impOk = c.brierImprovement > T.minChallenger;
      checks.push({
        label: `Challenger «${c.label}» improves proper score`,
        kind: "hard",
        passed: impOk,
        actual: `ΔBrier ${c.brierImprovement >= 0 ? "−" : "+"}${Math.abs(c.brierImprovement * 100).toFixed(1)}pp`,
        required: "lowers Brier",
        hint: impOk ? `Flipping «${c.label}» ON lowers walk-forward Brier — promotable.`
                    : `«${c.label}» does not lower Brier out-of-sample — keep it OFF.`,
      });
    } else {
      checks.push({
        label: `Challenger «${c.label}»`,
        kind: "advisory",
        passed: false,
        actual: "not enough history",
        required: "walk-forward eval",
        hint: `Not enough resolved trades to evaluate «${c.label}» yet.`,
      });
    }
  }

  // — Advisory: Sharpe-side confirmation (never blocks) —
  const psrOk = input.psr >= T.minPsr;
  checks.push({
    label: "PSR (fat-tail significance)",
    kind: "advisory",
    passed: psrOk,
    actual: pct(input.psr),
    required: `≥ ${pct(T.minPsr)}`,
    hint: psrOk ? "Sharpe survives fat-tail correction."
                : "Sharpe not yet significant after fat-tail correction — PnL confirmation weak (secondary).",
  });
  const dsrOk = input.dsr >= T.minDsr;
  checks.push({
    label: "DSR (trial-deflated)",
    kind: "advisory",
    passed: dsrOk,
    actual: pct(input.dsr),
    required: `≥ ${pct(T.minDsr)}`,
    hint: dsrOk ? `Sharpe survives deflation for ${input.nTrials} config trials.`
                : `After deflating for ${input.nTrials} config trials the Sharpe is not significant — config-hunting risk (secondary).`,
  });
  const trlOk = Number.isFinite(input.minTrl) && input.tradeN >= input.minTrl;
  checks.push({
    label: "MinTRL (track-record length)",
    kind: "advisory",
    passed: trlOk,
    actual: `n=${input.tradeN}`,
    required: Number.isFinite(input.minTrl) ? `≥ ${Math.ceil(input.minTrl)}` : "∞ (SR≤0)",
    hint: trlOk ? "Track record long enough for the Sharpe to be significant."
                : "Track record shorter than MinTRL — the Sharpe is not yet significant (secondary).",
  });

  // — Tally + decision —
  const hard = checks.filter((c) => c.kind === "hard");
  const hardPassed = hard.filter((c) => c.passed).length;
  const hardTotal = hard.length;

  let decision: PromotionDecision;
  if (!sampleOk) {
    decision = "INSUFFICIENT_DATA";
  } else if (hardPassed === hardTotal) {
    decision = "PROMOTE";
  } else {
    decision = "HOLD";
  }

  const advPassed = checks.filter((c) => c.kind === "advisory" && c.passed).length;
  const advTotal = checks.filter((c) => c.kind === "advisory").length;
  const failing = hard.filter((c) => !c.passed).map((c) => c.label);

  let headline: string;
  let detail: string;
  const label = input.challenger ? `«${input.challenger.label}»` : "current config";
  if (decision === "INSUFFICIENT_DATA") {
    headline = "INSUFFICIENT DATA";
    detail = `Only ${input.scoredN} scored predictions — need ≥ ${T.minScoredN} before the proper-score gate can judge ${label}. Keep measuring; do not promote.`;
  } else if (decision === "PROMOTE") {
    headline = "PROMOTE";
    detail = `All ${hardTotal} proper-score gates pass — ${label} is promotable. Sharpe-side confirmation ${advPassed}/${advTotal}.` +
      (advPassed < advTotal ? " (PnL/Sharpe confirmation still weak — promote the config, but size conservatively until it firms up.)" : "");
  } else {
    headline = "HOLD";
    detail = `${hardPassed}/${hardTotal} proper-score gates pass — HOLD ${label}. Failing: ${failing.join(", ")}. Do not promote on PnL alone.`;
  }

  return { decision, checks, hardPassed, hardTotal, headline, detail };
}
