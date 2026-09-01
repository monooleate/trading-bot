# EdgeCalc — Hetzner Docker deployment (teljes setup)

> **SSOT scope:** Ez a fájl a **konténerizált deployment SSOT-je**: a teljes Docker/Compose topológia, konténerek (services), Dockerfile-ok, szerver- és repo-könyvtárszerkezet, hálózat/portok, deploy-pipeline, a Python ML model-service, és a Netlify→konténer mapping.
>
> **Viszony a többi doksihoz:**
> - [`hetzner-infrastructure.md`](./hetzner-infrastructure.md) — szerver-választás, OS-hardening, Postgres-séma, DR, budget **továbbra is onnan él**; a **runtime/process/deploy** (ott §3/§6/§7/§9, PM2-alapú) **ezt a fájlt** tekinti mérvadónak (Docker-first).
> - [`hetzner-migration.md`](./hetzner-migration.md) — a fázisos action plan (mikor mit).
> - [`../current-state/env-vars.md`](../current-state/env-vars.md) — az env-vár katalógus SSOT-je.
>
> **Döntés (2026-09-01):** Az infra-doksi §14 korábban „Docker = overengineering, PM2 elég" volt. **Ezt megfordítjuk.** Indok: (1) a forecasting-réteg B-lépcsője **Python ML model-service** (Chronos/TimesFM/GARCH/kalibráció) — ez natívan nem fér meg a Bun/Node process-modellben, konténer kell; (2) reprodukálható, verziózott build (a „works on my machine" kizárva); (3) egy `docker compose up -d` = teljes stack, a Hetzner-újraépítés percek; (4) konténer-szintű izoláció = pilléres kill-switch tisztább. A PM2-modell alternatívaként megmarad az infra-doksiban, de az élesítés Docker-alapú.
>
> **Dátum:** 2026-09-01

---

## 1. Áttekintés — mit futtatunk

Egy **Docker Compose stack** egyetlen Hetzner VPS-en. Minden szolgáltatás konténer; a host csak Docker Engine + a `/opt/edgecalc` adat/config fát tartja. Kifelé **kizárólag a Caddy** publikál (80/443); minden más a belső Docker hálón beszél.

### A konténerek (services)

| Konténer | Image / build | Szerep | Kifelé nyitott |
|---|---|---|---|
| **caddy** | `caddy:2` | Reverse proxy + auto-HTTPS (Let's Encrypt) + statikus frontend-serve | **80, 443** |
| **web-build** | build stage (Astro) | A frontend `dist/` legyártása → megosztott volume (nem fut folyamatosan) | – |
| **api** | `./services/api` (Bun) | Read-only API-k: status-aggregator, edge-tracker, tools, signal-combiner endpoints | belső :7000 |
| **worker-crypto** | `./services/worker` (Bun) | Polymarket crypto pillér loop (a Netlify cron helyett belső ütemező) | belső :7101 |
| **worker-weather** | `./services/worker` (Bun) | Polymarket weather pillér loop | belső :7102 |
| **worker-hl** | `./services/worker` (Bun) | Hyperliquid directional pillér loop | belső :7103 |
| **worker-farb** | `./services/worker` (Bun) | Funding-arb pillér loop | belső :7104 |
| **worker-sports** | `./services/worker` (Bun) | Sports pillér loop (jelenleg stopped) | belső :7105 |
| **market-feeds** | `./services/feeds` (Bun) | Binance/Hyperliquid/Bybit/Polymarket WS → Redis pub/sub | belső :7500 |
| **model** | `./services/model` (Python) | **B-lépcső ML**: Chronos-Bolt/TimesFM, HAR-RV/GARCH, kalibráció (FastAPI) | belső :8000 |
| **postgres** | `postgres:16` | Állapot + trade-log + **prediction_ledger** + kalibráció | belső :5432 |
| **redis** | `redis:7` | Cache (Blobs-cache leváltása) + pub/sub event bus | belső :6379 |
| **migrate** | `./services/api` (Bun, one-shot) | SQL migrations futtató (compose `--profile migrate`) | – |
| **backup** | `./infra/backup` (alpine+pg_dump) | Napi `pg_dump` → Hetzner Storage Box (cron a konténerben) | – |

**Opcionális monitoring overlay** (`compose.monitoring.yml`, Phase 2 profil): `prometheus`, `grafana`, `node-exporter`, `cadvisor`, `postgres-exporter`.

### Miért ez a bontás
- **Pillér = külön worker konténer** → a pilléres modell (saját bankroll, saját kill-switch) konténer-szinten izolált; egy pillér OOM/restart nem viszi a többit. `docker compose stop worker-hl` = az a pillér áll, a többi megy.
- **A `model` (Python) külön konténer** → a nehéz ML-t (foundation modellek, GARCH) a Bun-workerek HTTP-n kérdezik; a Python-függőségek (torch, transformers, arch) nem szennyezik a JS-stacket.
- **A feeds külön** → a WS-kapcsolatok állapotos, hosszú-életű processzek; egy helyen élnek, Redisbe pusholnak, a workerek onnan olvasnak (nincs N×ugyanaz a WS).

---

## 2. Szerver-sizing (Docker-tudatos)

Az infra-doksi §1 CCX23 (4 vCPU / 16 GB) az induló gép. **Docker + a `model` konténerrel a RAM a szűk keresztmetszet:**

| Konténer | RAM (tipikus) | Megjegyzés |
|---|---|---|
| postgres | 2–4 GB | `shared_buffers` 1 GB konténerben (nem 4 — a host-osztozás miatt) |
| redis | ≤ 1 GB | `maxmemory 768mb` |
| model (Chronos-Bolt) | 1.5–3 GB | **Chronos-Bolt/TimesFM-200M elfér**; a nagy foundation modellek (>1B) nem — azok resident-je CCX33 (32 GB) |
| 5× worker + api + feeds (Bun) | 5× ~150 MB + ~400 MB | Bun kis lábnyom |
| caddy | ~50 MB | |
| **Összesen** | **~10–13 GB** | CCX23 (16 GB) elég **Chronos-Bolt tier-rel**; ha nagy foundation modellt akarsz resident-ben → **CCX33** |

**Ajánlás:** induljon **CCX23**-on Chronos-Bolt (small) tier-rel, load-on-demand model-betöltéssel (a `model` konténer csak kéréskor tartja memóriában, TTL után elereszti). Ha a nagy modellek resident-je kell → **CCX33 upgrade** (snapshot → új gép → IP transfer, ~10 perc, infra-doksi §1).

---

## 3. Könyvtárszerkezet — szerver (`/opt/edgecalc`)

A host **nem** tárol kódot forrásban futtatva; a kód a konténer-image-ekben van. A host csak a compose-t, a titkokat és a **perzisztens adatot** (bind-mount volume-ok) tartja:

```
/opt/edgecalc/
├── docker-compose.yml                 # a core stack
├── compose.monitoring.yml             # opcionális monitoring overlay (Phase 2)
├── .env                               # SECRETS — NEM git, chmod 600, root:edgecalc
├── .env.example                       # sablon (git-ben)
├── Caddyfile                          # reverse-proxy config (bind-mount a caddy-be)
├── caddy/
│   ├── data/                          # Caddy TLS certs (named volume is lehet)
│   └── config/
├── data/                              # PERZISZTENS bind-mount volume-ok
│   ├── postgres/                      # PGDATA
│   ├── redis/                         # ha appendonly kellene (most cache → üres)
│   └── model-cache/                   # HuggingFace model-cache (Chronos/TimesFM súlyok)
├── dist/                              # Astro build output → Caddy serve (a web-build rakja ide)
├── backups/                           # napi pg_dump ide, majd Storage Box-ra
└── logs/                              # ha fájlba is logolunk (elsődlegesen `docker logs`)
```

> A kódot **image-ben** szállítjuk (GHCR-ből `pull`, vagy a szerveren `build`). A `/opt/edgecalc` csak a futtató-konfig + adat. Így egy `git`-mentes, tiszta host.

---

## 4. Könyvtárszerkezet — repo (monorepo)

A jelenlegi Astro+Netlify repo átszervezve, hogy a Compose build-context-ek tiszták legyenek:

```
edgecalc/                              # repo gyökér
├── docker-compose.yml                 # → deploykor a szerverre másolva
├── compose.monitoring.yml
├── Caddyfile
├── .env.example
├── .dockerignore
│
├── apps/
│   └── web/                           # Astro + React frontend (a mostani src/)
│       ├── src/
│       ├── astro.config.mjs
│       └── Dockerfile                 # build stage → dist/
│
├── services/
│   ├── api/                           # Bun HTTP: read-only API-k + signal endpoints
│   │   ├── src/
│   │   │   ├── server.ts              # Hono/Elysia router (Caddy mögé)
│   │   │   ├── routes/
│   │   │   │   ├── status.ts          # ex multi-status.mts
│   │   │   │   ├── edge-tracker.ts    # ex edge-tracker.mts (+ properScores, ledgerStats)
│   │   │   │   ├── signal-combiner.ts # ex signal-combiner.mts
│   │   │   │   └── tools/*.ts         # ex 11 /tools/ endpoint
│   │   │   └── migrate.ts             # SQL migration runner (one-shot)
│   │   └── Dockerfile
│   │
│   ├── worker/                        # Bun: EGY image, az entrypoint dönti a pillért
│   │   ├── src/
│   │   │   ├── main.ts                # PILLAR=crypto|weather|hl|farb|sports → loop
│   │   │   ├── scheduler.ts           # setInterval loop (a Netlify cron helyett)
│   │   │   ├── pillars/               # a mostani auto-trader/* átemelve
│   │   │   │   ├── crypto/
│   │   │   │   ├── weather/
│   │   │   │   ├── hyperliquid/
│   │   │   │   ├── funding-arb/
│   │   │   │   └── sports/
│   │   │   └── shared/                # prediction-ledger.ts, signal-calibration.ts, telegram.ts…
│   │   └── Dockerfile
│   │
│   ├── feeds/                         # Bun: WS collectors → Redis pub/sub
│   │   ├── src/{binance,hyperliquid,bybit,polymarket}.ts
│   │   └── Dockerfile
│   │
│   └── model/                         # Python FastAPI: a B-lépcső ML
│       ├── app/
│       │   ├── main.py                # FastAPI: /forecast, /vol, /calibrate, /score
│       │   ├── forecasters.py         # Chronos-Bolt / TimesFM wrapper
│       │   ├── volatility.py          # HAR-RV (Yang–Zhang), arch-GARCH
│       │   ├── calibration.py         # isotonic/Venn-Abers/Platt (MAPIE/venn-abers)
│       │   └── scoring.py             # Brier/log/CRPS (properscoring)
│       ├── requirements.txt           # torch, transformers, chronos-forecasting, arch, scikit-learn, mapie, venn-abers, fastapi, uvicorn
│       └── Dockerfile
│
├── packages/                          # megosztott TS (mindkét Bun service importálja)
│   └── core/
│       ├── db.ts                      # postgres pool (a Blobs helyett)
│       ├── redis.ts                   # ioredis singleton (cache + pubsub)
│       ├── ledger.ts                  # prediction-ledger, Postgres-backend
│       └── env.ts                     # zod-validált env
│
├── infra/
│   ├── backup/Dockerfile              # alpine + postgresql-client + cron
│   └── postgres/init/                 # 001_init.sql, 002_ledger.sql … (docker-entrypoint-initdb.d)
│
└── migrations/                        # sorszámozott SQL (idempotens)
    ├── 001_init.sql
    ├── 002_trade_log.sql
    └── 003_prediction_ledger.sql
```

---

## 5. docker-compose.yml (core stack)

```yaml
name: edgecalc

x-bun-common: &bun-common
  restart: unless-stopped
  env_file: [.env]
  depends_on:
    postgres: { condition: service_healthy }
    redis:    { condition: service_started }
  networks: [edge]
  logging:
    driver: json-file
    options: { max-size: "20m", max-file: "5" }

services:
  # ─── Data layers ────────────────────────────────────────
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: edgecalc
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: edgecalc
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
      - ./infra/postgres/init:/docker-entrypoint-initdb.d:ro   # first-run schema
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U edgecalc -d edgecalc"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks: [edge]                  # NINCS ports: — csak belső
    logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } }

  redis:
    image: redis:7
    restart: unless-stopped
    command: ["redis-server", "--maxmemory", "768mb", "--maxmemory-policy", "allkeys-lru", "--save", ""]
    networks: [edge]

  # ─── Read APIs + signal layer ───────────────────────────
  api:
    <<: *bun-common
    build: { context: ., dockerfile: services/api/Dockerfile }
    environment: { PORT: "7000" }
    expose: ["7000"]

  # ─── Pillér workerek (EGY image, PILLAR env dönt) ───────
  worker-crypto:
    <<: *bun-common
    build: { context: ., dockerfile: services/worker/Dockerfile }
    environment: { PILLAR: crypto, PORT: "7101" }
    mem_limit: 350m
  worker-weather:
    <<: *bun-common
    build: { context: ., dockerfile: services/worker/Dockerfile }
    environment: { PILLAR: weather, PORT: "7102" }
    mem_limit: 350m
  worker-hl:
    <<: *bun-common
    build: { context: ., dockerfile: services/worker/Dockerfile }
    environment: { PILLAR: hyperliquid, PORT: "7103" }
    mem_limit: 350m
  worker-farb:
    <<: *bun-common
    build: { context: ., dockerfile: services/worker/Dockerfile }
    environment: { PILLAR: funding-arb, PORT: "7104" }
    mem_limit: 350m
  worker-sports:
    <<: *bun-common
    build: { context: ., dockerfile: services/worker/Dockerfile }
    environment: { PILLAR: sports, PORT: "7105" }
    mem_limit: 350m

  # ─── Market feeds (WS → Redis) ──────────────────────────
  market-feeds:
    <<: *bun-common
    build: { context: ., dockerfile: services/feeds/Dockerfile }
    environment: { PORT: "7500" }

  # ─── ML model service (B-lépcső) ────────────────────────
  model:
    build: { context: ., dockerfile: services/model/Dockerfile }
    restart: unless-stopped
    env_file: [.env]
    environment:
      HF_HOME: /cache                 # HuggingFace model-cache a volume-on
      MODEL_TIER: chronos-bolt-small  # resident tier; nagy modell → CCX33
    volumes:
      - ./data/model-cache:/cache
    expose: ["8000"]
    networks: [edge]
    mem_limit: 3g                     # Chronos-Bolt tier; nagy foundation → emeld + CCX33

  # ─── Reverse proxy (az EGYETLEN publikus) ───────────────
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./dist:/srv/www:ro            # Astro static build
      - ./caddy/data:/data
      - ./caddy/config:/config
    depends_on: [api]
    networks: [edge]

networks:
  edge:
    driver: bridge
```

**Egyszeri / ütemezett konténerek külön profillal** (nem indulnak a `up`-pal):

```yaml
  migrate:
    profiles: ["migrate"]
    build: { context: ., dockerfile: services/api/Dockerfile }
    env_file: [.env]
    command: ["bun", "run", "src/migrate.ts"]
    depends_on: { postgres: { condition: service_healthy } }
    networks: [edge]

  backup:
    profiles: ["ops"]
    build: { context: ., dockerfile: infra/backup/Dockerfile }
    env_file: [.env]
    volumes: [ "./backups:/backups" ]
    networks: [edge]
```

---

## 6. Dockerfile-ok

### `services/worker/Dockerfile` (és `api`, `feeds` ugyanez a minta)
```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app
# függőségek külön rétegben (cache)
COPY package.json bun.lockb ./
COPY packages/ ./packages/
RUN bun install --frozen-lockfile --production
# forrás
COPY services/worker ./services/worker
COPY tsconfig.json ./
USER bun
# Bun natívan futtatja a TS-t, nincs külön build-lépés
CMD ["bun", "run", "services/worker/src/main.ts"]
```

### `apps/web/Dockerfile` (build-stage → dist a Caddynek)
```dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY apps/web/package.json apps/web/bun.lockb ./
RUN bun install --frozen-lockfile
COPY apps/web ./
RUN bun run build                    # → /app/dist
# a dist-et a deploy másolja a hosthoz (./dist), Caddy serve-eli
FROM scratch AS export
COPY --from=build /app/dist /dist
```
> A `web` nem futó szolgáltatás: a CI/deploy kihúzza a `dist`-et (`docker build --target export -o ./dist .`), és a Caddy statikusan serve-eli. Nincs futó Node a frontendhez.

### `services/model/Dockerfile` (Python ML)
```dockerfile
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY services/model/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY services/model/app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
```
`requirements.txt` (a discovery A/B-lépcsőjéből): `fastapi uvicorn torch --index-url … chronos-forecasting arch scikit-learn mapie venn-abers properscoring numpy pandas`.

### `infra/backup/Dockerfile`
```dockerfile
FROM alpine:3.20
RUN apk add --no-cache postgresql16-client bash curl tzdata
COPY infra/backup/backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
# napi 03:00 UTC cron
RUN echo "0 3 * * * /usr/local/bin/backup.sh" > /etc/crontabs/root
CMD ["crond", "-f", "-l", "8"]
```

---

## 7. Caddyfile (konténerizált)

A Caddy a belső Docker-DNS-en éri el a többi konténert (service-név = host):

```caddy
edgecalc.jmeszaros.dev {
    root * /srv/www
    encode gzip zstd
    try_files {path} /index.html
    file_server
    header {
        Strict-Transport-Security "max-age=31536000;"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        -Server
    }
}

api.edgecalc.jmeszaros.dev {
    encode gzip
    # minden read-API + signal endpoint az `api` konténerbe
    handle /api/* {
        reverse_proxy api:7000
    }
    # az ML model-service (ha kell közvetlen hozzáférés; egyébként a workerek hívják belül)
    handle /model/* {
        reverse_proxy model:8000
    }
    handle { respond "Not found" 404 }
    log { output stdout; format json }
}
```

> A workerek **nem** publikusak — a Caddy nem proxyzza őket; belül HTTP-n (`worker-crypto:7101`) vagy Redisen keresztül elérhetők a status-aggregátornak. A frontend a `api` konténeren át kap mindent (az `api` kérdezi a workerek `/status`-át vagy Postgresből olvas).

---

## 8. Postgres — a ledger + trade-log séma (Docker-init)

Az infra-doksi §4 `trade_log` + `pillar_state_*` sémája marad. **Új: a prediction ledger táblája** (`003_prediction_ledger.sql`, a `infra/postgres/init/`-ben első-indításkor lefut, illetve `migrations/`-ból is):

```sql
CREATE TABLE IF NOT EXISTS prediction_ledger (
  id            BIGSERIAL PRIMARY KEY,
  category      TEXT NOT NULL,                 -- crypto|weather|hyperliquid
  slug          TEXT NOT NULL,                 -- market slug vagy coin
  condition_id  TEXT,
  end_date      TIMESTAMPTZ,
  first_ts      TIMESTAMPTZ NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,          -- latest prediction
  predicted_prob NUMERIC NOT NULL,             -- model P(YES)
  market_price  NUMERIC,
  edge          NUMERIC,
  direction     TEXT,
  taken         BOOLEAN NOT NULL DEFAULT false,
  last_action   TEXT,
  skip_reason   TEXT,
  signal_breakdown JSONB,
  scans         INT NOT NULL DEFAULT 1,
  outcome       NUMERIC,                       -- YES-resolution 0/1, NULL amíg unresolved
  resolved_at   TIMESTAMPTZ,
  UNIQUE (category, slug)                      -- upsert-per-market (a Blobs-modell 1:1 párja)
);
CREATE INDEX IF NOT EXISTS idx_pl_cat_resolved ON prediction_ledger(category, outcome);
CREATE INDEX IF NOT EXISTS idx_pl_pending ON prediction_ledger(category) WHERE outcome IS NULL;
```

A `packages/core/ledger.ts` a jelenlegi `prediction-ledger.mts` **portja**: ugyanaz a pure logika (`upsertRecords`/`capRecords`/`yesOutcomeFromClosedTrade`), de a Blobs `loadLedger`/`saveLedger` helyett Postgres `INSERT … ON CONFLICT (category,slug) DO UPDATE`. **A pure függvények és a tesztek változatlanul átjönnek** (a Blobs csak adapter volt).

---

## 9. Blobs → Postgres migráció (a ledger + minden állapot)

A hibrid-terv szerint a ledger **most Blobs-ba gyűlik**, Hetznernél átöltjük:

1. **Export** (Netlify oldalon, egyszeri): egy admin-endpoint / függvény kiírja minden store-t JSON-ba (`prediction-ledger/ledger-crypto`, `auto-trader-state/*`, `hyperliquid-session-v1/*`, …).
2. **Transfer**: a JSON-ok fel a VPS-re (`scp`).
3. **Import**: egy `bun run services/api/src/import-blobs.ts <dir>` egyszeri konténer (`--profile migrate` mintára) beolvassa és `INSERT`-eli Postgresbe (ledger → `prediction_ledger`, sessions → `pillar_state_*` vagy normalizált táblák).
4. **Cutover**: a `packages/core/ledger.ts` és a session-I/O innentől Postgres-backend; a Blobs-kód kivezetve.

> A ledger append-only rekord → az import triviális (`ON CONFLICT DO UPDATE`). **Az adat nem készül újra**, csak a tároló-adapter cserélődik — pontosan ez volt a hibrid-döntés indoka.

---

## 10. Ütemezés — a Netlify cron leváltása

A Netlify `*/3 min` cronok helyett minden `worker-*` konténer **belső ütemezőt** futtat (`scheduler.ts`): `setInterval(tick, LOOP_INTERVAL_SEC*1000)`, plusz egy azonnali első tick induláskor. Nincs külön cron-konténer (kevesebb mozgó alkatrész). A pillérenkénti intervallum env-ből (`*_LOOP_INTERVAL_SEC`, infra-doksi §8). Előny a Netlify-hoz képest: **nincs 10s function-timeout** → a live early-exit / reconcile budget-korlátok (LIVE_EXIT_BUDGET_PER_TICK stb.) feloldhatók, a WS-feedek folyamatosan futnak (nem cron-poll).

---

## 11. Hálózat, portok, biztonság

- **Publikus:** csak `caddy` (80/443). UFW a hoston: `22, 80, 443` (infra-doksi §2). A `postgres`/`redis`/`model`/workerek **nincsenek** `ports:`-szal kitéve — csak a belső `edge` bridge hálón.
- **Titkok:** `/opt/edgecalc/.env` (chmod 600), `env_file`-lal injektálva. Kulcsok (HL_PRIVATE_KEY, POLY_PRIVATE_KEY, BYBIT_*) sosem image-ben, sosem git-ben. Opcionális továbblépés: Docker secrets / SOPS-age.
- **Image-eredet:** a build a szerveren (`docker compose build`) VAGY GHCR-ből `pull` (CI push). Pin-elt base-image tag-ek (`postgres:16`, `oven/bun:1`, `python:3.12-slim`), nem `latest`.
- **Nem-root konténer:** a Bun image `USER bun`; a Python konténer futhat non-root user alatt (add hozzá a Dockerfile-ban éles előtt).

---

## 12. Deploy pipeline

### Opció A — szerveren build (egyszerű, induló)
```bash
# a repo a szerveren /opt/edgecalc/src-ben (vagy CI másolja a compose+context-et)
cd /opt/edgecalc
docker compose --profile migrate run --rm migrate   # SQL migrations
docker compose up -d --build                         # build + (re)start
docker compose --target export build web && cp -r … ./dist   # frontend a Caddynek
```

### Opció B — GHCR image-ek (ajánlott, ha CI van)
`.github/workflows/deploy.yml`: `main` push → `docker build` + `push ghcr.io/<owner>/edgecalc-{api,worker,feeds,model}` → SSH a VPS-re → `docker compose pull && docker compose up -d`. Migrations egy `--profile migrate run` lépésként a `up` előtt.

### Zero-downtime-ish
`docker compose up -d` service-enként újraindít; a pillér-workerek stateless-ek a tick között (az állapot Postgresben) → egy worker-restart max 1 kimaradt tick. A Caddy/api gyorsan cserél. Igazi rolling-hoz `docker compose up -d --no-deps --build worker-hl` (csak egy pillér).

---

## 13. Netlify Function → konténer mapping

| Netlify (most) | Docker (új) |
|---|---|
| `auto-trader/index.mts` (crypto cron) | `worker-crypto` (belső loop) |
| `auto-trader/weather/index.mts` | `worker-weather` |
| `auto-trader/hyperliquid/index.mts` | `worker-hl` |
| `auto-trader/.../funding-arb` | `worker-farb` |
| `auto-trader/sports/index.mts` | `worker-sports` |
| `signal-combiner.mts`, `vol-divergence`, `orderflow-analysis`, `cond-prob-matrix`, `apex-wallets`, `vwap-arb`, `llm-dependency` | `api` (routes) — a nehéz számítás egy része a `model` service-be |
| `edge-tracker.mts` (+ properScores, ledgerStats) | `api` route, Postgres-backend |
| `multi-status.mts`, `auto-trader-api.mts` | `api` route (a workerek `/status`-át aggregálja / Postgresből) |
| `*-cron.mts` wrapperek | **megszűnnek** — a workerek belső ütemezője váltja |
| Netlify Blobs (`getStore`) | `postgres` (state, ledger) + `redis` (cache, pubsub) |
| Netlify static host | `caddy` static serve (`./dist`) |
| — (nincs) | **`model` (Python ML)** — a B-lépcső új képessége |

---

## 14. Monitoring overlay (`compose.monitoring.yml`, Phase 2)

```yaml
name: edgecalc
services:
  prometheus:
    image: prom/prometheus
    volumes: [ "./infra/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro" ]
    networks: [edge]
  grafana:
    image: grafana/grafana
    environment: { GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD} }
    volumes: [ "grafana-data:/var/lib/grafana" ]
    networks: [edge]                  # Caddy mögé tehető (grafana.edgecalc…)
  node-exporter:   { image: prom/node-exporter, networks: [edge] }
  cadvisor:        { image: gcr.io/cadvisor/cadvisor, networks: [edge] }
  postgres-exporter:
    image: prometheuscommunity/postgres-exporter
    environment: { DATA_SOURCE_NAME: "postgresql://edgecalc:${POSTGRES_PASSWORD}@postgres:5432/edgecalc?sslmode=disable" }
    networks: [edge]
volumes: { grafana-data: {} }
```
Indítás: `docker compose -f docker-compose.yml -f compose.monitoring.yml up -d`. A workerek Prometheus-metrikát exportálnak (`/metrics` a belső porton): open positions, session PnL, win-rate, **Brier/log-score/reliability (a proper-scoring harnessből)**, tick-latency.

---

## 15. Ops — logok, kill-switch, backup, DR

- **Logok:** `docker compose logs -f worker-hl` (json-file driver, 20 MB×5 rotáció konténerenként). Struktúrált NDJSON a stdout-ra.
- **Kill-switch (pillér):** `docker compose stop worker-hl` — csak az a pillér áll. **Teljes:** `docker compose stop worker-crypto worker-weather worker-hl worker-farb worker-sports` + Telegram ops-alert (a mostani `kill-switch.sh` Docker-változata).
- **Backup:** a `backup` konténer napi `pg_dump | gzip → /backups` + rsync Storage Boxra (infra-doksi §11). Heti Hetzner-snapshot a teljes VPS-ről.
- **DR:** VPS-halál → új gép, `git`-mentes: `docker compose up -d` a `/opt/edgecalc`-ból (compose+.env+data restore snapshotból/Storage Boxból) → percek. Postgres-restore a napi dumpból (≤24h veszteség).
- **Upgrade (CCX23→CCX33):** snapshot → nagyobb gép → IP transfer → `docker compose up -d`. A `model` `mem_limit` felemelése + nagy foundation modell resident-je itt válik lehetővé.

---

## 16. Fázisos élesítés (strangler-fig, Docker-tudatos)

1. **VPS + stack fel, paper-only.** `postgres`+`redis`+`api`+`caddy`+`model` + 5 worker paper módban, a Netlify **még fut párhuzamosan** (strangler). A ledger/trade-log Postgresbe gyűlik.
2. **Blobs→Postgres import** (§9) — a Netlify-történet átemelve, a proper-scoring/kalibráció a teljes múlton fut.
3. **Signal-parity check:** az `api` signal-combiner outputja bit-közelre egyezik a Netlify-éval (ugyanaz a kód portolva) — 24-48h összevetés.
4. **Model-service bekötése:** a `model` (Chronos-Bolt vol/distribution + kalibráció) mint a discovery #2/#5/#10 — a workerek HTTP-n kérik, a proper-scoring harness (#1) méri a javulást.
5. **Pillérenkénti cutover live-ra:** a legkisebb/legismertebb pillér (crypto) először, a Netlify-cron kikapcs, a Docker-worker veszi át. Egyesével a többi.
6. **Netlify nyugdíjazás:** amikor mind az 5 pillér Dockeren fut és a paritás igazolt.

---

## 17. Mit NEM csinálunk (tudatos, Docker-kontextus)

- **Kubernetes** — 1 VPS, ~12 konténer → a Compose elég; k8s csak multi-node skálán.
- **Külön DB-konténer-host** — Phase 2, ha a Postgres > 50 GB vagy a model-service CPU-éhes (akkor a `model` külön GPU-node-ra is mehet).
- **Docker Swarm / rolling multi-replica** — a pillérek single-instance-ek (WS/állapot); nem replikázunk.
- **Saját registry** — GHCR elég.

---

**Következő lépés (a következő migráló sessionnek):** a repo `apps/`+`services/`+`packages/` átszervezése (a mostani `src/` + `netlify/functions/` szétbontása), a `packages/core/ledger.ts` Postgres-port + a `services/model` FastAPI skeleton. A fázissorrend a [`hetzner-migration.md`](./hetzner-migration.md)-ben.
