// Funding-Arb run-state — mirrors the directional HL bot's run-state.mts so
// the FundingArbPanel UI can show the same Scanning / Idle / cron / last-run
// status pills the other auto-traders already have. Without this the panel
// permanently displays "Idle / no runs yet" because getArbStatus didn't
// surface a runStatus payload.

import { getStore } from "@netlify/blobs";

const RUN_STORE = "hl-arb-runtime";
const RUN_KEY   = "v1";

export interface ArbRunState {
  startedAt:  string | null;
  lastRunAt:  string | null;
  lastResult: any | null;
  source:     "manual" | "cron" | null;
}

async function loadRunState(): Promise<ArbRunState> {
  try {
    const raw = await getStore(RUN_STORE).get(RUN_KEY);
    if (raw) return JSON.parse(raw as string);
  } catch {}
  return { startedAt: null, lastRunAt: null, lastResult: null, source: null };
}

async function saveRunState(s: ArbRunState): Promise<void> {
  try { await getStore(RUN_STORE).set(RUN_KEY, JSON.stringify(s)); } catch {}
}

export async function markArbRunStart(source: "manual" | "cron"): Promise<void> {
  const s = await loadRunState();
  await saveRunState({ ...s, startedAt: new Date().toISOString(), source });
}

export async function markArbRunFinish(result: any): Promise<void> {
  const s = await loadRunState();
  await saveRunState({
    startedAt:  null,
    lastRunAt:  new Date().toISOString(),
    lastResult: result,
    source:     s.source,
  });
}

export async function getArbRunStatus(): Promise<{
  isRunning:  boolean;
  startedAt:  string | null;
  lastRunAt:  string | null;
  source:     "manual" | "cron" | null;
  ageSec:     number | null;
  lastResult: any | null;
}> {
  const s = await loadRunState();
  // Stale-running guard: 90s — same threshold as the other run-states so
  // a crashed run doesn't leave the UI stuck on "Scanning..." forever.
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
