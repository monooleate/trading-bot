// netlify/functions/auto-trader/hyperliquid/index.mts
// Hyperliquid perp execution loop — Netlify-serverless adaptation of the
// engine described in internal-docs/edgecalc-hyperliquid-prompt.md.
//
// How it maps to the original VPS design:
//   Hetzner PM2 daemon  →  Netlify scheduled-function cron (every 3m)
//   WebSocket subs      →  REST polling via InfoClient each run
//   /tmp/session.json   →  Netlify Blobs (hyperliquid-session-v1)
//   Telegram alerts     →  shared/telegram.mts (reused)
//
// Public entry: runHyperliquidTrader(config) returns a JSON-ready summary.

import { log } from "../shared/logger.mts";
import { alertError, alertLiveBlocked } from "../shared/telegram.mts";
import { computeLiveReadiness, shouldForcePaper, type LiveReadinessReport } from "../shared/live-readiness.mts";
import { getHlConfig, getEffectiveHlConfig } from "./config.mts";
import { getHlSignalForCoin } from "./signal-source.mts";
import { getCurrentPrice } from "./hl-client.mts";
import { volatilityGate } from "./volatility-gate.mts";
import { kellyToPerpSize } from "./kelly-sizer.mts";
import {
  makeHlDecision,
  setCooldown,
  isOnCooldown,
} from "./decision-engine.mts";
import {
  placeHlEntry,
} from "./order-manager.mts";
import { resolveOpenHlPaperPositions } from "./paper-resolver.mts";
import { resolveOpenHlLivePositions } from "./live-resolver.mts";
import { markHlRunStart, markHlRunFinish, getHlRunStatus } from "./run-state.mts";
import {
  loadHlSession,
  saveHlSession,
  addOpenPosition,
  closePosition,
  stopHlSession,
  resetHlSession,
  applyConsecutiveLossPause,
  resumeHlSession,
  topupHlSession,
} from "./session-manager.mts";
import { alertTopup } from "../shared/telegram.mts";
import type {
  HlCoin,
  HlTraderConfig,
  HlSessionState,
  HlClosedTrade,
} from "./types.mts";

// Coins we'll scan per run — small to respect signal-combiner cache / API limits
const SCAN_COINS: HlCoin[] = ["BTC", "ETH", "SOL"];

// Paper positions are auto-closed once their hold time exceeds this, even
// if neither TP nor SL crossed. Default 4h matches the typical signal
// horizon; overridable via Settings later.
const DEFAULT_MAX_PAPER_HOLD_MS = 4 * 60 * 60 * 1000;

export async function runHyperliquidTrader(
  configOverride?: HlTraderConfig,
  source: "manual" | "cron" = "manual",
): Promise<any> {
  await markHlRunStart(source).catch(() => {});
  let result: any;
  try {
    result = await runHyperliquidTraderInner(configOverride, source);
  } catch (err: any) {
    result = { ok: false, action: "error", error: err?.message || "unknown", source };
  }
  await markHlRunFinish(result).catch(() => {});
  return { ...result, source };
}

async function runHyperliquidTraderInner(
  configOverride: HlTraderConfig | undefined,
  _source: "manual" | "cron",
): Promise<any> {
  // Pull runtime Settings overrides every tick so the operator's
   // Loose/Normal/Strict preset takes effect on the next cron run without
   // a redeploy. Env-only fallback inside getEffectiveHlConfig.
  const baseConfig = configOverride ?? await getEffectiveHlConfig();
  // Mutable clone so the live-readiness gate can flip paperMode back to
  // true when the paper track record hasn't met validation thresholds.
  const config: HlTraderConfig = { ...baseConfig };
  let   session = await loadHlSession(config.paperMode);

  // Live-readiness gate: convert HlClosedTrade → generic ClosedTrade for
  // computeLiveReadiness, then force paper if the gate fails.
  let liveReadiness: LiveReadinessReport | null = null;
  try {
    const tradesAsGeneric = session.closedTrades.map((t) => ({
      market:     t.coin,
      direction:  t.direction === "LONG" ? "YES" as const : "NO" as const,
      entryPrice: t.entryPrice,
      exitPrice:  t.exitPrice,
      shares:     t.sizeCoins,
      pnl:        t.pnlUSDC,
      pnlPct:     t.pnlPct,
      openedAt:   t.openedAt,
      closedAt:   t.closedAt,
      category:   "hyperliquid" as any,
      predictedProb: t.predictedProb,
      edgeAtEntry:   t.edgeAtEntry,
      signalBreakdown: t.signalBreakdown ?? null,
    }));
    let readyOv: any = {};
    try {
      const mod: any = await import("../../trader-settings.mts");
      readyOv = (await mod.loadRuntimeOverrides()) ?? {};
    } catch {}
    liveReadiness = computeLiveReadiness({
      category: "hyperliquid",
      session: {
        closedTrades: [],
        stopped: session.stopped,
        stoppedReason: session.stoppedReason,
        bankrollStart: session.bankrollStart,
      } as any,
      trades: tradesAsGeneric,
      simVersionExpected: null,
      thresholds: {
        minTrades:         readyOv.liveReadyMinTrades,
        minWinRate:        readyOv.liveReadyMinWinRate,
        minSharpe:         readyOv.liveReadyMinSharpe,
        maxDrawdownPct:    readyOv.liveReadyMaxDrawdownPct,
      } as any,
    });
    const overrideEnabled = readyOv.liveReadyOverrideEnabled === 1;
    const force = shouldForcePaper(config.paperMode, liveReadiness, overrideEnabled);
    if (force.forcePaper) {
      log("ERROR", true, { liveBlocked: true, category: "hyperliquid", reason: force.reason });
      const failed = liveReadiness.gates.filter((g) => g.applicable && !g.passed).map((g) => g.label);
      await alertLiveBlocked("hyperliquid", force.reason!, failed);
      config.paperMode = true;
    } else if (force.overrideActive) {
      log("ERROR", false, { liveOverride: true, category: "hyperliquid", reason: "OVERRIDE ACTIVE — readiness gate bypassed" });
    }
  } catch (err: any) {
    log("ERROR", true, { category: "hyperliquid", liveReadinessError: err?.message });
  }

  // Session-level short-circuits
  if (session.stopped) {
    return { ok: true, action: "skipped", reason: `Session stopped: ${session.stoppedReason}`, session: summarize(session), liveReadiness };
  }
  if (session.pausedUntil && new Date(session.pausedUntil).getTime() > Date.now()) {
    return { ok: true, action: "skipped", reason: `Paused until ${session.pausedUntil}`, session: summarize(session), liveReadiness };
  }

  // ── Resolve any open positions FIRST. Two paths share the same
  // post-close session-housekeeping (consecutive-loss pause + session
  // loss limit) so a TP/SL fill that pushes the bankroll over the limit
  // stops further entries on the same tick:
  //
  //   • paper: resolveOpenHlPaperPositions — TP/SL crossing on HL
  //     markPrice + funding accrual + 4h timeout safety net.
  //   • live:  resolveOpenHlLivePositions — clearinghouseState +
  //     userFillsByTime to detect actual TP/SL fills on HL itself.
  //     Without this the session blob never books closes and every
  //     subsequent tick refuses entries with "Already have open <COIN>"
  //     until a manual reset. (CLAUDE.md §9.A blocker, fixed here.)
  const resolutions: any[] = [];
  if (session.openPositions.length > 0) {
    if (config.paperMode) {
      const r = await resolveOpenHlPaperPositions(session, {
        feeRoundtrip:   config.roundtripFeePct,
        maxPaperHoldMs: DEFAULT_MAX_PAPER_HOLD_MS,
      });
      session = r.session;
      for (const res of r.resolutions) {
        resolutions.push({ coin: res.coin, action: "resolved", reason: res.reason, exit: res.exitPrice, pnl: res.pnlUSDC });
      }
      if (r.resolutions.length > 0) {
        if (session.consecutiveLosses >= config.consecutiveLossLimit) {
          session = applyConsecutiveLossPause(session, config.consecutiveLossPauseHours);
        }
        if (session.sessionLoss >= config.sessionLossLimit) {
          session = stopHlSession(session, "Session loss limit reached");
        }
      }
    } else {
      const r = await resolveOpenHlLivePositions(session);
      session = r.session;
      for (const res of r.resolutions) {
        resolutions.push({ coin: res.coin, action: "resolved", reason: res.reason, exit: res.exitPrice, pnl: res.pnlUSDC });
      }
      if (r.resolutions.length > 0) {
        if (session.consecutiveLosses >= config.consecutiveLossLimit) {
          session = applyConsecutiveLossPause(session, config.consecutiveLossPauseHours);
        }
        if (session.sessionLoss >= config.sessionLossLimit) {
          session = stopHlSession(session, "Session loss limit reached");
        }
      }
    }
  }

  const results: any[] = resolutions;

  // Per-coin gate pipeline. Every scanned coin builds an ordered DecisionGate
  // list so the UI's "X/Y gates ✓" chip + hover popover renders consistently
  // across all four bots (crypto, weather, HL, F-Arb). Gates are evaluated
  // greedily — once one fails, downstream gates that depend on the missing
  // data are recorded with `passed: false, actual: "not evaluated"` so the
  // total Y stays stable across rows.
  const threshold = config.paperMode ? config.edgeThresholdPaper : config.edgeThresholdLive;
  const HL_GATE_LABELS = [
    "Coin cooldown",
    "Signal forrás elérhető",
    "Volatility (RV) ≤ küszöb",
    "Session loss < limit",
    "Open pozíciók < max",
    "Consecutive losses < limit",
    "Coin nincs már nyitva",
    // Cross-position directional consistency (2026-05-14e). The "Coin
    // nincs már nyitva" gate above is the stronger constraint today
    // (1 position max per coin), so this gate only fires if/when the
    // stronger gate is ever relaxed to allow LONG+LONG averaging. Layered
    // defense — and it surfaces the LONG/SHORT-pair logic explicitly in
    // the UI for operator clarity.
    //
    // Outcome-overlap coverage (2026-05-15): LONG+SHORT on the same coin
    // IS the perp analog of crypto's NO+YES outcome-overlap — the two
    // winning conditions (price ↑ vs ↓) are disjoint by definition. This
    // gate already blocks that pattern, so no additional outcome-overlap
    // gate is needed for HL Perp.
    "Directional-consistency (no LONG+SHORT same coin)",
    "Aktív signal források ≥ 3",
    "Resolution risk ≠ SKIP",
    "Net edge ≥ küszöb",
    "Sanity cap (gross edge ≤ cap)",
    "Combiner trust (WATCH + extrém edge)",
    "HL price elérhető",
    "Méret > 0",
  ] as const;

  function notEvaluatedGate(label: string, hint?: string): import("../shared/types.mts").DecisionGate {
    return { label, passed: false, actual: "not evaluated", required: "—", hint };
  }

  for (const coin of SCAN_COINS) {
    const coinGates: import("../shared/types.mts").DecisionGate[] = [];
    // Snapshot helper: returns the full Y-gate list, padding with
    // "not evaluated" rows for any gate not yet checked. Keeps Y stable
    // across all rows so the UI chip is comparable.
    const snapGates = (): import("../shared/types.mts").DecisionGate[] => {
      const list = [...coinGates];
      for (let i = list.length; i < HL_GATE_LABELS.length; i++) {
        list.push(notEvaluatedGate(HL_GATE_LABELS[i]));
      }
      return list;
    };
    try {
      // Gate 1 — Coin cooldown
      const onCooldown = await isOnCooldown(coin);
      coinGates.push({
        label: HL_GATE_LABELS[0],
        passed: !onCooldown,
        actual: onCooldown ? "in cooldown" : "ready",
        required: `${config.cooldownSeconds}s a legutóbbi trade óta`,
        hint: "Ugyanazon a coin-on nem nyitunk pozíciót N másodpercen belül kétszer.",
      });
      if (onCooldown) {
        results.push({ coin, action: "skip", reason: "cooldown", gates: snapGates() });
        continue;
      }

      // Gate 2 — Signal source available
      const signal = await getHlSignalForCoin(coin);
      coinGates.push({
        label: HL_GATE_LABELS[1],
        passed: !!signal,
        actual: signal ? "elérhető" : "nincs adat",
        required: "elérhető",
        hint: "Combined signal: FR + VPIN + VOL + APEX + CP (Polymarket-driven).",
      });
      if (!signal) {
        results.push({ coin, action: "skip", reason: "no signal", gates: snapGates() });
        continue;
      }

      log("SIGNAL", config.paperMode, {
        venue: "hyperliquid",
        coin,
        direction: signal.direction,
        finalProb: signal.finalProb,
        edge: signal.edge,
        activeSignals: signal.activeSignals,
      });

      // Gate 3 — Volatility (paper + live parity).
      // Fail-open if klines unreachable: gate `pass:true, reason="vol data
      // unavailable"`.
      const volCheck = await volatilityGate(coin, config.volGateRvPct);
      coinGates.push({
        label: HL_GATE_LABELS[2],
        passed: volCheck.pass,
        actual: volCheck.rv > 0 ? `RV ${volCheck.rv.toFixed(0)}%/yr` : volCheck.reason,
        required: `RV ≤ ${config.volGateRvPct}%/yr`,
        hint: "12-candle 1h realised volatility. 200%+ napokon nem nyitunk.",
      });
      if (!volCheck.pass) {
        results.push({
          coin, action: "skip", reason: volCheck.reason,
          direction: signal.direction, edge: signal.edge,
          predictedProb: signal.finalProb, marketPrice: signal.marketPrice,
          gates: snapGates(),
        });
        continue;
      }

      // Gates 4–9 — decision-engine layer. We evaluate each independently
      // (instead of relying on makeHlDecision's first-failure short-circuit)
      // so the gate list reflects the full pre-flight checklist.
      const sessionLossOk = session.sessionLoss < config.sessionLossLimit;
      coinGates.push({
        label: HL_GATE_LABELS[3],
        passed: sessionLossOk,
        actual: `$${session.sessionLoss.toFixed(2)}`,
        required: `< $${config.sessionLossLimit.toFixed(2)}`,
        hint: "A futó session nettó vesztesége nem érheti el a felső határt.",
      });
      const openOk = session.openPositions.length < config.maxOpenPositions;
      coinGates.push({
        label: HL_GATE_LABELS[4],
        passed: openOk,
        actual: `${session.openPositions.length}`,
        required: `< ${config.maxOpenPositions}`,
        hint: "Egyszerre maximum N nyitott perp pozíció.",
      });
      const consecutiveOk = session.consecutiveLosses < config.consecutiveLossLimit;
      coinGates.push({
        label: HL_GATE_LABELS[5],
        passed: consecutiveOk,
        actual: `${session.consecutiveLosses}`,
        required: `< ${config.consecutiveLossLimit}`,
        hint: "N egymás utáni veszteség után pause.",
      });
      const notAlreadyOpen = !session.openPositions.some((p) => p.coin === coin);
      coinGates.push({
        label: HL_GATE_LABELS[6],
        passed: notAlreadyOpen,
        actual: notAlreadyOpen ? "no open position" : "already open",
        required: "no duplicate",
        hint: "Egy coinra max 1 nyitott perp pozíció.",
      });

      // Cross-position directional consistency (2026-05-14e). A LONG and
      // a SHORT on the same coin = effectively un-leveraged net zero +
      // double the fees, so expected value is strictly negative. The
      // upstream "Coin nincs már nyitva" gate already prevents this in
      // the current single-position-per-coin regime; this gate adds an
      // explicit directional check so the diagnostic is loud and any
      // future relaxation that allows LONG+LONG averaging still keeps
      // the no-pair-against-itself guarantee.
      const conflictingDir = session.openPositions.find(
        (p) => p.coin === coin && p.direction !== signal.direction,
      );
      const directionalOk = !conflictingDir;
      coinGates.push({
        label: HL_GATE_LABELS[7],
        passed: directionalOk,
        actual: conflictingDir
          ? `nyitott ${conflictingDir.direction}-${coin} vs javasolt ${signal.direction}`
          : `signal ${signal.direction} (no ellentétes-direction nyitott pozíció)`,
        required: "no LONG+SHORT same coin",
        hint: "LONG+SHORT ugyanazon coin-on = unleveraged + 2× fee → strict negatív EV. Ne nyiss önmagad ellen.",
      });
      if (!directionalOk) {
        results.push({
          coin, action: "skip",
          reason: `Directional conflict: ${conflictingDir!.direction}-${coin} már nyitva, ${signal.direction} blokk`,
          direction: signal.direction, edge: signal.edge,
          predictedProb: signal.finalProb, marketPrice: signal.marketPrice,
          gates: snapGates(),
        });
        continue;
      }

      const minActiveSignalsHl = config.minActiveSignals ?? 3;
      const activeSignalsOk = signal.activeSignals >= minActiveSignalsHl;
      coinGates.push({
        label: HL_GATE_LABELS[8],
        passed: activeSignalsOk,
        actual: `${signal.activeSignals}/8`,
        required: `≥ ${minActiveSignalsHl}`,
        hint: "HL-en min. ennyi signal-nak kell konvergálnia (Settings → Min active signals).",
      });
      const resolutionOk = signal.resolutionCategory !== "SKIP";
      coinGates.push({
        label: HL_GATE_LABELS[9],
        passed: resolutionOk,
        actual: signal.resolutionCategory ?? "OK",
        required: "≠ SKIP",
        hint: "Az alapul szolgáló piac resolution kockázata nem lehet SKIP.",
      });

      // Gate 10 — Net edge. Evaluated independently of session gates so
      // the user can see "edge passed but session loss tripped".
      const netEdgePre = signal.edge - config.roundtripFeePct;
      const netEdgeOk = netEdgePre >= threshold;
      coinGates.push({
        label: HL_GATE_LABELS[10],
        passed: netEdgeOk,
        actual: `${netEdgePre >= 0 ? "+" : ""}${(netEdgePre * 100).toFixed(2)}% (gross ${(signal.edge * 100).toFixed(2)}% − fees ${(config.roundtripFeePct * 100).toFixed(2)}%)`,
        required: `≥ ${(threshold * 100).toFixed(1)}%`,
        hint: `Edge − roundtrip taker fees. ${config.paperMode ? "Paper" : "Live"} küszöb.`,
      });

      // Gate 11 — Sanity cap on gross edge. The combiner inherits the
      // same failure modes as crypto (signal source defaulting to 0.5,
      // feed crash). For HL, signal.edge = |finalProb - 0.5| × 2, so
      // edge > 0.40 means combiner conviction ≥ 70% — strong but ok at
      // that bound; above 40% it's almost always hallucinated.
      const maxEdgeCapHl = config.maxEdgeCap ?? 0.40;
      const sanityOkHl = signal.edge <= maxEdgeCapHl;
      coinGates.push({
        label: HL_GATE_LABELS[11],
        passed: sanityOkHl,
        actual: `${(signal.edge * 100).toFixed(2)}%`,
        required: `≤ ${(maxEdgeCapHl * 100).toFixed(0)}%`,
        hint: "Túl nagy gross edge szinte mindig model-error (signal default, feed crash) — nem alpha.",
      });

      // Gate 12 — Combiner trust gate. WATCH + extreme edge = model bug.
      // Same logic as crypto but reads signal.combinerRecommendation
      // (added in 2026-05-12 to expose the combiner's own verdict).
      const watchThreshHl = config.watchExtremeEdgeThreshold ?? 0.20;
      const recHl = (signal.combinerRecommendation || "").toUpperCase();
      const isWatchHl   = recHl === "WATCH";
      const isExtremeHl = signal.edge > watchThreshHl;
      const trustOkHl   = !(isWatchHl && isExtremeHl);
      coinGates.push({
        label: HL_GATE_LABELS[12],
        passed: trustOkHl,
        actual: `${recHl || "n/a"} @ ${(signal.edge * 100).toFixed(1)}% gross edge`,
        required: isWatchHl
          ? `gross edge ≤ ${(watchThreshHl * 100).toFixed(0)}% (WATCH miatt)`
          : "n/a (csak WATCH-on alkalmazandó)",
        hint: "WATCH = alacsony combiner IR. Ha mégis nagy edge-et jelez, az tipikusan model-error.",
      });

      // Net edge / sanity / trust gate failures all short-circuit before
      // we hit makeHlDecision — surface the failing row with the full
      // gate snapshot so the operator can see exactly which one tripped.
      if (!netEdgeOk || !sanityOkHl || !trustOkHl) {
        const reason = !netEdgeOk
          ? `Net edge ${(netEdgePre * 100).toFixed(2)}% < ${(threshold * 100).toFixed(1)}%`
          : !sanityOkHl
          ? `Gross edge ${(signal.edge * 100).toFixed(1)}% > sanity cap ${(maxEdgeCapHl * 100).toFixed(0)}%`
          : `Combiner trust: ${recHl} + ${(signal.edge * 100).toFixed(1)}% edge — likely model error`;
        results.push({
          coin, action: "skip", reason,
          direction: signal.direction, edge: netEdgePre,
          predictedProb: signal.finalProb, marketPrice: signal.marketPrice,
          gates: snapGates(),
        });
        continue;
      }

      // Now invoke makeHlDecision for the actual short-circuit verdict.
      // It uses the same logic as gates 4–10, so its `shouldTrade` and our
      // gate list agree. We re-use its `reason` string for the row footer.
      const decision = makeHlDecision(signal, session, config);
      if (!decision.shouldTrade) {
        results.push({
          coin, action: "skip", reason: decision.reason,
          direction: signal.direction, edge: netEdgePre,
          predictedProb: signal.finalProb, marketPrice: signal.marketPrice,
          gates: snapGates(),
        });
        continue;
      }

      // Gate 13 — HL price available
      const hlPrice = await getCurrentPrice(coin, config.paperMode);
      coinGates.push({
        label: HL_GATE_LABELS[13],
        passed: !!hlPrice,
        actual: hlPrice ? `$${hlPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "nincs adat",
        required: "elérhető",
        hint: "HL allMids markPrice — paper-on testnet, live-on mainnet.",
      });
      if (!hlPrice) {
        results.push({
          coin, action: "skip", reason: "no HL price",
          direction: signal.direction, edge: netEdgePre,
          predictedProb: signal.finalProb, marketPrice: signal.marketPrice,
          gates: snapGates(),
        });
        continue;
      }

      // Gate 14 — Size > 0 after Kelly + tick-step rounding
      const sized = kellyToPerpSize({
        bankrollUSDC:   session.bankrollCurrent,
        kellyFraction:  signal.kellyFraction,
        edge:           decision.edge,
        currentPrice:   hlPrice,
        leverage:       config.maxLeverage,
        maxPctBankroll: config.maxPctBankroll,
        coin,
        // 2026-05-12 fix: perp R/R Kelly instead of broken combiner Kelly.
        // predProb = LONG-side win prob; the helper flips to (1−p) on SHORT.
        predProb:       signal.finalProb,
        direction:      signal.direction,
        tpPct:          config.tpPctMax,
        slPct:          config.slPctMax,
      });
      const sizeOk = sized.sizeCoins > 0;
      coinGates.push({
        label: HL_GATE_LABELS[14],
        passed: sizeOk,
        actual: sizeOk
          ? `${sized.sizeCoins.toFixed(4)} ${coin} ($${sized.sizeUSDC.toFixed(0)} · ${sized.leverageUsed}× lev)`
          : `0 ${coin}`,
        required: "> 0",
        hint: "Kelly × bankroll × leverage, lefelé kerekítve a coin tick-step-jére.",
      });
      if (!sizeOk) {
        results.push({
          coin, action: "skip", reason: "size rounds to zero",
          direction: signal.direction, edge: netEdgePre,
          predictedProb: signal.finalProb, marketPrice: signal.marketPrice,
          gates: snapGates(),
        });
        continue;
      }

      // 6a. Build the entry-decision snapshot before placing the order.
      // All gates passed → reuse the per-coin gate list verbatim for the
      // frozen entry rationale popover ("Why?").
      const grossEdgeRationale = Math.abs(signal.edge);
      const netEdgeRationale   = decision.edge;
      const kellyCapRationale  = config.maxPctBankroll;
      const kellyCappedRationale = Math.min(signal.kellyFraction, kellyCapRationale);
      const gatesRationale = [...coinGates];
      const entryDecision: import("../shared/types.mts").EntryDecisionSnapshot = {
        decidedAt:        new Date().toISOString(),
        finalProb:        signal.finalProb,
        marketPrice:      signal.marketPrice,
        grossEdge:        grossEdgeRationale,
        netEdge:          netEdgeRationale,
        feePct:           config.roundtripFeePct,
        // Surface HL's native LONG/SHORT so the popover reads "bot LONG-ot
        // vett" instead of "YES".
        direction:        signal.direction,
        kellyRaw:         signal.kellyFraction,
        kellyCapped:      kellyCappedRationale,
        kellyCap:         kellyCapRationale,
        positionSizeUSDC: sized.sizeUSDC,
        entryPrice:       hlPrice,
        // HL coin prices are USD, not 0..1 prob — pass a pre-formatted
        // label so the thesis line shows "$108,432" not cents.
        entryPriceLabel:  `$${hlPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        // The Polymarket-side market price is a 0..1 prob, default fmt OK.
        activeSignals:    signal.activeSignals,
        signalBreakdown:  signal.signalBreakdown,
        obImbalance:      null,
        gates:            gatesRationale,
        reason:           decision.reason,
      };

      // 6b. Place entry (paper sim or live SDK). Signal metadata is captured
      // on the position so the paper-resolver can carry predictedProb /
      // edgeAtEntry / signalBreakdown into the eventual HlClosedTrade.
      const entry = await placeHlEntry({
        coin,
        direction:       signal.direction,
        entryPrice:      hlPrice,
        sizeCoins:       sized.sizeCoins,
        sizeCoinsStr:    sized.sizeCoinsStr,
        sizeUSDC:        sized.sizeUSDC,
        leverage:        sized.leverageUsed,
        edge:            decision.edge,
        paperMode:       config.paperMode,
        tpPctMax:        config.tpPctMax,
        slPctMax:        config.slPctMax,
        predictedProb:   signal.finalProb,
        signalBreakdown: signal.signalBreakdown,
        entryDecision,
      });
      if (!entry.ok || !entry.position) {
        results.push({
          coin, action: "error", reason: entry.error || "entry failed",
          direction: signal.direction, edge: netEdgePre,
          predictedProb: signal.finalProb, marketPrice: signal.marketPrice,
          gates: snapGates(),
        });
        continue;
      }

      session = addOpenPosition(session, entry.position);
      await setCooldown(coin, config.cooldownSeconds);

      log("ORDER_PLACED", config.paperMode, {
        venue: "hyperliquid",
        coin,
        direction: signal.direction,
        entry: entry.position.entryPrice,
        tp: entry.position.tpPrice,
        sl: entry.position.slPrice,
        size: entry.position.sizeCoins,
      });

      // 7. Position is now open. In paper mode it stays open across cron
      // ticks until the live HL markPrice crosses TP or SL — see
      // resolveOpenHlPaperPositions called at the top of this function.
      // The previous synthetic same-tick close is gone because it was a
      // function of the price-direction sign relative to entry, which made
      // every signal look profitable when markPrice happened to drift
      // favorably (paper bias documented in paper-pnl-analysis.md).
      results.push({
        coin,
        action:        "position_opened",
        direction:     signal.direction,
        entry:         entry.position.entryPrice,
        tp:            entry.position.tpPrice,
        sl:            entry.position.slPrice,
        size:          entry.position.sizeCoins,
        notionalUSD:   sized.sizeUSDC,
        leverage:      sized.leverageUsed,
        edge:          netEdgeRationale,
        predictedProb: signal.finalProb,
        marketPrice:   signal.marketPrice,
        gates:         snapGates(),
      });
    } catch (err: any) {
      log("ERROR", config.paperMode, { venue: "hyperliquid", coin, error: err.message });
      await alertError(`[hyperliquid] ${coin}: ${err.message}`);
      results.push({ coin, action: "error", error: err.message, gates: snapGates() });
    }
  }

  await saveHlSession(session);

  // Persist per-signal realized IC for the signal-combiner's optional
  // blending path. Cheap; runs every tick so the Edge Tracker UI can
  // always show fresh "calibrated vs prior" numbers even if `useRealizedIC`
  // is off. Map HL's narrower ClosedTrade shape onto the generic one so
  // computeRealizedICs sees `signalBreakdown` + `pnl` fields uniformly.
  try {
    const cal: any = await import("../shared/signal-calibration.mts");
    const genericTrades = session.closedTrades.map((t: any) => ({
      ...t,
      direction: (t.side === "SHORT" ? "NO" : "YES") as "YES" | "NO",
      category: "hyperliquid" as any,
    }));
    // Half-life from Settings (default null = uniform). When set, recent
    // trades count more — protects against regime-shift drift.
    let halfLifeTrades: number | null = null;
    try {
      const settingsMod: any = await import("../../trader-settings.mts");
      const ov = (await settingsMod.loadRuntimeOverrides()) ?? {};
      const hl = (ov as any).icHalfLifeTrades;
      if (typeof hl === "number" && Number.isFinite(hl) && hl > 0) halfLifeTrades = hl;
    } catch {}
    await cal.persistCalibration("hyperliquid", genericTrades, { halfLifeTrades });
  } catch (err: any) {
    log("ERROR", config.paperMode, { calibration: "persist-failed", category: "hyperliquid", error: err?.message });
  }

  return {
    ok: true,
    action: "run",
    category: "hyperliquid",
    paperMode: config.paperMode,
    coinsScanned: SCAN_COINS.length,
    results,
    session: summarize(session),
    liveReadiness,
  };
}

// ─── Status / control entry points (used by dispatcher) ────────────────────
export async function getHlStatus(): Promise<any> {
  const config  = getHlConfig();
  const session = await loadHlSession(config.paperMode);
  const runStatus = await getHlRunStatus();

  // Compute live-readiness for the UI badge using the same converter the
  // run loop uses, so the verdict is identical between status polls and
  // post-run payloads.
  let liveReadiness: LiveReadinessReport | null = null;
  try {
    const tradesAsGeneric = session.closedTrades.map((t) => ({
      market:     t.coin,
      direction:  t.direction === "LONG" ? "YES" as const : "NO" as const,
      entryPrice: t.entryPrice,
      exitPrice:  t.exitPrice,
      shares:     t.sizeCoins,
      pnl:        t.pnlUSDC,
      pnlPct:     t.pnlPct,
      openedAt:   t.openedAt,
      closedAt:   t.closedAt,
      category:   "hyperliquid" as any,
      predictedProb: t.predictedProb,
      edgeAtEntry:   t.edgeAtEntry,
      signalBreakdown: t.signalBreakdown ?? null,
    }));
    let readyOv: any = {};
    try {
      const mod: any = await import("../../trader-settings.mts");
      readyOv = (await mod.loadRuntimeOverrides()) ?? {};
    } catch {}
    liveReadiness = computeLiveReadiness({
      category: "hyperliquid",
      session: {
        closedTrades: [],
        stopped: session.stopped,
        stoppedReason: session.stoppedReason,
        bankrollStart: session.bankrollStart,
      } as any,
      trades: tradesAsGeneric,
      simVersionExpected: null,
      thresholds: {
        minTrades:         readyOv.liveReadyMinTrades,
        minWinRate:        readyOv.liveReadyMinWinRate,
        minSharpe:         readyOv.liveReadyMinSharpe,
        maxDrawdownPct:    readyOv.liveReadyMaxDrawdownPct,
      } as any,
    });
    // Read-only status path: surface the override flag for UI consistency.
    if (liveReadiness) liveReadiness.overrideActive = readyOv.liveReadyOverrideEnabled === 1;
  } catch {}

  // Surface the "current gate state" per open position so the UI can show
  // what the bot's decision-engine would say RIGHT NOW (as of the last cron
  // tick) about that coin. Combined with the frozen entry-decision snapshot
  // the operator can compare "why we entered" vs "would we enter again".
  const lastScanResults: any[] | null = runStatus?.lastResult?.results ?? null;
  const tickFinishedAt: string | null =
    runStatus?.lastResult?.finishedAt ?? runStatus?.lastRunAt ?? null;
  const pickLiveScanForCoin = (coin: string) => {
    if (!Array.isArray(lastScanResults)) return null;
    const r = lastScanResults.find((x: any) => x?.coin === coin);
    if (!r) return null;
    return {
      evaluatedAt: r.evaluatedAt ?? tickFinishedAt ?? null,
      action:      r.action      ?? null,
      reason:      r.reason      ?? null,
      direction:   r.direction   ?? null,
      edge:        r.edge        ?? null,
      gates:       Array.isArray(r.gates) ? r.gates : [],
    };
  };

  const openDetails = session.openPositions.map((p) => ({
    coin:         p.coin,
    direction:    p.direction,
    sizeUSDC:     p.sizeUSDC,
    sizeCoins:    p.sizeCoins,
    entryPrice:   p.entryPrice,
    leverage:     p.leverage,
    tpPrice:      p.tpPrice,
    slPrice:      p.slPrice,
    openedAt:     p.openedAt,
    edgeAtEntry:  p.edgeAtEntry ?? null,
    predictedProb: p.predictedProb ?? null,
    entryDecision: p.entryDecision ?? null,
    liveGates:    pickLiveScanForCoin(p.coin),
  }));

  return {
    ok: true,
    action: "status",
    category: "hyperliquid",
    session: summarize(session),
    runStatus,
    // HL is wired into auto-trader-multi-cron */3 * * * *, always-on.
    cronEnabled: true,
    liveReadiness,
    openDetails,
  };
}

export async function hlReset(bankrollOverride?: number): Promise<any> {
  const config  = getHlConfig();
  const session = resetHlSession(config.paperMode, bankrollOverride);
  await saveHlSession(session);
  return { ok: true, action: "reset", category: "hyperliquid", session: summarize(session) };
}

export async function hlStop(): Promise<any> {
  const config  = getHlConfig();
  const loaded  = await loadHlSession(config.paperMode);
  const stopped = stopHlSession(loaded, "Manual stop");
  await saveHlSession(stopped);
  return { ok: true, action: "stopped", category: "hyperliquid", session: summarize(stopped) };
}

export async function hlResume(): Promise<any> {
  const config  = getHlConfig();
  const loaded  = await loadHlSession(config.paperMode);
  const resumed = resumeHlSession({ ...loaded, stopped: false, stoppedReason: null });
  await saveHlSession(resumed);
  return { ok: true, action: "resumed", category: "hyperliquid", session: summarize(resumed) };
}

// Sprint 42B (2026-05-15): non-destructive bankroll injection for HL. The
// F-Arb dispatcher delegates to this too (F-Arb has no independent
// bankroll, the funding-arb capital comes from the same HL perp account).
// Preserves closedTrades, openPositions, consecutiveLosses, pausedUntil,
// sessionPnL, sessionLoss, tradeCount, startedAt. Only bankrollStart +
// bankrollCurrent grow.
export async function hlTopup(amount?: number): Promise<any> {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Topup amount must be a positive number" };
  }
  const config = getHlConfig();
  const loaded = await loadHlSession(config.paperMode);
  const bankrollBefore = loaded.bankrollCurrent;
  const topped = topupHlSession(loaded, amount);
  await saveHlSession(topped);
  alertTopup(
    config.paperMode,
    "hyperliquid",
    amount,
    bankrollBefore,
    topped.bankrollCurrent,
    topped.bankrollStart,
  ).catch(() => { /* swallow */ });
  return {
    ok: true,
    action: "topup",
    category: "hyperliquid",
    amount,
    bankrollBefore,
    session: summarize(topped),
  };
}

function summarize(s: HlSessionState) {
  return {
    paperMode:         s.paperMode,
    stopped:           s.stopped,
    stoppedReason:     s.stoppedReason,
    pausedUntil:       s.pausedUntil,
    bankrollStart:     s.bankrollStart,
    bankrollCurrent:   Math.round(s.bankrollCurrent * 100) / 100,
    sessionPnL:        Math.round(s.sessionPnL * 100) / 100,
    sessionLoss:       Math.round(s.sessionLoss * 100) / 100,
    tradeCount:        s.tradeCount,
    openPositions:     s.openPositions.length,
    consecutiveLosses: s.consecutiveLosses,
    startedAt:         s.startedAt,
    // Surfaced for run-state.mts:getHlRunStatus, which invalidates a
    // lastResult snapshot whose simVersion < HL_PAPER_SIM_VERSION.
    simVersion:        s.simVersion ?? null,
  };
}
