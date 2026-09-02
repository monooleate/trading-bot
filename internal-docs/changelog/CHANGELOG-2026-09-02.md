# CHANGELOG — 2026-09-02

## Hetzner-migráció — Phase 0 + Phase 1 (repo-restrukturálás monorepóvá)

**Kontextus:** a [migration-runbook.md](../roadmap/migration-runbook.md) végrehajtásának kezdete — a Netlify + Blobs EdgeCalc rendszer átköltöztetése az `analytics` Hetzner-boxra (Docker Compose co-host a umami mellett, Postgres-állapot). Ez a session a **Phase 0** (döntések + secret-leltár) és a **Phase 1** (repo-restrukturálás) — **kód-logika NEM változott**, csak a fájlszerkezet + import-útvonalak. Paper mode végig, a Netlify a `main`-en érintetlenül fut (strangler).

### Branch

- Új branch **`feat/hetzner-migration`**, a `feat/forecasting-harness-and-ledger`-ről ágazva. A forecasting A-lépcső (#1–#9, 10 teszt-suite) reviewelhető marad, a nagy restruktúra izolált. **NEM** merge-eltük a `main`-be → a live Netlify-deploy (`mj-trading.netlify.app`) érintetlen.

### Phase 0 — secret-leltár + `.env.example` ✅

- Teljes `process.env` scan (services + packages + apps, ~100 hivatkozás). A tuning-knobok (crypto/weather/HL/F-arb/sports sizing + threshold) kód-defaulttal opcionálisak — az `.env.example` csak a **secret + infra + mode** kötelezőket sorolja, grouped formában (mode / Postgres[új] / auth / HL / Polymarket / exchange / LLM / Telegram / optional). A teljes 61-vár katalógus az [`env-vars.md`](../current-state/env-vars.md) marad.
- **Új infra-secret:** `EDGECALC_DB_PASSWORD` + `DATABASE_URL` (a §18.2 edgecalc Postgres-user, a umami postgres:17 konténerben izolált DB+user). A valós titkok NINCSENEK gitben → Phase 5-ben a szerver `/opt/edgecalc/.env`-jébe (chmod 600).

### Phase 1 — repo-restrukturálás (monorepo) ✅ — mind a 3 acceptance-gate zöld

**Cél-szerkezet ([hetzner-docker-setup.md §4](../roadmap/hetzner-docker-setup.md)): `apps/web` + `services/{api,worker,feeds}` + `packages/core`.**

**Mozgatások (mind `git mv` → history megőrizve, 176 rename detektálva):**

| Honnan | Hová | Megjegyzés |
|---|---|---|
| `src/`, `public/`, `astro.config.mjs`, `tailwind.config.mjs` | **`apps/web/`** | egészben → 0 frontend-import churn. Új `apps/web/{package.json,tsconfig.json}` |
| `auto-trader/shared/{prediction-ledger,har-rv,first-passage,deribit-rnd,devig}.mts` + `types.mts` + a 10 forecasting teszt | **`packages/core/src/`** | pure math + shared types. `prediction-ledger` egyelőre **még `@netlify/blobs`** (a Blobs→Postgres = Phase 2) |
| `edge-tracker/{statistics,calibration,online-weights}.mts` | **`packages/core/src/`** | proper-scores + kalibráció + AdaHedge |
| `auto-trader/` (teljes fa) | **`services/worker/src/pillars/`** | crypto/weather/hyperliquid[+funding-arb nested]/sports/macro/politics/shared/index/registry-bootstrap — belső struktúra megőrizve |
| `auto-trader-multi-cron.mts`, `scheduled-scan.mts` | **`services/worker/src/`** | §13: Phase 3-ban a belső scheduler váltja |
| ~25 endpoint `.mts` + `_auth-guard.ts` + `_resolution-risk.ts` + `edge-tracker/mock-trades.mts` | **`services/api/src/routes/`** | signal/tool/status/trade endpointok |
| — | **`services/feeds/`** | placeholder README (Phase 3 / B-lépcső) |

**Import-repair — path-aliasok (`tsconfig.json` `paths`):**
- `@core/*` → `packages/core/src/*`, `@worker/*` → `services/worker/src/*`, `@api/*` → `services/api/src/*`.
- A cross-boundary importok stabil, forrás-mélységtől független egy-string specifierré váltak (`@core/types.mts` mindenhonnan ugyanaz). A repair **`tsc`-vezérelt** volt: minden `TS2307 Cannot find module`-t az alias-célra pointoltunk, iteratívan (105 → 0 hiba). A `./types.mts` kétértelműséget (bot-lokális `types.mts` vs a mozgatott shared) `pillars/shared/`-ra scope-olt sed oldotta meg → a per-bot `types.mts`-ek érintetlenek.
- A **`tsx` futásidőben is honorálja** a tsconfig `paths`-t → a tesztek alias-importtal is futnak (nem kellett runtime-shim).

**Within-`packages/core` javítások (kézi):** a 3 edge-tracker modul `../auto-trader/shared/types.mts` → `./types.mts`; a proper-scores/calibration/online-weights tesztek `../../edge-tracker/X.mts` → `./X.mts`.

**Új tooling:**
- `scripts/run-tests.mjs` — cross-platform test-runner (minden `*.test.mts` tsx-szel, opcionális path-filter).
- Root `package.json` monorepo-scriptek: `typecheck` (`tsc --noEmit`), `test` (a runner), `build`/`build:web`/`dev`/`preview` (delegál `apps/web`-re). Deps változatlanul a root `node_modules`-ban (Phase 1 egyszerűsítés; a per-service split + npm-workspaces = Phase 3). `tsx` + `typescript` felvéve devDeps-be.
- `.dockerignore` + `.env.example` a repo-gyökérben (a §4 tree szerint).
- `.gitignore`: `_*.json` (lokális state-dump artifactok) + a mozgatott build-outputok (`dist/`, `.astro/` már fedve). Stale root `dist/` + `.astro/` törölve.

**Acceptance-eredmény:**
- ✅ `tsc --noEmit` → **exit 0** (a teljes új szerkezeten).
- ✅ `packages/core` → **10/10** forecasting teszt-suite zöld; teljes suite **23/23** zöld (a 13 worker-teszt is, alias-importtal).
- ✅ `apps/web` astro build → **zöld** (10 oldal, a hoisted root `node_modules`-ból).

**Ismert, Phase-later tételek (NEM regresszió):**
- A `netlify.toml` ezen a branchen elavult (üres `netlify/functions`-ra mutat) — a Netlify a **main**-ről deploy-ol, ezt a branchet nem. Deploy-config tisztítás → Phase 5/6.
- Per-service `package.json` + Dockerfile-ok + npm-workspaces → Phase 3.
- Az api↔worker cross-importok (`@worker/*` az api-ban, `@api/routes/trader-settings` a workerben) átmeneti layering — a Phase 3 (a settings → `packages/core`/Postgres, a scheduler → worker) tisztítja. Phase 1-ben tudatosan megtartva a zéró-logika-változás érdekében.

---

## Hetzner-migráció — Phase 2 + Phase 3 + Phase 4-tooling (ugyanaznap, folytatás)

A user: *„hozd szinkronba a main-nel az összes branchet … main-re menjen a push-od is"* + *„Normalized, proceed"* (session-séma) + *„nem baj ha az elő oldal nem lesz elérhető a migráció végéig. csak én használom!"* + *„folytasd a teljes implementálást"*.

### Branch-konszolidáció

A `feat/hetzner-migration` + `feat/forecasting-harness-and-ledger` **fast-forward a `main`-re** (12 forecasting commit + a Phase 1 restruktúra), **push `origin/main`** (`57be7e5..b273580`). Törölt (mind a main őse): `feat/hetzner-migration`, `feat/forecasting-harness-and-ledger`, `fix/p0-profitability-fixes`. **A Netlify main-deploy ezzel törött (üres `netlify/functions`) — a user tudatosan vállalta** (paper-only, egyszemélyes). A `main` a single trunk; a további migráció is ide megy.

### Phase 2 — `packages/core` Postgres-alap (valós SQL-en tesztelve PGlite-tal)

Session-séma-döntés: **normalizált** (§11.1). A pure logika változatlan; csak az I/O új.
- `db.ts` (Db/TxDb: `pg` Pool prod / PGlite teszt + `tx()` + coerce), `env.ts` (zod), `migrate.ts` (idempotens, `schema_migrations`).
- `ledger.ts` — a pure fn-ek 1:1 re-export; Blobs whole-array → `upsert ON CONFLICT (category,slug)` + prune (§8).
- `session-store.ts` — normalizált `pillar_session`/`pillar_open_position`/`pillar_closed_trade`, **mode-aware** (paper/live, PK `(category,mode)`); generikus mind az 5 botra (known scalars→oszlop, context→JSONB residual).
- `settings-store.ts` (KV). `migrations/001..006`. `services/api/src/migrate.ts` (`--profile migrate`).
- Teszt: `pg-roundtrip.test.mts` (14) — migrations-idempotencia, ledger save/load/upsert/prune/append/stats, normalizált session + HL-residual + paper/live izoláció, settings CRUD.

### Phase 3a — Bun-runnability: Netlify Blobs compat facade

`blobs-compat.ts` = drop-in `getStore()`: durable→Postgres `blob_kv` (migr. 006), `*-cache`→in-process. A `tsconfig` **aliasolja `@netlify/blobs` → compat** → az EGÉSZ worker/api kód **változatlanul** fut Bun+Postgres-en (tsc zöld az aliasszal = a compat API mindent lefed). Teszt: `blobs-compat.test.mts` (11).

### Phase 2 (normalizált sessions bekötése, churn nélkül)

A compat facade **maga dispatch-eli** a session-store-okat a normalizált táblákra (`sessionRoute` (store,key)→(category,mode)) → a session-managerek (write) ÉS az edge-tracker/multi-status (read) **változatlanul, konzisztensen** a normalizált táblát használják. Archive-kulcsok + F-Arb (dokumentum-alakú `ArbSessionState`) → blob_kv.

### Phase 3 — Bun entrypointok + model service + Docker stack

- `worker/src/{main.ts,scheduler.ts}` — belső ütemező, a meglévő dispatchert hívja (0 duplikáció), `setBlobsDb(pool)` induláskor.
- `api/src/server.ts` — `Bun.serve` router (nincs framework — a handlerek eleve Fetch); `/.netlify/functions/<name>` (0 frontend-churn) + `/api/<name>` + `/health`.
- `services/model/app/*` (FastAPI): `/health`, `/vol`, `/forecast` (Chronos load-on-demand + naive fallback), `/calibrate`, `/score`. Nehéz depek a 16 GB-tier-ig kommentben; súly nélkül bootol. Pure fn-ek smoke-tesztelve (Python 3.14).
- Dockerfile-ok (worker/api Bun, web Astro-export, model Python) + `docker-compose.yml` (§18.3 co-host + migrate profil) + `infra/caddy/trade.Caddyfile.snippet` (§18.4).

### Phase 4 — data-migráció TOOLING (végrehajtás megerősítés-köteles)

- `scripts/export-blobs.mjs` (netlify CLI → `blobs-export.json`), `services/api/src/import-blobs.ts` (a compat facade-on át → session→normalizált, ledger/KV→blob_kv; idempotens).

**Minden lépésnél `tsc --noEmit` exit 0 + a teljes teszt-suite 25/25 zöld.** Commitok a `main`-en: `b273580` (Phase 0/1) → `1e92df9` (Phase 2 core) → `0458fa8` (3a compat) → `cb081c1` (normalized sessions) → `a98d4e2` (Phase 3 services+docker) → `612058d` (Phase 4 tooling).

### Hátralévő (operatív, szerver + megerősítés kell)

- **Phase 5 (deploy az `analytics`-ra):** `/opt/edgecalc` + `.env` (valós titkok, chmod 600) + `edgecalc` DB (§18.2) + `migrate` + `docker compose up -d --build` + `apps/web` export a caddynek + `trade.<domain>` Caddy-blokk. **Operátor futtatja** (SSH read-only/install-only szabály + secret-kezelés).
- **Phase 4 (adat-import) ⚠ + Phase 6 (parity + cutover) ⚠ — explicit megerősítés-kötelesek.**
- **Ledger normalizálás bekötése** (prediction_ledger tábla live) — koordinált worker+api follow-up (jelenleg blob_kv).
- **Phase 7:** a `model` Chronos-Bolt súly bekötése (16 GB rescale után).

---

## Hetzner-migráció — Phase 5 DEPLOY (a stack ÉL, paper) + read-only prep

A user: „start the read-only Phase 5 prep over SSH" → majd „nekem feladat csak az env-ek rögzítése legyen" → a Caddy-hoz „trade.jmeszaros.dev, Yes after I set DNS" + „a netlify törlés csak akkor ha mondod, folytasd a tervet".

### Read-only prep (SSH, semmi nem változott a szerveren, umami érintetlen)
CX33 (4 vCPU/7.6GB/2GB swap/66GB szabad), Docker 29.7+Compose v5.4, `analytics_edge`+`analytics_internal` megvan, umami healthy (`analytics-db-1`=postgres:17-alpine, alias `db`, superuser `umami`). **TLS-korrekció:** stock `caddy:2-alpine` (nincs cloudflare DNS plugin) + nincs CF token → a `trade.` blokk plain auto-HTTPS (a snippet javítva).

### Install (én, secret nélkül)
`git clone /opt/edgecalc`, `.env` skeleton (chmod 600), `docker compose build` (workers/api/model) + web-export. **Az operátor egyetlen feladata:** `.env` 3 érték (`EDGECALC_DB_PASSWORD`/`JWT_SECRET`/`AUTH_PASSWORD_HASH`) + a `CREATE USER/DATABASE` (guardrail: account-létrehozást nem én csinálok). A `psql -c :'pw'` behelyettesítés nem ment → heredoc-os javított parancs.

### Deploy-közbeni build-fixek (commitolva)
- `services/api/Dockerfile`: `COPY migrations/` (a migrate-runner `/app/migrations`-t olvas) — a `migrate` külön image-ét `--build`-del újra kellett húzni.
- **Az `api` szolgálja a statikus frontendet** (`server.ts` serveStatic + web-build stage az api-image-ben) → egy origin (Caddy→edgecalc-api), **nulla umami-compose módosítás** (nem kell dist-mount a umami-caddyba).
- `workers` a `edge` hálóra is: az `analytics_internal` `internal:true` (nincs egress), a botok ETIMEOUT-oltak a tőzsdékre.

### Élesítés + verifikáció
`migrate` (8 tábla) → `docker compose up -d`. **Normalizált Postgres-írás él** (4 `pillar_session` paper sor, `pillar_open_position` a paper-orderekkel, `blob_kv` run-state). `api /health` ok; **valódi paper-order-ök nyílnak** (weather Paris, sports). RAM ~135 MB edgecalc / 6.2 GB szabad / **0 swap**.

### Caddy + public URL
`trade.jmeszaros.dev` blokk a `/opt/analytics/Caddyfile`-ba (backup + `caddy validate` throwaway-konténerrel — **elkapott egy inline `log{}` szintaxishibát**, javítva → `docker compose -p analytics up -d --force-recreate caddy`). **LE cert kiállítva (TLS-ALPN-01)**, umami végig healthy. Public: `GET / → 200` (frontend, cert valid), `/.netlify/functions/multi-status → 200`, `/trade/crypto/ → 200`, `http → 308`. DNS: A `91.99.218.165` + AAAA `2a01:4f8:c014:1d5::1` (Netlify DNS, nincs Cloudflare); a box IPv6-ja egyezik az AAAA-val (ACME inbound OK az egress-IPv6 hiánya ellenére).

**Commitok:** `348bed8` (api serves frontend) → `4ca5b17` (Dockerfile migrations) → `3627f63` (workers egress) → docs.

### HÁTRA — Phase 4 (adat-migráció) ⚠ a Netlify-törlés ELŐTT
A Netlify Blobs (teljes paper-history + IC-kalibráció + ledger) **csak a Netlify-en él**; a Docker-stack üresen indult. **A Netlify projekt törlése végleg törli ezt.** A user dönt: (a) history-migráció (`netlify login/link` → `export-blobs.mjs` → scp → `import-blobs.ts`), vagy (b) tiszta indulás. A user a Netlify-t **csak explicit jelzésre** törli.

### Phase 4/6 döntés (2026-09-02)
A user **tiszta indulást** választott — a Netlify Blobs history NEM lett átemelve (a box üres sessionökkel fut). Zöld jelzés a **trading SITE** törlésére (a box Netlify-független: workers/api/model + Postgres mind a boxon). ⚠ A **Netlify DNS-zóna maradjon** — a `stats.jmeszaros.dev` (umami) ÉS a `trade.jmeszaros.dev` is azon a zónán van (A `91.99.218.165` + AAAA `2a01:4f8:c014:1d5::1`). A migráció ezzel **funkcionálisan kész**; nyitott opcionális: ledger→prediction_ledger tábla, Phase 7 Chronos-súly.
