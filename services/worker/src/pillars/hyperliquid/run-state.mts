// Hyperliquid run-state — mirrors crypto/run-state.mts so the
// /trade/hyperliquid/ UI can show the same Scanning/Idle/cron/last-run pills
// the Weather and Crypto traders already have.
//
// The HL cron fires every 3 min via auto-trader-multi-cron, so the previous
// HL UI (no live indicator) made it look like nothing was happening between
// manual scans even though the bot was busy in the background.

import { getStore } from "@netlify/blobs";
import { HL_PAPER_SIM_VERSION } from "./config.mts";

const RUN_STORE = "hl-runtime";
const RUN_KEY   = "v1";

export interface HlRunState {
  startedAt:  string | null;
  lastRunAt:  string | null;
  lastResult: any | null;
  source:     "manual" | "cron" | null;
}

async function loadRunState(): Promise<HlRunState> {
  try {
    const raw = await getStore(RUN_STORE).get(RUN_KEY);
    if (raw) return JSON.parse(raw as string);
  } catch {}
  return { startedAt: null, lastRunAt: null, lastResult: null, source: null };
}

async function saveRunState(s: HlRunState): Promise<void> {
  try { await getStore(RUN_STORE).set(RUN_KEY, JSON.stringify(s)); } catch {}
}

export async function markHlRunStart(source: "manual" | "cron"): Promise<void> {
  const s = await loadRunState();
  await saveRunState({ ...s, startedAt: new Date().toISOString(), source });
}

export async function markHlRunFinish(result: any): Promise<void> {
  const s = await loadRunState();
  await saveRunState({
    startedAt: null,
    lastRunAt: new Date().toISOString(),
    lastResult: result,
    source: s.source,
  });
}

export async function getHlRunStatus(): Promise<{
  isRunning:  boolean;
  startedAt:  string | null;
  lastRunAt:  string | null;
  source:     "manual" | "cron" | null;
  ageSec:     number | null;
  lastResult: any | null;
}> {
  const s = await loadRunState();
  // Stale-running guard: 90s — same threshold as weather/crypto.
  let isRunning = false;
  if (s.startedAt) {
    const ageMs = Date.now() - new Date(s.startedAt).getTime();
    isRunning = ageMs < 90_000;
  }
  const ageSec = s.lastRunAt
    ? Math.floor((Date.now() - new Date(s.lastRunAt).getTime()) / 1000)
    : null;
  // Drop lastResult if it was captured under an older paper-sim version —
  // those results reference positions that loadHlSession() has since
  // archived, so surfacing them as the "current" run misleads the UI.
  let lastResult = s.lastResult;
  const snapshotSimV = lastResult?.session?.simVersion ?? null;
  if (typeof snapshotSimV === "number" && snapshotSimV < HL_PAPER_SIM_VERSION) {
    lastResult = null;
    try { await saveRunState({ ...s, lastResult: null }); } catch {}
  }
  return {
    isRunning,
    startedAt:  s.startedAt,
    lastRunAt:  s.lastRunAt,
    source:     s.source,
    ageSec,
    lastResult,
  };
}
