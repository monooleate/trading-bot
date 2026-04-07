// netlify/functions/user-settings.mts
// GET  /.netlify/functions/user-settings?uid=<id>        → beállítások lekérése
// POST /.netlify/functions/user-settings                 → beállítások mentése
//
// Body (POST): { uid: string, bankroll: number, kelly: number, ... }
// uid: böngészőben generált UUID (localStorage), nem autentikáció!

import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "user-settings";

interface UserSettings {
  uid:        string;
  bankroll:   number;
  kelly:      number;
  theme?:     string;
  saved_at:   string;
}

export default async function handler(req: Request, context: Context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const store = getStore(STORE_NAME);

  // ── GET: beállítások lekérése ──────────────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid");
    if (!uid) {
      return new Response(JSON.stringify({ ok: false, error: "uid required" }), {
        status: 400, headers: corsHeaders,
      });
    }
    const data = await store.get(`user:${uid}`);
    if (!data) {
      // Alapértelmezett beállítások, ha nincs mentve semmi
      return new Response(JSON.stringify({
        ok: true,
        settings: { uid, bankroll: 200, kelly: 0.25, theme: "dark" },
        is_default: true,
      }), { status: 200, headers: corsHeaders });
    }
    return new Response(JSON.stringify({ ok: true, settings: JSON.parse(data), is_default: false }), {
      status: 200, headers: corsHeaders,
    });
  }

  // ── POST: mentés ───────────────────────────────────────────────────────
  if (req.method === "POST") {
    let body: UserSettings;
    try {
      body = await req.json() as UserSettings;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
        status: 400, headers: corsHeaders,
      });
    }

    const { uid, bankroll, kelly } = body;
    if (!uid || typeof bankroll !== "number" || typeof kelly !== "number") {
      return new Response(JSON.stringify({ ok: false, error: "uid, bankroll, kelly required" }), {
        status: 400, headers: corsHeaders,
      });
    }

    // Validáció
    const settings: UserSettings = {
      uid,
      bankroll: Math.max(10, Math.min(1_000_000, bankroll)),
      kelly:    Math.max(0.05, Math.min(1, kelly)),
      theme:    body.theme || "dark",
      saved_at: new Date().toISOString(),
    };

    await store.set(`user:${uid}`, JSON.stringify(settings));

    return new Response(JSON.stringify({ ok: true, settings }), {
      status: 200, headers: corsHeaders,
    });
  }

  return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
    status: 405, headers: corsHeaders,
  });
}
