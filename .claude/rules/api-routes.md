---
paths:
  - "services/api/src/**"
  - "packages/core/src/fetch-retry*.mts"
  - "packages/core/src/blobs-compat*.ts"
  - "packages/core/src/session-store.ts"
  - "apex_wallet_profiler.py"
---

# API-route-ok (`services/api`, Bun) + külső API-k

- Route = `.mts` (kebab-case) Fetch-handler: `export default async function handler(req: Request, _ctx)`. Új route-ot a `services/api/src/server.ts` importjába ÉS név-dispatch-ébe is fel kell venni (kiszolgálva `/.netlify/functions/<név>` és `/api/<név>` alatt).
- Minden válasz CORS-headerrel, `OPTIONS` → 204. Hiba: `{ ok: false, error: err.message }` + 502. Minden külső hívás `AbortSignal.timeout(8000)`.
- GET-cache: `getStore("<név>")` + `metadata.ts` TTL. ⚠ A store-név dönti el a hátteret (`blobs-compat.ts`): ha a név tartalmazza a „cache"-t → in-process Map; különben DURABLE Postgres `blob_kv`. Cache-nek mindig „…-cache" nevet adj.
- `@netlify/blobs` a tsconfig-ban `packages/core/src/blobs-compat.ts`-re van aliasolva — ne telepíts/importálj valódi Netlify Blobs-ot; a compat a session-store-okat a normalizált `pillar_session*` táblákra dispatch-eli.
- Védett route: `checkAuth(req)` a `_auth-guard.ts`-ből (SHA-256 jelszó-hash + JWT HS256-pin, HttpOnly Secure cookie, 8 h). Az Anthropic-költséget okozó route-ok (`llm-dependency`, `resolution-risk`) auth-gated maradjanak.
- Claude-modell: `process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"` — modell-id-t ne hardkódolj (egy retired id egyszer mindhárom hívóhelyet törte; a Python `apex_wallet_profiler.py` is ezt az envet olvassa).
- Signed élő hívások `fetchWithRetry`-on át (429/5xx/network backoff); POST order CSAK 429-re retry-ol (idempotencia).
- Polymarket Gamma: lezárt piacot CSAK `&closed=true`-val ad vissza (a 2026-05-10-i paper-resolver bug oka).
- Binance Futures számla-végpontok: `/fapi/v3/balance`, `/fapi/v3/positionRisk` (v2 leváltva).
- `multi-status` / `edge-tracker` válasz lehet cache-elt — élő állapot-állításhoz nézd a frissességet, auth-olt hívással.
