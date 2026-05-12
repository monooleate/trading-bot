import type { TradeDecision, TraderConfig, AggregatedSignal, MarketInfo, DecisionGate } from "../shared/types.mts";
import { getBtcExitConfig } from "../shared/config.mts";
import { getStore } from "@netlify/blobs";

type BtcExitCfg = ReturnType<typeof getBtcExitConfig>;

// ─── Cooldown tracker (in-memory + Blobs persistence) ──
//
// 2026-05-12: migrated from pure-in-memory (HL-style pattern). Netlify
// functions are short-lived: a cron tick may land on a fresh container with
// empty memory, so the previous purely-in-memory map silently lost the
// no-revenge-trade guard between ticks. Now setCooldown writes both layers,
// and isOnCooldown checks memory first then falls back to Blobs.
//
// `isOnCooldown` is async (HL pattern), so callers should `await` and may
// need pre-warming (see warmCooldownCache). For backward compat we keep a
// sync `isOnCooldownSync` that uses memory only.
const STORE_NAME = "crypto-cooldowns";
const KEY        = "v1";
const cooldownMap = new Map<string, number>();
let blobLoadedAt = 0;
const BLOB_RELOAD_MS = 30_000;

async function loadCooldownsFromBlob(): Promise<void> {
  if (Date.now() - blobLoadedAt < BLOB_RELOAD_MS) return;
  try {
    const raw = await getStore(STORE_NAME).get(KEY);
    if (raw) {
      const parsed = JSON.parse(raw as string) as Record<string, number>;
      const now = Date.now();
      for (const [slug, until] of Object.entries(parsed)) {
        if (Number.isFinite(until) && until > now) {
          if (!cooldownMap.has(slug)) cooldownMap.set(slug, until);
        }
      }
    }
    blobLoadedAt = Date.now();
  } catch { /* fail open */ }
}

async function persistCooldowns(): Promise<void> {
  try {
    const obj: Record<string, number> = {};
    const now = Date.now();
    for (const [slug, until] of cooldownMap.entries()) {
      if (until > now) obj[slug] = until;
    }
    await getStore(STORE_NAME).set(KEY, JSON.stringify(obj));
  } catch { /* best-effort */ }
}

/** Pre-warm the cooldown cache from Blobs before the scan loop starts. */
export async function warmCooldownCache(): Promise<void> {
  await loadCooldownsFromBlob();
}

/** Sync check using in-memory state only. Pre-warm with `warmCooldownCache()`. */
export function isOnCooldown(slug: string, cooldownSeconds: number): boolean {
  const until = cooldownMap.get(slug);
  if (!until) return false;
  // The map stores the EXPIRY timestamp now (was: last-trade timestamp).
  // Both interpretations get the same answer when called via setCooldown,
  // since we always set `now + cooldownSeconds*1000` — but the underlying
  // semantics matter for the Blobs payload, which stores expiry only.
  return until > Date.now();
}

export async function setCooldown(slug: string, cooldownSeconds: number = 300): Promise<void> {
  cooldownMap.set(slug, Date.now() + cooldownSeconds * 1000);
  await persistCooldowns();
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
  "Combiner trust (WATCH + extrém edge)",
  "Resolution-risk gate",
  "Market cooldown",
  "Open interest ≥ küszöb",
  "Entry window (BTC short markets)",
  "OB imbalance konvergencia",
  "Net edge ≥ küszöb",
  "Sanity cap (gross edge ≤ cap)",
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

// Direction-aware binary-payoff Kelly fraction using the ACTUAL market price.
//
// The signal-combiner's own `kelly_q` field is structurally broken: it uses
// `b = (1/p) - 1` where p is the model probability, which collapses to 0 at
// "fair" pricing — but the market price is never the model's fair value, so
// the combiner's kelly is always ~0. We re-compute here using the side's
// real entry price so the Kelly gate reflects the real edge.
//
// For YES side: p = finalProb, price = marketPrice
// For NO  side: p = 1 - finalProb, price = 1 - marketPrice
// Kelly fraction f = max(0, (p*b - q) / b) where b = (1/price) - 1.
// Quarter-Kelly is applied by the caller (¼ × cap).
function kellyForSide(predProb: number, marketPrice: number, direction: "YES" | "NO"): number {
  const p     = direction === "YES" ? predProb       : 1 - predProb;
  const price = direction === "YES" ? marketPrice    : 1 - marketPrice;
  const safePrice = Math.max(0.01, Math.min(0.99, price));
  const b = (1 / safePrice) - 1;
  if (b <= 0) return 0;
  const q = 1 - p;
  return Math.max(0, (p * b - q) / b);
}

export function makeDecision(
  signal: AggregatedSignal,
  market: MarketInfo,
  bankrollUSDC: number,
  sessionLoss: number,
  config: TraderConfig,
  btcExit?: BtcExitCfg,
): TradeDecision {
  const { finalProb } = signal;
  const marketPrice = market.currentPrice;
  const grossEdge   = Math.abs(finalProb - marketPrice);
  const netEdge     = grossEdge - config.roundtripFeePct;
  const direction: "YES" | "NO" = finalProb > marketPrice ? "YES" : "NO";
  // Re-compute the Kelly fraction here against the REAL market price.
  // The combiner's signal.kellyFraction is broken (always ~0 at fair-implied
  // pricing); using it as a gate would silently veto every trade. The new
  // local kellyForSide() returns the binary-payoff Kelly for the chosen
  // direction at the market's quoted entry price. Quarter-Kelly + cap
  // applied below.
  const kellyRaw    = kellyForSide(finalProb, marketPrice, direction);
  const kellyQuarter = kellyRaw * 0.25;
  const kellyCapped = Math.min(kellyQuarter, config.maxKellyFraction);
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

  // 2. Minimum active signals (Settings-tunable since 2026-05-12 — was
  // hardcoded ≥ 2). Strict preset uses 5, Normal 3, Loose 2.
  const minActive = config.minActiveSignals ?? 2;
  const activeOk = signal.activeSignals >= minActive;
  gates.push({
    label: "Aktív signal források",
    passed: activeOk,
    actual:   `${signal.activeSignals}/8`,
    required: `≥ ${minActive}`,
    hint: "Több signal konvergenciája kell. Settings → Min active signals.",
  });
  if (!activeOk) reasons.push(`Too few active signals: ${signal.activeSignals} < ${minActive}`);

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

  // 4. Combiner recommendation gate (audit fix #3, 2026-05-11; relaxed
  // 2026-05-12 after Kelly fix). The combiner's recommend() can return:
  //   - WAIT   = |finalProb − 0.5| < 5% OR ir < 0.1 (no convergence)
  //   - WATCH  = combiner's broken kelly_q < 0.005 (combiner uses model-prob
  //              as implicit price → kelly always ~0 at "fair" pricing)
  //   - SKIP   = resolution-risk helper vetoed the trade
  //   - BUY YES / BUY NO = pass
  // The WATCH state is meaningless because the combiner's Kelly is
  // structurally broken (see kellyForSide() above). The WAIT state is
  // already covered by Gate 3 (combinerConfidenceMin). The SKIP state is
  // independently checked by Gate 5 (tradeRecommendedByRisk).
  // So this gate now only blocks explicit SKIP — preserves the resolution
  // -risk veto without depending on the broken Kelly.
  const recAction = (signal.combinerRecommendation || "").toUpperCase();
  const recOk     = !recAction.startsWith("SKIP");
  gates.push({
    label: "Combiner recommendation",
    passed: recOk,
    actual:   recAction || "n/a",
    required: "≠ SKIP",
    hint: "Csak SKIP-en blokkolunk (resolution-risk veto). WATCH = combiner kelly_q broken (lokál Kelly veszi át), WAIT = Gate 3 ellenőrzi.",
  });
  if (!recOk) reasons.push(`Combiner recommendation: ${recAction || "n/a"} (SKIP veto)`);

  // 4b. Combiner trust gate — WATCH + extreme edge = model bug, not alpha.
  //
  // Rationale: WATCH is the combiner's own "low IR / low conviction" signal.
  // Normally we let WATCH through because the combiner's kelly_q is
  // structurally broken (Gate 4 hint above). BUT — when a low-conviction
  // combiner reports a 20%+ gross edge, that combination is almost
  // certainly the hallucinated kind: one signal source defaulted to 0.5
  // and pulled the weighted average toward an extreme number, or the
  // market drifted into a region where the combiner has no calibration.
  // Distinct from the sanity cap (Gate 11) which is a hard ceiling on
  // ANY recommendation — this one is conviction-conditional.
  const watchExtremeThresh = config.watchExtremeEdgeThreshold ?? 0.20;
  const isWatch     = recAction === "WATCH";
  const isExtreme   = grossEdge > watchExtremeThresh;
  const trustOk     = !(isWatch && isExtreme);
  gates.push({
    label: "Combiner trust (WATCH + extrém edge)",
    passed: trustOk,
    actual:   `${recAction || "n/a"} @ ${(grossEdge * 100).toFixed(1)}% gross edge`,
    required: isWatch
      ? `gross edge ≤ ${(watchExtremeThresh * 100).toFixed(0)}% (WATCH miatt)`
      : "n/a (csak WATCH-on alkalmazandó)",
    hint: "WATCH = alacsony combiner IR. Ha mégis nagy edge-et jelez, az tipikusan model-error (egy signal source 0.5-re defaultolt és magával húzta a kombinátort).",
  });
  if (!trustOk) reasons.push(
    `Combiner trust gate: WATCH recommendation + ${(grossEdge * 100).toFixed(1)}% gross edge > ${(watchExtremeThresh * 100).toFixed(0)}% — likely model error`,
  );

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

  // 10b. Sanity cap on gross edge. Mirrors the weather bot's same-named
  // gate: any divergence above ~40% is structurally model error, not real
  // alpha. Common causes: a feed source crashed and defaulted to 0.5
  // driving the combiner average; or the price drifted deep-OTM/deep-ITM
  // after entry (the open-position carve-out in findBtcMarkets surfaces
  // these markets even when out-of-band, so the gate fires loudly).
  const maxEdgeCap = config.maxEdgeCap ?? 0.40;
  const sanityOk   = grossEdge <= maxEdgeCap;
  gates.push({
    label: "Sanity cap (gross edge ≤ cap)",
    passed: sanityOk,
    actual:   `${(grossEdge * 100).toFixed(2)}%`,
    required: `≤ ${(maxEdgeCap * 100).toFixed(0)}%`,
    hint: "Túl nagy gross edge szinte mindig model-error (signal default, drift, feed crash) — nem alpha.",
  });
  if (!sanityOk) reasons.push(
    `Gross edge ${(grossEdge * 100).toFixed(1)}% > sanity cap ${(maxEdgeCap * 100).toFixed(0)}% — likely model error, not opportunity`,
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
