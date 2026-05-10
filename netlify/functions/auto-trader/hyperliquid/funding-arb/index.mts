// netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts
// Main funding-arb loop. Scheduled alongside the directional Hyperliquid
// trader, but with its own session store and control endpoints.
//
// Per run:
//   1. Accrue funding on all open arb positions
//   2. Scan HL + Binance for current spreads
//   3. Close any open position whose spread has decayed below threshold
//      (or whose max-hold-days has elapsed, or whose spread flipped sign)
//   4. Open new positions from the top-ranked viable opportunities,
//      respecting position count, per-coin uniqueness, and capital cap.

import { log } from "../../shared/logger.mts";
import { alertError, alertLiveBlocked } from "../../shared/telegram.mts";
import { computeLiveReadiness, shouldForcePaper, type LiveReadinessReport } from "../../shared/live-readiness.mts";
import { loadHlSession, saveHlSession } from "../session-manager.mts";
import type { HlCoin } from "../types.mts";
import { scanFundings } from "./fr-scanner.mts";
import { detectArbOpportunity, rankOpportunities } from "./arb-detector.mts";
import { openArbPosition, closeArbPosition } from "./fr-executor.mts";
import {
  loadArbSession,
  saveArbSession,
  addArbPosition,
  accrueFunding,
  replacePosition,
  openArbPositions,
  deployedCapital,
  stopArbSession,
  resumeArbSession,
  resetArbSession,
} from "./fr-session.mts";
import { getFrArbConfig } from "./config.mts";
import { markArbRunStart, markArbRunFinish, getArbRunStatus } from "./arb-run-state.mts";
import type { ArbSessionState, ArbPosition } from "./types.mts";

// Broader coin universe than directional — funding edge is coin-agnostic
const ARB_COINS: HlCoin[] = ["BTC", "ETH", "SOL", "XRP", "AVAX"];

export async function runFundingArbLoop(
  source: "manual" | "cron" = "manual",
): Promise<any> {
  await markArbRunStart(source).catch(() => {});
  let result: any;
  try {
    result = await runFundingArbInner();
  } catch (err: any) {
    result = { ok: false, action: "error", error: err?.message || "unknown", source };
  }
  await markArbRunFinish(result).catch(() => {});
  return { ...result, source };
}

async function runFundingArbInner(): Promise<any> {
  const baseConfig = getFrArbConfig();
  // Mutable clone so the live-readiness gate can flip paperMode back to
  // true if the paper track record hasn't yet met validation thresholds.
  const config: typeof baseConfig = { ...baseConfig };
  let session  = await loadArbSession(config.paperMode);

  // Live-readiness gate: funding-arb is rate-driven (not prediction-driven),
  // so IC / calibration gates are N/A. We still enforce trade count, sharpe,
  // drawdown, sim version, and session-active gates.
  let liveReadiness: LiveReadinessReport | null = null;
  try {
    const closedTrades = (session.positions ?? [])
      .filter((p) => p.closedAt && (p.closeFundingNet ?? null) !== null)
      .map((p) => ({
        market:     p.coin,
        direction:  "NO" as const,                  // SHORT leg by convention
        entryPrice: p.hlEntryPrice ?? 0,
        exitPrice:  0,
        shares:     p.sizeCoins ?? 0,
        pnl:        p.closeFundingNet ?? 0,
        pnlPct:     p.sizeUSDC > 0 ? ((p.closeFundingNet ?? 0) / p.sizeUSDC) * 100 : 0,
        openedAt:   p.openedAt,
        closedAt:   p.closedAt!,
        category:   "funding-arb" as any,
      }));
    let readyOv: any = {};
    try {
      const mod: any = await import("../../../trader-settings.mts");
      readyOv = (await mod.loadRuntimeOverrides()) ?? {};
    } catch {}
    liveReadiness = computeLiveReadiness({
      category: "funding-arb",
      session: {
        closedTrades: [],
        stopped: session.stopped,
        stoppedReason: session.stoppedReason,
        bankrollStart: 100,
      } as any,
      trades: closedTrades,
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
      log("ERROR", true, { liveBlocked: true, category: "funding-arb", reason: force.reason });
      const failed = liveReadiness.gates.filter((g) => g.applicable && !g.passed).map((g) => g.label);
      await alertLiveBlocked("funding-arb", force.reason!, failed);
      config.paperMode = true;
    }
  } catch {}

  if (session.stopped) {
    return { ok: true, action: "skipped", reason: `Arb session stopped: ${session.stoppedReason}`, session: summarize(session), liveReadiness };
  }

  const results: any[] = [];

  try {
    // 1. Scan fundings (HL + Binance) — done BEFORE accrual so we can
    //    accrue at the latest observed HL hourly rate AND latest markPrice
    //    rather than the entry-time snapshot. See accrueFunding in
    //    fr-session for the mark-to-market math.
    const fundings = await scanFundings(ARB_COINS, config.paperMode);
    const hlSnapshotByCoin = new Map<string, { rate: number; markPrice: number }>();
    for (const f of fundings) {
      hlSnapshotByCoin.set(f.coin, { rate: f.hlFundingHourly, markPrice: f.markPrice });
    }

    // 2. Accrue funding using the freshest HL rate × current notional.
    session = accrueFunding(session, new Date(), hlSnapshotByCoin);

    const opportunities = fundings.map(f => detectArbOpportunity(f, config));
    const viable = rankOpportunities(opportunities.filter(o => o.isViable));

    // 3. Close-check existing open positions
    const fundingByCoin = new Map(fundings.map(f => [f.coin, f]));
    const maxHoldMs = config.maxHoldDays * 86_400_000;

    for (const pos of openArbPositions(session)) {
      const nowAge = Date.now() - new Date(pos.openedAt).getTime();
      const current = fundingByCoin.get(pos.coin);
      const currentSpread = current ? (current.hlFundingHourly - current.binanceFundingHourly) : pos.entrySpread;

      let closeReason: string | null = null;
      if (nowAge >= maxHoldMs)                          closeReason = `Max hold ${config.maxHoldDays}d reached`;
      else if (currentSpread < config.minSpreadToClose) closeReason = `Spread dropped to ${(currentSpread * 100).toFixed(4)}%/h`;
      else if (currentSpread < 0)                       closeReason = `Spread flipped negative — shorts now pay`;

      if (closeReason) {
        const closeResp = await closeArbPosition(pos, closeReason, config, current?.markPrice);
        if (closeResp.ok) {
          session = replacePosition(session, pos);
          log("ARB_CLOSE", config.paperMode, {
            id:       pos.id,
            coin:     pos.coin,
            reason:   closeReason,
            netPnl:   closeResp.netPnl,
            funding:  pos.accumulatedFunding,
          });
          results.push({ coin: pos.coin, action: "closed", reason: closeReason, netPnl: closeResp.netPnl });
        } else {
          log("ERROR", config.paperMode, { event: "ARB_CLOSE_FAIL", coin: pos.coin, error: closeResp.error });
          results.push({ coin: pos.coin, action: "close_error", error: closeResp.error });
        }
      }
    }

    // 4. Open-check new positions
    const bankroll = (await loadHlSession(config.paperMode)).bankrollCurrent;
    const maxCapital = bankroll * config.maxCapitalPct;
    const openNow = openArbPositions(session);
    const openCoinSet = new Set(openNow.map(p => p.coin));

    for (const opp of viable) {
      if (openArbPositions(session).length >= config.maxArbPositions) break;
      if (openCoinSet.has(opp.coin)) continue;

      const used = deployedCapital(session);
      const headroom = maxCapital - used;
      if (headroom <= 0) {
        results.push({ coin: opp.coin, action: "skip", reason: `Capital cap reached ($${maxCapital.toFixed(0)})` });
        break;
      }

      // Conservative sizing: half of remaining headroom, capped at 0.1% of
      // OI so we never become a meaningful share of the book. Falls back
      // to plain headroom when OI data is missing.
      const oiCap = opp.openInterestUSD > 0
        ? Math.min(opp.openInterestUSD * 0.001, headroom)
        : headroom;
      const sizeUSDC = Math.min(headroom * 0.5, oiCap);
      if (sizeUSDC < config.minPositionUSDC) {
        results.push({ coin: opp.coin, action: "skip", reason: `Size $${sizeUSDC.toFixed(0)} < min $${config.minPositionUSDC}` });
        continue;
      }

      // Build the spread-flavor entry-decision snapshot — same
      // `EntryDecisionSnapshot` shape as crypto/weather/HL, so the
      // unified UI's RationaleBlock renders the "Why?" panel without
      // a per-bot branch. flavor:"spread" swaps the thesis line and
      // grid layout client-side.
      const feePct = config.feeRoundtripHl + config.feeRoundtripBinance;
      const netSpread = opp.spread - feePct;
      const capPct    = config.maxCapitalPct;
      const usedFracBankroll = bankroll > 0 ? sizeUSDC / bankroll : 0;
      const entryDecision: import("../../shared/types.mts").EntryDecisionSnapshot = {
        decidedAt:        new Date().toISOString(),
        flavor:           "spread",
        finalProb:        opp.hlFundingHourly,
        marketPrice:      opp.binanceFundingHourly,
        grossEdge:        opp.spread,
        netEdge:          netSpread,
        feePct,
        direction:        "SHORT",
        kellyRaw:         usedFracBankroll,
        kellyCapped:      Math.min(usedFracBankroll, capPct),
        kellyCap:         capPct,
        positionSizeUSDC: sizeUSDC,
        entryPrice:       opp.markPrice,
        entryPriceLabel:  `$${opp.markPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        marketPriceLabel: `${(opp.binanceFundingHourly * 100).toFixed(4)}%/h`,
        spreadAnnualizedPct: opp.spreadAnnualized,
        openInterestUSD:  opp.openInterestUSD,
        activeSignals:    0,
        signalBreakdown:  null,
        obImbalance:      null,
        gates: [
          {
            label: "Spread ≥ küszöb",
            passed: true,
            actual:   `${(opp.spread * 100).toFixed(4)}%/h`,
            required: `≥ ${(config.minSpreadHourly * 100).toFixed(4)}%/h`,
            hint: "HL hourly funding − Binance hourly funding, fee-aware küszöb felett.",
          },
          {
            label: "Open interest ≥ küszöb",
            passed: true,
            actual:   `$${(opp.openInterestUSD / 1e6).toFixed(1)}M`,
            required: `≥ $${(config.minOpenInterestUSD / 1e6).toFixed(0)}M`,
            hint: "Vékony piacon a hedge nem fillel slippage nélkül.",
          },
          {
            label: "Per-coin uniqueness",
            passed: true,
            actual:   "no existing arb position on this coin",
            required: "no duplicate",
            hint: "Egy coinra max 1 nyitott arb pozíció.",
          },
          {
            label: "Position count ≤ max",
            passed: true,
            actual:   `${session.positions.filter(p => !p.closedAt).length}`,
            required: `≤ ${config.maxArbPositions}`,
            hint: "Egyszerre legfeljebb N arb pozíció.",
          },
          {
            label: "Capital cap (sizing)",
            passed: true,
            actual:   `$${sizeUSDC.toFixed(2)} (${(usedFracBankroll * 100).toFixed(1)}% of bankroll)`,
            required: `headroom ≥ $${config.minPositionUSDC} · ≤ ${(capPct * 100).toFixed(0)}% bankroll`,
            hint: "min(headroom × 0.5, OI × 0.1%) — soha nem leszünk a könyv értékelhető része.",
          },
        ],
        reason: `Spread ${(opp.spread * 100).toFixed(4)}%/h (${opp.spreadAnnualized.toFixed(1)}%/yr ann.) ` +
                `· OI $${(opp.openInterestUSD / 1e6).toFixed(1)}M · size $${sizeUSDC.toFixed(0)}`,
      };

      const resp = await openArbPosition(opp, sizeUSDC, config, entryDecision);
      if (!resp.ok || !resp.position) {
        results.push({ coin: opp.coin, action: "error", error: resp.error });
        continue;
      }
      session = addArbPosition(session, resp.position);
      openCoinSet.add(opp.coin);

      log("ARB_OPEN", config.paperMode, {
        id:               resp.position.id,
        coin:             opp.coin,
        sizeUSDC,
        spread:           opp.spread,
        spreadAnnualized: opp.spreadAnnualized,
      });
      results.push({
        coin:             opp.coin,
        action:           "opened",
        sizeUSDC:         parseFloat(sizeUSDC.toFixed(2)),
        spreadHourly:     opp.spread,
        spreadAnnualized: parseFloat(opp.spreadAnnualized.toFixed(1)),
      });
    }

    // Attach top-5 opportunity snapshot for UI
    const topSnapshot = rankOpportunities(opportunities).slice(0, 5).map(o => ({
      coin:             o.coin,
      spreadHourly:     parseFloat((o.spread * 100).toFixed(4)),
      annualized:       parseFloat(o.spreadAnnualized.toFixed(1)),
      viable:           o.isViable,
      reason:           o.reason,
      openInterestM:    parseFloat((o.openInterestUSD / 1e6).toFixed(1)),
    }));

    await saveArbSession(session);

    return {
      ok:           true,
      action:       "run",
      category:     "hyperliquid-arb",
      paperMode:    config.paperMode,
      coinsScanned: ARB_COINS.length,
      results,
      opportunities: topSnapshot,
      session:      summarize(session),
      liveReadiness,
    };
  } catch (err: any) {
    log("ERROR", config.paperMode, { venue: "hyperliquid-arb", error: err.message });
    await alertError(`[hyperliquid-arb] ${err.message}`);
    await saveArbSession(session);
    return { ok: false, error: err.message, session: summarize(session) };
  }
}

// ─── Status / control handlers ─────────────────────────────────────────────
export async function getArbStatus(): Promise<any> {
  const config    = getFrArbConfig();
  const session   = await loadArbSession(config.paperMode);
  const runStatus = await getArbRunStatus();

  // Live-readiness verdict for the UI badge — same shape as getHlStatus
  // returns for the directional bot, so the home-page banner can poll
  // `category=hyperliquid&layer=arb` and read it from a single field.
  let liveReadiness: LiveReadinessReport | null = null;
  try {
    const closedTrades = (session.positions ?? [])
      .filter((p) => p.closedAt && (p.closeFundingNet ?? null) !== null)
      .map((p) => ({
        market:     p.coin,
        direction:  "NO" as const,
        entryPrice: p.hlEntryPrice ?? 0,
        exitPrice:  0,
        shares:     p.sizeCoins ?? 0,
        pnl:        p.closeFundingNet ?? 0,
        pnlPct:     p.sizeUSDC > 0 ? ((p.closeFundingNet ?? 0) / p.sizeUSDC) * 100 : 0,
        openedAt:   p.openedAt,
        closedAt:   p.closedAt!,
        category:   "funding-arb" as any,
      }));
    let readyOv: any = {};
    try {
      const mod: any = await import("../../../trader-settings.mts");
      readyOv = (await mod.loadRuntimeOverrides()) ?? {};
    } catch {}
    liveReadiness = computeLiveReadiness({
      category: "funding-arb",
      session: {
        closedTrades: [],
        stopped: session.stopped,
        stoppedReason: session.stoppedReason,
        bankrollStart: 100,
      } as any,
      trades: closedTrades,
      simVersionExpected: null,
      thresholds: {
        minTrades:         readyOv.liveReadyMinTrades,
        minWinRate:        readyOv.liveReadyMinWinRate,
        minSharpe:         readyOv.liveReadyMinSharpe,
        maxDrawdownPct:    readyOv.liveReadyMaxDrawdownPct,
      } as any,
    });
  } catch {}

  return {
    ok: true,
    action:   "status",
    category: "hyperliquid-arb",
    session:  summarize(session),
    runStatus,
    // Funding-arb is wired into auto-trader-multi-cron */3 * * * *,
    // always-on (same as the directional HL bot).
    cronEnabled: true,
    liveReadiness,
  };
}

export async function arbReset(bankrollOverride?: number): Promise<any> {
  const config  = getFrArbConfig();
  const session = resetArbSession(config.paperMode);
  await saveArbSession(session);

  // Funding-arb has no bankroll of its own — capital is drawn from the HL
  // directional session's bankrollCurrent. When the dashboard supplies a new
  // bankroll on reset, propagate it to the HL session ONLY if that session
  // has no open positions (otherwise we'd corrupt PnL accounting). Open
  // positions ⇒ silently keep the existing HL bankroll; the response flag
  // lets the UI surface what happened.
  let bankrollApplied: number | null = null;
  let bankrollSkippedReason: string | null = null;
  if (typeof bankrollOverride === "number" && Number.isFinite(bankrollOverride)) {
    const hl = await loadHlSession(config.paperMode);
    if (hl.openPositions.length === 0) {
      const updated = { ...hl, bankrollStart: bankrollOverride, bankrollCurrent: bankrollOverride };
      await saveHlSession(updated);
      bankrollApplied = bankrollOverride;
    } else {
      bankrollSkippedReason = `HL session has ${hl.openPositions.length} open perp position(s); close them or reset Hyperliquid Perp first.`;
    }
  }

  return {
    ok: true,
    action: "reset",
    category: "hyperliquid-arb",
    session: summarize(session),
    bankrollApplied,
    bankrollSkippedReason,
  };
}

export async function arbStop(): Promise<any> {
  const config  = getFrArbConfig();
  const loaded  = await loadArbSession(config.paperMode);
  const stopped = stopArbSession(loaded, "Manual stop");
  await saveArbSession(stopped);
  return { ok: true, action: "stopped", category: "hyperliquid-arb", session: summarize(stopped) };
}

export async function arbResume(): Promise<any> {
  const config  = getFrArbConfig();
  const loaded  = await loadArbSession(config.paperMode);
  const resumed = resumeArbSession(loaded);
  await saveArbSession(resumed);
  return { ok: true, action: "resumed", category: "hyperliquid-arb", session: summarize(resumed) };
}

function summarize(s: ArbSessionState) {
  const open = openArbPositions(s);
  return {
    paperMode:            s.paperMode,
    stopped:              s.stopped,
    stoppedReason:        s.stoppedReason,
    openPositions:        open.length,
    deployedCapital:      parseFloat(deployedCapital(s).toFixed(2)),
    totalFundingAllTime:  parseFloat(s.totalFundingAllTime.toFixed(2)),
    totalFundingToday:    parseFloat(s.totalFundingToday.amount.toFixed(2)),
    fundingDate:          s.totalFundingToday.date,
    startedAt:            s.startedAt,
    openDetails:          open.map((p: ArbPosition) => ({
      id:                 p.id,
      coin:               p.coin,
      sizeUSDC:           p.sizeUSDC,
      spreadEntry:        parseFloat((p.entrySpread * 100).toFixed(4)),
      accumulatedFunding: parseFloat(p.accumulatedFunding.toFixed(2)),
      openedAt:           p.openedAt,
      entryDecision:      p.entryDecision ?? null,
    })),
  };
}
