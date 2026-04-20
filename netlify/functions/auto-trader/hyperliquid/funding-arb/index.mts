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
import { alertError } from "../../shared/telegram.mts";
import { loadHlSession } from "../session-manager.mts";
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
import type { ArbSessionState, ArbPosition } from "./types.mts";

// Broader coin universe than directional — funding edge is coin-agnostic
const ARB_COINS: HlCoin[] = ["BTC", "ETH", "SOL", "XRP", "AVAX"];

export async function runFundingArbLoop(): Promise<any> {
  const config = getFrArbConfig();
  let session  = await loadArbSession(config.paperMode);

  if (session.stopped) {
    return { ok: true, action: "skipped", reason: `Arb session stopped: ${session.stoppedReason}`, session: summarize(session) };
  }

  // 1. Accrue funding across open positions
  session = accrueFunding(session);

  const results: any[] = [];

  try {
    // 2. Scan fundings
    const fundings = await scanFundings(ARB_COINS, config.paperMode);
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
        const closeResp = await closeArbPosition(pos, closeReason, config);
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

      // Conservative sizing: half of remaining headroom, capped at 10% of OI proxy
      const oiCap = opp.markPrice * opp.markPrice > 0
        ? Math.min(opp.openInterestUSD * 0.001, headroom)   // 0.1% of OI max
        : headroom;
      const sizeUSDC = Math.min(headroom * 0.5, oiCap);
      if (sizeUSDC < config.minPositionUSDC) {
        results.push({ coin: opp.coin, action: "skip", reason: `Size $${sizeUSDC.toFixed(0)} < min $${config.minPositionUSDC}` });
        continue;
      }

      const resp = await openArbPosition(opp, sizeUSDC, config);
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
  const config  = getFrArbConfig();
  const session = await loadArbSession(config.paperMode);
  return { ok: true, action: "status", category: "hyperliquid-arb", session: summarize(session) };
}

export async function arbReset(): Promise<any> {
  const config  = getFrArbConfig();
  const session = resetArbSession(config.paperMode);
  await saveArbSession(session);
  return { ok: true, action: "reset", category: "hyperliquid-arb", session: summarize(session) };
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
  const todayStr = s.totalFundingToday.split(":")[0];
  const todayAmount = parseFloat(s.totalFundingToday.split(":")[1] || "0");
  return {
    paperMode:            s.paperMode,
    stopped:              s.stopped,
    stoppedReason:        s.stoppedReason,
    openPositions:        open.length,
    deployedCapital:      parseFloat(deployedCapital(s).toFixed(2)),
    totalFundingAllTime:  parseFloat(s.totalFundingAllTime.toFixed(2)),
    totalFundingToday:    parseFloat(todayAmount.toFixed(2)),
    fundingDate:          todayStr,
    startedAt:            s.startedAt,
    openDetails:          open.map((p: ArbPosition) => ({
      id:                 p.id,
      coin:               p.coin,
      sizeUSDC:           p.sizeUSDC,
      spreadEntry:        parseFloat((p.entrySpread * 100).toFixed(4)),
      accumulatedFunding: parseFloat(p.accumulatedFunding.toFixed(2)),
      openedAt:           p.openedAt,
    })),
  };
}
