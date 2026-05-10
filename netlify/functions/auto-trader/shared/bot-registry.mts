// netlify/functions/auto-trader/shared/bot-registry.mts
//
// Bot Registry — a single source of truth for every category-bot the
// auto-trader knows about. Each bot registers a thin adapter
// (`BotDefinition`) that maps the generic action dispatcher
// (run/status/reset/stop/resume/reconcile) to its concrete implementation.
//
// ──────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ──────────────────────────────────────────────────────────────────────
// Pre-registry the `index.mts` dispatcher had 4 hard-coded switch-case
// blocks, one per bot. Adding a new bot (Sports, Politics, Macro) meant
// editing 5-7 different files plus the frontend `CategoryDashboard`.
//
// The registry is **additive**:
//   1. The 4 existing bots register themselves via thin adapters.
//   2. The dispatcher tries the registry FIRST; if no match, it falls
//      back to the legacy switch-case (no breaking change).
//   3. New bots use the registry-native pattern from day one.
//   4. Frontend `multi-status` and `CategoryDashboard` can iterate the
//      registry instead of hard-coding category lists.
//
// Each bot is its own folder under `auto-trader/<category>/` and exports
// a `botDefinition` of type `BotDefinition`. The registry imports them.

import type { Category } from "./types.mts";

// ─── Base session shape every bot shares ──────────────────────────────
// Bot-specific session types extend this; the dispatcher only needs the
// common fields below to serve the UI's 4-cell stats grid (Bankroll /
// PnL / Trades / Open).
export interface BotSessionBase {
  startedAt:        string;
  paperMode:        boolean;
  stopped:          boolean;
  stoppedReason:    string | null;
  bankrollStart:    number;
  bankrollCurrent:  number;
  sessionPnL:       number;
  tradeCount:       number;        // closed trades count
  openPositions:    number;        // current open count
  // Optional — only bots that bump simVersion semantics (crypto v3,
  // weather v3, HL v2) populate this. Used by run-state to invalidate
  // stale UI snapshots.
  simVersion?:      number;
}

// ─── Result types every action returns ────────────────────────────────

export interface BotRunResult {
  ok: boolean;
  category: Category;
  action: "run";
  paperMode: boolean;
  source: "manual" | "cron";
  // Bot-specific extras (results, opportunities, scanned counts, …)
  [k: string]: unknown;
}

export interface BotStatusResponse {
  ok: true;
  action: "status";
  category: Category;
  session: BotSessionBase & Record<string, unknown>;  // bot-extended summary
  runStatus?: unknown;
  cronEnabled?: boolean;
  liveReadiness?: unknown;
  recentLogs?: string[];
  [k: string]: unknown;
}

// ─── BotDefinition contract ──────────────────────────────────────────
// Every category bot exports one of these. Layers (HL directional vs
// HL funding-arb) register as separate BotDefinitions with different
// category strings (`"hyperliquid"` + `"funding-arb"`) — keeps the
// dispatcher uniform.

export interface BotDefinition {
  /** Stable category identifier — must match Category type + URL routes. */
  category: Category | "funding-arb";

  /** Human-readable label for UI + logs. */
  label: string;

  /** Short subtitle for the bot's Tab 1 header (TraderShell subtitle). */
  subtitle?: string;

  /** Venue label for the HomePage execution card chip. */
  venue?: string;

  /**
   * Main scan/decide/execute loop.
   * @param ctx.source - "manual" (user click) vs "cron" (scheduled tick)
   * @param ctx.bodyOverride - rare: any-shape overrides from POST body
   * @param ctx.bankrollOverride - user's bankroll input value, applied
   *        if the bot's session is fresh (just archived or never existed).
   *        After the session exists, bankrollOverride is ignored on run
   *        — use Reset to change a live session's bankroll.
   */
  run(ctx: {
    source: "manual" | "cron";
    bodyOverride?: unknown;
    bankrollOverride?: number;
  }): Promise<unknown>;

  /** Status snapshot for the UI. Must include `session: BotSessionBase` at minimum. */
  getStatus(): Promise<BotStatusResponse | unknown>;

  /**
   * Reset session. The optional bankrollOverride is the new starting
   * bankroll the user sets in the UI before confirming the Reset dialog.
   */
  reset(bankrollOverride?: number): Promise<unknown>;

  /** Stop session — sets `stopped: true` until resume(). */
  stop(): Promise<unknown>;

  /** Resume from a stopped state. */
  resume(): Promise<unknown>;

  /**
   * Optional manual reconcile — force a settlement pass without waiting
   * for the next cron tick. Only bots with deferred settlement (weather,
   * crypto) implement this.
   */
  reconcile?(): Promise<unknown>;

  /**
   * Optional: tell the frontend which TraderShell features to enable.
   * Lets new bots reuse the shell without writing custom UI logic.
   */
  ui?: {
    showLiveReadiness?:  boolean;   // default true
    showCalibration?:    boolean;   // default true
    cronIntervalLabel?:  string;    // e.g. "3 min", "5 min"
    flavor?: "prob" | "spread";     // default "prob"
  };
}

// ─── Registry storage ─────────────────────────────────────────────────
// Lazy-populated to avoid circular imports — each bot's index.mts calls
// `registerBot(botDefinition)` at module load. The dispatcher reads via
// `getBot(category)`.

const REGISTRY = new Map<string, BotDefinition>();

export function registerBot(def: BotDefinition): void {
  if (REGISTRY.has(def.category)) {
    // Idempotent re-register OK for HMR / test contexts — just overwrite.
    console.warn(`[bot-registry] overwriting existing definition for "${def.category}"`);
  }
  REGISTRY.set(def.category, def);
}

export function getBot(category: string): BotDefinition | null {
  return REGISTRY.get(category) ?? null;
}

export function listBots(): BotDefinition[] {
  return Array.from(REGISTRY.values());
}

export function listCategoryIds(): string[] {
  return Array.from(REGISTRY.keys());
}

// ─── Dispatcher helper ────────────────────────────────────────────────
// Call this from `auto-trader/index.mts` BEFORE the legacy switch-case.
// Returns null if the bot isn't registered → caller falls back to legacy
// path. This is the strangler-fig hinge: existing bots can register
// gradually, new bots are registry-native from day one.

export type BotAction = "run" | "status" | "reset" | "stop" | "resume" | "reconcile";

export interface DispatchInput {
  category:         string;
  action:           BotAction;
  source:           "manual" | "cron";
  bankrollOverride?: number;
  bodyOverride?:    unknown;
}

export async function dispatchToRegistry(
  input: DispatchInput,
): Promise<{ handled: boolean; result?: unknown; error?: string }> {
  const bot = getBot(input.category);
  if (!bot) return { handled: false };

  try {
    switch (input.action) {
      case "run":     return { handled: true, result: await bot.run({ source: input.source, bodyOverride: input.bodyOverride, bankrollOverride: input.bankrollOverride }) };
      case "status":  return { handled: true, result: await bot.getStatus() };
      case "reset":   return { handled: true, result: await bot.reset(input.bankrollOverride) };
      case "stop":    return { handled: true, result: await bot.stop() };
      case "resume":  return { handled: true, result: await bot.resume() };
      case "reconcile":
        if (!bot.reconcile) {
          return { handled: true, error: `reconcile not supported by "${input.category}"` };
        }
        return { handled: true, result: await bot.reconcile() };
      default:
        return { handled: true, error: `Unknown action: ${input.action}` };
    }
  } catch (err: any) {
    return { handled: true, error: err?.message || String(err) };
  }
}
