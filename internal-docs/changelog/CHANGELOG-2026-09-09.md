# CHANGELOG — 2026-09-09 (84-92. session)

## 84. session — a 10 bekapcsolt knob Edge-Tracker-kiértékelése (read-only) → P1 mérési hiba

A user: „csináld meg az 1-est" (a 09-04-én bekapcsolt 10 knob kiértékelése). **Kód nem változott**; a ledgerek a boxról lehúzva és a repo SAJÁT függvényeivel pontozva (`computeWalkForward`, `computeConfigAttribution`, `banditArmsFromRecords`).

### Eredmény: a kiértékelés NEM elvégezhető — két független okból

**1. Nincs pre-flip kar.** A config-fingerprint jól elválasztja a 09-03 22:09-es flippet, de a kar-eloszlás használhatatlan:

| config | mikor | n (rezolvált) |
|---|---|---|
| `101cde4d` | flip **előtt** | **3** |
| `3683673b` | flip **után** | **214** |
| `unlabeled` | a #4 stamp előtt | 19 |

A Thompson-bandit „`101cde4d` 58% prob-best"-je a **priorból** jön (`nEff = 0.4`) — nem bizonyíték. Ok: a ledger rescan-enként felülírta a config-stampet, így a flip előtti, de utána is scannelt piacok átcímkéződtek.

**2. A metrika maga sérült** → lásd a 85. session (B53).

### Amit a szennyezéstől függetlenül tudunk

A **crypto modell nem-informatív**: átlagos `|p − 0.5|` = **0.119**, a piacé **0.296**; a modell Brier-je 0.213, a triviális „mindig 0.5"-é 0.25. A combiner a 0.5 körül lebeg, míg a piac határozottan és helyesen áraz. Ez a Sprint 41-42A-ban dokumentált „lapos finalProb" patológia, **nem** knob-hangolási kérdés. → **B54**.

Felvéve: **B53** (P1 mérési fix) + **B54** (a knob-kiértékelés, blokkolva).

---

## 85. session — B53 (ledger first-sighting latch) + B52 4. lépcső (8-rendszeres ensemble)

A user: „csináld a B53-at és B52-t is." A B52 2-3. lépcsője adat-függő (vár), tehát a **4. lépcső** készült el.

**Verifikáció:** `npx tsc --noEmit` exit 0 · `node scripts/run-tests.mjs` → **48/48** · `npm run build` zöld.

### B53 — a mérési réteg rossz mezőt olvasott

**A hiba.** A [`prediction-ledger`](../../packages/core/src/prediction-ledger.mts) slug-onként upsertel: minden rescan frissítette a `predictedProb`-ot, a `marketPrice`-t és a `configHash`-t (a mező doc-ja is kimondta: *„at the **latest** scan"*), miközben a `firstTs` megmaradt. Egy rezolvált sor tehát az **utolsó** scan állapotát hordozta — a lejárathoz közelit, amikorra a piaci ár már mechanikusan a kimenetre konvergált.

Mérve az élő ledgeren (2026-09-08):

| | weather | crypto | sports |
|---|---|---|---|
| rezolvált sor | 43 | 73 | 118 |
| ebből `ár > 0.98` | **17** | 0 | 0 |
| ebből `abs(ár − kimenet) < 0.02` | **18** | 4 | 1 |
| Brier-skill a piac ellen | **−233.6%** | −98.7% | −0.6% |

A szennyezettség sorrendje pontosan megmagyarázza a „rosszaság" sorrendjét, és a `> 0.98`-as sorok **94%-a** YES-re rezolvált — a „baseline" a válasz ismeretében árazott. Ez nem az a **belépéskori** összehasonlítás, amit a Walk-forward kártya állít: a bot belépéskor kereskedik, nem az utolsó scan-en.

**A fix.** Új, **írás-egyszer** hármas a `PredictionRecord`-on: `firstPredictedProb`, `firstMarketPrice`, `firstConfigHash`. Az `upsertRecords` az első látáskor rögzíti, és a latch a frissítés **ELŐTT** fut — így egy pre-B53 rekordnál a frissítés előtti (régebbi) értéket kapja, onnantól immutábilis. A „latest" mezők maradnak, a UI azt mutatja.

A **config** is a hármas része, szándékosan: a pontozott predikciót ahhoz a confighoz kell kötni, amelyik **készítette**. Enélkül egy knob-flip átcímkézi az összes még nyitott piacot és kiéhezteti a régebbi kart — pontosan ez blokkolta a 84. session kiértékelését (3 vs 214).

**Négy fogyasztó** vált a first-hármasra, mind `?? latest` fallbackkel: `ledgerPointsFromRecords` (walk-forward) · `computeConfigAttribution` · `banditArmsFromRecords` · a promóciós kapu hard „beats market OOS" gate-je (a walk-forwardon át).

**18 új regressziós assert** ([`prediction-ledger.test.mts`](../../packages/core/src/prediction-ledger.test.mts)) — köztük a végponti bizonyíték: az utolsó árral (0.99, YES-kimenet) a piac tökéletesnek látszik, a first-árral (0.25) viszont a modell (0.30) a jobb előrejelzés, és az attribúció a forecastot **készítő** confighoz írja.

**Élőben verifikálva:** a jelenlegi (mind pre-B53) ledgeren a walk-forward számok **bit-azonosak** a fix előttivel → a fallback ép, a fix tisztán forward-tölt. A már felülírt belépéskori árak **nem visszaállíthatók** (B50 #2 doktrína) → a tiszta mérés a deploytól indul. **Nem trading-hiba** — a bot mindig a valós árral kereskedett.

Doksi: [`math/21` §6](../math/21-walk-forward.md) + egysoros hivatkozás a [`math/30`](../math/30-config-attribution.md) és [`math/33`](../math/33-thompson-bandit.md) doksikban.

### B52 4. lépcső — 4 → 8 ensemble-rendszer

**A nyitott kérdés az volt, kell-e per-állomás modell-lista.** Nem kell: a domainjén kívüli regionális modellt az API **némán elhagyja** a multi-model válaszból — verifikálva: Tokió `gfs_seamless,icon_eu` → **HTTP 200, 31 tag**, se hiba, se null-oszlop. Csak **önmagában** kérve ad 400-at, amit ez a kód sosem tesz.

Új a listán: `gem_global` (CMC GEPS, 21) + `ukmo_global_ensemble_20km` (MOGREPS-G, 18) mindenhol, `icon_eu` (40 @ **13 km**) + `icon_d2` (20 @ **2 km**) Európában.

| állomások | rendszer | tag |
|---|---|---|
| EGLC London, EDDM München | **8** | **296** |
| LEMD Madrid (`icon_d2` kiesik) | 7 | 276 |
| US / Ázsia / Dél-Amerika / Afrika | 6 | 236 |

**Ugyanaz a költség:** egy kérés, ~42 KB, **~0,2 s** (mérve, 3 futás).

**Kihagyva:** `bom_access_global_ensemble` (18 tagot hirdet, de minden tesztelt állomáson **csupa null** hőmérséklet-oszlop) és `ukmo_uk_ensemble_2km` (3 tag — modellenként egyenlő súlyú keverékben túl kevés használható modellen-belüli σ-hoz, és egyetlen állomást fed). A US-regionális `gfs_hrrr`/`ncep_nbm_conus` **determinisztikus** (nincs ensemble-tagság) → a keverékbe nem illik; a determinisztikus DEB-ág bővítése külön tétel.

**Élő-verifikálva.** London 8 rendszer / 296 tag — és a két ICON (`icon_eu` μ 20.34, `icon_d2` μ 20.64) ~**1 °C-kal melegebb** a globálisoknál (18.76–19.90): pont az a lokális jel, amit a 25 km-es rács elsimít. Tokió 6/236. A legacy trading-út mindkét állomáson **bit-azonos** a recorder bekapcsolt fetch-ével.

Doksi: [`math/37` §2](../math/37-multi-model-ensemble.md) · [`math/16` §3.B (d)](../math/16-weather-bot.md) · [`env-vars.md` §13](../current-state/env-vars.md).

### Következő

Deploy → a B53 tiszta mérése és a 8-rendszeres log innen indul → 2-3 hét után `bun scripts/eval-multimodel.ts` (B52 flip) és a **B54** knob-kiértékelés, immár valódi A/B-karokkal.

---

## 86. session — sports: kizárva a cross-bot aggregátumból + session-reset (B55)

A user megkérdőjelezte a tegnapi „a sports bot ne kereskedjen" javaslatot: *„miért baj, ha kereskedik? nem a rendszer filozófiája szerint kereskedik? a weather akkor a külső api-kat használja és az alapján kereskedik?"* — jogos kérdés, és a kódból megválaszolva **részben igaza volt**.

### Mit mond a kód

A sports élő fair-value ága (odds-feed nélkül) — [`sports/decision-engine.mts`](../../services/worker/src/pillars/sports/decision-engine.mts):

```ts
predicted = 0.5 + (yp - 0.5) * 0.55;   // yp = a Polymarket YES-ára
```

Ez **annak az árnak a determinisztikus függvénye, ami ellen fogad**; a sports pillérben **egyetlen külső adatforrás sincs**. Következmények: edge = `0.45 × |ár − 0.5|` (a szélsőségeken maximális), a kapu csak `≤15¢`/`≥85¢`-en nyílik → **minden belépő longshot — aritmetikából, nem felfedezésből**. A kód saját kommentje is kimondja: *„fabricated — no real edge"*.

**Kontraszt a weatherrel** (a user második kérdése): a weather P(YES)-e olyan forrásokból jön, amelyek semmit nem tudnak a Polymarket árról — Open-Meteo ensemble (**8 rendszer**: GEFS, ECMWF IFS-ENS, ECMWF AIFS-ENS, Google WeatherNext 2, CMC, MOGREPS-G, ICON-EU, ICON-D2), determinisztikus GFS+ECMWF+NOAA, METAR a settlementhez és az EMOS-kalibrációhoz. Ezért a weather **tud érdemben nem egyetérteni a piaccal**; a sports ma nem tud. Pont ezt adná meg neki a **B37**.

### A user igazsága, és ami mégis probléma

Igaza volt abban, hogy ez **nem veszélyes** (paper), és hogy a `paperNeverStop` filozófia szerint egy bot ne álljon le magától. *(Pontosítás: az 52. session szándékosan csak az **auto**-stopot oldotta fel; a manuális operátor-stop maradni hivatott volt — azt a Phase-4 tiszta indulás vesztette el, nem a filozófia.)*

A valódi kár **mérési**: a sports **118/236 rezolvált ledger-sort** adott — a promóciós kapu bizonyítékának **felét** —, miközben a Brier-skillje **konstrukcióból ≈0** (mért −0,6%).

### Amit csináltam (B55)

- Új `AGGREGATE_EXCLUDED` az [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts)-ben: a `category="all"` pool (walk-forward · config-attribution · Thompson-bandit · rajtuk át a promóciós kapu hard gate-je) **kihagyja a sportsot**. A sports **saját fülje változatlanul működik**, és a ledgere **tovább gyűlik** — csak nem hígítja a cross-bot bizonyítékot. A pool címkéje explicit: `all (excl. sports)`.
- A **sports session nullázva** (bankroll $50, 0 trade, 0 open). A **ledger NEM törölve** — az mérési adat, és a rendszer `reset`-je sem érinti.

### ⚠ A fix ROSZABBNAK mutatja az aggregátumot — és ez a helyes

A valós ledgeren mérve:

| pool | n | Brier-skill a piac ellen |
|---|---|---|
| ALL **sportsszal** (eddig) | 236 | **−52,78%** |
| ALL **sports nélkül** (mostantól) | 118 | **−135,31%** |

A sports a ~0 körüli skilljével **érzéstelenítette** a mutatót. Kivéve látszik, milyen rosszul áll valójában a crypto+weather. Ez nem regresszió: eddig egy olyan bot maszkolta a képet, amelyik nem tud eltérni az ártól. (A −135% maga is még **pre-B53-szennyezett** — a valódi szám a tiszta forward-adattal jön.)

**B37-nél visszavonandó:** amint a `pinnacleFairYes` fel van töltve, a sports forecastja független lesz az ártól → ki kell venni az `AGGREGATE_EXCLUDED`-ből.

---

## 87. session — crypto „lapos predikció" diagnózis (B56) + a júliusi knobok visszaállítása

A user: „csináld a crypto diagnózist és állítsd vissza a júliusi knobokat." **Kód nem változott** — a diagnózis elemzés, a knob-visszaállítás futásidejű állapot.

### ⚠ Korrekció: a 84. session aggregált megállapítása félrevezetett

Tegnap ezt írtam: *„a crypto modell nem-informatív — `|p−0.5|` = 0.119 vs a piac 0.296"*. Ez igaz **átlagban**, de **két ellentétes rezsimet fed el**. Piac-típusonként bontva (98 ledger-sor, 91 rezolvált):

| piac-típus | n | `|final−0.5|` | jel-szórás | `|ár−0.5|` | Brier | skill a base rate ellen |
|---|---|---|---|---|---|---|
| **threshold** (`above-K`) | 26 | **0.371** | 0.162 | 0.372 | **0.0226** | **+90.9%** (n=20) |
| **up-or-down** | 49 | **0.037** | 0.113 | 0.267 | 0.2645 | **−6.5%** (n=48) |
| other | 23 | 0.049 | 0.123 | 0.262 | 0.2790 | **−17.1%** (n=23) |

A threshold-ág **kiváló**: olyan döntésképes, mint maga a piac, és a Brier-je a triviális 0.25 helyett **0.023**. Az up-or-down ág **rosszabb, mint a „mindig 0.5"**, és a kimenete gyakorlatilag konstans 0.5. *(Caveat: a threshold-minta részben „könnyű" — sok piac messze van a strike-tól —, tehát a +90.9% nem tiszta alfa; a kontraszt viszont valós.)*

### A mechanizmus

- **A threshold-ágnak strukturális horgonya van:** a `combinerKAnchorStrength` (default 1.0) a `vol_divergence` Black–Scholes digitális fair-value-jához horgonyoz, a többi jel csak igazít rajta → határozott, fizikailag megalapozott kimenet.
- **A directional ágnak nincs horgonya:** 9 gyenge, egymásnak ellentmondó jel súlyozott átlaga — ami matematikailag 0.5 köré esik. A `combinerLogOddsStrength=1` ott aktív (a threshold-ágon a [`signal-combiner.mts:1518`](../../services/api/src/routes/signal-combiner.mts) szándékosan kihagyja), de nem segít: ellentmondó logitok súlyozott **átlaga** is 0 körül marad. **Nem a pooling romlott el — a bemenetek nem tudnak megegyezni.**
- **A combiner súlyának ~⅓-a halott jelekre megy:** `cond_prob` `|s−0.5|`=**0.001** (0.500–0.613), `funding_rate` **0.002** (0.498–0.505), `oi_delta` **0.007** (0.352–0.533) — együtt **0.19/0.60 = a pool-súly 32%-a** gyakorlatilag konstans 0.5-tel, ami mechanikusan a 0.5 felé húz.

### A trade-ek: a forecast jó, a szelekció nem

Mind az 5 megkötött trade **YES**, 0.10–0.38 belépőn, **mind 0.000-ra rezolvált** (−$7…−$10). Ugyanaz a longshot-aláírás, mint a weathernél és a sportsnál. n=5, nem konkluzív, de egybevág a júliusi 37-trade audittal (a profit 4 longshoton ült).

**A feszültség a lényeg:** a forecast a threshold-ágon kiváló, a trade-ek mégis buknak → a hiba a **szelekcióban/méretezésben**, nem az előrejelzésben (optimizer's curse: ott köt, ahol a modell a legjobban eltér a piactól, azaz ahol a legvalószínűbb, hogy téved). A weathernek van erre `selectionShrink`-je, a cryptónak **nincs**.

**Mellék-lelet:** ugyanennek az 5 trade-nek a ledger-sora az élő bizonyíték a **B53**-ra — a ledger 0.001–0.004 árat mutat, miközben a tényleges belépők 0.10–0.38 voltak.

Jelölt lépések (jóváhagyásra, egyik sincs implementálva): → [`sprints.md` B56](../roadmap/sprints.md).

### A júliusi knobok visszaállítva

A Phase-4 tiszta indulás a *history* mellett a **knob-override-okat is eldobta**; a boxon a `.env`-ben egyetlen bot-tuning változó sincs, a DB-ben pedig csak a 09-03-i 10 knob élt. Visszaállítva (a meglévő 10 megőrizve, a `trader-settings` POST-út pontos másával: merge → default-prune → save → `appendTrial` a DSR trial-számlálónak):

| knob | vissza | default volt |
|---|---|---|
| `weatherSelectionShrink` | **1.0** | 0.5 |
| `weatherMaxPositionUSD` | **15** | 25 |
| `frMinSpreadHourly` | **0.00005** | 0.00002 |
| `sportsSessionLossLimit` | **50** | 30 |
| `sportsSessionLossLimitEnabled` | **1** | 0 |
| `sessionLossLimit` (crypto) | **1000** | 20 |

**Két knobot szándékosan NEM állítottam vissza:**

- **`weatherInvertDirection` = 1** — a júliusi döntés akkor született, amikor a `forecast_edge` IC **−0.359** volt. A 07-23-i audit szerint az IC azóta **+0.393**-ra fordult, és a CLAUDE.md maga jelezte az ellentmondást (→ B40, sosem lezárva). Bekapcsolva a bot egy bizonyítottan **jó** irány ellen fogadna. Marad OFF.
- **`combinerKBlindDownweight` = 0.5** — ez kizárólag a **threshold**-piacokra hat, azaz pontosan arra az ágra, amelyről a mai diagnózis kimutatta, hogy **a crypto bot egyetlen működő fele** (+90.9% skill), és ezt a mérést a jelenlegi 1.0 default mellett produkálta. A visszaállítása a működő felet módosítaná. Operátor-döntést kér.

`frMinSpreadHourly` élő indoklás: a jelenleg nyitott AVAX F-arb pozíció **−0.000029** spreaddel lépett be — pont abban a churn-sávban, amit a júliusi 0.00005 bezárt.

---

## 88. session — a B56 javaslatok LEMÉRVE → #2 elvetve, `combinerLogOddsStrength` visszavonva

A user: „a B56 javaslatokat is csináld meg, **ha jobb lesz tőle minden bot**." A feltételt komolyan véve **előbb leszimuláltam** a javaslatokat a valós ledgeren (72 directional sor, 71 rezolvált), a `combine()` súlyozásának hű újraimplementálásával. **Kód nem változott** — a végeredmény egy knob-visszavonás.

**Hitelesség-ellenőrzés:** a szimulált „mai" variáns `|p−0.5|`=0.041 / Brier 0.2692 ≈ a **ténylegesen logolt** finalProb 0.041 / 0.2692 → a modell hű.

| variáns | `|p−0.5|` | Brier | skill a base rate ellen |
|---|---|---|---|
| mai (log-odds ON, minden jel) | 0.041 | 0.2696 | −7.9% |
| **+ semleges jelek kihagyva (a #2 javaslat)** | 0.079 | **0.2889** | **−15.6%** |
| **lineáris pool (log-odds OFF)** | 0.032 | **0.2630** | **−5.2%** |
| lineáris + semleges kihagyva | 0.062 | 0.2760 | −10.4% |

### #2 — elvetve, mérés alapján

A saját javaslatom (a 3 konstans-0.5 jel súlyának felszabadítása) **rontana**: Brier 0.2696 → 0.2889.

**Miért:** a directional ág élő jelei *tévednek*. A 3 semleges jel 0.5 felé húzása **véletlenül védelmet adott** — a kimenet határozottabbá tétele (0.041 → 0.079) csak a hibát nagyítja. Tanulság: egy „nyilvánvalóan helyes" tisztítás egy negatív-skillű ágon árt.

### Helyette: `combinerLogOddsStrength` 1 → 0 ✅ alkalmazva

A knobot 2026-09-03-án a B50-batch kapcsolta ON-ra **bizonyíték nélkül**. Az első valódi mérés szerint **ront**: a lineáris pool Brier-je **0.2630** vs a log-oddsé **0.2696** (skill −5.2% vs −7.9%).

Ráadásul kevésbé döntésképes kimenetet ad (0.032 vs 0.041), ami a `combinerConfidenceMin`=0.05 kapun **több rossz directional trade-et blokkol** — vagyis implicit módon teljesíti a **#1 javaslatot** (directional kapuzás), kódváltozás nélkül.

### Amit szándékosan NEM csináltam

- **#1 (directional piacok kihagyása a scanből):** a knob-visszavonás elérte a lényegét; a scan-sorok viszont **értékes unbiased ledger-adatot** adnak (B50 doktrína), a kihagyásuk információt semmisítene meg.
- **#3 (selection-shrink a cryptóra):** elvileg ugyanez a lelet támogatja (a 0.5 felé húzás segít ezen az ágon), de **n=5 trade** kevés egy új live-feature-höz. Marad javaslat.

### Korlát

A mérés **crypto** directional sorokon készült; a knob **globális**, tehát a HL-t is érinti — ott viszont mindössze **2 ledger-sor** van, azaz mérhetetlen. Ezért ez **nem új fogadás, hanem visszaállás a kód-defaultra** az egyetlen létező bizonyíték alapján. A minta pre-B53 (szennyezett piaci ár), de a modell-oldali `|p−0.5|` és a base-rate-skill ettől független.

**Élő knob-állapot 15 override:** a 09-03-i 10-ből 9 marad (a `combinerLogOddsStrength` kivezetve) + a 6 visszaállított júliusi.

---

## 89. session — B57: coin-diverzifikált crypto scan-slotok, ablak 3 → 5

A user: „a threshold piacokra fókuszáljunk, mit tehetünk még? illetve mi kell hogy a BTC is szállítsa amit az ETH/SOL már szállít?" majd: „csináld az 1-est, ablak 5-re, illetve a többit ha javaslod."

### A premissza fordítva volt

A B51 (multi-coin) deploy óta eltelt 26 órában a crypto ledger: **BTC threshold 25 sor, ETH threshold 1, SOL 0.** Nem a BTC-vel van baj — az **ETH/SOL soha nem került a scan-ablakba**.

Ok: [`pillars/index.mts`](../../services/worker/src/pillars/index.mts) `markets.slice(0, 3)` — top-3 nyers 24h-volumen szerint. Az élő Gamma-rangsor (2026-09-09): **171 crypto piac, ebből 154 threshold** (bitcoin 77 · ethereum 44 · solana 33; up-or-down mindössze **6**), és a **BTC birtokolja az első ötöt** — az ETH legjobbja a #6, a SOL a top 12-ben sem szerepel. A B51 helyesen coin-aware-ré tette a kódot, de a volumen-rangsor minden slotot a BTC-nek adott.

### A fix

Új pure modul [`@core/scan-slots.mts`](../../packages/core/src/scan-slots.mts): `selectScanSlots(markets, {windowSize, minPerCoin})`. A volumen marad az **elsődleges** rangsor (likviditás-proxy, amitől a B49 #1 fill-modell függ), de **minden jelen lévő coin kap egy fenntartott slotot**; a maradékot szigorúan volumen tölti. Round-robin a tartalék-osztásnál (több coin mint slot esetén se egyen fel egy coin mindent), a kimenet volumen-sorrendben marad. **Egyetlen coin vagy `minPerCoin=0` esetén bit-azonos a régi `slice(0,N)`-nel.**

[24 pinelt assert](../../packages/core/src/scan-slots.test.mts), köztük a valós 2026-09-09-es rangsor regressziós esete.

**Ablak 3 → 5**, új Settings-knob `cryptoScanWindow` (default 5, 1–12) + env `CRYPTO_SCAN_WINDOW`. Azért Settings-tunable, mert **ez a bot fő külső-API tárcsája**: minden slot egy TELJES signal-combiner futás ~8 külső fetch-csel, tehát 3 → 5 ≈ **+67% külső hívás**; rate-limit esetén deploy nélkül visszavehető.

**Élő szimuláció a valós rangsoron:**

```
RÉGI (top-3):   BTC:above-82k  BTC:above-74k  BTC:above-72k
ÚJ  (5, kvóta): BTC:above-82k  BTC:above-74k  BTC:above-72k  ETH:above-2600  SOL:above-110
```

A 3 BTC slot **változatlan** → nulla regresszió a bot egyetlen működő ágán.

### Amit szándékosan NEM csináltam

- **„Okosabb" rangsor a volumen helyett (a saját #3 javaslatom) — elvetve.** Egy bizonyíték nélküli opportunity-score pontosan az a plauzibilis heurisztika, amiről a **B56b** mérése kimutatta, hogy árt (a „nyilvánvaló" combiner-tisztítás Brier 0.2696 → 0.2889). A slot-fenntartás **lefedettségi** döntés, nem új alfa-állítás.
- **SOL kizárása a gyengébb σ miatt (#4).** Deribit-opció csak BTC/ETH-re van, a SOL horgonya modell-σ-ra épül — de ez nem ok a kizárásra: a `combinerConfidenceMin` + `resolution-risk` kapuk kezelik a gyenge predikciót, a logolt sor pedig értékes adat. A kvóta coinonként **1** maradt, hogy a SOL ne kapjon aránytalan súlyt.

### ⚠ Őszinte korlát a „threshold-fókuszhoz"

A threshold-ág a base rate-et fényesen veri (**+90.9%**, n=20), **de a piaci árat nem**: Brier modell **0.0226** vs piac **0.0166**; a nem-konvergált 17 soron **−23.9%**. A piaci baseline B53-szennyezett (tehát a valós szám ennél jobb), de **bizonyítottan pozitív edge NINCS**.

Ezért a lefedettség-bővítés indoka elsősorban a **bizonyíték-gyűjtés üteme**, nem egy ismert profit. A kérdést a B53 tiszta mérése fogja eldönteni — most 3 helyett 5 piac/tick és 3 coin táplálja.

---

# 90. session (2026-09-09) — Teljes rendszer-audit a charta szerint → 16 lelet, 15 javítva

A user a [`playbooks/system-audit.md`](../playbooks/system-audit.md) charta szerinti **teljes rendszer-auditot** kérte, majd: *„csináld sorba a javításokat kezd a p0-1-el és haladj sorban"*.

## 1. fázis — audit (read-only)

A charta két alapszabálya szerint: **adat-first** (előbb élő adat, csak utána kód), és **szegmentálás átlagolás előtt**. Élő adatforrás: a Hetzner-box Postgresa (`blob_kv`, `pillar_*`), a konténer-logok és a valós Gamma/Open-Meteo válaszok. A kód-magyarázatot 4 párhuzamos read-only ágens adta — de **minden lelet mérésből indult**, nem kódolvasásból.

**Eredmény: 16 lelet — P0×3, P1×5, P2×5, P3×3.** Mindegyik mellett mérés (explicit n-nel), `fájl:sor`, hatókör és **ellen-hipotézis**.

### A charta §6 csapdái, amikbe tényleg bele lehetett volna esni

- **Szennyezett baseline.** A B53 előtti ledger-sorok az utolsó scan árát hordozzák. Mérve: a weather 52 rezolvált sorából **21 (40%)** ára 0.02-n belül van a kimenettől, a konvergált részhalmazon a „piac Brier"-je **0.0001** → a skill-szám (−937462%) értelmetlen. Ezért a weather végső mérése **nem a ledgerből**, hanem a `pillar_closed_trade` **belépéskor befagyasztott** mezőiből készült (n=28) — amit előbb igazoltam is (5-ből 4 sor eltér a ledger utolsó scanjétől).
- **Saját magam is beleestem egyszer.** Az EMOS-residualok összevont var-ratio-ja 1.30-nak jött — de a store **99,3%-a seedelt** backfill. Csak forwardra: **10.04**. Ez lett a P0-1.

### Amit ellenőriztem és RENDBEN volt (a charta szerint ezt is ki kell mondani)

Deployolt kód **== `main`** (sorvég-normalizált hash 6 kulcsfájlon); mind a 15 élő override létezik a SCHEMA-ban és van fogyasztója; a crypto/weather bankroll centre rekonciliál; a B57 élőben helyesen működik (3 BTC + 1 ETH + 1 SOL); a sports longshot-floor élőben blokkolt egy 2,9¢-es belépőt; a `paperNeverStop` helyesen **nem** oldja fel a manuális stopot.

### Megcáfolt saját hipotézisek

„A trade-tábla is felülíródik, mint a ledger" (nem — 5-ből 4 sor bizonyítja, hogy befagy; **ez adta a tiszta P0-1 mérést**); „a weather-forecast cache-elt" (nem — METAR °F kvantálás); „a HL/F-Arb nem ad PnL-t az ENB-nek" (adnak, payloadon át); „a ~19,5%-os belépő-edge-ek capeltnek tűnnek" (nem — a 15% + 3,6% kapu határa).

## 2. fázis — javítás (jóváhagyás után, prioritási sorrendben)

**8 commit, egyenként `tsc` 0 + teljes teszt-suite + build zöld.** Minden viselkedés-változás **default-OFF** knob mögött; minden fix mellé a **mérést** pinelő regressziós teszt (charta §7.2). Teszt-suite **49 → 52**.

| # | lelet | commit | knob |
|---|---|---|---|
| P0-1 | weather σ 1,8–3,2× túl kicsi | `74bfc6a` | `weatherSigmaInflation` (1.0=KI) |
| P0-2 | EMOS seed-dominancia 4887:35 | `d02b229` | `weatherEmosSeedWeight` (1.0=KI) |
| P0-3 | HL perp-irány threshold-piacból | `afef04a` | — (egyértelmű bugfix) |
| P1-4 | B53 back-fill „mosott" adatot ad ki | `bd41602` | — |
| P1-5/6 | HL realized-IC ≡ 0; `useRealizedIC` inert | `21d5279` | — |
| P1-7/8 | fél sports-kizárás; HL-ledger 2 sor | `930bbaf` | — |
| P2-9…13, P3-14/15 | lásd B64/B65 | `bb0f5c3` | `sportsCronEnabled`, `weatherShrinkSizing` |

Részletek: [`sprints.md` B58–B65](../roadmap/sprints.md) · [`math/38`](../math/38-weather-dispersion.md) · [`math/23 §6`](../math/23-emos.md).

### Két eset, ahol a mérés megfordította a saját narratívámat

1. **A P0-2 audit-megfogalmazása részben téves volt.** „Az EMOS rossz eloszláson illeszkedik → nem megbízható" túlbecsülte a kárt: forward adaton az EMOS **javít** (var-ratio 10,04 → 5,96). Amit tényleg nem javít, az a **torzítás** (+0,497 → +0,55 °C). A tétel szűkebb lett, nem tágabb.
2. **λ path-függő.** A σ-szorzó optimuma nyers ensemble-on 2,0–2,5, az **élő** (EMOS-be) úton **2,25** — és az irány a nem-nyilvánvaló: az élő út **kevesebb** inflációt kér. A teszt ezt explicit pineli, hogy senki ne olvassza egy konstansba.

### ⚠ Amit a P0-1 NEM old meg

A σ-tágítás **monoton** transzformáció, ezért a `corr(predikció, kimenet)` = **−0,316** (n=28) előjelét nem tudja megfordítani, és a Brier **minden λ-nál 0,25 fölött marad**. **Kár-csökkentés, nem edge.** A naiv „flippeljük meg" **szintén nem működik** (Brier(1−p) = 0,2753) — ugyanaz a csapda, mint a B56b-nél. Az előjel-probléma nyitva marad.

## Operátor-döntést kér

1. **A sports élőben FUT** (3 nyitott pozíció), szemben a 2026-07-23-i dokumentált stoppal. A kód-oldali okokat javítottam (a stop már túléli a hibát és a séma-bumpot, és van tartós `sportsCronEnabled` knob), de az **élő session-höz nem nyúltam** — az live-state változtatás.
2. **A knobok élesítése.** Mind default-OFF; a mért ajánlás: `weatherSigmaInflation` **2.25** + `weatherEmosSeedWeight` **0.1** (párban mérve). 
3. **P3-16** (log-megőrzés deployok között) — infra-döntés, backlogban.
4. **Deploy**: a `main`-re push automatikusan deployol; a munka jelenleg branchen áll.

## 3. fázis — deploy + élesítés (operátor-jóváhagyás után, ugyanaznap)

A user: *„igen pushold és állítsd le a sportsot, élesítsd a knobokat is ssh-zhatsz a szerverre"*.

**⚠ A leállítás előtt találtam még egy hibát.** A sports `session.stopped` ága **a `resolvePendingSportsPositions` ELŐTT** tért vissza → egy leállított bot **soha nem rendezte** a nyitott pozícióit. A kért leállítás így **bennragasztotta volna a 3 nyitott pozíciót ($7,50)**, örökre lekötött cost basisszal. A settlement a stop- és a cron-kapu elé került (`9af4a2a`); a `sportsCronEnabled` ellenőrzése emiatt a dispatcherből a pillérbe költözött.

**Deploy:** 9 commit → `main` (`878cede..9af4a2a`) → CI **success** → Deploy **success** (11:03). Deployolt kód == `main` (sorvég-normalizált hash 4 kulcsfájlon), konténerek fent.

**A P0-3 élőben igazolva** — előtte 7 napon át minden tickben `BTC SHORT finalProb 0.0156 edge 0.9688` (a 40%-os cap blokkolta), utána:

```
BTC LONG  finalProb 0.5198  edge 4.0%
ETH LONG  finalProb 0.5254  edge 5.1%     ← az ETH-nek ELŐSZÖR van jele
```

**Élesítés** (egyetlen tranzakcióban, a 15 meglévő override jsonb-merge-dzsel megőrizve + DSR-trial naplózva):

| knob | érték | indok |
|---|---|---|
| `weatherSigmaInflation` | **2.25** | P0-1, a plató az élő (EMOS-be) úton |
| `weatherEmosSeedWeight` | **0.1** | P0-2, LOO-val mérve; 0.03 alatt az effektív minta ~10-re esik |
| `sportsCronEnabled` | **0** | sports leállítva |

+ a sports session `stopped=true`, `stopped_reason = "Manual stop - no odds feed (B37); system audit 2026-09-09"` — szándékosan **egyik** `isAutoStopReason` mintát sem tartalmazza, tehát a `paperNeverStop` nem oldja fel.

**Élő verifikáció a következő tickben (11:13):**

- **sports** → `action=skipped`, reason: *„Sports cron disabled (sportsCronEnabled = 0) — settled open positions, opened nothing"* ✓
- **weather** → a predikciók behúzódtak a végekről, ahogy egy becsületes σ-tól várható (a mód-közeli bucketek mass-t adnak le, a tail-bucketek kapnak):

| város | előtte | utána | Δ |
|---|---|---|---|
| munich | 0,0069 | **0,1109** | **+0,1040** |
| london | 0,4209 | 0,2222 | −0,1987 |
| paris | 0,3766 | 0,2172 | −0,1594 |
| hong-kong | 0,4544 | 0,3033 | −0,1511 |
| shanghai | 0,1826 | 0,2020 | +0,0194 |

A **munich** a lényeg: 0,0069-ről kijött abból a `[0–0,15)` sávból, ami a valós belépőkön **71,4%-ban YES**-re rezolvált és a −$11,82-os összesből **−$20,68**-t vitt.

**Egészség:** 0 hiba / 10 perc, 4 tick, a crypto 5 piacot scannel vegyes coinnal (BTC threshold 0,87 és 0,07 — a K-horgony dolgozik; a directional lapos 0,51, ahogy a B56 leírta).

**Fontos részlet:** a `confidence` (1 − σ/4) **változatlan** maradt — a σ-infláció szándékosan az EMOS UTÁN, közvetlenül a `matchBucket` előtt hat, tehát a confidence-kaput **nem** mozgatja; a hatás az edge/Kelly úton jön. Ez a sebészi elhelyezés szándékos.

## 4. fázis — peer-lelet: a ledger nem rögzítette, MELYIK KÓD készítette a predikciót (B66)

Egy párhuzamos Claude-session (a charta szerzője) adta át lane 7 / lane 9 leletként. **Függetlenül reprodukálva, mielőtt hozzányúltam** — a részletek: [sprints B66](../roadmap/sprints.md).

Röviden: a `configHash` a futásidejű **knobokat** hasheli, nem a kódot, tehát egy attribúciós arm némán átível minden knob-változás nélküli deployt. Élőben az `e03b4835` arm 10:45:41 → 11:07:11 közé esett — **benne a 11:03-as audit-deploy**, ami átírta a HL signal-source-ot, a ledger-szabályokat, az IC-blendet és a fill-ellenőrzést.

**A SHA-t szándékosan NEM hasheltem a `configHash`-be** (minden push új armot nyitna → egysoros armok, sosem gyűlő bizonyíték). Helyette külön `codeVersion` mező + `codeVersionSpread()`, ami armonként **megnevezi** a kevert kód-rezsimeket.

**Élő igazolás a deploy után** (crypto ledger, n=102) — a mechanizmus azonnal láthatóvá tette azt, amiért készült:

```
arm 3683673b:  81 sor unlabeled  +  3 sor 66efbf6c7503   → MIXED
arm e03b4835:   1 sor unlabeled  +  2 sor 66efbf6c7503   → MIXED
```

### ⚠ Incidens: elrontottam a deploy-workflow-t, majd javítottam (10 perc)

A `fc21251` BUILD_INFO-lépése `printf 'sha=%s\nbuiltAt=%s\n'`-t használt, de a backslash-escape-ek nem élték túl a szerkesztést és **valódi sortörésekké** váltak → a printf formátum-string három sorra terjedt, és **a YAML nem parse-olt**. A GitHub 0 másodperces, a workflow-fájlról elnevezett hibaként jelentette — ez az érvénytelen workflow aláírása, nem egy elbukott job.

**Hatás:** amíg törött volt, **semmilyen deploy nem futhatott**. A box a korábbi jó deployt (`87ba884`) szolgálta ki változatlanul, tehát **éles hatás nem volt** — de az `fc21251` nem jutott ki.

**Javítás** (`66efbf6`): escape nélküli `echo`-blokk (`{ echo "sha=$SHA"; echo "builtAt=$(date -u …)"; } > BUILD_INFO`), és ezúttal **lokálisan leparse-oltam a YAML-t push előtt**, plusz lefuttattam a lépés shell-jét szó szerint, hogy a kimenet egyezzen azzal, amit a `build-info.mts` olvas.

**Tanulság a chartához:** ugyanez az escape-hiba **kétszer** ütött ma (a tesztfájlban is), és mindkétszer *hihető, de néma* eredményt adott. Ez ugyanaz az osztály, mint a B53/B66: nem összeomlás, hanem egy elfogadhatónak látszó érték egy meg nem történt művelet helyén. A generált YAML/shell-t **parse-olni kell**, nem ránézni.

### Egészség a végén

0 hiba, tickek futnak, sports `stopped=true` és kihagyva, HL mindkét coinon józan jel (`BTC LONG 0.524 / 4,8%`, `ETH LONG 0.5308 / 6,2%`), BUILD_INFO a konténerben.
---

## 91. session — B36 lezárva (már kész volt), B38 előkészítve, napi drift-ellenőrzés beállítva

A user: „állítsd be a heti ellenőrzést, de most napi legyen amíg megbizonyosodunk hogy minden rendben! illetve végezd el a B36-ot és a B38-at készítsd elő."

### B36 — nem elvégezni kellett, hanem lezárni

**A fix 2026-09-03 óta a kódban van** (`534f637`, „audit batch 1: P0 HL persistence + P1 correctness fixes"), a `sprints.md` viszont nyitottként mutatta. A re-implementálás duplikált, káros munka lett volna — helyette **verifikáltam**:

- [`kelly-sizer.mts`](../../services/worker/src/pillars/hyperliquid/kelly-sizer.mts): `baseline = 1/(1+rr)`, ami **azonos** a spec `slPct/(tpPct+slPct)` alakjával (tp=0.02, sl=0.01 → RR=2 → mindkettő **1/3**); a `BRACKET_CONVICTION_SCALE=0.5` az edge-implikált drift-tilt.
- **Az invariáns kézzel ellenőrizve:** dirProb=0.5 → winBracket=1/3, loss=2/3 → `1/3 − (2/3)/2 = 0`, azaz **edge=0 ⇒ Kelly=0**. A régi kód itt 0.25-öt adott (~3× túlméretezés).
- [`kelly-sizer.test.mts`](../../services/worker/src/pillars/hyperliquid/kelly-sizer.test.mts) fejléce szó szerint *„pins the B36 fix"*, külön esettel a nulla-edge → nulla méretre.

**Ez maga is drift-lelet** (a 9. audit-sáv osztálya): a tracker hat napja élő fixet mutatott nyitottként.

### B38 — előkészítve, nem implementálva

A lényeg, ami a 2026-07-23-i felvetés óta változott: a **(3) alpont nagyrészt LEFEDVE**. A B49 #2 [`checkBetaCap`](../../packages/core/src/portfolio-exposure.mts) él (`betaCapEnabled=1`, 0.25), és a crypto+HL **együttes** kitettséget capeli — tágabban, mint amit a B38 kért. **Maradék rés:** nem szegmentál rezolúciós ablak szerint (az azonos napra lejáró piacok egyetlen korrelált fogadás). A `btcMinPriceBand=0.10` szintén aktív, a `maxEdgeCap` szigorítás nyitva.

Friss bizonyíték: mind az 5 megkötött crypto trade YES volt 0.10–0.38 belépőn és mind 0.000-ra rezolvált — **n=5, nem elég** live-feature-höz, ezért marad előkészítés. A **B56** megerősíti az (1) alpontot: a threshold-forecast **jó** (+90.9%), a trade-ek mégis buknak → a hiba a szelekcióban van, nem az előrejelzésben.

**Végrehajtási sorrend a tervben:** (1) előbb szimuláció a ledgeren — a **B56b** tanulsága, hogy egy plauzibilis javítás mérve **ronthat** (Brier 0.2696 → 0.2889); (2) precondition **≥30 tiszta crypto sor** (ma 1 van az egész rendszerben); (3) csak azután knob, default-0; (4) a döntést a promóciós kapu hozza, nem a PnL.

### Napi drift-ellenőrzés

Lokális ütemezett feladat (`edgecalc-drift-check`, minden nap 08:00 helyi idő). **Szándékosan NEM felhő-routine**: annak nincs SSH-ja a boxhoz, tehát pont az élő állapotot nem látná — márpedig a drift ott keletkezik.

Nyolc read-only ellenőrzés: knob-override-ok vs. CLAUDE.md · session-állapotok (az F-Arb a `blob_kv`-ben, nem a normalizált táblában!) · bankroll-ugrás · **tiszta first-observation számláló** (ma 1, nőnie kell) · `codeVersion`-stamp vs. box `BUILD_INFO` · recorderek frissessége · deploy-szinkron · konténer-egészség. Csak eltérést jelent; nem javít, nem dönt.

Amíg meg nem bizonyosodunk, hogy minden stabil, **napi**; utána heti.

---

## 92. session — a napi drift-check első futása: sports visszaindítva, `weatherSigmaInflation` igazolva

A user: „futtasd le most kézzel a drift-ellenőrzést" → majd „indítsd újra a sportsot ahogy reggel megbeszéltük, ehhez adj segítséget: `weatherSigmaInflation=2.25` be van kapcsolva, jó ha be van kapcsolva?"

### A drift-check első futása: 6 tiszta, 2 jelzés

Nincs programozott „run now" a scheduled-tasks API-ban, ezért kézzel futtattam le mind a nyolc ellenőrzést. **Az első futáson rögtön két valódi eltérést talált** — pontosan azért készült.

| check | eredmény |
|---|---|
| Deploy-szinkron | box `bf6f382834ca` = `origin/main` ✓ |
| Konténerek / hibák | Up, **0 hiba** 1 órában ✓ |
| Recorderek | 10 snapshot / 6 óra, **6 db 8-rendszeres** (EU) + 4 db 6-os ✓ |
| `codeVersion`-stamp | működik — a crypto ledgerben **két kód-arm** különül el (`66efbf6c` ×6, `a3501946` ×4) ✓ |
| Bankroll-ugrás | nincs ✓ |
| Tiszta rezolvált sorok | **2** (reggel 1) — nő, de lassan ✓ |
| **Sessionök** | 🔴 **sports leállítva** — szemben a user aznap reggeli döntésével |
| **Knobok** | 🟠 `weatherSigmaInflation=2.25` **aktív**, pedig default-OFF-ként szállították |

### 🔴 Sports — két session ellentétesen döntött

A 86. sessionben a user döntése: fusson (paper), de legyen kizárva a cross-bot aggregátumból (B55) — a session nullázva, a CLAUDE.md-be beírva, hogy **FUT**. A 90. session rendszer-audit ezt **leállította** (`sportsCronEnabled=0` + manuális session-stop, „no odds feed (B37)" indoklással), a régi dokumentált politika alapján.

Nem hiba egyik oldalról sem — a politika tényleg az volt, a user viszont aznap reggel megváltoztatta. **A user megerősítette a reggeli döntést**, ezért visszaindítva az app saját `resumeSportsSession` útján: `stopped=false`, bankroll $50, 0 trade, a `sportsCronEnabled=0` override törölve (vissza default 1-re) → 17 override. A B55 aggregát-kizárás **érintetlen**.

### 🟠 `weatherSigmaInflation=2.25` — MÉRVE, és jó

A user kérdésére lemértem élő EMOS-residuálokon (`dispersionDiagnostics` + `suggestSigmaInflation`). **Két minta ellentmond egymásnak:**

| σ-faktor | varRatio — seedelt (n=4924) | varRatio — forward METAR (n=37) |
|---|---|---|
| 1,00 | 2,62 | **13,04** |
| 1,50 | 1,16 | 5,80 |
| **2,25 (élő)** | **0,52** | **2,58** |
| 3,00 | 0,29 | 1,45 |
| *javaslat* | *1,75* | *3,00* |

**A feloldás a medián.** A `varRatio` átlag-alapú és a forward mintában outlier-vezérelt (átlag 13,04 vs **medián 2,53**). Az outlier-robusztus mediánból (kalibrált referencia χ²₁ szerint **0,455**):

- **forward METAR:** 2,531 / 0,455 = 5,56 → σ-alulbecslés **√5,56 ≈ 2,36×**
- seedelt: 0,636 / 0,455 = 1,40 → **≈ 1,18×**

A termelési adaton a robusztus becslés **~2,36** → a beállított **2,25 gyakorlatilag telibe talál**. A „túllő" olvasat kizárólag a seedelt residuálokból jön, azok viszont **más adatgeneráló folyamat** (Open-Meteo inter-modell spread + ERA5, nem GEFS + METAR) — az audit ezért állította be egyúttal a `weatherEmosSeedWeight=0.1`-et.

**Aszimmetria:** túl széles σ → kimaradt lehetőség; túl szűk σ → a dokumentált `payoffRatio 0.44` vérzés. A vérző boton a széles irányba tévedni olcsóbb. **Verdikt: marad ON.**

**Két figyelmeztetés rögzítve:** (1) n=37 vékony — ha a forward medián lemegy 0,455 közelébe, a 2,25 sokká válik; a napi check figyeli. (2) **Dupla-számolás-veszély a B52-vel**: a `weatherUseMultiModel` flip a *forrásnál* szélesíti a σ-t (inter-modell tag), a `weatherSigmaInflation` *utólag* ugyanazt — a flip előtt újra kell mérni és valószínűleg lejjebb venni, különben a confidence (`1 − σ/4`) beomlik. Felvezetve a [B52 flip-checklistbe](../roadmap/sprints.md). A recorder `baseSd`-je a **nyers** GEFS-szórást rögzíti, tehát a B52 forecast-mérése maga nem szennyezett — csak a trading-út.
