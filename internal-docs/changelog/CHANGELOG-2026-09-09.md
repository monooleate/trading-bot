# CHANGELOG — 2026-09-09 (84-88. session)

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
