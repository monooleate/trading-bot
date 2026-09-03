// netlify/functions/edge-tracker.mts
// GET /.netlify/functions/edge-tracker
//   ?mode=paper|live|both         (default: paper)
//   &category=all|crypto|weather  (default: all)
//   &days=7|30|90|all             (default: 30)
//   &mock=1                       (force mock data)
//
// Read-only: aggregates closed trades from auto-trader session state
// and returns statistics for the Edge Tracker UI.

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import type { ClosedTrade, SessionState } from "@core/types.mts";
import { generateMockTrades } from "./edge-tracker/mock-trades.mts";
import {
  computeSummary,
  computeCumulativePnl,
  computeCalibration,
  computeProperScores,
  computeSignalIC,
} from "@core/statistics.mts";
import { computeCalibrationEval } from "@core/calibration.mts";
import { computeOnlineWeightEval } from "@core/online-weights.mts";
import {
  computeCalibrationHealth,
  computeSignalCollinearity,
  computeEdgeDecay,
  computeWinRateHeatmap,
  computePnlDistribution,
} from "@core/statistics.mts";
import {
  loadCalibration as loadSignalCalibration,
  effectiveICs as computeEffectiveICs,
  type CalibrationCategory,
} from "@worker/pillars/shared/signal-calibration.mts";
import {
  loadLedger,
  computeLedgerStats,
  type LedgerStats,
} from "@core/prediction-ledger.mts";
import {
  computeWalkForward,
  ledgerPointsFromRecords,
  type WalkForwardResult,
} from "@core/walk-forward.mts";
import { correlationMatrix, effectiveNumberOfBets, type EnbResult } from "@core/enb.mts";
import { deflatedSharpe } from "@core/sharpe-robust.mts";
import { evaluatePromotionGate, type PromotionGateResult } from "@core/promotion-gate.mts";
import { computeConfigAttribution, type ConfigAttributionRow } from "@core/config-fingerprint.mts";
import { banditArmsFromRecords, thompsonRank, type ArmPosterior } from "@core/thompson.mts";

// Categories that write a prediction ledger (forecasting bots). Funding-arb
// is delta-neutral carry (not forecasting); sports is not yet wired.
const LEDGER_CATEGORIES = ["crypto", "weather", "hyperliquid", "sports"];

// Aggregate per-category ledger stats into one object (for category="all").
function aggregateLedgerStats(label: string, parts: LedgerStats[]): LedgerStats {
  const tss = parts.flatMap((p) => [p.oldestTs, p.newestTs]).filter(Boolean).sort() as string[];
  return {
    category: label,
    total: parts.reduce((s, p) => s + p.total, 0),
    resolved: parts.reduce((s, p) => s + p.resolved, 0),
    taken: parts.reduce((s, p) => s + p.taken, 0),
    skippedResolved: parts.reduce((s, p) => s + p.skippedResolved, 0),
    oldestTs: tss[0] ?? null,
    newestTs: tss[tss.length - 1] ?? null,
  };
}

// Static SIGNAL_ICS priors mirrored from signal-combiner.mts:29. Kept here
// so the Edge Tracker can render "Realized vs Prior" without an HTTP
// round-trip. If priors ever change in the combiner, update this map too
// (it's a 9-line block — minimal duplication risk).
const SIGNAL_ICS_PRIORS: Record<string, number> = {
  vol_divergence: 0.06,
  orderflow:      0.09,
  apex_consensus: 0.08,
  cond_prob:      0.07,
  funding_rate:   0.05,
  momentum:       0.06,
  contrarian:     0.05,
  pairs_spread:   0.07,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Each auto-trader category has its own Blobs store (so a stopped session
// in one venue does not block another). The Edge Tracker reads from all
// of them so closed trades surface uniformly in the per-venue UI.
interface StoreSpec {
  store: string;
  paperKey: string;
  liveKey: string;
  category: string;            // tag the trade if it lacks ClosedTrade.category
}

const STORE_SPECS: StoreSpec[] = [
  { store: "auto-trader-state",          paperKey: "auto-trader-session",                 liveKey: "auto-trader-session-live",                 category: "crypto" },
  { store: "auto-trader-state",          paperKey: "auto-trader-session-weather",         liveKey: "auto-trader-session-live-weather",         category: "weather" },
  { store: "hyperliquid-session-v1",     paperKey: "session_paper",                       liveKey: "session_live",                             category: "hyperliquid" },
  { store: "hyperliquid-arb-session-v1", paperKey: "arb_paper",                           liveKey: "arb_live",                                 category: "funding-arb" },
  { store: "auto-trader-session-sports", paperKey: "session_paper",                       liveKey: "session_live",                             category: "sports" },
];

// Legacy STORE_NAME / PAPER_KEYS / LIVE_KEYS kept here for code that still
// imports them; new logic should use STORE_SPECS.
const STORE_NAME = "auto-trader-state";
const PAPER_KEYS = ["auto-trader-session", "auto-trader-session-weather"];
const LIVE_KEYS = ["auto-trader-session-live", "auto-trader-session-live-weather"];

// Tier 1 Settings overrides loader (lazy import to avoid circular module
// init). Returns undefined fields when no override is set, so callers can
// `?? defaultValue` cleanly. Wraps any error in a safe fallback.
interface Tier1Overrides {
  bonferroniAlpha?: number;
  bonferroniGoodMultiplier?: number;
  collinearityHighThreshold?: number;
}
async function loadTier1Overrides(): Promise<Tier1Overrides> {
  try {
    const mod: any = await import("./trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    return {
      bonferroniAlpha:           ov.bonferroniAlpha,
      bonferroniGoodMultiplier:  ov.bonferroniGoodMultiplier,
      collinearityHighThreshold: ov.collinearityHighThreshold,
    };
  } catch {
    return {};
  }
}

// ─── Helpers ──────────────────────────────────────────────

interface SessionLike {
  closedTrades?: ClosedTrade[];
  positions?: any[];          // funding-arb shape uses positions[] with closedAt
}

// HL bot stores HlClosedTrade — different field names than the shared
// ClosedTrade shape. Without normalization t.pnl is undefined, all summary
// numbers go NaN→null in JSON, and the panel crashes on `null.toFixed()`.
// LONG/SHORT direction is preserved (not mapped to YES/NO) so the IC and
// calibration computations can stay venue-aware without losing the original
// trade side. pnlPct is stored as a ratio (-0.0352) in the HL bot but as a
// percent (-3.52) everywhere else — multiply by 100 to match.
function isHlClosedTrade(t: any): boolean {
  return t && typeof t === "object"
    && (typeof t.coin === "string"
        || typeof t.pnlUSDC === "number"
        || typeof t.sizeCoins === "number");
}

function normalizeHlClosedTrade(t: any): ClosedTrade {
  return {
    market:        String(t.coin ?? ""),
    direction:     t.direction as any,            // "LONG" | "SHORT" — handled downstream
    entryPrice:    Number(t.entryPrice ?? 0),
    exitPrice:     Number(t.exitPrice ?? 0),
    shares:        Number(t.sizeCoins ?? 0),
    pnl:           Number(t.pnlUSDC ?? 0),
    pnlPct:        Number(t.pnlPct ?? 0) * 100,
    openedAt:      t.openedAt,
    closedAt:      t.closedAt,
    category:      "hyperliquid" as any,
    predictedProb: t.predictedProb,
    edgeAtEntry:   t.edgeAtEntry,
    signalBreakdown: t.signalBreakdown,
  };
}

function tradesFromSession(s: SessionLike, fallbackCategory: string): ClosedTrade[] {
  const out: ClosedTrade[] = [];
  // Standard SessionState shape
  if (Array.isArray(s.closedTrades)) {
    for (const t of s.closedTrades as any[]) {
      if (isHlClosedTrade(t)) {
        out.push(normalizeHlClosedTrade(t));
      } else {
        out.push({ ...t, category: t.category ?? (fallbackCategory as any) });
      }
    }
  }
  // Funding-arb session shape: positions[] with optional closedAt.
  // Field names must match the actual ArbPosition shape
  // (funding-arb/types.mts): hlEntryPrice / sizeCoins / sizeUSDC /
  // closeFundingNet / direction("forward"|"reverse") / entrySpread.
  // 2026-06-06 fix: this branch previously read a guessed shape
  // (hlAvgPrice / hlSize / realizedPnl / hlSide) that ArbPosition never had,
  // so every closed F-Arb trade rendered as all-zeros in the Edge Tracker
  // even though the positions carried real size + funding PnL. The PnL
  // figure is the funding-only net after fees (price legs are delta-neutral,
  // so there is no meaningful entry/exit price PnL — exitPrice stays 0).
  // Direction: forward = HL-short leg → "NO"; reverse = HL-long → "YES",
  // mirroring the closed-trade projection in funding-arb/index.mts.
  if (Array.isArray(s.positions)) {
    for (const p of s.positions as any[]) {
      if (!p?.closedAt) continue;
      const sizeUSDC = Number(p.sizeUSDC ?? 0);
      const fundingNet = Number(p.closeFundingNet ?? p.realizedPnl ?? p.realizedPnL ?? 0);
      out.push({
        market:               p.coin || p.symbol || "funding-arb",
        direction:            p.direction === "reverse" ? "YES" : "NO",
        entryPrice:           p.hlEntryPrice ?? 0,
        exitPrice:            0,
        shares:               p.sizeCoins ?? 0,
        pnl:                  fundingNet,
        pnlPct:               sizeUSDC > 0 ? (fundingNet / sizeUSDC) * 100 : 0,
        openedAt:             p.openedAt || new Date().toISOString(),
        closedAt:             p.closedAt,
        category:             "funding-arb" as any,
        marketPriceAtEntry:   p.entrySpread,
        edgeAtEntry:          p.entrySpread ?? 0,
      });
    }
  }
  return out;
}

async function loadTradesFromStore(storeName: string, key: string, fallbackCategory: string): Promise<ClosedTrade[]> {
  try {
    const store = getStore(storeName);
    const raw = await store.get(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw as string);
    return tradesFromSession(parsed, fallbackCategory);
  } catch { return []; }
}

async function loadAllPaperTrades(): Promise<ClosedTrade[]> {
  const lists = await Promise.all(
    STORE_SPECS.map((s) => loadTradesFromStore(s.store, s.paperKey, s.category)),
  );
  return lists.flat();
}

async function loadAllLiveTrades(): Promise<ClosedTrade[]> {
  const lists = await Promise.all(
    STORE_SPECS.map((s) => loadTradesFromStore(s.store, s.liveKey, s.category)),
  );
  return lists.flat();
}

// Per-category starting bankroll, read from the same session blob the trades
// come from. computeSummary needs it as the denominator for totalPnlPct /
// maxDrawdownPct / kellyUsed / kellyEfficiency — it previously defaulted to a
// hardcoded $150, so every percentage/Kelly stat was wrong for the $200–$450
// bots (e.g. a −$285 sports loss on a $450 start was shown as −190% instead of
// −63%). (Post-2026-07 profitability audit.)
async function loadBankrollStart(storeName: string, key: string): Promise<number | null> {
  try {
    const store = getStore(storeName);
    const raw = await store.get(key);
    if (!raw) return null;
    const s: any = JSON.parse(raw as string);
    return typeof s.bankrollStart === "number" && Number.isFinite(s.bankrollStart) && s.bankrollStart > 0
      ? s.bankrollStart
      : null;
  } catch { return null; }
}

// Resolve the denominator for computeSummary. A single category → its own
// session start; "all" → the sum across every bot's start (matches the
// home-page totals). Returns undefined when unknown, so the caller falls back
// to computeSummary's own default rather than a wrong number.
async function resolveBankrollStart(category: string, mode: string): Promise<number | undefined> {
  const useLive = mode === "live";
  const specs = category === "all"
    ? STORE_SPECS
    : STORE_SPECS.filter((s) => s.category === category);
  if (specs.length === 0) return undefined;
  const starts = await Promise.all(
    specs.map((s) => loadBankrollStart(s.store, useLive ? s.liveKey : s.paperKey)),
  );
  const valid = starts.filter((n): n is number => typeof n === "number" && n > 0);
  if (valid.length === 0) return undefined;
  return valid.reduce((a, b) => a + b, 0);
}

// Legacy helper retained so older imports compile; routes via STORE_SPECS.
async function loadTrades(keys: string[]): Promise<ClosedTrade[]> {
  const matches = STORE_SPECS.filter((s) => keys.includes(s.paperKey) || keys.includes(s.liveKey));
  const lists: ClosedTrade[][] = [];
  for (const s of matches) {
    if (keys.includes(s.paperKey)) lists.push(await loadTradesFromStore(s.store, s.paperKey, s.category));
    if (keys.includes(s.liveKey))  lists.push(await loadTradesFromStore(s.store, s.liveKey,  s.category));
  }
  return lists.flat();
}

function filterByCategory(trades: ClosedTrade[], category: string): ClosedTrade[] {
  if (category === "all") return trades;
  return trades.filter((t) => (t.category ?? "crypto") === category);
}

function filterByDays(trades: ClosedTrade[], days: string): ClosedTrade[] {
  if (days === "all") return trades;
  const n = parseInt(days, 10);
  if (!Number.isFinite(n) || n <= 0) return trades;
  const cutoff = Date.now() - n * 24 * 60 * 60 * 1000;
  return trades.filter((t) => new Date(t.closedAt).getTime() >= cutoff);
}

// ─── Main handler ─────────────────────────────────────────

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "paper";
  const category = url.searchParams.get("category") ?? "all";
  // Default to ALL-TIME. The old 30-day default silently truncated the headline
  // totalPnl so the operator saw only the trailing slice (e.g. sports −$47 vs
  // the real −$285), diverging from the bankroll delta. Windowing is opt-in via
  // &days=7|30|90. (Post-2026-07 profitability audit.)
  const days = url.searchParams.get("days") ?? "all";
  const forceMock = url.searchParams.get("mock") === "1";

  try {
    // 1. Load trades from storage (or mock)
    let trades: ClosedTrade[] = [];
    let isMock = false;

    if (!forceMock) {
      if (mode === "paper" || mode === "both") {
        trades = trades.concat(await loadAllPaperTrades());
      }
      if (mode === "live" || mode === "both") {
        trades = trades.concat(await loadAllLiveTrades());
      }
    }

    // 2. Fall back to mock if empty or forced
    if (forceMock || trades.length === 0) {
      trades = generateMockTrades(100);
      isMock = true;
    }

    // 3. Sort chronologically
    trades.sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());

    // Snapshot the unfiltered, all-category list (already loaded per `mode`)
    // before category/day filtering — the cross-bot ENB card reuses it instead
    // of re-loading every store, and it honours `mode` for free (audit P2).
    const unfilteredTrades = trades.slice();

    // 4. Apply filters (after mock fallback so filter works on mock too)
    trades = filterByCategory(trades, category);
    trades = filterByDays(trades, days);

    // 5. Compute statistics (all pure functions, run in parallel would be overkill)
    // Thread the real per-category starting bankroll into the summary so the
    // percentage/Kelly stats are correct (not scaled to a phantom $150). Skip
    // for mock data (no real session to key off). (Post-2026-07 audit.)
    const bankrollStart = isMock ? undefined : await resolveBankrollStart(category, mode);
    const summary = bankrollStart !== undefined
      ? computeSummary(trades, bankrollStart)
      : computeSummary(trades);
    const cumulativePnl = computeCumulativePnl(trades);
    const calibration = computeCalibration(trades);
    // Proper-scoring harness (model-discovery §7 #1): log-score + Brier-Murphy
    // decomposition + reliability-diagram bins. Scores the forecast itself so
    // combiner/calibration changes can be judged on a strictly-proper metric
    // instead of noisy PnL.
    const properScores = computeProperScores(trades);
    // Post-hoc calibration eval (model-discovery §7 #2, measurement only):
    // walk-forward raw-vs-calibrated Brier/log-score — tells the operator
    // whether a Platt calibrator WOULD help, with NO live behaviour change.
    const calibrationEval = computeCalibrationEval(trades);
    // Online adaptive weighting eval (model-discovery §7 #4, measurement only):
    // walk-forward AdaHedge vs static-IC signal weighting — tells the operator
    // whether adaptive reweighting WOULD lower Brier, with NO live change.
    const onlineWeightsEval = computeOnlineWeightEval(trades);

    // Prediction-ledger stats (model-discovery §2): show the unbiased dataset
    // growing — total logged, resolved, and crucially skipped-resolved (the
    // markets the bot did NOT take but we still labeled). Skipped for mock.
    let ledgerStats: LedgerStats | null = null;
    // B49 #4: walk-forward scoring over the ledger — model P(YES) vs the market
    // baseline, per chronological block. Reuses the records loaded for stats.
    let walkForward: WalkForwardResult | null = null;
    // B50 #4: per-config forecast-quality A/B from the config-fingerprint stamped
    // on each ledger record. Groups resolved predictions by config → Brier skill.
    let configAttribution: ConfigAttributionRow[] | null = null;
    // B50 #6: discounted Thompson-sampling ranking over the ledger's configs —
    // which config's forecast is probably best (posterior + prob-best), recency-
    // discounted (#8 forgetting factor). Measurement-only: the bandit PROPOSES.
    let banditEval: ArmPosterior[] | null = null;
    if (!isMock) {
      try {
        const cats = category === "all"
          ? LEDGER_CATEGORIES
          : (LEDGER_CATEGORIES.includes(category) ? [category] : []);
        if (cats.length > 0) {
          const loaded = await Promise.all(
            cats.map((c) => loadLedger(c).then((recs) => ({ c, recs }))),
          );
          const parts = loaded.map(({ c, recs }) => computeLedgerStats(c, recs));
          ledgerStats = cats.length === 1 ? parts[0] : aggregateLedgerStats("all", parts);
          const allRecs = loaded.flatMap(({ recs }) => recs);
          walkForward = computeWalkForward(ledgerPointsFromRecords(allRecs), { blockCount: 5 });
          const attr = computeConfigAttribution(allRecs as any[]);
          configAttribution = attr.length > 0 ? attr : null;
          // #8: unify the forgetting half-life with the icHalfLifeTrades knob
          // (>0), else a sensible default of 75 resolved predictions.
          let halfLifeSteps = 75;
          try {
            const ov: any = await (await import("./trader-settings.mts")).loadRuntimeOverrides();
            if (typeof ov?.icHalfLifeTrades === "number" && ov.icHalfLifeTrades > 0) halfLifeSteps = ov.icHalfLifeTrades;
          } catch { /* default */ }
          const arms = banditArmsFromRecords(allRecs as any[]);
          const ranked = thompsonRank(arms, { halfLifeSteps, samples: 3000 });
          banditEval = ranked.length > 0 ? ranked : null;
        }
      } catch { ledgerStats = null; walkForward = null; configAttribution = null; banditEval = null; }
    }

    // B50 #1: promotion gate — collapse the scattered advisory metrics (proper
    // scores, walk-forward Brier-skill vs market, PSR/MinTRL/DSR) into ONE
    // pre-registered PROMOTE / HOLD / INSUFFICIENT_DATA verdict, judged PRIMARILY
    // on proper score (calibration + beats-the-market OOS) with the Sharpe/DSR
    // side as secondary confirmation. Measurement-only — NO live behaviour change;
    // it makes the "is this config promotable?" bar explicit instead of eyeballed
    // PnL. Reuses summary/properScores/walkForward already computed above.
    let promotionGate: PromotionGateResult | null = null;
    try {
      // B50 #3: deflate by the EFFECTIVE (clustered) trial count — near-duplicate
      // knob tweaks collapse, so the DSR benchmark reflects the trials the config
      // search actually explored, not the raw log length.
      const { effective: nTrials } = await (await import("./trader-settings.mts")).effectiveTrials();
      // σ_SR proxy from the bootstrap CI half-width (same approach live-readiness
      // uses); deflatedSharpe falls back internally if this collapses to 0.
      const sdProxy = (summary.sharpeCiHi - summary.sharpeCiLo) / (2 * 1.959963985);
      const dsr = deflatedSharpe(
        summary.sharpeRatio, summary.totalTrades,
        summary.returnSkew, summary.returnKurtosis, nTrials, sdProxy,
      );
      promotionGate = evaluatePromotionGate({
        scoredN:         properScores.n,
        brierSkillScore: properScores.brierSkillScore,
        logSkillScore:   properScores.logSkillScore,
        wfBrierSkill:    walkForward?.overall.brierSkill ?? NaN,
        wfConsistency:   walkForward?.consistency ?? 0,
        wfMaxDayShare:   walkForward?.maxDayShare ?? 1,
        wfNResolved:     walkForward?.nResolved ?? 0,
        psr:             summary.psr,
        dsr:             Number.isFinite(dsr) ? dsr : 0,
        minTrl:          summary.minTrl >= 999999 ? Infinity : summary.minTrl,
        tradeN:          summary.totalTrades,
        nTrials,
      });
    } catch { promotionGate = null; }

    // B49 #9: Effective Number of Bets across ALL bots (measurement-only). Build
    // per-bot daily-PnL series aligned to a common date union, correlate, ENB.
    // Reveals whether the 6 bots are really independent edges or ~2-3 crypto-beta.
    let enb: (EnbResult & { labels?: string[] }) | null = null;
    if (!isMock) {
      try {
        // Group the already-loaded (mode-aware) trades by bot — no extra store
        // reads, and consistent with the summary's paper/live/both selection.
        const byCat = new Map<string, ClosedTrade[]>();
        for (const s of STORE_SPECS) byCat.set(s.category, []);
        for (const t of unfilteredTrades) {
          const c = t.category ?? "unknown";
          if (byCat.has(c)) byCat.get(c)!.push(t);
        }
        const perBot = [...byCat.entries()].map(([cat, ts]) => ({ cat, ts }));
        const dayKey = (iso?: string) => (iso || "").slice(0, 10);
        const dateSet = new Set<string>();
        for (const b of perBot) for (const t of b.ts) { const d = dayKey(t.closedAt); if (d) dateSet.add(d); }
        const dates = [...dateSet].sort();
        if (dates.length >= 2) {
          const idx = new Map(dates.map((d, i) => [d, i]));
          const active = perBot
            .map((b) => {
              const v = new Array(dates.length).fill(0);
              for (const t of b.ts) { const i = idx.get(dayKey(t.closedAt)); if (i != null) v[i] += (t.pnl || 0); }
              return { cat: b.cat, v };
            })
            .filter((x) => x.v.some((y) => y !== 0));
          if (active.length >= 2) {
            enb = { ...effectiveNumberOfBets(correlationMatrix(active.map((a) => a.v))), labels: active.map((a) => a.cat) };
          }
        }
      } catch { enb = null; }
    }
    // Load Tier 1 Settings overrides (Bonferroni + collinearity threshold).
    // Defaults preserve the original Tier 1 hardcoded behaviour.
    const tier1Overrides = await loadTier1Overrides();

    const signalIC = computeSignalIC(trades);
    const calibrationHealth = computeCalibrationHealth(trades, 30, {
      bonferroniAlpha:          tier1Overrides.bonferroniAlpha,
      bonferroniGoodMultiplier: tier1Overrides.bonferroniGoodMultiplier,
    });
    const collinearity = computeSignalCollinearity(trades, 20, tier1Overrides.collinearityHighThreshold);
    const edgeDecay = computeEdgeDecay(trades);
    const heatmap = computeWinRateHeatmap(trades);
    const distribution = computePnlDistribution(trades);

    // 6. Last 50 trades for the table (newest first)
    const recentTrades = trades
      .slice(-50)
      .reverse()
      .map((t) => ({
        closedAt: t.closedAt,
        openedAt: t.openedAt,
        category: t.category ?? "unknown",
        market: t.market,
        direction: t.direction,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        shares: t.shares,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        edgeAtEntry: t.edgeAtEntry ?? 0,
        predictedProb: t.predictedProb ?? 0,
      }));

    // 7. Signal IC calibration view (crypto + hyperliquid only).
    // Surfaces the persisted realized IC alongside priors and the
    // shrinkage-blended effective IC, plus whether `useRealizedIC` is
    // active. Used by the EdgeTrackerPanel "Calibrated vs Prior IC"
    // card so the operator can decide whether to flip the toggle on.
    let calibrationView: any = null;
    if (category === "crypto" || category === "hyperliquid") {
      try {
        const record = await loadSignalCalibration(category as CalibrationCategory);
        const settings: any = await import("./trader-settings.mts");
        const ov = await settings.loadRuntimeOverrides();
        const k = typeof ov.calibrationShrinkageK === "number" ? ov.calibrationShrinkageK : 30;
        const useRealizedIC = ov.useRealizedIC === 1;
        const effective = record
          ? computeEffectiveICs(SIGNAL_ICS_PRIORS, record, k)
          : { ...SIGNAL_ICS_PRIORS };
        calibrationView = {
          category,
          useRealizedIC,
          shrinkageK: k,
          computedAt: record?.computedAt ?? null,
          sampleSize: record?.sampleSize ?? 0,
          priors:     SIGNAL_ICS_PRIORS,
          realized:   record?.perSignal ?? {},
          effective,
        };
      } catch { /* no calibration data — leave null */ }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        fetchedAt: new Date().toISOString(),
        filters: { mode, category, days },
        isMock,
        summary,
        cumulativePnl,
        calibration,
        properScores,
        promotionGate,
        calibrationEval,
        onlineWeightsEval,
        ledgerStats,
        walkForward,
        configAttribution,
        banditEval,
        enb,
        signalIC,
        calibrationHealth,
        collinearity,
        edgeDecay,
        heatmap,
        distribution,
        trades: recentTrades,
        calibrationView,
      }),
      { status: 200, headers: CORS },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: CORS },
    );
  }
}
