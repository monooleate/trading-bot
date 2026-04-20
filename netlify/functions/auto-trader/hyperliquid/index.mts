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
import { alertError } from "../shared/telegram.mts";
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
  simulatePaperPnl,
} from "./order-manager.mts";
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

export async function runHyperliquidTrader(configOverride?: HlTraderConfig): Promise<any> {
  const config  = configOverride ?? getHlConfig();
  let   session = await loadHlSession(config.paperMode);

  // Session-level short-circuits
  if (session.stopped) {
    return { ok: true, action: "skipped", reason: `Session stopped: ${session.stoppedReason}`, session: summarize(session) };
  }
  if (session.pausedUntil && new Date(session.pausedUntil).getTime() > Date.now()) {
    return { ok: true, action: "skipped", reason: `Paused until ${session.pausedUntil}`, session: summarize(session) };
  }

  const results: any[] = [];

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

      // 6. Place entry (paper sim or live SDK)
      const entry = await placeHlEntry({
        coin,
        direction:    signal.direction,
        entryPrice:   hlPrice,
        sizeCoins:    sized.sizeCoins,
        sizeCoinsStr: sized.sizeCoinsStr,
        sizeUSDC:     sized.sizeUSDC,
        leverage:     sized.leverageUsed,
        edge:         decision.edge,
        paperMode:    config.paperMode,
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

      // 7. Paper-mode: close synthetically within this run
      if (config.paperMode) {
        const sim = simulatePaperPnl({
          position:     entry.position,
          currentPrice: hlPrice,
          feeRoundtrip: config.roundtripFeePct,
        });
        const closedTrade: HlClosedTrade = {
          coin,
          direction:     signal.direction,
          entryPrice:    entry.position.entryPrice,
          exitPrice:     sim.exitPrice,
          sizeCoins:     entry.position.sizeCoins,
          pnlUSDC:       sim.pnlUSDC,
          pnlPct:        sim.pnlPct,
          openedAt:      entry.position.openedAt,
          closedAt:      new Date().toISOString(),
          closeReason:   sim.closeReason,
          edgeAtEntry:   decision.edge,
          predictedProb: signal.finalProb,
          signalBreakdown: signal.signalBreakdown,
        };
        session = closePosition(session, entry.position.entryOrderId, closedTrade);

        log("TRADE_CLOSED", config.paperMode, {
          venue: "hyperliquid",
          coin,
          pnl: sim.pnlUSDC,
          reason: sim.closeReason,
        });

        // Consecutive-loss pause
        if (session.consecutiveLosses >= config.consecutiveLossLimit) {
          session = applyConsecutiveLossPause(session, config.consecutiveLossPauseHours);
        }

        // Session-loss stop
        if (session.sessionLoss >= config.sessionLossLimit) {
          session = stopHlSession(session, "Session loss limit reached");
        }

        results.push({
          coin,
          action:    "traded",
          direction: signal.direction,
          entry:     entry.position.entryPrice,
          exit:      sim.exitPrice,
          pnl:       sim.pnlUSDC,
          reason:    sim.closeReason,
        });
      } else {
        results.push({
          coin,
          action:    "position_opened",
          direction: signal.direction,
          entry:     entry.position.entryPrice,
          size:      entry.position.sizeCoins,
        });
      }
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
  };
}

// ─── Status / control entry points (used by dispatcher) ────────────────────
export async function getHlStatus(): Promise<any> {
  const config  = getHlConfig();
  const session = await loadHlSession(config.paperMode);
  return { ok: true, action: "status", category: "hyperliquid", session: summarize(session) };
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
