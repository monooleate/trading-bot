// netlify/functions/auto-trader/hyperliquid/decision-engine.mts
// Final-stage decision gates for Hyperliquid entries.
// Short-circuits as soon as any gate rejects, so the reason string reflects
// the first failure rather than a compound condition.

import { getStore } from "@netlify/blobs";
import type { HlSessionState, HlTraderConfig, HlCoin } from "./types.mts";
import type { HlSignalResult } from "./signal-source.mts";

// Per-coin cooldown.
//
// Two layers — Blobs (durable across cold starts) merged with an in-memory
// cache (avoid round-tripping every read). Netlify functions are short-
// lived: a cron tick may land on a fresh container with empty memory, so
// the previous purely-in-memory map silently lost the no-revenge-trade
// guard between ticks. Now `setCooldown(coin, sec)` writes both layers,
// and `isOnCooldown(coin)` reads memory first and falls back to Blobs.
const STORE_NAME = "hyperliquid-runtime";
const KEY        = "cooldowns-v1";

const memCooldown = new Map<HlCoin, number>();
let blobLoadedAt = 0;
const BLOB_RELOAD_MS = 30_000; // refresh once per 30s, well below the 3min tick

async function loadCooldownsFromBlob(): Promise<void> {
  if (Date.now() - blobLoadedAt < BLOB_RELOAD_MS) return;
  try {
    const raw = await getStore(STORE_NAME).get(KEY);
    if (raw) {
      const parsed = JSON.parse(raw as string) as Record<string, number>;
      for (const [coin, until] of Object.entries(parsed)) {
        if (Number.isFinite(until) && until > Date.now()) {
          // Only the Blobs entry wins for entries the in-memory map
          // doesn't know about; existing in-memory entries (set during
          // this run) take precedence.
          if (!memCooldown.has(coin as HlCoin)) memCooldown.set(coin as HlCoin, until);
        }
      }
    }
    blobLoadedAt = Date.now();
  } catch {
    // best-effort — fail open (in-memory only)
  }
}

async function persistCooldowns(): Promise<void> {
  try {
    const obj: Record<string, number> = {};
    const now = Date.now();
    for (const [coin, until] of memCooldown.entries()) {
      // Drop expired entries before persisting so the blob doesn't grow.
      if (until > now) obj[coin] = until;
    }
    await getStore(STORE_NAME).set(KEY, JSON.stringify(obj));
  } catch {
    // best-effort — the in-memory copy still serves the rest of the run
  }
}

export async function setCooldown(coin: HlCoin, seconds: number): Promise<void> {
  memCooldown.set(coin, Date.now() + seconds * 1000);
  await persistCooldowns();
}

export async function isOnCooldown(coin: HlCoin): Promise<boolean> {
  const until = memCooldown.get(coin);
  if (until && until > Date.now()) return true;
  // Memory miss → consult Blobs once (cached for 30s).
  await loadCooldownsFromBlob();
  const fresh = memCooldown.get(coin);
  return !!(fresh && fresh > Date.now());
}

export async function clearAllCooldowns(): Promise<void> {
  memCooldown.clear();
  await persistCooldowns();
}

export interface HlDecision {
  shouldTrade: boolean;
  reason:      string;
  edge:        number;
  threshold:   number;
}

export function makeHlDecision(
  signal:  HlSignalResult,
  session: HlSessionState,
  config:  HlTraderConfig,
): HlDecision {
  const threshold = config.paperMode
    ? config.edgeThresholdPaper
    : config.edgeThresholdLive;

  // Session-level gates
  if (session.stopped) {
    return { shouldTrade: false, reason: `Session stopped: ${session.stoppedReason}`, edge: signal.edge, threshold };
  }
  if (session.pausedUntil && new Date(session.pausedUntil).getTime() > Date.now()) {
    return { shouldTrade: false, reason: `Paused until ${session.pausedUntil}`, edge: signal.edge, threshold };
  }
  if (session.sessionLoss >= config.sessionLossLimit) {
    return { shouldTrade: false, reason: `Session loss limit reached ($${config.sessionLossLimit})`, edge: signal.edge, threshold };
  }
  if (session.openPositions.length >= config.maxOpenPositions) {
    return { shouldTrade: false, reason: `Max open positions (${config.maxOpenPositions}) reached`, edge: signal.edge, threshold };
  }
  if (session.consecutiveLosses >= config.consecutiveLossLimit) {
    return { shouldTrade: false, reason: `${config.consecutiveLossLimit} consecutive losses — pause required`, edge: signal.edge, threshold };
  }

  // Coin-level gates.
  //
  // NOTE: cooldown is checked by the caller (`runHyperliquidTraderInner`)
  // before reaching this function. We don't re-check here because the
  // cooldown read is async (Blobs-backed) and `makeHlDecision` stays sync
  // for ergonomics — the entryDecision-snapshot builder needs synchronous
  // access to its result.
  if (session.openPositions.some(p => p.coin === signal.coin)) {
    return { shouldTrade: false, reason: `Already have open ${signal.coin} position`, edge: signal.edge, threshold };
  }

  // Signal-quality gates (Settings-tunable since 2026-05-12 via
  // hlMinActiveSignals; was hardcoded 3, label said "/5" but the combiner
  // emits 8 signals).
  const minActive = config.minActiveSignals ?? 3;
  if (signal.activeSignals < minActive) {
    return { shouldTrade: false, reason: `Only ${signal.activeSignals}/8 signals active (min ${minActive})`, edge: signal.edge, threshold };
  }
  if (signal.resolutionCategory === "SKIP") {
    return { shouldTrade: false, reason: "Underlying market resolution risk = SKIP", edge: signal.edge, threshold };
  }

  // Edge gate (fee-aware)
  const netEdge = signal.edge - config.roundtripFeePct;
  if (netEdge < threshold) {
    return {
      shouldTrade: false,
      reason: `Net edge ${(netEdge * 100).toFixed(1)}% < ${(threshold * 100).toFixed(1)}% threshold`,
      edge: netEdge,
      threshold,
    };
  }

  return { shouldTrade: true, reason: "all gates passed", edge: netEdge, threshold };
}
