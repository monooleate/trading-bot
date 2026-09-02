// services/worker/src/scheduler.ts
//
// Replaces the Netlify cron. Runs `tick` immediately, then every
// intervalMs. Overlap-guarded (a slow tick never stacks). No external cron —
// the container's own loop drives the pillars (hetzner-docker-setup §10).

export interface SchedulerHandle {
  /** Stop scheduling and await the in-flight tick (bounded by the caller). */
  stop(): Promise<void>;
}

export function startScheduler(tick: () => Promise<void>, intervalMs: number): SchedulerHandle {
  let running = false;
  let stopped = false;
  let current: Promise<void> | null = null;

  const runGuarded = async () => {
    if (running || stopped) return;
    running = true;
    current = (async () => {
      try { await tick(); }
      catch (e) { console.error("[scheduler] tick failed:", e); }
      finally { running = false; current = null; }
    })();
    await current;
  };

  // immediate first tick, then interval
  void runGuarded();
  const timer = setInterval(runGuarded, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Let an in-flight tick finish (avoids a killed mid-tick save on redeploy).
      if (current) { try { await current; } catch { /* already logged */ } }
    },
  };
}
