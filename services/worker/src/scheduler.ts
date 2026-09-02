// services/worker/src/scheduler.ts
//
// Replaces the Netlify cron. Runs `tick` immediately, then every
// intervalMs. Overlap-guarded (a slow tick never stacks). No external cron —
// the container's own loop drives the pillars (hetzner-docker-setup §10).

export interface SchedulerHandle { stop(): void }

export function startScheduler(tick: () => Promise<void>, intervalMs: number): SchedulerHandle {
  let running = false;
  let stopped = false;

  const runGuarded = async () => {
    if (running || stopped) return;
    running = true;
    try { await tick(); }
    catch (e) { console.error("[scheduler] tick failed:", e); }
    finally { running = false; }
  };

  // immediate first tick, then interval
  void runGuarded();
  const timer = setInterval(runGuarded, intervalMs);

  return {
    stop() { stopped = true; clearInterval(timer); },
  };
}
