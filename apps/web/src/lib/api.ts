// src/lib/api.ts
// Frontend API kliens – Netlify Functions hívása
// Automatikusan felismeri a dev vs prod környezetet

const BASE = typeof window !== "undefined"
  ? ""   // ugyanaz az origin, Netlify routing kezeli
  : "";

const FN = `${BASE}/.netlify/functions`;

// ── UID kezelés (böngésző localStorage) ──────────────────────────────────────
export function getOrCreateUID(): string {
  if (typeof window === "undefined") return "ssr";
  let uid = localStorage.getItem("ec_uid");
  if (!uid) {
    uid = crypto.randomUUID();
    localStorage.setItem("ec_uid", uid);
  }
  return uid;
}

// ── Polymarket piacok ─────────────────────────────────────────────────────────
export async function fetchMarkets(limit = 30): Promise<{
  ok: boolean;
  markets: any[];
  fetched_at: string;
  from_cache?: boolean;
}> {
  const res = await fetch(`${FN}/polymarket-proxy?limit=${limit}`, {
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`polymarket-proxy: ${res.status}`);
  const data = await res.json();
  data.from_cache = res.headers.get("X-Cache") === "HIT";
  return data;
}

// ── Funding rates ─────────────────────────────────────────────────────────────
export async function fetchFundingRates(): Promise<{
  ok: boolean;
  pairs: any[];
  fetched_at: string;
}> {
  const res = await fetch(`${FN}/funding-rates`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`funding-rates: ${res.status}`);
  return res.json();
}

// ── User settings ─────────────────────────────────────────────────────────────
export async function loadSettings(uid: string): Promise<{
  bankroll: number;
  kelly: number;
  theme: string;
}> {
  const res = await fetch(`${FN}/user-settings?uid=${encodeURIComponent(uid)}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return { bankroll: 200, kelly: 0.25, theme: "dark" };
  const data = await res.json();
  return data.settings || { bankroll: 200, kelly: 0.25, theme: "dark" };
}

export async function saveSettings(uid: string, settings: {
  bankroll: number;
  kelly: number;
  theme?: string;
}): Promise<boolean> {
  const res = await fetch(`${FN}/user-settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid, ...settings }),
    signal: AbortSignal.timeout(5000),
  });
  return res.ok;
}
