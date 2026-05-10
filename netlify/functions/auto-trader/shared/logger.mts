import type { LogEntry, LogEvent } from "./types.mts";

const logBuffer: string[] = [];

export function log(event: LogEvent, paper: boolean, data: Record<string, unknown> = {}) {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    event,
    paper,
    ...data,
  };
  const line = JSON.stringify(entry);
  logBuffer.push(line);
  console.log(line);
}

export function getLogBuffer(): string[] {
  return [...logBuffer];
}

export function clearLogBuffer(): void {
  logBuffer.length = 0;
}

// ─── Per-category log filtering ───────────────────────────────────────────
//
// The log buffer is shared across all categories, so a weather operator
// scrolling the status page used to see crypto/HL events too. We tag many
// events with `category`, `type`, or `venue` — those tags give us a stable
// filter without changing every call site.
//
// Heuristics (kept conservative — when in doubt, KEEP a line):
//   - Direct match on `category` / `venue` / `type` field
//   - Weather: `type` startsWith "weather"
//   - Crypto: market slug pattern (bitcoin-…, btc-…, ethereum-…) — but
//     funding-arb logs also include slugs, so we only fall back to slug
//     classification when no explicit category/venue is present
//   - Funding-arb: `venue: "funding-arb"` or `coin` field (5-coin HL list)
//
// Untagged lines (no category/venue/type/coin) appear on EVERY category's
// status — they're probably session-wide warnings worth showing.

const WEATHER_TYPE_PREFIX = "weather";
const HL_COINS = new Set(["BTC", "ETH", "SOL", "XRP", "AVAX"]);

function classifyLogLine(line: string): string | null {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;

  // Explicit tags win.
  if (typeof obj.category === "string") return obj.category.toLowerCase();
  if (typeof obj.venue === "string") {
    const v = obj.venue.toLowerCase();
    if (v === "hyperliquid" || v === "funding-arb" || v === "weather") return v;
  }
  if (typeof obj.type === "string") {
    const t = obj.type.toLowerCase();
    if (t === "weather" || t.startsWith(WEATHER_TYPE_PREFIX)) return "weather";
  }
  // HL/funding-arb have a `coin` field (BTC/ETH/SOL/XRP/AVAX). Crypto's
  // BTC short-market trades use the slug "bitcoin-up-or-down-…" — that's
  // never set as `coin`, so this remains a clean discriminator.
  if (typeof obj.coin === "string" && HL_COINS.has(obj.coin.toUpperCase())) {
    return "hyperliquid";
  }
  // Slug heuristic: crypto vs weather distinguishable from the slug shape.
  if (typeof obj.market === "string") {
    const m = obj.market.toLowerCase();
    if (m.startsWith("highest-temperature-")) return "weather";
    if (/^(bitcoin|btc|ethereum|eth|solana|sol)-/.test(m)) return "crypto";
  }
  return null;
}

/** Subset of `getLogBuffer()` whose lines plausibly belong to the given
 *  category, plus all unclassified (session-wide) lines. */
export function getLogBufferForCategory(category: string): string[] {
  const wanted = category.toLowerCase();
  return logBuffer.filter((line) => {
    const cat = classifyLogLine(line);
    return cat === null || cat === wanted;
  });
}
