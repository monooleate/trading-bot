// netlify/functions/auth.mts
// POST /.netlify/functions/auth        { action: "login",  password: "..." }
// POST /.netlify/functions/auth        { action: "logout" }
// GET  /.netlify/functions/auth        → JWT ellenőrzés
//
// Env vars szükségesek (Netlify dashboard → Environment variables):
//   AUTH_PASSWORD_HASH   – bcrypt hash, generálás: node -e "require('crypto').createHash('sha256').update('jelszo').digest('hex')"
//   JWT_SECRET           – legalább 32 karakter random string
//
// Mivel csak 1 user van (te), nem kell Supabase –
// a jelszó SHA-256 hash-e az env-ben van, a JWT HttpOnly cookie-ban él.

import type { Context } from "@netlify/functions";
import { SignJWT, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "crypto";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// JWT beállítások
const JWT_EXPIRY   = "8h";     // 8 óra session
const COOKIE_NAME  = "ec_token";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Constant-time hex compare (audit P2 — the old `!==` was non-constant-time).
function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Best-effort per-IP login rate limit (audit P2 — no lockout/throttle before).
// In-memory (single container); resets on redeploy. 8 fails / 15 min → 429.
const LOGIN_ATTEMPTS = new Map<string, { count: number; firstAt: number }>();
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
function loginLocked(ip: string): boolean {
  const e = LOGIN_ATTEMPTS.get(ip);
  if (!e) return false;
  if (Date.now() - e.firstAt > LOGIN_WINDOW_MS) { LOGIN_ATTEMPTS.delete(ip); return false; }
  return e.count >= MAX_LOGIN_ATTEMPTS;
}
function recordLoginFail(ip: string): void {
  const e = LOGIN_ATTEMPTS.get(ip);
  if (!e || Date.now() - e.firstAt > LOGIN_WINDOW_MS) LOGIN_ATTEMPTS.set(ip, { count: 1, firstAt: Date.now() });
  else e.count++;
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET missing or too short (min 32 chars)");
  return new TextEncoder().encode(secret);
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map(c => c.trim().split("=").map(decodeURIComponent))
  );
}

export default async function handler(req: Request, _ctx: Context) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // ── GET: token ellenőrzés ─────────────────────────────────────────────
  if (req.method === "GET") {
    const cookies = parseCookies(req.headers.get("cookie"));
    const token   = cookies[COOKIE_NAME];
    if (!token) return new Response(JSON.stringify({ ok: false, reason: "no_token" }), { status: 401, headers: CORS });
    try {
      await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
    } catch {
      return new Response(JSON.stringify({ ok: false, reason: "invalid_token" }), { status: 401, headers: CORS });
    }
  }

  // ── POST: login / logout ──────────────────────────────────────────────
  if (req.method === "POST") {
    let body: { action?: string; password?: string };
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, reason: "bad_json" }), { status: 400, headers: CORS }); }

    // LOGOUT
    if (body.action === "logout") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          ...CORS,
          "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        },
      });
    }

    // LOGIN
    if (body.action === "login") {
      const ip = clientIp(req);
      if (loginLocked(ip)) {
        return new Response(JSON.stringify({ ok: false, reason: "rate_limited" }), { status: 429, headers: CORS });
      }
      const storedHash = process.env.AUTH_PASSWORD_HASH;
      if (!storedHash) return new Response(JSON.stringify({ ok: false, reason: "server_config" }), { status: 500, headers: CORS });

      const inputHash = sha256(body.password || "");
      if (!safeHexEqual(inputHash, storedHash)) {
        recordLoginFail(ip);
        await new Promise(r => setTimeout(r, 400 + Math.random() * 200));  // slow brute-force
        return new Response(JSON.stringify({ ok: false, reason: "wrong_password" }), { status: 401, headers: CORS });
      }
      LOGIN_ATTEMPTS.delete(ip);   // success clears the counter

      // JWT generálás
      const token = await new SignJWT({ sub: "owner", role: "admin" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(JWT_EXPIRY)
        .sign(getSecret());

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          ...CORS,
          "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
        },
      });
    }

    return new Response(JSON.stringify({ ok: false, reason: "unknown_action" }), { status: 400, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: false, reason: "method_not_allowed" }), { status: 405, headers: CORS });
}
