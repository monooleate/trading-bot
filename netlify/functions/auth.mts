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
import { createHash } from "crypto";

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
      await jwtVerify(token, getSecret());
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
      const storedHash = process.env.AUTH_PASSWORD_HASH;
      if (!storedHash) return new Response(JSON.stringify({ ok: false, reason: "server_config" }), { status: 500, headers: CORS });

      const inputHash = sha256(body.password || "");
      if (inputHash !== storedHash) {
        // Timing-safe: kis késleltetés brute-force ellen
        await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
        return new Response(JSON.stringify({ ok: false, reason: "wrong_password" }), { status: 401, headers: CORS });
      }

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
