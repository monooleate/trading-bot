// netlify/functions/_auth-guard.ts
// Segédfüggvény – minden védett function importálja ezt.
// Használat:
//   const { ok, error } = await checkAuth(req);
//   if (!ok) return error!;

import { jwtVerify } from "jose";

const COOKIE_NAME = "ec_token";

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [decodeURIComponent(k), decodeURIComponent(v.join("="))];
    })
  );
}

export async function checkAuth(req: Request): Promise<{ ok: true } | { ok: false; error: Response }> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return { ok: false, error: new Response(JSON.stringify({ ok: false, reason: "server_config" }), { status: 500, headers: { "Content-Type": "application/json" } }) };
  }

  const cookies = parseCookies(req.headers.get("cookie"));
  const token   = cookies[COOKIE_NAME];

  if (!token) {
    return { ok: false, error: new Response(JSON.stringify({ ok: false, reason: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }) };
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
    return { ok: true };
  } catch {
    return { ok: false, error: new Response(JSON.stringify({ ok: false, reason: "invalid_token" }), { status: 401, headers: { "Content-Type": "application/json" } }) };
  }
}
