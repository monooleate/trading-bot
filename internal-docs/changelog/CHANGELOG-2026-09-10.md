# CHANGELOG — 2026-09-10

## API-szolgáltatás felmérés (read-only) + mellék-lelet: a box nem nyithat Polymarket-pozíciót

A user: *„erre amit most a robotok tudnak és amit gyűjtenek adatot nem lehetne api szolgáltatást építeni. lenne erre kereslet?"* **Kód nem változott, deploy nem volt.** Módszer: read-only leltár a boxon (Postgres + az élő Edge Tracker promóciós kapuja), 3 párhuzamos webes kutató-ág (piaci körkép · licenc és szabályozás · rés-kereslet), majd a döntő állítások szúrópróbája primer forráson. A szúrópróba két ágens-állítást **cáfolt**: az ICE a saját sajtóközleménye szerint nem „exkluzív", hanem *„a global distributor"* a Polymarket-adatnak; és az ESMA-statement nem nevesíti külön a weathert/cryptót (egy WebFetch-összefoglaló ezt állította, a PDF-ben nincs benne).

### Verdikt: most nem — nem az ötlet rossz, hanem a sorrend

**1. A „tudás" (predikciók, jelek) ma negatív értékű egy vevőnek.** Az élő promóciós kapu (`/api/edge-tracker`, 2026-09-10):

| Bot | Kapu | Brier-skill a piaci ár ellen (walk-forward, OOS) | Rezolvált ledger-sor |
|---|---|---|---|
| crypto | INSUFFICIENT_DATA | −61% | 108 |
| weather | HOLD | −124% | 64 |
| sports | INSUFFICIENT_DATA | −6% | 167 |
| hyperliquid | INSUFFICIENT_DATA | +7% | 10 |

A piaci ár ingyen elérhető, így a nála rosszabb előrejelzés eladása negatív értéket ad el. Ha lesz edge, az eladás a vékony könyvekben (B49 #1) maga emésztené fel. Piaci háttér: rengeteg $15–100/hó signal-termék, auditált track recorddal egyet sem találtunk; a generikus AI-előrejelzés a [ForecastBench](https://forecastingresearch.substack.com/p/ai-models-have-likely-reached-parity) szerint (2026-07-16) már superforecaster-szinten van.

**2. Az adat kicsi, rövid, és a szegmens telített.** A teljes `edgecalc` DB **11 MB**. OI: 650 snapshot/coin (09-03 óta, 15 perc). `clob-book`: 5000 snapshot / 15 token, ~2 napos ablak (→ B68). Ledger: 406 sor (crypto 125 · sports 190 · weather 79 · HL 12). Weather-multimodel: 101 snapshot, ebből 36 obs-szal. A piacon ingyenes, teljes könyv-archívum van ([Pendulum Flow](https://archive.pendulumflow.com/), CC BY 4.0, 2026-02-21 óta), a [Tardis.dev](https://docs.tardis.dev/historical-data-details/polymarket) 2026-05-25 óta viszi a Polymarketet, a [Predexon](https://predexon.com/pricing) historikus könyvet minden tieren ingyen ad. A Polymarket [megvette a Dome-ot](https://crypto.news/polymarket-acquires-prediction-market-api-startup-dome/) (2026-02-19), az [ICE](https://ir.theice.com/press/news-details/2025/ICE-Announces-Strategic-Investment-in-Polymarket/default.aspx) pedig legfeljebb $2B befektetés mellett globális disztribútora a Polymarket-adatnak.

**3. Licenc.** A [Polymarket intézményi oldala](https://institutional.polymarket.com/) szerint egy „Capital Markets Entity" (bróker, market maker, prop trading, indexszámító, ETF-kibocsátó) **bármilyen** Polymarket-adatot — nyers, derived, aggregált — csak Polymarket + ICE licenccel használhat, és a nekik való továbbértékesítés is licenc-köteles. Pont ők lennének a derived adat vevői. A kutató-ág szerint a Kalshi, Binance, Bybit és Deribit feltételei is tiltják az adat továbbértékesítését (a Deribit a derived adatét is), az Open-Meteo ingyenes API-ja pedig non-commercial — ezeket nem szúrópróbáztam.

**4. Az egyetlen rés fizetési hajlandósággal: weather.** A Kalshi weather-volumen ~500%-kal nőtt év/év alatt, 2026-ra ~$1,1B várható ([WSJ, 2026-08-27](https://finance.yahoo.com/markets/options/articles/kalshi-weather-co-join-forces-110000142.html)). A [wethr.net](https://wethr.net/subscribe) $14,99 / $24,99 / $99 havidíjat kér (modell-pontosság dashboard + API). A rés (gyenge bizonyítékkal): a piac **tényleges rezolúciós forrásához** illesztett eloszlás (Wunderground napi tábla vs NOAA órás idősor vs NWS CLI) + point-in-time archívum (forecast vs piaci ár vs rezolúciós obs). A B52 + EMOS + B53 ennek pont a váza. A belépő egy nyilvános, auditált track record — a weather modell ma −124% a piac ellen.

**5. Szabályozás (nem jogi tanács).** [ESMA, 2026-07-03](https://www.esma.europa.eu/sites/default/files/2026-07/ESMA35-243228190-8148_Public_Statement_on_the_application_of_the_national_product_intervention_measures_on_binary_options_to_event_contracts.pdf): a MiFID II Annex I C(4)–(10) alapmutatójú event contract pénzügyi eszköz, retail felé a marketingje és értékesítése tilos (a C(10) a klimatikus változókat is lefedi). MiCA: személyre szabott crypto-tanácsadást csak engedélyes cég adhat; egy mindenkinek azonos jelfolyam valószínűleg nem tanácsadás, de a saját nyitott pozíció melletti vélemény-közlés piacbefolyásolásnak minősülhet. HU: SZTFH ISP-blokk a polymarket.com-ra 2026 január óta (tiltott szerencsejáték gyanúja); az engedély nélküli szerencsejáték reklámozása legalább 10M Ft bírság, egyetemlegesen a reklámozóra, a közzétevőre és a reklámban szereplőre is ([SZTFH](https://sztfh.hu/tevekenysegek/szerencsejatek-felugyelet/szerencsejatekot-nepszerusito-reklam-kozzetetelenek-alapveto-feltetelei/), Szjtv. 2. § (7a)).

### ⚠ Mellék-lelet: a box nem nyithat Polymarket-pozíciót

`GET https://polymarket.com/api/geoblock` a boxról → `{"blocked":true,"country":"DE","region":"SN"}`. A [Polymarket-doksi](https://docs.polymarket.com/api-reference/geoblock) szerint DE = close-only: új pozíció nem nyitható, se frontenden, se API-n. A paper-mód nem érintett; a Polymarket live-flip (B10) viszont a mostani boxról nem működne. A repóban eddig sehol nem szerepelt (a `geo-block` találatok a Binance/Bybit Netlify-fallbackre vonatkoznak). → **B10**: új precondition.

### Felvéve

- **B10** — új blokkoló: geoblock + HU/ESMA jogi precondition.
- **B68** — fill-modell kalibráció külső, teljes-piacos könyv-archívumból (jelölt).
- **B69** — B52 offline előkiértékelés dynamical.org IFS-ENS/AIFS-ENS archívumon (jelölt).
- [`current-state/trading-status.md`](../current-state/trading-status.md) — geoblock-figyelmeztetés a tetején.

---

## 93. session — a drift-check kiértékelése → B67 (a tiszta-számláló provenanciája) + a drift-check prompt pontosítása

A user sorban: „nézd meg a drift-check eredményét és minden rendben van-e a kereskedő botokkal" → „csináld a kettő kicsit" (a számláló-fix és a drift-check prompt) → „pusholhatsz is a mainre".

### 1. A drift-check első ütemezett futása (06:03 UTC) — kiértékelve

Hat pont rendben, két eltérés, és **mindkettő valós**:

- **(a) a tiszta first-observation számláló túlszámol** (54 számolt, ebből 29 valódi) → **B67**, lent.
- **(b) a sports-session nem rekonciliál** → **B70**. A kiértékeléskor ezt reset-szivárgásnak írtam le, és a bankrollt helyesnek mondtam. **Mindkettő téves volt.** Nem volt reset: a `started_at` 09-09 06:00:19. A −7,5 ennek a sessionnek a valódi vesztesége, és a **bankroll** a hibás: +$7,50 fantom a P2-10 fix átmenetéből.

Két dolgot tévesen jelzett a futás, illetve én:

- A „8 hiba" a logban hamis pozitív. Mind a crypto combiner-bizalmi kapu `DECISION_SKIP` szövege: „Combiner trust gate: WATCH recommendation + … — likely model error".
- **A saját F-Arb riasztásomat visszavontam.** Azt állítottam, hogy 6 pozíció beragadt, de a szkriptem nem szűrt `status`-ra. Mind a 6 `CLOSED` („Carry flipped negative (reverse)"), a nyitott pozíciók száma 0, a bot tickel. Valós megfigyelés közben: kettő 6, illetve 15 perc után zárult, összesen $0,0009 funding jött, a bankroll 200 → 198,56 (díj).

Bot-állapot a read-only ellenőrzéskor:

| bot | állapot |
|---|---|
| crypto | 104,30 |
| weather | 86,57 = 100 − 13,43, rekonciliál |
| HL | 199,83, van SHORT is |
| sports | 43,00, 3 új pozíció; a bankroll +7,50-dal túlbecsült (B70) |
| F-Arb | 198,56 |

Mind az öt fut, 17 override, a deploy szinkronban.

### 2. B67 — a számláló provenanciája: epoch, nem jelzés

**A hiba.** A B61 `firstBackfilled` jelzést csak a saját deployjától (09-09 11:04 UTC) állítja be a kód, és csak akkor, ha a first-tuple még **üres**. A B53 viszont már 05:25-kor élesedett, és a kettő között újrascannelt pre-B53 sorokat a `??=` kitöltötte. Ezek soha nem kaphatnak jelzést, a régi `isCleanFirstObservation` pedig tisztának mondta őket.

**Mérés.** Élő ledger-dump, 15:44 UTC. Két független implementáció, számra egyező eredménnyel: egy inline újraimplementáció és a **szállított** függvény.

| | rezolvált | tiszta (csak jelzés) | tiszta (provenancia) | rés |
|---|---|---|---|---|
| crypto | 108 | 16 | 13 | 3 |
| weather | 64 | 7 | **2** | 5 |
| sports | 167 | 31 | 15 | 16 |
| hyperliquid | 10 | 9 | 8 | 1 |
| **össz.** | **349** | **63** | **38** | **25** |

- **Hány órás volt a rés-sor a befagyasztáskor** (medián): 14–32 óra; a HL-sor 150 órás volt.
- **Az epoch pontos másodperce nem számít.** Élőben 0 jelzett sor jött létre az epoch után, és ±10 percében egyetlen sor sem jött létre.
- **⚠ Mekkora a hatás valójában.** Ez **provenancia- és számlálási hiba, nem nagy pontszám-torzítás**.
  - A 25 rés-sorból csak 2 ára volt a kimenettől 0,02-n belül.
  - A pontszámok nem változnak, mert a fogyasztók minden sort pontoznak.
  - A walk-forward banner (`category=all`) 30% → **25%** tisztát mutat.

**Fix.** [`prediction-ledger.mts`](../../packages/core/src/prediction-ledger.mts): `FIRST_TUPLE_EPOCH` = `2026-09-09T05:25:24Z` (a B53 deploy-run vége) + `firstObservationProvenance()`. Erre vált az `isCleanFirstObservation` és a `firstObservationCoverage`. Tiszta függvény, adatmigráció nélkül. A `firstBackfilled` hamis doc-ját („Absent/false ⇒ genuine") is javítottam.

**Teszt.** [`prediction-ledger.test.mts`](../../packages/core/src/prediction-ledger.test.mts): pinelve egy élő rés-sor pontos mása, az epoch-határ, a hiányzó/olvashatatlan `firstTs` és a négy élő alak coverage-e. Részletek: [sprints B67](../roadmap/sprints.md).

### 3. A drift-check prompt pontosítása

Ez lokális ütemezett feladat (`edgecalc-drift-check`), nincs a repóban. A változások:

- **A referencia a CLAUDE.md, nem a prompt.** A promptba égetett „15 override" elavult volt, a CLAUDE.md „18"-at mondott, élőben 17 volt. Az AKTUÁLIS ÁLLAPOT elejére kulcsonkénti referencia-lista került, a prompt pedig már nem tartalmaz knob-számot.
- **F-Arb: nyitott = `status = "OPEN"`.** A lezártak a tömbben maradnak.
- **Hiba-számlálás:** `grep -v "likely model error"`. Élőben: nyers 2 → szűrt 0.
- **Tiszta-számláló:** a B67-szabály, plusz `clean_24h` a `resolvedAt`-ból, mert a check futások között nem emlékszik a tegnapi értékre.
- **Sports:** fut (operátor-döntés). A +7,50-es bankroll-fantom ismert eltérés (B70), csak akkor jelenti, ha változik.
- **codeVersion:** a `BUILD_INFO` sha első 12 karaktere, és csak a `builtAt` utáni sorokon kell egyeznie. E nélkül minden deploy után hamis riasztás jönne.
- **Minden parancs 2026-09-10-én élőben kipróbálva.**

### 4. Felvéve / doksi

- **`sprints.md`:**
  - **B67** ✅;
  - **B70** 🟢 backlog (sports bankroll-fantom, operátor-döntés);
  - B38 precondition-állás: 19 tiszta crypto sor.
- **CLAUDE.md:** AKTUÁLIS ÁLLAPOT 2026-09-10, kulcsonkénti knob-referencia-lista, a 90. session „18 override" blokkja átcímkézve, 93. session bejegyzés.
- **`math/21` §6:** provenancia-bekezdés.
- **`playbooks/system-audit.md` §6:** új anti-pattern, „provenancia-jelzőt csak előre bevezetni".

**Verifikáció:** `tsc` 0 · **53/53** teszt · build zöld. Pusholva `main`-re → auto-deploy.

---

## 93. session (folytatás) — B68/B69 felderítés → B71 állomás-fix (5 város) + B70 bankroll-korrekció

A user a párhuzamos session két jelöltjét adta következő feladatnak: B68 (fill-kalibráció külső könyv-archívumból) és B69 (offline ensemble-értékelés). Előbb felderítés jött, három csak-olvasó ágenssel, primer forráson ellenőrizve. Utána a döntések (AskUserQuestion):
- **B71 most;**
- B69 köre 2025-07-től (később);
- **B70 korrekció most;**
- B68 később.

### 1. Felderítés

- **B69 — megvalósítható:**
  - dynamical.org Icechunk (Python ≥ 3.12); a régi Zarr-URL-ek 2026-09-30-tól leállnak;
  - GEFS 00z, **valódi intervallum-maximummal**; IFS-ENS 00z 2024-04-től; AIFS-ENS 6 óránként 2025-07-től;
  - ~74 GB olvasás a 2025-07-től induló közös ablakra, ebből <0,5 GB marad;
  - megfigyelés: IEM METAR. Az ERA5 −0,7…−1,4 °C-kal hideg, nem használható.
- **B68 — a Pendulum Flow v3 alkalmas:** teljes könyv, szintváltozások és trade-ek; ~17 MB range-olvasás lekérésenként.
  - 08-15 és 08-18 között 68 órás lyuk van. Az AG6-tükörnek nincs licence.
  - A saját trade-jeink nem köthetők: nincs token-id, a weathernél bucket sem.
- **A kód-térkép leletei, amiket saját forrásolvasással ellenőriztem:**
  - a weather ág eldobja a fill-modell eredményét (33-ból 6 trade érintett) → B68 előfeltétel;
  - az EMOS megfigyelés begyűjtése nem robusztus → **B72**, mérve ma kicsi;
  - a crypto live-order `size: sizeUSDC` gyanús → B10.
- A részletek a [sprints B68/B69/B72](../roadmap/sprints.md)-ben.

### 2. B71 — 5 városban rossz rezolúciós állomás

A B69-hez a rezolúciós állomások kellettek, ezért a boxról (a Gamma innen blokkolt) mind a 26 aktív város szabályát ellenőriztem. Az eltérés 2026-08-01…09-09 között, IEM METAR napi maximummal, helyi napra (Hongkongnál HKO open data):

| város | volt | a piac szerint | átlag (volt − piac) | ≥1 °C |
|---|---|---|---|---|
| Houston | KIAH | KHOU (Hobby) | **+0,95 °C** | 28/41 nap |
| Szöul | RKSS | RKSI (Incheon) | **+1,24 °C** | 28/41 nap |
| Hongkong | VHHH | Hong Kong Observatory | +0,55 °C | 14/31 nap |
| Denver | KDEN | KBKF (Buckley SFB) | −0,43 °C | 13/41 nap |
| Párizs | LFPG | LFPB (Le Bourget) | −0,20 °C | 12/41 nap |

**Fix:**
- **[`station-config.mts`](../../services/worker/src/pillars/weather/station-config.mts):** 5 állomás ICAO-ja és koordinátája (az IEM metaadataiból). Hongkong azonosítója `HKO`, `obsSource: "hko"`.
- **[`station-obs.mts`](../../services/worker/src/pillars/weather/station-obs.mts):** METAR, vagy HKO `RYES` (`HKOReadingsMaxTemp`). A riport D-napi értéke = D maximuma, 5/5 augusztusi napon egyezik a CLMMAXT-tal. Erre vált az EMOS-reconcile és a reconciler tartalék-ága.
- **Visszaesés elleni őr:** `settlementKey` minden ellenőrzött városra. A market-finder minden szkennelt listingnél összeveti, és eltérésnél `SETTLEMENT_STATION_MISMATCH` logot ír, városonként naponta egyszer, blokkolás nélkül.
- **Seed:** a seed-szkript állomás-listát kap, így a többi 22 állomás illesztése érintetlen marad.

**Teszt és próba:**
- A `station-config.test.mts` és az új `station-obs.test.mts` 54/54 zöld.
- Élő próba deploy előtt: HKO 09-09 = 32,2 °C, 09-10 = 31,9 °C; a METAR RKSI, KHOU és LFPB állomásra rendben.

### 3. B70 — sports bankroll-korrekció (operátor-jóváhagyással)

Védett UPDATE: csak akkor fut, ha a rés pontosan 7,50.
- 18:06 UTC: 43,00 → 35,50.
- A 18:08:42-es tick után is tartós, az invariáns-rés 0,0000.

### 4. Doksi

- **`sprints.md`:** B68/B69 kiegészítve, B70 ✅, **B71** ✅, **B72** 🟡, B10 kiegészítve.
- **CLAUDE.md:** 93. session bejegyzés.
- **`math/16`:** HKO-forrás és állomás-őr.

**Verifikáció:** `tsc` 0 · **54/54** teszt · build zöld.

**Deploy és élő ellenőrzés:**
- `a6c47e5`: a CI és a deploy zöld (18:30 UTC); a box `BUILD_INFO` egyezik, a konténerben az új `station-config` fut.
- EMOS-újratöltés a boxon: 905 seed-sor, mind az 5 állomás illesztve. A többi 22 érintetlen, és a seedelt sorok a következő tick után is megvannak.
- Élőben 0 `SETTLEMENT_STATION_MISMATCH`, 0 valódi hiba. A runner már az új azonosítókkal logol (az RKSI első élő sora).
