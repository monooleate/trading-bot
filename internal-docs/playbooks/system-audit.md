# Rendszer-audit — Claude Code charta

> **Mire való:** teljes, szisztematikus audit az **összes bot + a megosztott infra** működésére. Nem diff-review (arra a `/code-review` van) és nem per-bot trade-history (arra a [`trade-history-audit.md`](./trade-history-audit.md)) — ez a **rendszer egésze**: bot-logika, megosztott jel-infra, mérési réteg, execution/state, és az élő állapot vs. dokumentált szándék.
>
> **Hatókör:** `services/worker/src/pillars/*`, `services/api/src/routes/*`, `packages/core/*`, valamint az **élő box-állapot** (Postgres `blob_kv` + `pillar_*` táblák, `.env`, futó konténerek).
>
> **Utolsó frissítés:** 2026-09-09 (a 84-89. session öt leletéből született).

---

## §1 — Miért létezik ez a charta: a kód-first audit vakfoltja

**2026-09-03**: 4 párhuzamos read-only ágens auditálta a teljes B49-B50 diffet (88 fájl, ~4800 sor). **Verdikt: „0 P0/P1".**

**2026-09-08**: a **B53** — a prediction-ledger rescan-enként felülírta a `predictedProb`/`marketPrice`/`configHash` mezőket, amitől a *teljes mérési réteg* (walk-forward, config-attribúció, Thompson-bandit, és rajtuk át a promóciós kapu hard gate-je) egy **konvergált**, azaz a kimenetet már ismerő piaci árral hasonlított — ott volt a kódban, deployolva, végig.

**Miért nem találta meg a kód-audit?** Mert a kód **önmagában konzisztens volt.** A mező doc-ja kimondta: *„market YES price at the **latest** scan"*, és a kód pontosan ezt csinálta. A hiba csak akkor látszik, ha megkérdezed: *„ez a mező azt jelenti-e, amit a fogyasztója állít róla?"* — és erre a választ **az adat adja meg, nem a kód.**

### A 2026-09-09-i öt lelet eredete

| lelet | osztály | hogyan derült ki |
|---|---|---|
| **B53** ledger-felülírás | szemantikai drift (mező ≠ amit a fogyasztó hisz róla) | ledger-mezők eloszlása |
| **B55** sports hígítja a cross-bot poolt | aggregáció-szennyezés | botok összehasonlítása |
| **elveszett júliusi knobok** | live-state drift | élő override-ok vs. doksi |
| **B57** scan-ablak kizárta az ETH/SOL-t | lefedettségi vakfolt | „miért nincs ETH az adatban?" |
| **B56** crypto lapos predikció | rezsim-keveredés (átlag elfedi) | ledger **szegmentálása** piac-típusra |

**Mind az öt méréssel jött elő, egyik sem kódolvasásból. Négy közülük cross-cutting** — per-bot silóban nem lettek volna láthatók.

---

## §2 — A két alapszabály

### 1. ADAT-FIRST, ne kód-first

Minden sáv így indul:

1. **Húzd le az élő adatot** (§4) — ledger, session-táblák, `blob_kv`, override-ok, konténer-logok.
2. **Kérdezd meg: azt jelenti-e minden mező, amit a fogyasztója hisz róla?**
3. **Szegmentálj**, mielőtt átlagolsz (piac-típus, coin, irány, lead-idő, config, dátum). *Egy átlag két ellentétes rezsimet is elfedhet — a B56 pontosan ez volt.*
4. **Csak ezután** nézd a kódot, hogy megmagyarázd, amit az adatban láttál.

### 2. Read-only az 1. fázisban

Az audit **nem javít**. Előbb a teljes, prioritált lista áll össze (§5), a user jóváhagyja, és csak utána jön a fix-fázis. Ok: a mai nap megmutatta, hogy egy „nyilvánvalóan helyes" javítás mérve **ronthat** (B56b: a halott jelek eltávolítása Brier 0.2696 → **0.2889**).

---

## §3 — A 9 sáv

Párhuzamos, read-only ágensek. **A sávok szándékosan NEM tisztán per-bot** — a mai leletek 4/5-e cross-cutting volt.

| # | sáv | fő kérdés |
|---|---|---|
| 1 | **crypto** | gate-lánc, K-anchor, market-finder, exit-logika |
| 2 | **weather** | ensemble → bucket-matcher → Kelly, EMOS, reconciler |
| 3 | **HL Perp** | irány, Kelly-mapping, consecutive-loss, live-resolver |
| 4 | **F-Arb** | carry-számítás, bidirekcionális ág, hedge, churn |
| 5 | **sports** | fair-value forrás, longshot-floor, ledger |
| 6 | **megosztott jel-infra** | `signal-combiner` pooling-ágak, IC-súlyozás, kalibráció |
| 7 | **mérési réteg** | ledger, edge-tracker, promóciós kapu, walk-forward, bandit |
| 8 | **execution / state** | fill-modell, session-store, `blobs-compat`, migráció-integritás |
| 9 | ⭐ **live-state drift** | az élő állapot megegyezik-e a dokumentált szándékkal |

### A 9. sáv (új, 2026-09-09) — miért kell

A Phase-4 tiszta indulás **csendben** eldobta a 2026-07-23-i operátor-hangolást (`weatherSelectionShrink`, `weatherMaxPositionUSD`, `frMinSpreadHourly`, sports loss-limit) **és** a sports manuális stopját. Egyik sem kód-hiba — mégis hetekig más rendszer futott, mint amit a doksi leír.

Ellenőrizendő: élő override-ok vs. CLAUDE.md · box `.env` vs. `env-vars.md` · session `stopped`-flagek vs. dokumentált operátor-döntések · a knobok tényleg elérik-e a fogyasztójukat (nincs-e „holt knob") · deployolt kód vs. `main`.

---

## §4 — Adatbeszerzés (a boxról)

```bash
ssh analytics                     # /opt/edgecalc, docker compose: api / workers / model
```

Postgres a umami-konténerben, **`edgecalc` DB** (dollár-idézés kell, hogy ne kelljen escape-elni):

```bash
docker exec analytics-db-1 psql -U edgecalc -d edgecalc -tAc \
  "select value from blob_kv where store = \$\$prediction-ledger\$\$ and key = \$\$ledger-crypto\$\$;"
```

| mi | hol |
|---|---|
| prediction-ledger | `blob_kv` / `prediction-ledger` / `ledger-{crypto,weather,sports,hyperliquid}` |
| élő knob-override-ok | `blob_kv` / `trader-settings` / `runtime-overrides-v1` |
| session + trade-ek | `pillar_session`, `pillar_closed_trade`, `pillar_open_position` (`mode='paper'`) |
| F-Arb session | `blob_kv` / `hyperliquid-arb-session-v1` *(NEM a normalizált táblában!)* |
| weather EMOS / multi-model | `blob_kv` / `weather-emos`, `weather-multimodel` |
| recorderek | `blob_kv` / `market-recorder` |
| tick-logok | `docker compose logs workers --since 30m` |

Egyszeri script futtatása a konténerben (a `scripts/` nincs az image-ben):

```bash
docker cp x.ts edgecalc-workers:/app/scripts/x.ts
docker exec -u root -w /app edgecalc-workers bun scripts/x.ts
```

---

## §5 — Kimenet: EGYETLEN prioritált lista

Nem sávonkénti riportok — egy összefésült lista, súlyosság szerint.

| prio | jelentés |
|---|---|
| **P0** | pénzt veszít / adatot ront **most** |
| **P1** | egy döntési vagy mérési réteget érvénytelenít (pl. B53) |
| **P2** | helytelen, de korlátozott hatású |
| **P3** | kozmetikai / technikai adósság |

**Minden tétel kötelezően tartalmaz:**

1. **Mérés**, ami megmutatja (szám, nem sejtés)
2. **Kód-hely** `fájl:sor` formában
3. **Hatókör** — mely botokat érinti
4. **Ellen-hipotézis**: mi cáfolná? *(ha semmi, akkor az nem lelet, hanem vélemény)*

**Új feladat kizárólag a [`sprints.md`](../roadmap/sprints.md)-be** kerül (2026-05-15 SSOT-szabály) — a többi doksiba csak hivatkozás.

---

## §6 — Anti-patterns

- ❌ **Kódolvasással kezdeni.** Ez a 09-03-i „0 P0/P1" receptje.
- ❌ **Szegmentálás nélkül átlagolni.** A crypto „nem-informatív" verdikt átlag volt; szétbontva threshold **+90.9%** / directional **−6.5%**.
- ❌ **Szennyezett baseline-nal mérni.** A ledger `marketPrice`-a a B53 előtti sorokon az utolsó scan ára — a piacnak *kedvez*. Ellenőrizd: hány sor ára van a kimenettől 0.02-n belül?
- ❌ **Kis mintából következtetni.** n=5 trade nem alap live-feature-höz. Írd ki az n-t minden állításnál.
- ❌ **„Nyilvánvaló" javítást mérés nélkül szállítani.** B56b: mérve rontott.
- ❌ **Auditálás közben javítani.** Előbb a lista, aztán a jóváhagyás, aztán a fix.
- ❌ **Feltételezni, hogy az élő állapot = a doksi.** Pont ez a 9. sáv.

---

## §7 — Fix-fázis (a lista jóváhagyása után)

1. **P0/P1 először**, egyesével, mindegyik saját commitban.
2. Minden fix mellé **regressziós teszt**, ami a *mérést* pineli, ne csak a kódot.
3. **Viselkedés-változás → default-OFF knob** (a projekt mérés-first doktrínája), kivéve, ha egyértelmű bugfix.
4. Ha lehet, **mérd le a fixet a valós adaton, mielőtt szállítod** (a B56b-módszer: implementáld újra a logikát, futtasd a ledgeren, hasonlíts).
5. `tsc --noEmit` + `node scripts/run-tests.mjs` + `npm run build` **minden lépésnél**.
6. Doksi a session-záró szabály szerint: CLAUDE.md állapot · `changelog/CHANGELOG-YYYY-MM-DD.md` · `sprints.md` · érintett `math/NN-*.md`.

---

## §8 — Karbantartás

Minden lefuttatott rendszer-audit után: az **új bug-osztály** ujjlenyomata a §1 táblázatba, az új adat-forrás a §4-be, az új csapda a §6-ba. A charta annyit ér, amennyi tanulságot visszaforgatunk bele.
