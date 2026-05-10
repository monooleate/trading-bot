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
import { getHlConfig } from "./config.mts";
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
} from "./session-manager.mts";
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
  const baseConfig = configOverride ?? getHlConfig();
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
    const force = shouldForcePaper(config.paperMode, liveReadiness);
    if (force.forcePaper) {
      log("ERROR", true, { liveBlocked: true, category: "hyperliquid", reason: force.reason });
      const failed = liveReadiness.gates.filter((g) => g.applicable && !g.passed).map((g) => g.label);
      await alertLiveBlocked("hyperliquid", force.reason!, failed);
      config.paperMode = true;
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

  // ── Resolve any open paper positions FIRST. This replaces the old
  // synthetic-close-in-the-same-run pattern with real HL markPrice driven
  // TP/SL crossings. Any position that didn't cross stays open across cron
  // ticks — so an ETH LONG opened at 12:00 with a 1% TP genuinely needs
  // ETH to move 1% (the same way) before it counts as a winner.
  const resolutions: any[] = [];
  if (config.paperMode && session.openPositions.length > 0) {
    const r = await resolveOpenHlPaperPositions(session, {
      feeRoundtrip:   config.roundtripFeePct,
      maxPaperHoldMs: DEFAULT_MAX_PAPER_HOLD_MS,
    });
    session = r.session;
    for (const res of r.resolutions) {
      resolutions.push({ coin: res.coin, action: "resolved", reason: res.reason, exit: res.exitPrice, pnl: res.pnlUSDC });
    }
    // Apply post-close session checks once after the batch resolution.
    if (r.resolutions.length > 0) {
      if (session.consecutiveLosses >= config.consecutiveLossLimit) {
        session = applyConsecutiveLossPause(session, config.consecutiveLossPauseHours);
      }
      if (session.sessionLoss >= config.sessionLossLimit) {
        session = stopHlSession(session, "Session loss limit reached");
      }
    }
  }

  const results: any[] = resolutions;

  for (const coin of SCAN_COINS) {
    try {
      if (isOnCooldown(coin)) {
        results.push({ coin, action: "skip", reason: "cooldown" });
        continue;
      }

      // 1. Signal
      const signal = await getHlSignalForCoin(coin);
      if (!signal) {
        results.push({ coin, action: "skip", reason: "no signal" });
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

      // 2. Volatility gate (skip in paper unless explicitly testing)
      if (!config.paperMode) {
        const volCheck = await volatilityGate(coin, config.volGateRvPct);
        if (!volCheck.pass) {
          results.push({ coin, action: "skip", reason: volCheck.reason });
          continue;
        }
      }

      // 3. Final decision gates
      const decision = makeHlDecision(signal, session, config);
      if (!decision.shouldTrade) {
        results.push({ coin, action: "skip", reason: decision.reason });
        continue;
      }

      // 4. Live price from HL
      const hlPrice = await getCurrentPrice(coin, config.paperMode);
      if (!hlPrice) {
        results.push({ coin, action: "skip", reason: "no HL price" });
        continue;
      }

      // 5. Size
      const sized = kellyToPerpSize({
        bankrollUSDC:   session.bankrollCurrent,
        kellyFraction:  signal.kellyFraction,
        edge:           decision.edge,
        currentPrice:   hlPrice,
        leverage:       config.maxLeverage,
        maxPctBankroll: config.maxPctBankroll,
        coin,
      });
      if (sized.sizeCoins <= 0) {
        results.push({ coin, action: "skip", reason: "size rounds to zero" });
        continue;
      }

      // 6. Place entry (paper sim or live SDK). Signal metadata is captured
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
        predictedProb:   signal.finalProb,
        signalBreakdown: signal.signalBreakdown,
      });
      if (!entry.ok || !entry.position) {
        results.push({ coin, action: "error", reason: entry.error || "entry failed" });
        continue;
      }

      session = addOpenPosition(session, entry.position);
      setCooldown(coin, config.cooldownSeconds);

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
        action:    "position_opened",
        direction: signal.direction,
        entry:     entry.position.entryPrice,
        tp:        entry.position.tpPrice,
        sl:        entry.position.slPrice,
        size:      entry.position.sizeCoins,
      });
    } catch (err: any) {
      log("ERROR", config.paperMode, { venue: "hyperliquid", coin, error: err.message });
      await alertError(`[hyperliquid] ${coin}: ${err.message}`);
      results.push({ coin, action: "error", error: err.message });
    }
  }

  await saveHlSession(session);

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
  } catch {}

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

export async function hlReset(): Promise<any> {
  const config  = getHlConfig();
  const session = resetHlSession(config.paperMode);
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
  };
}
