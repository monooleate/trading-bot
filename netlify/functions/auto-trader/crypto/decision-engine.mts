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

  // Build the gate list incrementally so even on early exits the popover
  // can show what was evaluated up to the failure point. Every gate gets a
  // pass/fail flag, the actual measurement, the required threshold and a
  // one-line hint.
  const gates: DecisionGate[] = [];

  const noResult = (reason: string): TradeDecision => ({
    shouldTrade: false,
    direction: "YES",
    positionSizeUSDC: 0,
    entryPrice: 0,
    edge: 0,
    kellyUsed: 0,
    reason,
    gates,
  });

  // 1. Session loss limit
  const sessionLossOk = sessionLoss < config.sessionLossLimit;
  gates.push({
    label: "Session loss limit",
    passed: sessionLossOk,
    actual:   `$${sessionLoss.toFixed(2)}`,
    required: `< $${config.sessionLossLimit.toFixed(2)}`,
    hint: "A futó session nettó vesztesége nem érheti el a megadott felső határt.",
  });
  if (!sessionLossOk) {
    return noResult(`Session loss limit reached: $${sessionLoss.toFixed(2)} >= $${config.sessionLossLimit}`);
  }

  // 2. Minimum active signals
  const activeOk = signal.activeSignals >= 2;
  gates.push({
    label: "Aktív signal források",
    passed: activeOk,
    actual:   `${signal.activeSignals}/5`,
    required: "≥ 2",
    hint: "Egyetlen signal-tól nem nyitunk pozíciót — több forrás konvergenciája kell.",
  });
  if (!activeOk) {
    return noResult(`Too few active signals: ${signal.activeSignals} < 2`);
  }

  // 3. Cooldown
  const cooldownOk = !isOnCooldown(market.slug, config.cooldownSeconds);
  gates.push({
    label: "Market cooldown",
    passed: cooldownOk,
    actual:   cooldownOk ? "ready" : "active",
    required: `${config.cooldownSeconds}s a legutóbbi trade óta`,
    hint: "Ugyanazon a piacon nem trade-elünk N másodpercen belül kétszer.",
  });
  if (!cooldownOk) {
    return noResult(`Market on cooldown: ${market.slug}`);
  }

  // 4. Open interest
  const oiOk = market.openInterest >= config.minOpenInterest;
  gates.push({
    label: "Open interest ≥ küszöb",
    passed: oiOk,
    actual:   `$${Math.round(market.openInterest).toLocaleString()}`,
    required: `≥ $${config.minOpenInterest.toLocaleString()}`,
    hint: "Vékony piacon a paper-fill nem reflektálja a live likviditást.",
  });
  if (!oiOk) {
    return noResult(`Low OI: $${market.openInterest} < $${config.minOpenInterest}`);
  }

  // 4b. Entry-window filter for short BTC up/down markets (P1.2)
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
      if (ageMs < exit.entryWindowStartMs) {
        return noResult(`Outside entry window: ${ageMs}ms since open < ${exit.entryWindowStartMs}ms`);
      }
      return noResult(`Outside entry window: ${ageMs}ms since open > ${exit.entryWindowEndMs}ms`);
    }
  }

  // 5. Edge (net of fees)
  const grossEdge = Math.abs(finalProb - marketPrice);
  const netEdge   = grossEdge - config.roundtripFeePct;
  const direction: "YES" | "NO" = finalProb > marketPrice ? "YES" : "NO";

  // 5b. OB-imbalance convergence filter (P1.3)
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
    if (!aligned) {
      return noResult(
        `OB imbalance diverges: depth ratio ${signal.obImbalance.ratio} → ${signal.obImbalance.direction}, ` +
        `combined signal → ${direction}`,
      );
    }
  } else {
    gates.push({
      label: "OB imbalance konvergencia",
      passed: true,
      actual:   signal.obImbalance ? `OB NEUTRAL (ratio ${signal.obImbalance.ratio.toFixed(2)})` : "no data",
      required: direction === "YES" ? "UP / NEUTRAL" : "DOWN / NEUTRAL",
      hint: "Binance top-10 depth ratio ne menjen szembe az általunk vett iránnyal.",
    });
  }

  // 6. Net edge ≥ threshold
  const edgeOk = netEdge >= config.edgeThreshold;
  gates.push({
    label: "Net edge ≥ küszöb",
    passed: edgeOk,
    actual:   `${netEdge >= 0 ? "+" : ""}${(netEdge * 100).toFixed(2)}% (gross ${(grossEdge * 100).toFixed(2)}% − fees ${(config.roundtripFeePct * 100).toFixed(2)}%)`,
    required: `≥ ${(config.edgeThreshold * 100).toFixed(1)}%`,
    hint: "|finalProb − marketPrice| − roundtrip fees, signed.",
  });
  if (!edgeOk) {
    return noResult(
      `Net edge ${(netEdge * 100).toFixed(1)}% < threshold ${(config.edgeThreshold * 100)}% ` +
      `(gross ${(grossEdge * 100).toFixed(1)}% - fees ${(config.roundtripFeePct * 100).toFixed(1)}%)`,
    );
  }

  // 7. Kelly conviction gate — block when the signal-combiner says no edge.
  // Without this, kellyFraction=0 still opens a $1 floor position whenever
  // every other gate passes, which lets noise-driven directional bias leak
  // through (cf. 2026-05-10 paper-pnl-analysis: 3 BTC paper trades opened
  // at $1 minimum size while the combiner returned `kelly.full=0` and a
  // WAIT recommendation).
  const kellyConvictionOk = kellyFraction > 0;
  gates.push({
    label: "Kelly conviction (combiner)",
    passed: kellyConvictionOk,
    actual:   `${(kellyFraction * 100).toFixed(2)}%`,
    required: "> 0%",
    hint: "Ha a signal-combiner ¼-Kellyje 0, a jelek nem konvergálnak — nem nyitunk minimum-size pozíciót.",
  });
  if (!kellyConvictionOk) {
    return noResult(
      `Signal-combiner Kelly=0 → no conviction (${signal.activeSignals} signals active but they don't converge)`,
    );
  }

  // 8. Kelly cap
  const kellyCapped = Math.min(kellyFraction, config.maxKellyFraction);
  gates.push({
    label: "Kelly méret ≤ cap",
    passed: kellyCapped <= config.maxKellyFraction,
    actual:   `${(kellyCapped * 100).toFixed(2)}%`,
    required: `≤ ${(config.maxKellyFraction * 100).toFixed(1)}%`,
    hint: "¼-Kelly + intézményi 8% hard cap a bankroll-ra.",
  });

  const positionSize = Math.max(1, bankrollUSDC * kellyCapped); // min $1

  // Entry price (1 tick above market for YES, 1 tick above for NO)
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
