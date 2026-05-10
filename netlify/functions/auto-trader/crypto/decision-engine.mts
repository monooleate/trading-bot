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
export const CRYPTO_GATE_LABELS = [
  "Session loss limit",
  "Aktív signal források",
  "Market cooldown",
  "Open interest ≥ küszöb",
  "Entry window (BTC short markets)",
  "OB imbalance konvergencia",
  "Net edge ≥ küszöb",
  "Kelly conviction (combiner)",
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
    actual:   `${signal.activeSignals}/5`,
    required: "≥ 2",
    hint: "Egyetlen signal-tól nem nyitunk pozíciót — több forrás konvergenciája kell.",
  });
  if (!activeOk) reasons.push(`Too few active signals: ${signal.activeSignals} < 2`);

  // 3. Cooldown
  const cooldownOk = !isOnCooldown(market.slug, config.cooldownSeconds);
  gates.push({
    label: "Market cooldown",
    passed: cooldownOk,
    actual:   cooldownOk ? "ready" : "active",
    required: `${config.cooldownSeconds}s a legutóbbi trade óta`,
    hint: "Ugyanazon a piacon nem trade-elünk N másodpercen belül kétszer.",
  });
  if (!cooldownOk) reasons.push(`Market on cooldown: ${market.slug}`);

  // 4. Open interest
  const oiOk = market.openInterest >= config.minOpenInterest;
  gates.push({
    label: "Open interest ≥ küszöb",
    passed: oiOk,
    actual:   `$${Math.round(market.openInterest).toLocaleString()}`,
    required: `≥ $${config.minOpenInterest.toLocaleString()}`,
    hint: "Vékony piacon a paper-fill nem reflektálja a live likviditást.",
  });
  if (!oiOk) reasons.push(`Low OI: $${market.openInterest} < $${config.minOpenInterest}`);

  // 5. Entry-window filter for short BTC up/down markets (P1.2). Always
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

  // 6. OB-imbalance convergence (P1.3)
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

  // 7. Net edge ≥ threshold
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

  // 8. Kelly conviction gate — block when the signal-combiner says no edge.
  const kellyConvictionOk = kellyFraction > 0;
  gates.push({
    label: "Kelly conviction (combiner)",
    passed: kellyConvictionOk,
    actual:   `${(kellyFraction * 100).toFixed(2)}%`,
    required: "> 0%",
    hint: "Ha a signal-combiner ¼-Kellyje 0, a jelek nem konvergálnak — nem nyitunk minimum-size pozíciót.",
  });
  if (!kellyConvictionOk) reasons.push(
    `Signal-combiner Kelly=0 → no conviction (${signal.activeSignals} signals active but they don't converge)`,
  );

  // 9. Kelly cap (always passes after Math.min — informational, but kept in
  // the gate list so the operator sees the cap value alongside the actual).
  const kellyCapped = Math.min(Math.max(0, kellyFraction), config.maxKellyFraction);
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

  const positionSize = Math.max(1, bankrollUSDC * kellyCapped); // min $1
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
      `Kelly ${(kellyCapped * 100).toFixed(1)}%, ` +
      `${signal.activeSignals} signals active`,
    gates,
  };
}
