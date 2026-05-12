// netlify/functions/auto-trader/weather/reconciler.mts
//
// Real-settlement closure for paper-mode weather positions.
//
// Source priority (matching the crypto paper-resolver pattern):
//
//   1. POLYMARKET (authoritative). Query the Gamma API for the position's
//      conditionId. When the sub-market has resolved, outcomePrices snaps to
//      {0,1} — that's the exact PnL a real bet would have realised, including
//      any disputes / off-chain adjustments. This is the primary source.
//
//   2. METAR FALLBACK. If Polymarket hasn't published resolution yet (the
//      common case in the first ~6h after endDate while UMA voting runs), we
//      check the actual METAR daily-max temp at the airport station. We
//      simulate Polymarket's settlement convention (°F-rounded daily high)
//      and decide which bucket would win. This lets us close stale positions
//      during the resolution window and credit them once Polymarket catches
//      up — but in 99% of cases Polymarket settles first and we never need
//      this branch.
//
// Idempotent: a position is removed from openPositions on success, so
// running the reconciler twice doesn't double-settle anything. Source-1
// failure leaves the position open for the next tick.

import { log } from "../shared/logger.mts";
import { closePosition, loadSession, saveSession } from "../crypto/session-manager.mts";
import { recordDebSample } from "./deb.mts";
import { getStation } from "./station-config.mts";
import { fetchMetarDailyMax } from "./metar-fetcher.mts";
import { fetchPolymarketResolution } from "./polymarket-resolver.mts";
import type { Position, ClosedTrade } from "../shared/types.mts";

const DEFAULT_BANKROLL = 100;

// Number of hours past endDate after which we accept the METAR fallback.
// Polymarket usually settles within 1-2h; if we're past this window with no
// Gamma resolution yet we'd rather close on the underlying physical truth
// than leave the position open indefinitely.
const METAR_FALLBACK_AFTER_HOURS = 6;

// ─── Public API ───────────────────────────────────────────────────────────

export interface ReconcileResult {
  ok:           boolean;
  scanned:      number;
  ready:        number;
  settled:      number;
  failed:       number;
  pendingTotal: number;
  details:      ReconcileDetail[];
}

export interface ReconcileDetail {
  market:        string;
  city:          string;
  date:          string;
  bucketLabel:   string;
  predictedMaxC: number;
  source?:       "polymarket" | "metar-fallback";
  actualMaxC?:   number;          // METAR-only
  isWin?:        boolean;
  pnl?:          number;
  status:        "settled" | "pending" | "fetch-failed" | "no-meta";
  reason?:       string;
  // Tentative outcome preview — populated for pending positions when the
  // current METAR observation is informative (day's max likely already
  // observed even before the formal 6h fallback window). UI surfaces this
  // as a "leaning W/L" hint so the operator doesn't have to guess.
  tentative?: {
    actualMaxC: number;
    isWin:      boolean;
    pnl:        number;
    source:     "metar-preview";
  };
}

export async function runWeatherReconciler(paperMode: boolean = true): Promise<ReconcileResult> {
  let session = await loadSession(paperMode, DEFAULT_BANKROLL, "weather");
  const details: ReconcileDetail[] = [];
  let scanned = 0, ready = 0, settled = 0, failed = 0;

  const positions = [...session.openPositions];

  for (const pos of positions) {
    scanned++;
    const meta = pos.weatherMeta;
    if (!meta) continue; // not a weather paper position

    // Time gate: don't try to settle before reconcileAfter. We still attempt
    // a tentative METAR fetch though — by reconcileAfter time the day's max
    // is usually already in the books even if Polymarket/UMA haven't booked
    // the resolution yet. The tentative outcome is informational only; the
    // settled close still requires reconcileAfter to pass + a real source.
    if (Date.now() < new Date(meta.reconcileAfter).getTime()) {
      let tentative: ReconcileDetail["tentative"] | undefined = undefined;
      try {
        const station = getStation(meta.city);
        if (station) {
          const metar = await fetchMetarDailyMax(meta.stationIcao, meta.date, station.tz);
          if (metar) {
            const f = metar.dailyMaxC * 9 / 5 + 32;
            const settlementC = parseFloat((((Math.round(f) - 32) * 5) / 9).toFixed(2));
            const isTailLow  = /\bor\s+below\b|\bor\s+lower\b/i.test(meta.bucketLabel);
            const isTailHigh = /\bor\s+(higher|above|more)\b/i.test(meta.bucketLabel);
            const bucketWon = isTailLow ? settlementC <= meta.bucketTempC + 0.5
                            : isTailHigh ? settlementC >= meta.bucketTempC - 0.5
                            : Math.abs(settlementC - meta.bucketTempC) < 0.5;
            const positionWon = pos.direction === "YES" ? bucketWon : !bucketWon;
            const exit = positionWon ? 1.0 : 0.0;
            tentative = {
              actualMaxC: metar.dailyMaxC,
              isWin:      positionWon,
              pnl:        pos.shares * exit - pos.costBasis,
              source:     "metar-preview",
            };
          }
        }
      } catch {
        // METAR preview is best-effort. Failure leaves tentative undefined.
      }
      details.push({
        market: pos.market, city: meta.city, date: meta.date,
        bucketLabel: meta.bucketLabel, predictedMaxC: meta.predictedMaxC,
        status: "pending",
        reason: `Settles after ${meta.reconcileAfter}`,
        tentative,
      });
      continue;
    }
    ready++;

    // ─── Source 1: Polymarket (authoritative) ─────────────────────────
    let exitPrice: number | null = null;
    let source: "polymarket" | "metar-fallback" | null = null;
    let actualMaxC: number | null = null;

    if (pos.conditionId) {
      const resolved = await fetchPolymarketResolution(pos.conditionId);
      if (resolved) {
        // Defensive slug check (2026-05-10 (i)): the position's `market`
        // field is the event slug (e.g. "highest-temperature-in-shanghai-
        // on-may-10-2026"); the resolved sub-market slug should start with
        // it (e.g. "...-may-10-2026-24c"). If not, the stored conditionId
        // points to a sibling bucket — refuse the resolution to avoid
        // booking a fake win against the wrong sub-market.
        const slugMatches = !!resolved.resolvedSlug
          && resolved.resolvedSlug.startsWith(pos.market);
        if (!slugMatches) {
          console.error(
            `[reconciler] conditionId-bucket mismatch on ${pos.market} (${meta.bucketLabel}): ` +
            `stored conditionId resolved to slug "${resolved.resolvedSlug}". Skipping settlement.`,
          );
        } else {
          exitPrice = pos.direction === "YES"
            ? resolved.yesResolvedPrice
            : resolved.noResolvedPrice;
          source = "polymarket";
        }
      }
    }

    // ─── Source 2: METAR fallback ─────────────────────────────────────
    if (exitPrice === null) {
      const fallbackEligible = Date.now() >=
        new Date(meta.reconcileAfter).getTime() + METAR_FALLBACK_AFTER_HOURS * 3_600_000;

      if (!fallbackEligible) {
        // Within the Polymarket settlement window — wait for it. Still try
        // a tentative METAR preview: by this point reconcileAfter has passed,
        // so the day's max is in the books (just not yet booked via Gamma).
        let tentative: ReconcileDetail["tentative"] | undefined = undefined;
        try {
          const station = getStation(meta.city);
          if (station) {
            const metar = await fetchMetarDailyMax(meta.stationIcao, meta.date, station.tz);
            if (metar) {
              const f = metar.dailyMaxC * 9 / 5 + 32;
              const settlementC = parseFloat((((Math.round(f) - 32) * 5) / 9).toFixed(2));
              const isTailLow  = /\bor\s+below\b|\bor\s+lower\b/i.test(meta.bucketLabel);
              const isTailHigh = /\bor\s+(higher|above|more)\b/i.test(meta.bucketLabel);
              const bucketWon = isTailLow ? settlementC <= meta.bucketTempC + 0.5
                              : isTailHigh ? settlementC >= meta.bucketTempC - 0.5
                              : Math.abs(settlementC - meta.bucketTempC) < 0.5;
              const positionWon = pos.direction === "YES" ? bucketWon : !bucketWon;
              const exit = positionWon ? 1.0 : 0.0;
              tentative = {
                actualMaxC: metar.dailyMaxC,
                isWin:      positionWon,
                pnl:        pos.shares * exit - pos.costBasis,
                source:     "metar-preview",
              };
            }
          }
        } catch { /* preview best-effort */ }
        details.push({
          market: pos.market, city: meta.city, date: meta.date,
          bucketLabel: meta.bucketLabel, predictedMaxC: meta.predictedMaxC,
          status: "pending",
          reason: "Polymarket has not resolved yet, METAR fallback not eligible",
          tentative,
        });
        continue;
      }

      const station = getStation(meta.city);
      if (!station) {
        failed++;
        details.push({
          market: pos.market, city: meta.city, date: meta.date,
          bucketLabel: meta.bucketLabel, predictedMaxC: meta.predictedMaxC,
          status: "no-meta",
          reason: `Unknown city: ${meta.city}`,
        });
        continue;
      }

      const metar = await fetchMetarDailyMax(meta.stationIcao, meta.date, station.tz);
      if (!metar) {
        failed++;
        details.push({
          market: pos.market, city: meta.city, date: meta.date,
          bucketLabel: meta.bucketLabel, predictedMaxC: meta.predictedMaxC,
          status: "fetch-failed",
          reason: `Polymarket pending and METAR fetch failed for ${meta.stationIcao}`,
        });
        continue;
      }

      // Simulate Polymarket settlement: METAR-rounded daily max → which
      // bucket center matches?
      //
      // The matcher in bucket-matcher.mts integrates each bucket over
      // [mid-prev, mid-next] (≈ tempC ± 0.5°C for 1°C grids). The reconciler
      // must use the SAME boundary semantics or matcher and settlement will
      // disagree on values right at the edge.
      //
      // Bug we just fixed (2026-05-11): with tempC=21 for "21°C or below",
      // METAR=70°F gives settlementC=21.11°C — the matcher integrated
      // (-∞, 21.5] (assigning mass to the tail), but the reconciler tested
      // `settlementC <= 21` and would have NOT settled the bucket as won.
      // Now both use the ±0.5°C window so they agree.
      const f = metar.dailyMaxC * 9 / 5 + 32;
      const settlementC = parseFloat((((Math.round(f) - 32) * 5) / 9).toFixed(2));
      const isTailLow  = /\bor\s+below\b|\bor\s+lower\b/i.test(meta.bucketLabel);
      const isTailHigh = /\bor\s+(higher|above|more)\b/i.test(meta.bucketLabel);
      const bucketWon = isTailLow ? settlementC <= meta.bucketTempC + 0.5
                      : isTailHigh ? settlementC >= meta.bucketTempC - 0.5
                      : Math.abs(settlementC - meta.bucketTempC) < 0.5;
      const positionWon = pos.direction === "YES" ? bucketWon : !bucketWon;
      exitPrice = positionWon ? 1.0 : 0.0;
      source = "metar-fallback";
      actualMaxC = metar.dailyMaxC;
    }

    // ─── Close the position ───────────────────────────────────────────
    const proceeds = pos.shares * exitPrice;
    const pnl      = proceeds - pos.costBasis;
    const isWin    = exitPrice > 0.5;

    const trade: ClosedTrade = {
      market:     pos.market,
      direction:  pos.direction,
      entryPrice: pos.avgEntry,
      exitPrice,
      shares:     pos.shares,
      pnl,
      pnlPct:     (pnl / pos.costBasis) * 100,
      openedAt:   pos.openedAt,
      closedAt:   new Date().toISOString(),
      category:   "weather",
      predictedProb:      pos.predictedProb,
      marketPriceAtEntry: pos.marketPriceAtEntry,
      edgeAtEntry:        (pos.predictedProb !== undefined && pos.marketPriceAtEntry !== undefined)
        ? pos.predictedProb - pos.marketPriceAtEntry
        : undefined,
      // Propagate the per-trade signal snapshot so the live-readiness IC gate
      // can compute Pearson(forecast_edge, win/loss). Weather entries populate
      // `forecast_edge`; the other 8 signal slots stay null.
      signalBreakdown:    pos.entryDecision?.signalBreakdown ?? null,
    };

    session = closePosition(session, pos.buyOrderId, trade);
    settled++;

    log("TRADE_CLOSED", paperMode, {
      type:     "weather",
      market:   pos.market,
      city:     meta.city,
      bucket:   meta.bucketLabel,
      direction: pos.direction,
      source:   source!,
      predictedC: meta.predictedMaxC,
      actualC:    actualMaxC,
      exitPrice,
      isWin,
      pnl,
    });

    // Record DEB sample so the model-weight tuner gets per-city feedback on
    // which forecast model (GFS/ECMWF/NOAA) was closest to the actual
    // outcome. Two paths:
    //   - METAR-fallback already knows the precise dailyMaxC → record
    //     immediately.
    //   - Polymarket-primary doesn't ship the exact temperature, just which
    //     bucket won. Fire an opportunistic METAR fetch (best-effort, may
    //     fail or return null in which case DEB skips this sample).
    //
    // Before this fix (2026-05-11 round-4): DEB only learned from METAR
    // fallback ticks, which fire only when Polymarket hadn't settled within
    // 6h of endDate — i.e. ~1% of trades. So DEB effectively never updated
    // its weights from the bot's own paper history. Now it learns from
    // every settled trade.
    if (actualMaxC !== null) {
      try {
        await recordDebSample(
          meta.city, meta.date, actualMaxC,
          { gfs: meta.rawGfsMaxC, ecmwf: meta.rawEcmwfMaxC, noaa: meta.rawNoaaMaxC },
        );
      } catch { /* DEB is best-effort */ }
    } else if (source === "polymarket") {
      try {
        const station = getStation(meta.city);
        if (station) {
          const metar = await fetchMetarDailyMax(meta.stationIcao, meta.date, station.tz);
          if (metar && Number.isFinite(metar.dailyMaxC)) {
            await recordDebSample(
              meta.city, meta.date, metar.dailyMaxC,
              { gfs: meta.rawGfsMaxC, ecmwf: meta.rawEcmwfMaxC, noaa: meta.rawNoaaMaxC },
            );
          }
        }
      } catch { /* DEB is best-effort; POL settled trade is unaffected */ }
    }

    details.push({
      market: pos.market, city: meta.city, date: meta.date,
      bucketLabel: meta.bucketLabel, predictedMaxC: meta.predictedMaxC,
      source: source!,
      actualMaxC: actualMaxC ?? undefined,
      isWin,
      pnl: parseFloat(pnl.toFixed(2)),
      status: "settled",
    });
  }

  if (settled > 0) {
    await saveSession(session, "weather");
  }

  return {
    ok: true,
    scanned, ready, settled, failed,
    pendingTotal: session.openPositions.length,
    details,
  };
}

// Status helper: shape the open positions for the UI.
export async function getPendingPositions(paperMode: boolean = true) {
  const session = await loadSession(paperMode, DEFAULT_BANKROLL, "weather");
  const open = session.openPositions.filter(p => p.weatherMeta);
  if (open.length === 0) {
    return { count: 0, nextReconcileAt: null as string | null, positions: [] as any[] };
  }
  const sorted = [...open].sort((a, b) =>
    (a.weatherMeta!.reconcileAfter || "").localeCompare(b.weatherMeta!.reconcileAfter || ""),
  );
  return {
    count: open.length,
    nextReconcileAt: sorted[0].weatherMeta!.reconcileAfter,
    positions: sorted.map(p => ({
      market:         p.market,
      city:           p.weatherMeta!.city,
      date:           p.weatherMeta!.date,
      bucket:         p.weatherMeta!.bucketLabel,
      direction:      p.direction,
      size:           p.costBasis,
      predictedMaxC:  p.weatherMeta!.predictedMaxC,
      reconcileAfter: p.weatherMeta!.reconcileAfter,
      isReady:        Date.now() >= new Date(p.weatherMeta!.reconcileAfter).getTime(),
    })),
  };
}
