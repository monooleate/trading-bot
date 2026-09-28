# CHANGELOG — 2026-09-28 (96. session)

## Kiváltó ok

A user: *„a botok már régen nem kereskednek, miért? kalibrálni kellene? összhangban van a terv és a kód? hogyan tanítsuk?"*, majd: *„csináld meg az első hármat, és bővítsd a paper budgetet, hogy ne dobja vissza a méretezés"*.

## Élő diagnózis (read-only, `ssh analytics`, worker-log 14 nap)

| Esemény | Darab |
|---|---|
| SIGNAL | 58 291 |
| DECISION_SKIP | 25 408 |
| **DECISION_TRADE** | **68** |
| **ORDER_REJECTED** | **68** |
| ORDER_PLACED / FILLED | **0** |

A botok nem álltak le: naponta több belépési döntés született, de a paper fill modell mindet visszadobta (`"paper fill below min size / invalid / implausible vs quote"`). **Korrekció a 95. sessionhöz:** a „ma is nyitott 3 NO-fade" állítás téves volt — azok `DECISION_TRADE` sorok voltak, mindegyiket `ORDER_REJECTED` követte.

Két ok, gyakran együtt:

1. **Vol-target a bináris hozamon** — a `riskVolTargetEnabled=1` a trade saját `pnlPct`-jének szórását (bináris: −100% / +x00%) célozta 10%-ra, így a szorzó mindig a 0,25-ös padlón ült. Minden megbízás a Kelly-méret negyede lett (8,95 → 2,24 $, 6,72 → 1,68 $), ami kevesebb, mint 5 részvény.
2. **Az edge a Gamma-quote-on volt számolva** — az utolsó 20 elutasításból 14-nél a könyv-VWAP több mint 10¢-tel drágább volt (0,22 → 0,37; 0,50 → 0,65). A kijelzett 15–20% nagyrészt spread volt.

A harmadik, amiért két hétig senki nem vette észre: a boxon **üres a `TELEGRAM_BOT_TOKEN`** (minden `alert*` hívás csendben elnyelődik), a napi drift-check pedig knobokat nézett, teljesítést nem.

## Változások (kód)

| Fájl | Mit |
|---|---|
| [`packages/core/src/risk-overlay.mts`](../../packages/core/src/risk-overlay.mts) | Új `equityReturnsFromTrades` — a tőke per-trade hozama (pnl / tőke-előtte). `Number(null)`-csapda kezelve (a hiányzó PnL-t kihagyja, nem 0-nak veszi). |
| [`packages/core/src/executable-edge.mts`](../../packages/core/src/executable-edge.mts) | Új pure `evaluateExecutableEdge`: `P(oldal) − VWAP − kilépési díj ≥ küszöb` és ≥ 5 részvény, explicit hibaokkal (`no_fill` / `below_min_size` / `edge_below_threshold`). |
| [`services/worker/src/pillars/shared/executable-edge.mts`](../../services/worker/src/pillars/shared/executable-edge.mts) | Runner-wrapper: könyv-lekérés + `simulateDepthFill` (a paper fill modelljével azonos) + a Why?-panelbe menő `DecisionGate`. Könyv nélkül a fill modell haircut-fallbackja árazza, sosem a nyers quote. |
| [`services/worker/src/pillars/index.mts`](../../services/worker/src/pillars/index.mts) | Crypto: a vol-target a tőke-hozamon (`maxMult 1`); új végrehajtható-edge kapu a `placeBuyOrder` előtt (`fillModelEnabled` mellett); a `DECISION_TRADE` log közvetlenül a megbízás elé került, és a vol-targetelt méretet írja. |
| [`services/worker/src/pillars/weather/index.mts`](../../services/worker/src/pillars/weather/index.mts) | Ugyanez a kapu a weather ágon (a kísérleti `invertDirection` módban kihagyva). |
| [`services/worker/src/pillars/crypto/execution.mts`](../../services/worker/src/pillars/crypto/execution.mts) | `NO_FILL_WATCHDOG`: 5 egymás utáni elutasításnál (utána 20-anként) logsor + Telegram-kísérlet. |
| [`packages/core/src/types.mts`](../../packages/core/src/types.mts) | `LogEvent += "NO_FILL_WATCHDOG"`. |

Új knob / env nincs: a kapu a meglévő `fillModelEnabled`-hez kötött.

## Mérés (a javítás valós adaton)

- **Vol-target:** a crypto 10 lezárt trade-jén a tőke-hozam szórása **0,059**, így a szorzó **1,000** (volt 0,25).
- **Végrehajtható-edge kapu, replay a 68 élő döntésen:** **7** érte volna el a 15%-ot; a medián valódi edge **−0,3%**, a maximum 29,7%. Ez optimista becslés, mert a mért VWAP a negyedére zsugorított méretre szólt.
- **Őszinte következmény:** a kötések száma nem ugrik meg. A legtöbb „edge" a spread volt, és most a döntésnél, érthető okkal esik ki. Ami átmegy, az valódi áron valódi edge.

## Verifikáció

`tsc` 0 hiba · **55/55** teszt (új: `executable-edge.test.mts`, benne a két élő eset szó szerint + egy valódi depth-walk; `risk-overlay.test.mts` B75-blokk — pozitív kontroll: a régi `pnlPct`-alap ugyanarra a történetre 0,25-öt ad) · build zöld.

## Operatív

- **Napi drift-check:** új 10. pont (teljesítési arány: DECISION_TRADE vs ORDER_PLACED / ORDER_REJECTED + `NO_FILL_WATCHDOG`). A 2. pont sports-elvárása a 95. session döntéséhez igazítva (a sports kézzel leállítva — a CLAUDE.md az irányadó).
- **Paper-tőke feltöltése** (a user kérése): a dashboard 💰 Top up gombjával, `/trade/crypto` → a feltöltés auth-os action, ezért az operátor végzi. A javítás után a 8,95 $-os megbízás már ≥ 9 részvény; a feltöltés a kisebb Kelly-méretű jelek min-méret-ütközését szünteti meg.
- Feladat: [sprints B75](../roadmap/sprints.md) · algoritmus: [math/39](../math/39-executable-edge.md).

---

# 97. session (ugyanaznap) — B69: a weather multi-model keverék élesítése, két lépésben

## Kiváltó ok

A user: *„csináld meg a B69 weather pooling élesítését"*.

## Két flip-előfeltétel-hiba a kódban (javítva)

1. **A σ nem vált át.** `weatherUseMultiModel=1` mellett a μ a keverékből jött, de a bucket-matcher σ-ja (`rawSigma`) továbbra is a GEFS-ensemble szórása (`forecast.ensembleDetail`) — épp a flip lényege, a modellek közti tag veszett volna el. Új `ForecastResult.forecastSd` + `forecastSource` ([forecast-engine.mts](../../services/worker/src/pillars/weather/forecast-engine.mts)); a runner flip mellett ezt olvassa, flip nélkül a régi kifejezést (bájt-azonos).
2. **A recorder throttle-je kiesett.** A `isRecordDue` csak `!useMultiModel` mellett futott, a rögzítés feltétele pedig a lekérés megléte volt → flip után minden 3 perces tick snapshotot írt volna, és a 400-as gördülő tár napok alatt kiürült volna. Most a throttle a RÖGZÍTÉST kapuzza, a lekéréstől függetlenül ([weather/index.mts](../../services/worker/src/pillars/weather/index.mts)).

## Mérés a forward logon (új: [`scripts/eval-multimodel-flip.ts`](../../scripts/eval-multimodel-flip.ts))

Az élő σ-lánc hű visszajátszása (METAR-kerekítés → σ-padló 0,5 → EMOS → σ-szorzó), állomás-nap-lead-naponként egy mintával (735 címkézett snapshot → 224 minta, 18 állomás, 09-09 → 09-27).

- **A mai élő σ túl széles:** GEFS + EMOS × 2,25 → var-ratio **0,34**, ±1σ-lefedettség **92%**. Ugyanaz a GEFS-út × 1,25-tel **+8,3%** CRPS [6,2; 11,2].
- **A keverék a GEFS-re illesztett EMOS-szal rosszabb** a GEFS-útnál: a keverék μ-ja +0,79 °C-kal hidegebb a mértnél (ECMWF-hidegtorzítás), amit a GEFS-EMOS nem vesz le.
- **Saját kalibrációval a keverék nyer.** Gördülő, **mindkét oldalon out-of-sample** mérés (a GEFS-oldalon az állomás-EMOS csak a korábbi forward-maradékokra illesztve, az élő tár seed-súlyával): keverék + saját EMOS × 1,0 = **0,794** vs GEFS × 1,25 = **0,864** → **+8,1% [1,2; 15,5]**.
- ⚠ **Mérési csapda, amit elkaptam:** az első összevetésben a GEFS-alapvonal in-sample volt (az állomás-EMOS ezekre a napokra is illesztve) — ott a keverék −3,8%-kal vesztesnek látszott. Az in-sample GEFS-szám (0,764) 0,1-gyel szebb a valóságnál; a döntés csak a tisztességes összevetésből jöhetett.

## Változások (kód)

| Fájl | Mit |
|---|---|
| [`packages/core/src/pooled-emos.mts`](../../packages/core/src/pooled-emos.mts) | Új: a keverék saját EMOS-a — globális (a,b,c,d) + zsugorított állomás-bias (K=5); dedup állomás-nap-lead-naponként; illesztés nélkül a nyers keverék, sosem a GEFS-térkép. + teszt. |
| [`services/worker/src/pillars/weather/pooled-emos-cache.mts`](../../services/worker/src/pillars/weather/pooled-emos-cache.mts) | Óránkénti újraillesztés a multi-model tárból, memóriában cache-elve. |
| [`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts) | Flip mellett a keverék-EMOS fut; a GEFS-EMOS-tár továbbra is GEFS-adatot kap (a visszakapcsolás tiszta marad); σ-forrás és recorder-throttle javítás. |
| [`weather/forecast-engine.mts`](../../services/worker/src/pillars/weather/forecast-engine.mts) | `forecastSd` + `forecastSource`. |

## Élesítés

1. **1. lépés — ✅ alkalmazva:** `weatherSigmaInflation` 2,25 → **1,25** (a settings-séma 0,25-ös lépésköze miatt 1,25, nem 1,3; a görbe 1,2–1,4 között lapos). DSR-trial naplózva.
2. **2. lépés — ✅ alkalmazva a `f73be61` deploy után:** `weatherUseMultiModel` = 1 és `weatherSigmaInflation` = 1,0 (a kód-default, tehát az override törölve; 18 override, DSR-trial naplózva). A flip előtt a szállított keverék-EMOS élőben ellenőrizve a boxon: 224 minta, 18 állomás, `a=−0,60 b=1,05` (25 °C körül +0,7 °C melegítés — pont a mért hidegtorzítás), `d=3,64` (a keverék σ-ja ~1,9×-re tágul), in-sample CRPS 1,044 → 0,870. A sorrend számít: a régi kóddal a flip a σ-hibával és a GEFS-EMOS-szal futott volna.

`tsc` 0 · **56/56** · build zöld. Feladat: [sprints B69 / B52 (3)](../roadmap/sprints.md) · algoritmus: [math/37 §9](../math/37-multi-model-ensemble.md).

## Követő (97. session): forrásonkénti σ-szorzó (`7bd55f8`)

A user kérése: a GEFS-fallback is kapja meg az 1,25-öt. A közös `weatherSigmaInflation` knob miatt a flip után a GEFS-fallback (sikertelen keverék-lekérés) a keverék 1,0-ját kapta. Most a két forrásnak saját, mért szorzója van: `weatherSigmaInflation` **1,25** (GEFS-út és -fallback) és az új `weatherMultiSigmaInflation` **1,0** (keverék; kód-default, env `WEATHER_MULTI_SIGMA_INFLATION`). Kikapcsolt flip mellett bájt-azonos. Sorrend: előbb deploy, utána az override visszaállítása 1,25-re (a régi kód a szorzót a keverékre is alkalmazta volna). 19 override, DSR-trial naplózva. `tsc` 0 · 56/56 · build zöld.

**Élő ellenőrzés:** az első flip utáni tickben (06:32 UTC) mind az 5 város μ-ja elmozdult a 05:31-es GEFS-értékhez képest (Hongkong 32,2 → 31,7, Madrid 23,3 → 24,4, Tokió 25,6 → 25,0), hiba nincs.

**Következő lépések:** [sprints B76/B77](../roadmap/sprints.md).
