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

### Következő lépés

**Phase 2 — `packages/core` Blobs→Postgres adapter** (a load-bearing lépés): `db.ts` (pg pool) + `env.ts` (zod) + `ledger.ts` port (a pure fn-ek változatlanul, csak a `loadLedger`/`saveLedger` → Postgres `ON CONFLICT`) + a session-state/settings I/O + `migrations/*.sql`. Nyitott döntés a Phase 2 elejére: `pillar_state_*` blob-modell vs normalizált táblák (runbook §11.1). Runbook-tracked.
