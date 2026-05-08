// Crypto auto-trader run-state — mirrors weather/index.mts:RunState so the
// /trade/crypto/ UI can show the same Scanning/Idle/cron/last-run pills.
//
// State lives in a dedicated Netlify Blobs store separate from the session
// store, so a stuck "running" flag never blocks a session reset and an old
// session reset never wipes the run-state.

import { getStore } from "@netlify/blobs";

const RUN_STORE = "crypto-runtime";
const RUN_KEY   = "v1";

export interface CryptoRunState {
  startedAt:  string | null;
  lastRunAt:  string | null;
  lastResult: any | null;
  source:     "manual" | "cron" | null;
}

async function loadRunState(): Promise<CryptoRunState> {
  try {
    const raw = await getStore(RUN_STORE).get(RUN_KEY);
    if (raw) return JSON.parse(raw as string);
  } catch {}
  return { startedAt: null, lastRunAt: null, lastResult: null, source: null };
}

async function saveRunState(s: CryptoRunState): Promise<void> {
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

export async function getCryptoRunStatus(): Promise<{
  isRunning:  boolean;
  startedAt:  string | null;
  lastRunAt:  string | null;
  source:     "manual" | "cron" | null;
  ageSec:     number | null;
  lastResult: any | null;
}> {
  const s = await loadRunState();
  // Stale-running guard: 90s matches weather's threshold. A run that takes
  // longer than that almost certainly crashed before clearing the flag.
  let isRunning = false;
  if (s.startedAt) {
    const ageMs = Date.now() - new Date(s.startedAt).getTime();
    isRunning = ageMs < 90_000;
  }
  const ageSec = s.lastRunAt
    ? Math.floor((Date.now() - new Date(s.lastRunAt).getTime()) / 1000)
    : null;
  return {
    isRunning,
    startedAt:  s.startedAt,
    lastRunAt:  s.lastRunAt,
    source:     s.source,
    ageSec,
    lastResult: s.lastResult,
  };
}
