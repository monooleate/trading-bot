# Migration Runbook — EdgeCalc: Netlify → `analytics` Docker co-host

> **Cél:** ez a **végrehajtható, fázisokra bontott runbook** a következő session(ök)nek: a jelenlegi Netlify + Blobs rendszert átköltöztetni az **`analytics`** Hetzner-boxra (Docker Compose co-host a umami mellett), Postgres-állapottal, majd a B-lépcső ML-t bekötni.
>
> **Viszony a többi doksihoz:** a **topológia + compose + Dockerfile-ok** a [`hetzner-docker-setup.md`](./hetzner-docker-setup.md)-ben (fő: **§18** co-host + **§4** repo-szerkezet + **§8** séma). Ez a fájl az **időrendi végrehajtás** (fázis, acceptance, parancs, rollback). Az absztrakt 7-fázis: [`hetzner-migration.md`](./hetzner-migration.md).
>
> **Dátum:** 2026-09-02

---

## 0. Kickoff prompt (másold be a köv. session indításához)

```
Olvasd el: internal-docs/roadmap/migration-runbook.md (ez a terv) + a
hetzner-docker-setup.md §18 (co-host topológia) + §4 (repo-szerkezet) + §8 (séma).

Feladat: a Netlify+Blobs EdgeCalc rendszer átköltöztetése az `analytics` Hetzner-boxra
(Docker Compose co-host a umami mellett, Postgres-állapot). A runbook Phase 1-től indul.

Állapot amiből indulsz:
- A forecasting A-lépcső (#1–#9) KÉSZ a `feat/forecasting-harness-and-ledger` branchen —
  mind pure-TS, default-off/mérés-first, 10 teszt-suite zöld, NEM deployolva. A pure
  modulok 1:1 átjönnek; csak a Blobs→Postgres adapter + a Bun-entrypoint új.
- Az `analytics` box (ssh alias: `analytics`, IP 91.99.218.165) rescale-ve: CX33
  (4 vCPU / 8 GB / 75 GB), 2 GB swap + swappiness=10 beállítva, futó umami Docker-stack
  (caddy + umami + postgres:17, `analytics_edge` / `analytics_internal` hálók).

Eldöntve: a Postgres a MEGLÉVŐ umami-konténer újrahasznosítása (külön `edgecalc` DB +
user, izolálva) — NEM új Postgres. Lásd Phase 2 + §18.2.

Szabályok:
- Fázisonként dolgozz, minden fázis végén futtasd az acceptance-check-et.
- SSH-n a szerverre CSAK olvasás/telepítés — a umami-konténerekhez NE nyúlj.
- Phase 4 (adat-migráció) és Phase 6 (cutover) ELŐTT kérj megerősítést tőlem.
- Paper mode végig; a Netlify párhuzamosan fut (strangler), amíg a parity nincs meg.

Kezdd a Phase 1-gyel (repo-restrukturálás). Minden lépést dokumentálj a changelogban.
```

---

## 1. Pre-flight — amiből indulunk (checklist)

- [x] **Rescale kész** — `analytics` = CX33 (4 vCPU / 8 GB / 75 GB), SSH-verifikált.
- [x] **Swap kész** — 2 GB `/swapfile` + fstab + `vm.swappiness=10`.
- [x] **umami-stack ép** — caddy + umami + postgres:17 `healthy`, `analytics_edge`/`analytics_internal` hálók.
- [x] **Forecasting A-lépcső kész** — branch `feat/forecasting-harness-and-ledger` (#1–#9, default-off, tesztelt).
- [ ] **Branch mergelve** a `main`-be (vagy a migráció róla indul) — **Phase 0 döntés**.
- [ ] **Secret-leltár** (lásd Phase 0).

---

## 2. Phase 0 — Döntések + secret-leltár (kód előtt)

**Feladatok**
1. **Branch:** merge `feat/forecasting-harness-and-ledger` → `main` (a repo-restrukturálás innen indul), vagy a migrációt külön branchen kezdd.
2. **Secret-leltár** (a `current-state/env-vars.md` alapján) — mi kell a szerver `/opt/edgecalc/.env`-be:
   - Meglévő: `HL_PRIVATE_KEY`, `HL_WALLET_ADDRESS`, `POLY_PRIVATE_KEY` (+ funder/sig), `BYBIT_API_KEY/SECRET`, `BINANCE_*` (ha kell), `ANTHROPIC_API_KEY`, `JWT_SECRET`, `AUTH_PASSWORD_HASH`, `TELEGRAM_BOT_TOKEN` + chat-id-k, `POLYGON_RPC_URL`.
   - **Új:** `EDGECALC_DB_PASSWORD` (a §18.2 edgecalc Postgres-user), `DATABASE_URL` (a workerek/api).
   - **Opcionális:** `ODDS_API_KEY` (a #9 sports odds-feedhez — a-lépcső data-task, nem blokkoló).
3. **`.env.example`** összeállítása (secret-értékek NÉLKÜL) a repóba.

**Acceptance:** branch-döntés megvan; teljes secret-lista + `.env.example` kész; a szerver-oldali titkok elérhetők (nem a git-ben).

---

## 3. Phase 1 — Repo-restrukturálás (monorepo)

A cél a [`hetzner-docker-setup.md` §4](./hetzner-docker-setup.md) szerkezet: `apps/web`, `services/{api,worker,feeds,model}`, `packages/core`, `infra/`, `migrations/`.

**Feladatok**
- `src/` → `apps/web/` (Astro frontend, `Dockerfile` a §6 build-stage szerint).
- `netlify/functions/` szétbontása:
  - a **pure forecasting modulok** (`auto-trader/shared/{proper-scores? →,prediction-ledger,calibration? (edge-tracker/), online-weights? (edge-tracker/), har-rv,first-passage,deribit-rnd,devig}` + `edge-tracker/{statistics,calibration,online-weights}`) → **`packages/core`** (változatlan logika).
  - a botok (`auto-trader/{crypto,weather,hyperliquid,funding-arb,sports}` + `shared`) → **`services/worker/src/pillars/`**.
  - az endpointok (`edge-tracker.mts`, `signal-combiner.mts`, `multi-status.mts`, `*-panel` functions, `trader-settings.mts`) → **`services/api/src/routes/`**.
  - a WS-feed logika (ha van) → **`services/feeds/`**.
- **Fontos:** a `.mts` tesztek (`*.test.mts`) átjönnek a modulokkal — a köv. session futtassa őket a port után (regresszió-védelem).

**Acceptance:** `tsc --noEmit` zöld az új szerkezeten; a 10 forecasting teszt-suite zöld a `packages/core` alól; `apps/web` build zöld.

---

## 4. Phase 2 — `packages/core` — a Blobs→Postgres adapter (a load-bearing lépés)

A pure logika változatlan; **csak az I/O-adapter cserélődik** (Netlify Blobs → Postgres).

> **✅ DÖNTVE (2026-09-02) — Postgres: ÚJRAHASZNÁLÁS, nem új telepítés.** A meglévő umami `analytics-db-1` (postgres:17) konténerbe egy **külön `edgecalc` adatbázis + `edgecalc` user** kerül (jogok csak a saját DB-jén — §18.2). A umami és az edgecalc DB **izolált** (külön adatbázis + user + grant; egy edgecalc-séma-hiba a umami adatait nem érinti — standard „egy instance, több DB" minta). Indok: −150 MB RAM (nincs 2. Postgres), a `db` már fut/hangolt/backupolt.
> **Trade-off (tudatos):** közös instance = közös erőforrás-keret (a `db` `mem_limit: 1g`-jén a umami+edgecalc query-i osztoznak). Paper-trading + cron-tick terhelésre bőven elég; ha az edgecalc DB-terhelés nő → a `db` `mem_limit` emelése, vagy külön **`edgecalc-db` konténerre** bontás (triviális, +150 MB) — **escape hatch**, nem most.

**Feladatok**
- `packages/core/db.ts` — `pg` pool a `DATABASE_URL`-re.
- `packages/core/env.ts` — zod-validált env.
- `packages/core/ledger.ts` — a `prediction-ledger.mts` portja: a **pure** `upsertRecords`/`capRecords`/`yesOutcomeFromClosedTrade`/`fillOutcomesFromClosedTrades`/`computeLedgerStats` **változatlan**; a `loadLedger`/`saveLedger` (Blobs) → Postgres `INSERT … ON CONFLICT (category,slug) DO UPDATE` a `prediction_ledger` táblára (§8 séma).
- **Session-state I/O** — a `getStore(...)` alapú session load/save (crypto/weather/hl/arb/sports) → Postgres táblák (`pillar_state_*` blob-modell VAGY normalizált — a hetzner-infrastructure.md §4 két opciója; **döntés a köv. session elején**).
- **Settings** (`trader-settings.mts` Blobs-override) → Postgres `settings` tábla (vagy `.env` + egy kis KV-tábla).
- `migrations/` — `001_init.sql`, `002_trade_log.sql`, `003_prediction_ledger.sql` (a séma §8-ból), `004_pillar_state.sql`, `005_settings.sql`. **Idempotens** (`IF NOT EXISTS`).

**Acceptance:** a ledger + a session-I/O pure tesztek zöldek; egy lokális Postgresen a ledger round-trip (upsert→load) egyezik; `docker compose --profile migrate run migrate` lefut tisztán.

---

## 5. Phase 3 — `services/` (worker, api, model)

**Feladatok**
- `services/worker/src/main.ts` — `PILLARS` env → az 5 pillér-loop; `scheduler.ts` = `setInterval(tick, LOOP_INTERVAL_SEC*1000)` + azonnali első tick (a Netlify cron helyett). A pillérek logikája a `pillars/`-ból, a state a `packages/core` Postgres-adapterén.
- `services/api/src/server.ts` — Bun HTTP router (Hono/Elysia); route-ok: `/api/status`, `/api/edge-tracker` (properScores/calibrationEval/onlineWeightsEval/ledgerStats), `/api/signal-combiner`, `/api/tools/*`. Auth: a meglévő JWT (`JWT_SECRET`, `AUTH_PASSWORD_HASH`).
- `services/model/app/main.py` — FastAPI: `/forecast`, `/vol` (HAR-RV cross-check / RealizedGARCH), `/calibrate` (isotonic/Venn-Abers), `/score` (CRPS). **Chronos-Bolt load-on-demand** (idle-ben nem tartja bent a súlyt). `requirements.txt`: fastapi uvicorn torch chronos-forecasting arch scikit-learn mapie properscoring.
- Dockerfile-ok a §6 szerint (Bun worker/api, Python model).
- **A default-off knobok viselkedése változatlan** — a workerek ugyanazt a logikát futtatják; a #5/#7 külső fetch (Deribit/daily-OHLC) + a #B model-hívás a `services/model`-en át megy (a knob ON-nál).

**Acceptance:** `docker compose build` sikeres; minden service elindul; `curl trade.<domain>/api/status` válaszol; a `model` `/health` OK (súly nélkül, idle).

---

## 6. Phase 4 — Adat-migráció (Blobs → Postgres) ⚠ MEGERŐSÍTÉS ELŐTTE

**Feladatok**
1. **Export** (Netlify): egy admin-endpoint / `netlify` CLI kiírja minden store-t JSON-ba (`prediction-ledger/*`, `auto-trader-state/*`, `hyperliquid-session-v1/*`, `hyperliquid-arb-session-v1/*`, `auto-trader-session-sports/*`, `trader-settings`).
2. **Transfer** → `scp` a VPS-re.
3. **Import** — `services/api/src/import-blobs.ts` one-shot (`--profile migrate` mintára): JSON → Postgres (`prediction_ledger`, `pillar_state_*`, `settings`).

**Acceptance:** a sorok száma egyezik (export vs Postgres); az `api` edge-tracker route ugyanazt a történelmet + proper-scores-t adja, mint a Netlify.

---

## 7. Phase 5 — Deploy az `analytics`-ra (strangler — a Netlify MÉG fut)

**Feladatok** (a §18.2–18.5 lépéssora)
- `/opt/edgecalc` + repo/build-kontextus; `.env` (chmod 600); `edgecalc` DB (§18.2); `migrate` (§18.5); `docker compose up -d --build`.
- `apps/web` build → `dist` a caddynek; `trade.<domain>` Caddyfile-blokk (§18.4) + `docker compose -p analytics up -d --force-recreate caddy`; DNS A-rekord (proxy KI).
- **PAPER mode**, minden default-off knob a jelenlegi állapoton.

**Acceptance:** `https://trade.<domain>` szolgál; `docker compose ps` mind `Up`; a workerek tickelnek (`logs -f workers`); a **ledger tölt** + a proper-scores kártyák renderelnek; `free -h` stabil (< 0.5 GB swap).

---

## 8. Phase 6 — Parity + cutover ⚠ MEGERŐSÍTÉS ELŐTTE

**Feladatok**
- **Signal-parity:** az `api` signal-combiner outputja bit-közelre egyezik a Netlify-éval (ugyanaz a kód) — 24–48h összevetés azonos slug-okon.
- **Pillérenkénti cutover:** a legkisebb/legismertebb pillér (crypto) először — a Netlify-cron kikapcs arra a pillérre, a Docker-worker veszi át. Egyesével a többi.
- **Netlify nyugdíjazás:** amikor mind az 5 pillér Dockeren fut és a paper-parity igazolt.

**Acceptance:** paper PnL parity pillérenként (a cutover előtti/utáni ledger egyezik); a Netlify-cronok leállítva; a Docker-stack a single source.

---

## 9. Phase 7 — B-lépcső ML bekötése (a co-host már bírja)

**Feladatok**
- A `services/model` bekötése: a workers a `http://model:8000/vol` (Chronos-Bolt distribution / RealizedGARCH) + `/calibrate` (isotonic/Venn-Abers) végpontokat hívja a **meglévő default-off knobok mögött** (#5 σ-forrás, #2 kalibráció live).
- **Mérés-first:** a #1 proper-scoring harness az Edge Trackeren mutatja, javít-e; a knobot csak **pozitív walk-forward gain** után kapcsold ON, egyesével.

**Acceptance:** a `model` konténer idle ~0.3 GB / csúcs ~2 GB (mem_limit 2.5g); a `/vol` válaszol; a #1 harness a bekapcsolt módra méri a Brier-t.

---

## 10. Rollback + kockázatok

- **Minden fázis visszafordítható; a Netlify Phase 6-ig ÉL** (strangler) → bármikor visszaállás.
- **Data-migráció:** az import idempotens (`ON CONFLICT`); a Blobs-export megmarad backupként.
- **RAM:** `free -h` + `docker stats` figyelése; ha tartós >0.5 GB swap → a `model` mem_limit / load-on-demand TTL hangolása, végső esetben 16 GB rescale.
- **Titkok:** `.env` chmod 600, sosem a git-ben; a `db` az `internal`-hálón, port nélkül.
- **umami-izoláció:** külön compose-projekt (`edgecalc`), mem_limitek → egy trading-hiba a umami-t nem viszi.

---

## 11. Nyitott döntések a köv. session elejére

> **Már eldöntve (nem kell újra-tárgyalni):** **Postgres = a meglévő umami-konténer újrahasznosítása** (külön `edgecalc` DB + user) — lásd Phase 2 + §18.2. Külön `edgecalc-db` konténer csak escape-hatch, ha a DB-terhelés nő.

1. **Session-state séma-ALAK** (a reuse-on belül): `pillar_state_*` blob-modell (gyors port) VS normalizált táblák (jobb lekérdezhetőség) — a hetzner-infrastructure.md §4 két opciója. *(A tároló-instance eldöntve; csak a tábla-alak nyitott.)*
2. **Bun router:** Hono vs Elysia.
3. **Branch:** merge main-be vagy külön migráció-branch.
4. **Redis:** kihagyva az A-lépcsőben; a B-lépcső feed/pubsubhoz később.
5. **Odds-feed (#9):** melyik provider (the-odds-api free tier?) — külön data-task, nem blokkoló.
