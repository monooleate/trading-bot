// netlify/functions/auto-trader/shared/paper-never-stop.mts
//
// Paper-mode "never stop" safety valve (all-bot feature, 2026-09-01).
//
// When ON (default) AND the bot is running in PAPER mode, the automatic
// loss-based auto-stops are suppressed and an already-auto-stopped session is
// self-healed at the start of each cron tick, so a paper bot keeps gathering
// data without needing a manual `resume` API call. The knob is deliberately
// gated behind `paperMode`: in LIVE mode it is ignored entirely — real-money
// stops (session-loss-limit, consecutive-loss pause, calibration-noise) always
// fire regardless of this setting.
//
// Scope — "only auto-stops": a MANUAL operator stop (`stoppedReason` ==
// "Manual stop") is NEVER cleared by this valve, so the operator can still
// halt any bot by hand. Only the automatic reasons below are self-healed.
//
// Applies to the three bots that have an automatic stop: crypto + HL perp
// (session-loss-limit; HL also consecutive-loss pause) and sports (loss-limit,
// when enabled). Weather + funding-arb have no automatic stop at all (they
// only ever stop on an explicit manual halt), so the invariant already holds
// for them and there is nothing to self-heal.

export const PAPER_NEVER_STOP_DEFAULT = true;

// Whitelist of automatic stop reasons that the paper valve may clear. Manual
// stops ("Manual stop") are intentionally excluded so an operator halt sticks.
// Matched case-insensitively as substrings so wording variants (e.g. the
// sports "Session loss limit hit: -$…") are covered.
export function isAutoStopReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const r = String(reason).toLowerCase();
  return (
    r.includes("session loss limit") ||
    r.includes("calibration noise") ||
    r.includes("consecutive loss")
  );
}

// Reads the effective `paperNeverStop` toggle: Blobs override (0/1) wins,
// then the PAPER_NEVER_STOP env var, else the default (ON). Never throws — a
// settings outage falls back to the env/default so the runner keeps working.
export async function loadPaperNeverStop(): Promise<boolean> {
  const env = (process.env.PAPER_NEVER_STOP || "").toLowerCase();
  const envDefault =
    env === "false" || env === "0" ? false :
    env === "true"  || env === "1" ? true  :
    PAPER_NEVER_STOP_DEFAULT;
  try {
    const mod: any = await import("@api/routes/trader-settings.mts");
    const ov = await mod.loadRuntimeOverrides();
    if (typeof ov.paperNeverStop === "number") return ov.paperNeverStop >= 0.5;
    return envDefault;
  } catch {
    return envDefault;
  }
}
