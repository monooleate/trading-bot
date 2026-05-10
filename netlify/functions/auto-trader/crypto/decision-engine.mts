import type { TradeDecision, TraderConfig, AggregatedSignal, MarketInfo, DecisionGate } from "../shared/types.mts";
import { getBtcExitConfig } from "../shared/config.mts";

type BtcExitCfg = ReturnType<typeof getBtcExitConfig>;

// ─── Cooldown tracker (in-memory, resets on function restart) ──

const cooldownMap = new Map<string, number>();

export function isOnCooldown(slug: string, cooldownSeconds: number): boolean {
  const lastTrade = cooldownMap.get(slug);
  if (!lastTrade) return false;
  return Date.now() - lastTrade < cooldownSeconds * 1000;
}

export function setCooldown(slug: string): void {
  cooldownMap.set(slug, Date.now());
}

// ─── Decision engine ──────────────────────────────────────
//
// Evaluates the full ordered gate list for one scanned market, then derives
// shouldTrade from `gates.every(g => g.passed)`. Returning the *complete*
// gate list (instead of short-circuiting on the first failure) is what
// powers the unified "X/Y gates" chip on the auto-trader UI — every row
// shows the same Y, so the operator can compare at a glance.
//
// Reason string still tracks the first failing gate so the row footer reads
// naturally.

// Canonical labels for crypto-bot gates. Used by the engine when fully
// evaluating a market AND by the runner to pad early-exit rows so every
// scan row reports the same Y on the "X/Y gates" chip. Keep in sync with
// the gates pushed in makeDecision below.
//
// 2026-05-11 audit expansion: 9 → 12 gates. The legacy "Kelly conviction
// (combiner > 0)" gate was a paper-thin defence — kellyFraction = 0.0001
// would clear it and then the $1 floor on the position size would silently
// pad the trade up to $1, defeating the entire ¼-Kelly system. Three new
// gates now enforce convergence at the same thresholds the combiner uses
// internally:
//   - Combiner confidence ( |p − 0.5| ≥ 5% ) — combiner's own WAIT gate
//   - Combiner recommendation === BUY        — combiner's verdict
//   - Resolution-risk trade_recommended ≠ false — risk-adjustment helper
// And the floor itself moved from an implicit silent pad to an explicit
// "Kelly méret ≥ minimum" gate, so under-conviction signals now show up
// as gate failures in the UI instead of being padded into real trades.
export const CRYPTO_GATE_LABELS = [
  "Session loss limit",
  "Aktív signal források",
  "Combiner confidence (|p − 0.5|)",
  "Combiner recommendation",
  "Resolution-risk gate",
  "Market cooldown",
  "Open interest ≥ küszöb",
  "Entry window (BTC short markets)",
  "OB imbalance konvergencia",
  "Net edge ≥ küszöb",
  "Kelly méret ≥ minimum",
  "Kelly méret ≤ cap",
] as const;

// Build a fully-padded gate list for early-exit code paths (no signal data
// available yet). Caller passes the gates that DID get evaluated; the rest
// are filled with `passed: false, actual: "not evaluated"` so Y stays
// stable at 9 across every row in the UI.
export function padCryptoGates(evaluated: DecisionGate[]): DecisionGate[] {
  const have = new Set(evaluated.map((g) => g.label));
  const out  = [...evaluated];
  for (const label of CRYPTO_GATE_LABELS) {
    if (!have.has(label)) {
      out.push({ label, passed: false, actual: "not evaluated", required: "—" });
    }
  }
  return out;
}

export function makeDecision(
  signal: AggregatedSignal,
  market: MarketInfo,
  bankrollUSDC: number,
  sessionLoss: number,
  config: TraderConfig,
  btcExit?: BtcExitCfg,
): TradeDecision {
  const { finalProb, kellyFraction } = signal;
  const marketPrice = market.currentPrice;
  const grossEdge   = Math.abs(finalProb - marketPrice);
  const netEdge     = grossEdge - config.roundtripFeePct;
  const direction: "YES" | "NO" = finalProb > marketPrice ? "YES" : "NO";
  // Compute the candidate position size up-front so the "Kelly méret ≥
  // minimum" gate has a real USDC number to evaluate. The legacy code
  // computed this only on the happy path AFTER all gates passed and then
  // silently padded sub-min sizes up to $1; now the size is a first-class
  // gate input.
  const kellyCapped       = Math.min(Math.max(0, kellyFraction), config.maxKellyFraction);
  const candidatePosition = bankrollUSDC * kellyCapped;

  const gates: DecisionGate[] = [];
  const reasons: string[] = [];

  // 1. Session loss limit
  const sessionLossOk = sessionLoss < config.sessionLossLimit;
  gates.push({
    label: "Session loss limit",
    passed: sessionLossOk,
    actual:   `$${sessionLoss.toFixed(2)}`,
    required: `< $${config.sessionLossLimit.toFixed(2)}`,
    hint: "A futó session nettó vesztesége nem érheti el a megadott felső határt.",
  });
  if (!sessionLossOk) reasons.push(`Session loss limit reached: $${sessionLoss.toFixed(2)} >= $${config.sessionLossLimit}`);

  // 2. Minimum active signals
  const activeOk = signal.activeSignals >= 2;
  gates.push({
    label: "Aktív signal források",
    passed: activeOk,
    actual:   `${signal.activeSignals}/8`,
    required: "≥ 2",
    hint: "Egyetlen signal-tól nem nyitunk pozíciót — több forrás konvergenciája kell.",
  });
  if (!activeOk) reasons.push(`Too few active signals: ${signal.activeSignals} < 2`);

  // 3. Combiner-confidence gate (audit fix #4, 2026-05-11). Mirrors the
  // signal-combiner's own `recommend()` WAIT threshold: if |p − 0.5| <
  // combinerConfidenceMin, the 8-signal weighted average is statistically
  // indistinguishable from noise (each signal defaults to 0.5 when absent).
  // Without this gate the engine would see "model 0.505 vs market 0.255"
  // and report a 25% edge built entirely on combiner noise.
  const combinerEdgeAbs = Math.abs(finalProb - 0.5);
  const convergenceOk   = combinerEdgeAbs >= config.combinerConfidenceMin;
  gates.push({
    label: "Combiner confidence (|p − 0.5|)",
    passed: convergenceOk,
    actual:   `${(combinerEdgeAbs * 100).toFixed(2)}%`,
    required: `≥ ${(config.combinerConfidenceMin * 100).toFixed(1)}%`,
    hint: "Ha a kombinált predikció 5%-nál közelebb van 50%-hoz, az nem signal, hanem zaj — a 8 jelzés default 0.5-höz konvergál ha nincs valódi input.",
  });
  if (!convergenceOk) reasons.push(
    `Combiner output too close to 0.5: |${finalProb.toFixed(4)} − 0.5| = ${(combinerEdgeAbs * 100).toFixed(2)}% < ${(config.combinerConfidenceMin * 100)}% — noise, not signal`,
  );

  // 4. Combiner recommendation gate (audit fix #3, 2026-05-11). The
  // combiner runs its OWN WAIT/WATCH/SKIP/BUY decision (recommend()), but
  // before this gate the engine ignored that verdict and re-derived an
  // entry purely from finalProb vs. marketPrice. The combiner applies the
  // stricter joint gate (|edge| ≥ 5% AND ir ≥ 0.1 AND kellyQ ≥ 0.005) and
  // also flips BUY → WATCH/SKIP when resolution-risk vetoes the trade.
  const recAction = (signal.combinerRecommendation || "").toUpperCase();
  const recOk     = recAction.startsWith("BUY");
  gates.push({
    label: "Combiner recommendation",
    passed: recOk,
    actual:   recAction || "n/a",
    required: "BUY YES / BUY NO",
    hint: "A signal-combiner saját ajánlása: WAIT = nem konvergens, WATCH = túl kis pozíció, SKIP = resolution-risk veto. Csak BUY-ra trade-elünk.",
  });
  if (!recOk) reasons.push(`Combiner recommendation: ${recAction || "n/a"} (not BUY)`);

  // 5. Resolution-risk gate (audit fix #5, 2026-05-11). The combiner's
  // analyseResolutionRisk() helper flags markets with off-platform
  // resolution sources, ambiguous rules, or dispute history. Previously
  // this verdict was logged in the combiner UI but never read by the
  // trader. `null` means the helper didn't run (skip_risk=1 or fetch
  // failed) — gate passes so we don't block on missing data.
  const riskFlag = signal.tradeRecommendedByRisk;
  const riskOk   = riskFlag !== false;
  gates.push({
    label: "Resolution-risk gate",
    passed: riskOk,
    actual:   riskFlag === null || riskFlag === undefined
      ? "n/a (risk score missing)"
      : (riskFlag ? "trade_recommended: true" : "trade_recommended: false"),
    required: "trade_recommended ≠ false",
    hint: "A resolution-risk helper átállítja a kombinátor ajánlását SKIP/WATCH-ra ha a piac rules / source / dispute kockázata túl magas.",
  });
  if (!riskOk) reasons.push("Resolution-risk: trade_recommended = false");

  // 6. Cooldown
  const cooldownOk = !isOnCooldown(market.slug, config.cooldownSeconds);
  gates.push({
    label: "Market cooldown",
    passed: cooldownOk,
    actual:   cooldownOk ? "ready" : "active",
    required: `${config.cooldownSeconds}s a legutóbbi trade óta`,
    hint: "Ugyanazon a piacon nem trade-elünk N másodpercen belül kétszer.",
  });
  if (!cooldownOk) reasons.push(`Market on cooldown: ${market.slug}`);

  // 7. Open interest
  const oiOk = market.openInterest >= config.minOpenInterest;
  gates.push({
    label: "Open interest ≥ küszöb",
    passed: oiOk,
    actual:   `$${Math.round(market.openInterest).toLocaleString()}`,
    required: `≥ $${config.minOpenInterest.toLocaleString()}`,
    hint: "Vékony piacon a paper-fill nem reflektálja a live likviditást.",
  });
  if (!oiOk) reasons.push(`Low OI: $${market.openInterest} < $${config.minOpenInterest}`);

  // 8. Entry-window filter for short BTC up/down markets (P1.2). Always
  // present in the gate list so Y stays stable across rows; for daily
  // markets the gate is reported as "n/a" and counts as passed.
  if (market.openedAtEstimate) {
    const exit = btcExit ?? getBtcExitConfig();
    const ageMs = Date.now() - new Date(market.openedAtEstimate).getTime();
    const inWindow = ageMs >= exit.entryWindowStartMs && ageMs <= exit.entryWindowEndMs;
    gates.push({
      label: "Entry window (BTC short markets)",
      passed: inWindow,
      actual:   `${Math.round(ageMs / 1000)}s a piac nyitása óta`,
      required: `[${Math.round(exit.entryWindowStartMs / 1000)}s, ${Math.round(exit.entryWindowEndMs / 1000)}s]`,
      hint: "Túl korai belépés zajos; túl késői nem tud kilépni resolve előtt.",
    });
    if (!inWindow) {
      if (ageMs < exit.entryWindowStartMs) reasons.push(`Outside entry window: ${ageMs}ms since open < ${exit.entryWindowStartMs}ms`);
      else                                  reasons.push(`Outside entry window: ${ageMs}ms since open > ${exit.entryWindowEndMs}ms`);
    }
  } else {
    gates.push({
      label: "Entry window (BTC short markets)",
      passed: true,
      actual:   "n/a (daily market)",
      required: "n/a",
      hint: "Csak BTC 5m / 15m up-down piacokra értelmezett — daily piacokon kihagyva.",
    });
  }

  // 9. OB-imbalance convergence (P1.3)
  if (signal.obImbalance && signal.obImbalance.direction !== "NEUTRAL") {
    const obWantsYes = signal.obImbalance.direction === "UP";
    const weWantYes  = direction === "YES";
    const aligned    = obWantsYes === weWantYes;
    gates.push({
      label: "OB imbalance konvergencia",
      passed: aligned,
      actual:   `OB ${signal.obImbalance.direction} (ratio ${signal.obImbalance.ratio.toFixed(2)})`,
      required: direction === "YES" ? "UP / NEUTRAL" : "DOWN / NEUTRAL",
      hint: "Binance top-10 depth ratio ne menjen szembe az általunk vett iránnyal.",
    });
    if (!aligned) reasons.push(
      `OB imbalance diverges: depth ratio ${signal.obImbalance.ratio} → ${signal.obImbalance.direction}, ` +
      `combined signal → ${direction}`,
    );
  } else {
    gates.push({
      label: "OB imbalance konvergencia",
      passed: true,
      actual:   signal.obImbalance ? `OB NEUTRAL (ratio ${signal.obImbalance.ratio.toFixed(2)})` : "no data",
      required: direction === "YES" ? "UP / NEUTRAL" : "DOWN / NEUTRAL",
      hint: "Binance top-10 depth ratio ne menjen szembe az általunk vett iránnyal.",
    });
  }

  // 10. Net edge ≥ threshold
  const edgeOk = netEdge >= config.edgeThreshold;
  gates.push({
    label: "Net edge ≥ küszöb",
    passed: edgeOk,
    actual:   `${netEdge >= 0 ? "+" : ""}${(netEdge * 100).toFixed(2)}% (gross ${(grossEdge * 100).toFixed(2)}% − fees ${(config.roundtripFeePct * 100).toFixed(2)}%)`,
    required: `≥ ${(config.edgeThreshold * 100).toFixed(1)}%`,
    hint: "|finalProb − marketPrice| − roundtrip fees, signed.",
  });
  if (!edgeOk) reasons.push(
    `Net edge ${(netEdge * 100).toFixed(1)}% < threshold ${(config.edgeThreshold * 100)}% ` +
    `(gross ${(grossEdge * 100).toFixed(1)}% - fees ${(config.roundtripFeePct * 100).toFixed(1)}%)`,
  );

  // 11. Kelly méret ≥ minimum (audit fix #1, 2026-05-11). Replaces the
  // legacy "Kelly conviction (combiner > 0)" gate AND the implicit $1
  // floor inside positionSize calculation. Now the floor is an explicit
  // gate the operator can see fail on the UI — kelly = 0.03% × $250 =
  // $0.075 cleanly fails this gate at $0.50 minimum instead of being
  // silently padded to a $1 trade.
  const sizeMinOk = candidatePosition >= config.minPositionSizeUSDC;
  gates.push({
    label: "Kelly méret ≥ minimum",
    passed: sizeMinOk,
    actual:   `$${candidatePosition.toFixed(2)} (Kelly ${(kellyCapped * 100).toFixed(2)}% × bankroll $${bankrollUSDC.toFixed(2)})`,
    required: `≥ $${config.minPositionSizeUSDC.toFixed(2)}`,
    hint: "Ha a Kelly-méret a minimum alatt van, a jel túl gyenge — sub-min trade-et NEM padding-elünk $1-re.",
  });
  if (!sizeMinOk) reasons.push(
    `Kelly position size $${candidatePosition.toFixed(2)} < minimum $${config.minPositionSizeUSDC.toFixed(2)} ` +
    `(kellyCapped ${(kellyCapped * 100).toFixed(2)}% — combiner doesn't have enough conviction)`,
  );

  // 12. Kelly cap (always passes after Math.min — informational, but kept in
  // the gate list so the operator sees the cap value alongside the actual).
  gates.push({
    label: "Kelly méret ≤ cap",
    passed: kellyCapped <= config.maxKellyFraction,
    actual:   `${(kellyCapped * 100).toFixed(2)}%`,
    required: `≤ ${(config.maxKellyFraction * 100).toFixed(1)}%`,
    hint: "¼-Kelly + intézményi 8% hard cap a bankroll-ra.",
  });

  const allPassed = gates.every((g) => g.passed);

  if (!allPassed) {
    return {
      shouldTrade: false,
      direction,
      positionSizeUSDC: 0,
      entryPrice: 0,
      edge: netEdge,
      kellyUsed: 0,
      reason: reasons[0] ?? "Gate failure",
      gates,
    };
  }

  // No more Math.max(1, ...) floor: the "Kelly méret ≥ minimum" gate above
  // already rejected sub-min sizes. Round to cent precision for CLOB
  // tickSize alignment.
  const positionSize = candidatePosition;
  const entryPrice =
    direction === "YES"
      ? Math.min(marketPrice + 0.01, 0.99)
      : Math.max(1 - marketPrice + 0.01, 0.01);

  return {
    shouldTrade: true,
    direction,
    positionSizeUSDC: Math.round(positionSize * 100) / 100,
    entryPrice: Math.round(entryPrice * 100) / 100,
    edge: netEdge,
    kellyUsed: kellyCapped,
    reason:
      `Net edge ${(netEdge * 100).toFixed(1)}% (gross ${(grossEdge * 100).toFixed(1)}%), ` +
      `Kelly ${(kellyCapped * 100).toFixed(1)}% = $${positionSize.toFixed(2)}, ` +
      `${signal.activeSignals} signals active, combiner ${recAction || "n/a"}`,
    gates,
  };
}
