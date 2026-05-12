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
import { getFrArbConfig, getEffectiveFrArbConfig } from "./config.mts";
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
  // Pull runtime Settings overrides every tick — same pattern as HL perp,
  // so the Loose/Normal/Strict preset propagates without a redeploy.
  const baseConfig = await getEffectiveFrArbConfig();
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

    // 4. Per-coin scan: every coin emits a result row with the full gate
    //    list, regardless of whether we end up opening a position. This
    //    feeds the unified "X/Y gates ✓" chip + hover popover on the
    //    FundingArbPanel — same UX as the other 3 bots.
    const bankroll = (await loadHlSession(config.paperMode)).bankrollCurrent;
    const maxCapital = bankroll * config.maxCapitalPct;
    const openCoinSet = new Set(openArbPositions(session).map((p) => p.coin));
    const viableCoinSet = new Set(viable.map((o) => o.coin));
    const oppByCoin = new Map(opportunities.map((o) => [o.coin, o]));
    const ARB_GATE_LABELS = [
      "Spread ≥ küszöb",
      "Break-even hold ≤ max",
      "Open interest ≥ küszöb",
      "Per-coin uniqueness",
      "Pozíció szám < max",
      "Capital cap (sizing)",
    ] as const;
    function arbNotEval(label: string, hint?: string): import("../../shared/types.mts").DecisionGate {
      return { label, passed: false, actual: "not evaluated", required: "—", hint };
    }
    type Gate = import("../../shared/types.mts").DecisionGate;

    for (const coin of ARB_COINS) {
      // Note: a coin may have been closed earlier this tick (its row is
      // already in `results`). We still evaluate it here so the operator
      // sees the post-close scan verdict — typically "skip" because the
      // spread that just triggered the close is below the open threshold.
      const opp = oppByCoin.get(coin);
      const coinGates: Gate[] = [];
      const snapGates = (): Gate[] => {
        const list = [...coinGates];
        for (let i = list.length; i < ARB_GATE_LABELS.length; i++) {
          list.push(arbNotEval(ARB_GATE_LABELS[i]));
        }
        return list;
      };

      // No funding data at all (scan failed for this coin).
      if (!opp) {
        coinGates.push(arbNotEval(ARB_GATE_LABELS[0], "Funding rate scan failed for this coin."));
        results.push({
          coin, action: "skip", reason: "no funding data", gates: snapGates(),
        });
        continue;
      }

      // Gate 1 — Spread ≥ minimum hourly
      const spreadOk = opp.spread >= config.minSpreadHourly;
      coinGates.push({
        label: ARB_GATE_LABELS[0],
        passed: spreadOk,
        actual: `${(opp.spread * 100).toFixed(4)}%/h`,
        required: `≥ ${(config.minSpreadHourly * 100).toFixed(4)}%/h`,
        hint: "HL hourly funding − Binance hourly funding.",
      });

      // Gate 2 — Fee-aware break-even hold
      const totalFees = config.feeRoundtripHl + config.feeRoundtripBinance;
      const breakEvenH = totalFees / Math.max(opp.spread, 1e-9);
      const breakEvenDays = breakEvenH / 24;
      const beOk = spreadOk && breakEvenDays <= config.maxHoldDays;
      coinGates.push({
        label: ARB_GATE_LABELS[1],
        passed: beOk,
        actual: spreadOk ? `${breakEvenDays.toFixed(1)}d` : "spread fail",
        required: `≤ ${config.maxHoldDays}d`,
        hint: "Spread × holdHours fedezze a teljes roundtrip fee-t.",
      });

      // Gate 3 — Open interest floor
      const oiOk = opp.openInterestUSD >= config.minOpenInterestUSD;
      coinGates.push({
        label: ARB_GATE_LABELS[2],
        passed: oiOk,
        actual: `$${(opp.openInterestUSD / 1e6).toFixed(1)}M`,
        required: `≥ $${(config.minOpenInterestUSD / 1e6).toFixed(0)}M`,
        hint: "Vékony piacon a hedge nem fillel slippage nélkül.",
      });

      // Gate 4 — Per-coin uniqueness (no existing arb position)
      const uniqOk = !openCoinSet.has(coin);
      coinGates.push({
        label: ARB_GATE_LABELS[3],
        passed: uniqOk,
        actual: uniqOk ? "no existing arb position" : "already open",
        required: "no duplicate",
        hint: "Egy coinra max 1 nyitott arb pozíció.",
      });

      // Gate 5 — Position-count cap
      const posCount = openArbPositions(session).length;
      const posOk = posCount < config.maxArbPositions;
      coinGates.push({
        label: ARB_GATE_LABELS[4],
        passed: posOk,
        actual: `${posCount}`,
        required: `< ${config.maxArbPositions}`,
        hint: "Egyszerre legfeljebb N arb pozíció.",
      });

      // Coin must pass gates 1–5 to be opening-eligible.
      const isViable = viableCoinSet.has(coin);
      const eligible = isViable && uniqOk && posOk;

      if (!eligible) {
        // Build a row reason — prefer the detector's wording, then the
        // session-level fail.
        let reason = opp.reason || "not viable";
        if (!uniqOk) reason = `Already have open arb position on ${coin}`;
        else if (!posOk) reason = `Max arb positions (${config.maxArbPositions}) reached`;
        // Fill gate 6 as not-evaluated (no sizing attempted).
        coinGates.push(arbNotEval(ARB_GATE_LABELS[5], "Sizing only happens on viable+open-eligible rows."));
        results.push({
          coin, action: "skip", reason,
          spreadHourly:    parseFloat((opp.spread * 100).toFixed(4)),
          spreadAnnualized: parseFloat(opp.spreadAnnualized.toFixed(1)),
          openInterestM:   parseFloat((opp.openInterestUSD / 1e6).toFixed(1)),
          gates: snapGates(),
        });
        continue;
      }

      // Gate 6 — Capital cap + sizing.
      const used = deployedCapital(session);
      const headroom = maxCapital - used;
      if (headroom <= 0) {
        coinGates.push({
          label: ARB_GATE_LABELS[5],
          passed: false,
          actual: `headroom $${headroom.toFixed(0)}`,
          required: `headroom ≥ $${config.minPositionUSDC} · ≤ ${(config.maxCapitalPct * 100).toFixed(0)}% bankroll`,
          hint: "min(headroom × 0.5, OI × 0.1%) sizing.",
        });
        results.push({
          coin, action: "skip", reason: `Capital cap reached ($${maxCapital.toFixed(0)})`,
          spreadHourly:    parseFloat((opp.spread * 100).toFixed(4)),
          spreadAnnualized: parseFloat(opp.spreadAnnualized.toFixed(1)),
          openInterestM:   parseFloat((opp.openInterestUSD / 1e6).toFixed(1)),
          gates: snapGates(),
        });
        // Capital is shared across coins — once cap is hit, no further opens.
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
        coinGates.push({
          label: ARB_GATE_LABELS[5],
          passed: false,
          actual: `$${sizeUSDC.toFixed(2)} (headroom $${headroom.toFixed(0)})`,
          required: `≥ $${config.minPositionUSDC} · ≤ ${(config.maxCapitalPct * 100).toFixed(0)}% bankroll`,
          hint: "min(headroom × 0.5, OI × 0.1%) sizing.",
        });
        results.push({
          coin, action: "skip", reason: `Size $${sizeUSDC.toFixed(0)} < min $${config.minPositionUSDC}`,
          spreadHourly:    parseFloat((opp.spread * 100).toFixed(4)),
          spreadAnnualized: parseFloat(opp.spreadAnnualized.toFixed(1)),
          openInterestM:   parseFloat((opp.openInterestUSD / 1e6).toFixed(1)),
          gates: snapGates(),
        });
        continue;
      }
      coinGates.push({
        label: ARB_GATE_LABELS[5],
        passed: true,
        actual: `$${sizeUSDC.toFixed(2)} (${bankroll > 0 ? ((sizeUSDC / bankroll) * 100).toFixed(1) : "0"}% of bankroll)`,
        required: `≥ $${config.minPositionUSDC} · ≤ ${(config.maxCapitalPct * 100).toFixed(0)}% bankroll`,
        hint: "min(headroom × 0.5, OI × 0.1%) sizing.",
      });

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
        // Reuse the per-coin gate list — all 6 already passed at this point.
        gates: [...coinGates],
        reason: `Spread ${(opp.spread * 100).toFixed(4)}%/h (${opp.spreadAnnualized.toFixed(1)}%/yr ann.) ` +
                `· OI $${(opp.openInterestUSD / 1e6).toFixed(1)}M · size $${sizeUSDC.toFixed(0)}`,
      };

      const resp = await openArbPosition(opp, sizeUSDC, config, entryDecision);
      if (!resp.ok || !resp.position) {
        results.push({ coin: opp.coin, action: "error", error: resp.error, gates: snapGates() });
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
        openInterestM:    parseFloat((opp.openInterestUSD / 1e6).toFixed(1)),
        gates:            snapGates(),
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

  // Load the shared HL bankroll for parity with the other bots' stats grid.
  // Failure is non-fatal — summary just renders with bankrollShared=null.
  let hlBankroll: { bankrollStart: number; bankrollCurrent: number } | null = null;
  try {
    const hl = await loadHlSession(config.paperMode);
    hlBankroll = { bankrollStart: hl.bankrollStart, bankrollCurrent: hl.bankrollCurrent };
  } catch {}

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
    session:  summarize(
      session,
      hlBankroll,
      runStatus?.lastResult?.results ?? null,
      runStatus?.lastResult?.finishedAt ?? runStatus?.lastRunAt ?? null,
    ),
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

// Summarize the F-Arb session for the UI. `hlBankroll` is the shared HL
// session bankroll (F-Arb has no bankroll of its own), included so the
// dashboard can show parity with the other bots' 4-cell stats grid.
function summarize(
  s: ArbSessionState,
  hl?: { bankrollStart: number; bankrollCurrent: number } | null,
  lastScanResults: any[] | null = null,
  tickFinishedAt: string | null = null,
) {
  const open    = openArbPositions(s);
  const closed  = (s.positions ?? []).filter((p) => p.closedAt);
  // Live-gate snapshot per open coin from the most recent scan tick.
  const pickLive = (coin: string) => {
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
  return {
    paperMode:            s.paperMode,
    stopped:              s.stopped,
    stoppedReason:        s.stoppedReason,
    openPositions:        open.length,
    closedTradesCount:    closed.length,
    deployedCapital:      parseFloat(deployedCapital(s).toFixed(2)),
    totalFundingAllTime:  parseFloat(s.totalFundingAllTime.toFixed(2)),
    totalFundingToday:    parseFloat(s.totalFundingToday.amount.toFixed(2)),
    fundingDate:          s.totalFundingToday.date,
    startedAt:            s.startedAt,
    bankrollShared:       hl ? parseFloat(hl.bankrollCurrent.toFixed(2)) : null,
    bankrollSharedStart:  hl ? parseFloat(hl.bankrollStart.toFixed(2))   : null,
    openDetails:          open.map((p: ArbPosition) => ({
      id:                 p.id,
      coin:               p.coin,
      sizeUSDC:           p.sizeUSDC,
      spreadEntry:        parseFloat((p.entrySpread * 100).toFixed(4)),
      accumulatedFunding: parseFloat(p.accumulatedFunding.toFixed(2)),
      openedAt:           p.openedAt,
      entryDecision:      p.entryDecision ?? null,
      liveGates:          pickLive(p.coin),
    })),
  };
}
