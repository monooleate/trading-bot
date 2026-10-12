---
paths:
  - "docker-compose.yml"
  - ".github/workflows/**"
  - "infra/**"
  - "services/*/Dockerfile"
  - "apps/web/Dockerfile"
  - "migrations/**"
  - "packages/core/src/migrate.ts"
  - "packages/core/src/db.ts"
  - "packages/core/src/env.ts"
  - "services/api/src/migrate.ts"
  - "services/api/src/server.ts"
  - "services/worker/src/main.ts"
  - "services/worker/src/scheduler.ts"
  - ".env.example"
  - "BUILD_INFO"
---

# Infra / deploy (Hetzner `analytics` box, Docker co-host)

- Deploy-lánc: push `main` → `ci.yml` (`npx tsc --noEmit` + `node scripts/run-tests.mjs` + `npm run build`) → `deploy.yml` (workflow_run) rsync-eli a CI-validált commitot (`rsync -rlptz --delete`, kizárva `.env`/`.env.save`/`data/`/`logs/`/`dist/`/`.git/`/`.claude/`) → `docker compose up -d --build`. A box-oldali `git pull` helyett a Deploy workflow újrafuttatása a kézi fallback.
- A boxon nincs `.git` → a futó kód a `BUILD_INFO`-ból azonosítja magát; a CI írja deploy előtt, a trackelt placeholder `sha=dev` maradjon. Ha az új ledger-sorokon `codeVersion=dev`, a stamp elromlott.
- Workflow-szerkesztés után a YAML-t parse-old (egy escape-hiba egyszer eltörte a `deploy.yml`-t).
- A box `.env` a repón kívül él (titkok, `RECORD_*` flagek) — env-változás után a konténert újra kell létrehozni; a `.env`-be nem kerül bot-tuning változó (az a knob-store dolga).
- Konténerek: `edgecalc-workers` (minden pillér egy konténerben, `PILLARS`, `LOOP_INTERVAL_SEC` 180, belső ütemező), `edgecalc-api` (port 7000, a frontendet is szolgálja), `edgecalc-model` (load-on-demand). A Postgres a umami `postgres:17` konténere (`analytics-db-1`, DB `edgecalc`); hálók `edge` (egress) + `dbnet`. A mem-limitek egy 2 vCPU / 3,7 GB boxra vannak méretezve a umami mellett.
- Migráció: `docker compose --profile migrate run --rm migrate` (atomi, `tx()`). A ledger és a KV-store-ok `blob_kv` JSON → mezőbővítés nem kell SQL-migráció.
- Új pillér a workerben: payload a `services/worker/src/main.ts` `payloadsFor`-ban + a compose `PILLARS` lista. A recorderek a pillérek UTÁN, best-effort futnak.
- Caddy `trade.` blokk (`infra/caddy/trade.Caddyfile.snippet`): a site rejtve kereső/AI elől (X-Robots-Tag noindex, `robots.txt` Disallow, 403 AI user-agentekre) — maradjon így.
- Netlify-specifikus minta (netlify.toml cron, `schedule()` wrapper, functions-bundling) már nem fut — a futtató Bun + belső ütemező. A Netlify DNS-zóna viszont maradjon (`stats.` umami ÉS `trade.` is ott van).
- A Phase-4 adat-migráció helyett tiszta indulás történt (2026-09-02). A Netlify trading-site (`mj-trading.netlify.app`) 2026-10-12-én ellenőrizve törölve (Netlify „Not Found"), vele a Blobs-adat is; ezért az `export-blobs.mjs` / `import-blobs.ts` 2026-10-12-én törölve. A `netlify.toml` is törölve; a `@netlify/blobs`/`@netlify/functions` csomagok maradnak (a kód aliasként a Postgres-facade-ot importálja, `packages/core/src/blobs-compat.ts`). A `jmeszaros.dev` DNS-zóna Netlify DNS-en (NS1) MARAD.
- Box-hozzáférés: `ssh analytics`, `/opt/edgecalc`. Élő DB-írás, `.env`-szerkesztés, konténer-recreate operátor-jóváhagyáshoz kötött.
