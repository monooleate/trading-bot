// netlify/functions/auto-trader/sports/run-state.mts
//
// Run-state Blobs store for the sports bot UI status pill
// (Scanning / Idle / cron / last-run timestamp). Mirrors crypto/run-state.

import { getStore } from "@netlify/blobs";
import { SPORTS_SIM_VERSION } from "./config.mts";

const RUN_STORE = "sports-runtime";
const RUN_KEY   = "v1";

interface RunState {
  startedAt:  string | null;
  lastRunAt:  string | null;
  lastResult: any | null;
  source:     "manual" | "cron" | null;
}

async function loadRunState(): Promise<RunState> {
  try {
    const raw = await getStore(RUN_STORE).get(RUN_KEY);
    if (raw) return JSON.parse(raw as string);
  } catch {}
  return { startedAt: null, lastRunAt: null, lastResult: null, source: null };
}

async function saveRunState(s: RunState): Promise<void> {
  try { await getStore(RUN_STORE).set(RUN_KEY, JSON.stringify(s)); } catch {}
}

export async function markRunStart(source: "manual" | "cron"): Promise<void> {
  const s = await loadRunState();
  await saveRunState({ ...s, startedAt: new Date().toISOString(), source });
}

export async function markRunFinish(result: any): Promise<void> {
  const s = await loadRunState();
  await saveRunState({
    startedAt: null,
    lastRunAt: new Date().toISOString(),
    lastResult: result,
    source: s.source,
  });
}

export async function getSportsRunStatus(): Promise<{
  isRunning:  boolean;
  startedAt:  string | null;
  lastRunAt:  string | null;
  source:     "manual" | "cron" | null;
  ageSec:     number | null;
  lastResult: any | null;
}> {
  const s = await loadRunState();
  let isRunning = false;
  if (s.startedAt) {
    const ageMs = Date.now() - new Date(s.startedAt).getTime();
    isRunning = ageMs < 90_000;
  }
  const ageSec = s.lastRunAt
    ? Math.floor((Date.now() - new Date(s.lastRunAt).getTime()) / 1000)
    : null;
  // Drop stale result on simVersion bump.
  let lastResult = s.lastResult;
  const snapshotSimV = lastResult?.session?.simVersion ?? null;
  if (typeof snapshotSimV === "number" && snapshotSimV < SPORTS_SIM_VERSION) {
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
