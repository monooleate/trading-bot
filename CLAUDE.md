# EdgeCalc – CLAUDE.md

Ez a fájl minden Claude Code session elején betöltődik — csak a mindig érvényes tudást tartja. A területi szabályok a `.claude/rules/`-ban élnek (fájl-útvonal szerint töltődnek be), a régi session-narratívák a `CLAUDE-HISTORY.md`-ben (NEM töltődik be).

> **Session-narratíva SOHA nem kerül ide.** A session-leírás helye `internal-docs/changelog/CHANGELOG-YYYY-MM-DD.md`; a tartós tanulság (csapda mechanizmussal, invariáns, operátor-döntés) 1–2 soros szabályként a megfelelő `.claude/rules/<terület>.md`-be. Ez a fájl csak a ma igaz állapotot és a mindenhol érvényes szabályokat tartja.

**Session zárása:** minden érdemi (kód / knob / élő állapot / algoritmus) változás után futtasd a **`session-close`** skillt (`.claude/skills/session-close/SKILL.md`) — doksi-szinkron checklist + SSOT-szabályok. Ha nem volt érdemi változás, mondd ki: *„Nincs dokumentáció-frissítés szükséges, mert csak X történt."*

---

## Mi ez a projekt?

**EdgeCalc** — kvantitatív Polymarket trading dashboard + 5 paper-módú auto-trader bot. Nem copy-trade, nem affiliate: akadémiai irodalom alapú saját implementáció. A repo nyelve (doksik, kommentek, UI) magyar.

**Stack:** monorepo — `apps/web` (Astro 4 + React 18 + TS, CSS-változós design) · `services/api` (Bun, Fetch-handler route-ok) · `services/worker` (Bun, minden pillér-loop egy konténerben, belső ütemező) · `services/model` (Python FastAPI, load-on-demand Chronos) · `packages/core` (pure TS mag: ledger, kalibráció, kockázat, mérés) · Postgres (`migrations/`, a Netlify Blobs API egy `blob_kv`-compat rétegen át). Path-aliasok: `@core/*`, `@worker/*`, `@api/*`; az `@netlify/blobs` import a `packages/core/src/blobs-compat.ts`-re mutat.
**Élő:** `https://trade.jmeszaros.dev` — Hetzner `analytics` box Docker co-host (umami mellett), **paper mód**. A régi Netlify-deploy nyugdíjazva (a Netlify DNS-zóna marad).

## Mappaszerkezet

```
apps/web/src/          components/ (egy tab = egy *Panel.tsx; shared/ = TraderShell + kártyák; trader/ = per-bot UI), lib/math.ts, styles/global.css, pages/ (index, tools, trade/[category])
services/api/src/      server.ts (router: /.netlify/functions/<név> + /api/<név>), routes/*.mts, migrate.ts, import-blobs.ts
services/worker/src/   main.ts (payloadsFor), scheduler.ts, pillars/{crypto,weather,hyperliquid(+funding-arb),sports,shared,politics,macro}, recorders/
packages/core/src/     pure modulok + *.test.mts (prediction-ledger, fill-model, emos, risk-overlay, promotion-gate, …)
services/model/        Python ML service        migrations/  001–007 SQL        scripts/  eval-*/seed-emos/fit-har/run-tests
infra/                 caddy/ (trade. snippet), monitor/        internal-docs/  doksik (lásd lent)
*.py (gyökér)          4 standalone CLI elemző script (apex_wallet_profiler, vol_divergence, orderflow_analyzer, conditional_prob_matrix)
```
A `{src/` és `{src/{components,pages,layouts},public}/` mappák régi build-artefaktok — ignoráld (nem hiba). A `package-lock.json`-t ne szerkeszd kézzel.

## Az 5 auto-trader bot (+ politics/macro stub)

| Kategória | Kód | Stratégia | Ma (2026-09-30) |
|---|---|---|---|
| `crypto` | `pillars/crypto/` + `pillars/index.mts` + `api/routes/signal-combiner.mts` | 8–9 signal combiner, BTC/ETH/SOL short-piacok | fut; csak a threshold (`above-K`) ág nyithat |
| `weather` | `pillars/weather/` | multi-model ensemble + EMOS → Polymarket hőmérséklet-bucketek | measure-only (`weatherHalt`=1) |
| `hyperliquid` | `pillars/hyperliquid/` | HL directional perp | measure-only (`directionalHalt`=1) |
| `funding-arb` | `pillars/hyperliquid/funding-arb/` | HL/Binance funding-spread, delta-neutrális | fut |
| `sports` | `pillars/sports/` | Polymarket vs (tervezett) Pinnacle | MANUÁLISAN leállítva B37-ig |

Worker-tick: `LOOP_INTERVAL_SEC` 180 (`services/worker/src/main.ts`). Bot-registry: `internal-docs/current-state/bot-registry.md`.

## Az /tools/ tabok (`Dashboard.tsx` `TABS`)

| Tab | Komponens | Route(ok) | Technika |
|---|---|---|---|
| `scanner` / `ev` / `swarm` | `Dashboard.tsx` inline | `polymarket-proxy` / – / – | piac-lista + EV · Kelly · Monte Carlo |
| *(manuális venue-k, nem tab)* | `TradingPanel` a `trader/{Binance,Bybit,PolymarketManual}Trader.tsx`-ben | `binance-trade`, `bybit-trade`, `polymarket-trade` | JWT-auth, végrehajtás |
| `orderflow` | `OrderFlowPanel` | `orderflow-analysis` | Kyle λ, VPIN, Hawkes |
| `vol` | `VolDivergencePanel` | `vol-divergence` | IV−RV, BS-digital |
| `apex` | `ApexWalletsPanel` | `apex-wallets` | payout ratio, bot-detect |
| `condprob` | `CondProbPanel` | `cond-prob-matrix` | monotonicitás-sértések |
| `signals` | `SignalCombinerPanel` | `signal-combiner` | Grinold–Kahn IR = IC×√N |
| `arbmatrix` | `ArbMatrixPanel` | `vwap-arb`, `llm-dependency` | VWAP-arb, Claude |

Matematika: `internal-docs/math/` (02-ev-kelly … 40-maker-shadow). ¼-Kelly + 8% binary cap (`apps/web/src/lib/math.ts` `kellyBinary`). API-hostok: Gamma `gamma-api.polymarket.com` (lezárt piac csak `&closed=true`!), CLOB `clob.polymarket.com`, Data `data-api.polymarket.com`, Binance (`api`/`fapi`), Bybit, HL `api.hyperliquid.xyz/info`.

## Futtatás, teszt, deploy

```bash
npm install
npm run dev                      # apps/web, localhost:4321 (csak frontend)
npx tsc --noEmit                 # typecheck (CI-kapu)
node scripts/run-tests.mjs [szűrő]   # minden *.test.mts a packages/ + services/ alatt (tsx)
npm run build                    # apps/web build (CI-kapu)
```
**Deploy = push `main`-re**: `ci.yml` (tsc + tesztek + build) → `deploy.yml` rsync a boxra → `docker compose up -d --build`. Box: `ssh analytics`, `/opt/edgecalc`; Postgres: `analytics-db-1` konténer, DB `edgecalc`; migráció `docker compose --profile migrate run --rm migrate`. Részletek: `.claude/rules/infra-deploy.md`, `internal-docs/current-state/deploy.md`.
**„Kész"** csak: tsc 0 + teljes tesztsor zöld + build zöld (a számokkal jelentve).

## Mindig érvényes szabályok (biztonság + munkamód)

- **Paper mód marad** (`PAPER_MODE=true`). A live-flip B10-blokkolt: a box IP-je (DE) a Polymarketnél close-only (geoblock), SZTFH ISP-blokk, ESMA event-contract statement → jogi tisztázás kell; **a megkerülés nem opció**. `liveReadyOverrideEnabled`-et soha ne kapcsolj.
- **Operátor-jóváhagyás kell** minden élő állapot-módosításhoz: knob-írás, session reset/stop/resume/topup, bankroll-korrekció, box `.env`, konténer-recreate, éles DB-írás. A harness classifier a production DB-írást blokkolja → adj kész SQL-t/parancsot, az operátor futtatja. Felhasználótól kapott jelszót/credentialt ne használj fel — az operátor flippel a Settings-ben.
- **Mérés előbb, kapcsolás utána:** új viselkedés default-OFF knob mögé, OFF-nál bit-azonosan; élesítés csak a promóciós kapu / tisztességes OOS mérés pozitív bizonyítéka után. Hangolás nem teremt edge-et; ha a modell a piaci ár ellen veszít, küszöb-lazítás TILOS.
- **Élő állítást élőből igazolj**, ne a doksiból vagy egy régi session-összefoglalóból (több korábbi „diagnózis" tévesnek bizonyult). Read-only élő ellenőrzés: `ssh analytics` + worker-logok + belső `/multi-status`.
- **Knob-váltás után** a lenti „⚡ ÉLŐ knob-állapot" listát frissíteni kell (a napi `edgecalc-drift-check` ütemezett feladat ezt tekinti referenciának) + `appendTrial` a DSR-hez.
- **Sprint/backlog-feladat csak a `internal-docs/roadmap/sprints.md`-be** kerülhet (B-szám); máshova csak hivatkozás.
- Frank–Wolfe / Gurobi cond-prob solver licenc nélkül nem implementálható — permanens állapot, nem feladat.

## Hol élnek a szabályok (`.claude/rules/`)

| Fájl | Mikor töltődik be (paths) | Tartalom |
|---|---|---|
| `knobs-settings.md` | `trader-settings.mts`, `shared/config.mts`, `paper-never-stop.mts`, recommendations, `settings-store.ts`, `plateau/thompson/trial-cluster`, `SettingsPanel.tsx` | knob-életciklus, guardrail-osztályok, effektív getter, tartós stop |
| `prediction-ledger-measurement.md` | `packages/core` ledger/promotion-gate/walk-forward/config-fingerprint/build-info/sharpe/calibration/statistics/enb…, `edge-tracker*`, `EdgeTrackerPanel.tsx`, `scripts/eval-*.ts` | first-tuple latch, tisztaság, bucketId, codeVersion, kontrollok |
| `crypto.md` | `pillars/crypto/**`, `pillars/index.mts`, `signal-combiner`/`vol-divergence`/`cond-prob-matrix`, `coin/scan-slots/oi-delta/har/deribit/maker-shadow`, recorders | threshold-only, strike-parsing, új signal checklist, executable edge |
| `weather.md` | `pillars/weather/**`, `emos*`/`pooled-emos`/`multi-model-*`/`weather-dispersion`, weather scriptek | weatherHalt, σ-lánc, Open-Meteo kvirkek, állomások, EMOS |
| `hyperliquid-funding-arb.md` | `pillars/hyperliquid/**`, `funding-rates.mts`, HL/F-Arb trader UI | irány-forrás, Kelly-horgony, F-Arb saját bankroll, reverse paper-only |
| `sports.md` | `pillars/sports/**`, `devig*`, `eval-devig.ts`, `SportsTrader.tsx` | fabrikált fair value, B37, ledger-mezők |
| `execution-risk-shared.md` | `pillars/shared/**`, `*/decision-engine.mts`, `*/paper-resolver.mts`, fill-model/risk-overlay/portfolio-exposure, `auto-trader-api`, `multi-status` | gate-list minta, paper-PnL, fill-modell, vol-target, új bot |
| `api-routes.md` | `services/api/src/**`, `fetch-retry`, `blobs-compat`, `session-store`, `apex_wallet_profiler.py` | route-konvenció, cache-store név, auth, ANTHROPIC_MODEL, Gamma kvirk |
| `infra-deploy.md` | `docker-compose.yml`, `.github/workflows/**`, `infra/**`, Dockerfile-ok, `migrations/**`, db/env/migrate, worker main/scheduler, `.env.example`, `BUILD_INFO` | deploy-lánc, BUILD_INFO, box-topológia, Caddy-rejtés |
| `testing.md` | `packages/**/*.test.mts`, `services/**/*.test.mts`, `run-tests.mjs`, `ci.yml` | teszt-felfedezés, „kész" definíció, PGlite, kontrollok |
| `frontend.md` | `apps/web/**` | CSS-változók (nincs Tailwind utility), prefix, mobil, új tab/bot UI |
| `internal-docs.md` | `internal-docs/**` | SSOT: mi hova kerül, playbookok |

Skill: `.claude/skills/session-close/SKILL.md` — session-záró checklist + teljes SSOT-szabálylista.

## Doksik (`internal-docs/`)

- `README.md` — index, itt kezdj · `current-state/` — élő rendszer (architecture, deploy, env-vars [env-katalógus SSOT], settings-reference, trading-status, bot-registry, auto-claim)
- `math/NN-*.md` — algoritmusok · `roadmap/` — `sprints.md` (feladat-SSOT), `master-plan.md`, `new-strategies.md`, `model-discovery-*.md`, migrációs/Hetzner tervek
- `playbooks/` — `trade-history-audit.md` (audit-kérésnél KÖTELEZŐ), `system-audit.md`, `edgecalc-ops.md` · `changelog/CHANGELOG-YYYY-MM-DD.md` — session-history · `archive/` — kész promptok
- `CLAUDE-HISTORY.md` (repo gyökér) — a CLAUDE.md 2026-10-12 előtti narratívái és Netlify-korszaki szekciói, szó szerint.

---

## AKTUÁLIS ÁLLAPOT (2026-09-30)

> Utolsó dokumentált élő ellenőrzés: 98. session, 2026-09-30 (commit `66f9027`). Ami ennél frissebb, azt élőben ellenőrizd.

> **⚡ ÉLŐ knob-állapot — a drift-ellenőrzés referencia-listája (2026-09-28, 20 override, élőben verifikálva; `blob_kv` / `trader-settings` / `runtime-overrides-v1`):** `fillModelEnabled` 1 · `betaCapEnabled` 1 · `weatherUseEmos` 1 · `oiDeltaEnabled` 1 · `useHarRv` 1 · `useFirstPassage` 1 · `useDeribitIV` 1 · `riskVolTargetEnabled` 1 · `riskDdKillEnabled` 1 *(a 09-03-i B50-batch; a 10. kulcs, `combinerLogOddsStrength`, 09-09-én visszavonva — B56b)* · `weatherSelectionShrink` 1 · `weatherMaxPositionUSD` 15 · `frMinSpreadHourly` 0.00005 · `sportsSessionLossLimit` 50 · `sportsSessionLossLimitEnabled` 1 · `sessionLossLimit` 1000 *(a 6 visszaállított júliusi — B56)* · `weatherUseMultiModel` 1 *(B69, 2026-09-28: a multi-model keverék hajtja a weather μ/σ-t, SAJÁT EMOS-szal, a saját σ-szorzójával — `weatherMultiSigmaInflation`, kód-default 1,0, override NINCS)* · `weatherSigmaInflation` 1.25 *(2026-09-28: már CSAK a GEFS-útra és a keverék-lekérés hibájakor a GEFS-fallbackra hat; a forward logon mérve 1,2–1,4 a plató)* · `weatherEmosSeedWeight` 0.1 *(a GEFS-EMOS-tár seed-súlya; a flip óta csak a visszakapcsolási útra hat)* · **`weatherHalt` 1** *(B79, 2026-09-28: a weather measure-only — nem nyit, de előrejelez, logol és a multi-model felvétel fut; indok a B76: a piac ellen egyik horizonton sincs edge)* · **`directionalHalt` 1** *(B74 — measure-only directional halt, 2026-09-17 14:28 UTC élesítve: a crypto up-or-down + HL nem nyit, de mér; a threshold ág változatlan)*. **Szándékosan NINCS override-ban** (= kód-default): `makerShadowRecord` *(B77, 2026-09-30: default **1** — a shadow maker recorder a kód-defaulttal fut; a mérés nem visszatölthető, nulla trading-hatás)*, `weatherMultiSigmaInflation` *(1,0 — a keverék + saját EMOS mért optimuma)*, `sportsCronEnabled` *(⚠ a 92. sessionben törölve; a **95. session (2026-09-25)** viszont a sportot MANUÁLIS session-stoppal leállította — `stoppedReason="Manual stop"`, amit a `paperNeverStop` sosem old fel — mert a fabrikált fair value strukturálisan veszít, B37-ig ne fusson; ez visszafordítja a 92. session „sports fut" döntését)*, `weatherInvertDirection`, `combinerKBlindDownweight`, `combinerLogOddsStrength`. **Aki knobot vált, ezt a listát frissíti** — a napi `edgecalc-drift-check` kulcsonként ehhez hasonlít. A recorderek ON (`RECORD_OI=1`/`RECORD_CLOB_BOOK=1`), a weather EMOS seed lefuttatva (27/27 állomás).

**Bot-státusz (szándék):** crypto fut (csak threshold-ág nyithat) · weather measure-only (B79; visszakapcsolás csak ha `scripts/eval-weather-vs-market.ts` pozitív skillt mutat a piac ellen) · HL measure-only (B74) · F-Arb fut · **sports MANUÁLISAN leállítva** (`stoppedReason="Manual stop"`, B37-ig — nem drift). A 09-02-i tiszta indulás óta mindegyik bot mínuszban (2026-09-25: $700 → $614.58).

**Élő tények:**
- Promóciós kapu: egyik ág sem veri a piaci árat (2026-09-14 tiszta ledger: crypto threshold +8% [−5; +23] n=23 · up-or-down −44% · HL −59% · weather −61% · sports −10%; B76 weather vs piac T+1 −28%). Edge nincs bizonyítva → nincs lazítás.
- 2026-09-14…28 között 68 döntés → 68 elutasítás (fill-modell); B75 óta végrehajtható-edge kapu + `NO_FILL_WATCHDOG` → kevés, de valós kötés várható.
- A boxon a `TELEGRAM_BOT_TOKEN` üres volt (2026-09-28) → az `alert*`-ek elnyelődnek; a monitorozás a napi drift-check.
- Weather ledger „tiszta" számláló a B78 óta (2026-09-30) szándékosan 0-ról épül újra (bucket-kulcsos sorok) — nem riasztás.
- Az egyetlen fizetős termék-rés a weather lenne, de auditált track record kell (API-szolgáltatás: most nem).

**Nyitott, operátor-/adat-függő tételek (részletek: `internal-docs/roadmap/sprints.md`):** **B37** sports odds-feed (`ODDS_API_KEY`) · **B10** live-előfeltételek + jogi tisztázás · **B77b** valódi maker paper-megbízások (csak `PROMISING` maker-shadow verdikt után, ≥30 lezárt-kitöltött piac) · **B20** reverse F-Arb live (futures-short adapter) · **B38** korreláció-tudatos crypto cap (≥30 tiszta crypto sor után) · **B12** ledger normalizált táblára (nem blokkoló) · Phase 7 Chronos-súly (box-bővítés kell).
