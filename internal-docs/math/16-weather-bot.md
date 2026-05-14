# Weather bot – matematikai és működési háttér

> **Hatókör.** Ez a dokumentum a `netlify/functions/auto-trader/weather/` modult írja le: a Polymarket napi-max hőmérsékleti piacokon kereskedő autotrader-t. A bot **prediction-driven** (ensemble időjárás-előrejelzés vs. piaci ár), és **csak valódi, Polymarket Gamma API-ból visszaadott eseményeken** dönt — szintetikus / szimulált piacon nem nyit pozíciót.
>
> **Fontos:** ez a fájl egyben **bug-audit** is — a 2026-05-10-i validáció során 3 kritikus és 4 figyelendő hibát találtunk. A legkritikusabb a settlement-conditionId mismatch (lásd 9. szekció). Amíg az 1-es hiba élesítve nincs, a paper PnL **nem reprezentálja** a valódi PnL-t — ezt a Kalibráció / Edge Tracker értékelésénél is figyelembe kell venni.

---

## Tartalomjegyzék

1. [A bot célja és üzleti modellje](#1-a-bot-célja-és-üzleti-modellje)
2. [Pipeline áttekintés](#2-pipeline-áttekintés)
3. [Adatforrások](#3-adatforrások)
4. [Forecast engine — ensemble matek](#4-forecast-engine--ensemble-matek)
5. [Bucket matching — Gauss PDF allokáció](#5-bucket-matching--gauss-pdf-allokáció)
6. [Settlement-szimuláció: METAR Fahrenheit-rounding](#6-settlement-szimuláció-metar-fahrenheit-rounding)
7. [Decision engine — gate-ek](#7-decision-engine--gate-ek)
8. [Pozíciómérezés — Kelly](#8-pozíciómérezés--kelly)
9. [Settlement / reconciler — Polymarket + METAR fallback](#9-settlement--reconciler--polymarket--metar-fallback)
10. [Paper vs live parity](#10-paper-vs-live-parity)
11. [Live-readiness gate](#11-live-readiness-gate)
12. [DEB — Dynamic Error Balancing](#12-deb--dynamic-error-balancing)
13. [Talált hibák (2026-05-10 audit)](#13-talált-hibák-2026-05-10-audit)
14. [Tesztelési protokoll](#14-tesztelési-protokoll)

---

## 1. A bot célja és üzleti modellje

A Polymarket napi-max hőmérsékleti piacai **negRisk események**: egy `(város, dátum)` páros = egy event, amelyen belül N db binary sub-market van — minden sub-market egy hőmérséklet-bucket (`"21°C"`, `"22°C"`, …, `"27°C or higher"`). Pontosan egy bucket fizet 1 USD-t, az összes többi 0-t. A bucketek YES árainak összege ≈ 1 (likviditás-korrekciókkal).

**Edge forrása.** A piaci konszenzus és a saját ensemble forecastunk (GFS + ECMWF + opc. NOAA + opc. 31-tagú GFS-ENS) közötti eltérés. A piac nem mindig reagál azonnal egy új modell-futásra (00/06/12/18 UTC), és a tail-bucket-ek (`"or below"` / `"or higher"`) esetén a tömeg-szentiment szisztematikusan torzulhat.

**Settlement.** Polymarket UMA-n keresztül a hivatalos repülőtéri **METAR napi-max** °F-egész értékre kerekítve dönt. Ez egy strukturális kvantálás, amit a botnak modelleznie kell — `20.3°C → 68.54°F → 69°F → 20.6°C`.

---

## 2. Pipeline áttekintés

```
┌──────────────────────────────────────────────────────────────────────┐
│  CRON (5 min) vagy manuális Scan gomb                                │
│  └─ auto-trader-weather-cron.mts (csak ha cronEnabled = true)        │
│     └─ getEffectiveWeatherConfig()  ← env defaults + Blobs override  │
│        └─ runWeatherTrader(cfg, source)                              │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  runWeatherTraderInner(config)                                       │
│   1. loadSession(paper, $100, "weather")  ← simVersion auto-reset    │
│   2. computeLiveReadiness() → shouldForcePaper() (paper if not ready)│
│   3. detectModelLag() — skip ha 15 perc-en belül lesz új run         │
│   4. findWeatherMarketsDetailed() → Gamma /events?limit=500          │
│   5. for each market in markets.slice(0, 5):                         │
│      a. getStation(city) — settlement station ICAO + city_offset     │
│      b. getForecast(city, station, date, opts):                      │
│         - GFS + ECMWF Open-Meteo párhuzamos fetch                    │
│         - NOAA api.weather.gov fetch (csak US tz-k)                  │
│         - opc. 31-tagú ensemble (USE_ENSEMBLE / runtime override)    │
│         - DEB-súlyok per város (ha ≥10 closed trade)                 │
│         - computeEnsemble() → ensembleMaxC + confidence              │
│         - correctForecast() → METAR-rounding (°F-egész)              │
│      c. matchBucket(predictedMaxC, outcomes, σ) → BucketMatch        │
│      d. makeWeatherDecision(forecast, match, modelLag, ...) → 6 gate │
│      e. ha shouldTrade: placeBuyOrder() (paper or live)              │
│      f. addOpenPosition() → session blob, weatherMeta + entryDecision│
│   6. saveSession()                                                   │
│   7. saveRunState() — UI status cluster (last/now/ago) frissítése    │
└──────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  CRON (15 min) — auto-trader-weather-reconciler-cron.mts             │
│  └─ runWeatherReconciler(paper)                                      │
│     For each open position with weatherMeta:                         │
│       if Date.now() < reconcileAfter: skip (még nem érett)           │
│       else:                                                          │
│         1. fetchPolymarketResolution(pos.conditionId)                │
│            ↑ (lásd 13. szekció — itt van a kritikus bug!)            │
│         2. ha Polymarket nem resolve: várj 6h-t METAR fallback előtt │
│         3. fetchMetarDailyMax() → bucketFromDailyMax()               │
│         4. closePosition() — exit 0 vagy 1, ClosedTrade rögzítés     │
│         5. recordDebSample() — DEB súlyok frissítése                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Adatforrások

| Forrás | Endpoint | Használat | Paraméterek |
|--------|----------|-----------|-------------|
| **Polymarket Gamma** | `gamma-api.polymarket.com/events` | Piacok keresése + sub-market struktúra | `limit=500&active=true&closed=false&order=volume24hr` |
| **Polymarket Gamma** | `gamma-api.polymarket.com/markets?condition_ids=…&closed=true` | Settlement-state lekérdezés | A `&closed=true` query nélkül a Gamma a lezárt piacokat **elrejti** (ez a reconciler bug-fix `2026-05-10`-ben) |
| **Open-Meteo Forecast** | `api.open-meteo.com/v1/forecast` | GFS és ECMWF determinisztikus run-ok | `models=gfs_seamless` vagy `ecmwf_ifs025`, `forecast_days=2..7`, `timezone=<station.tz>` |
| **Open-Meteo Ensemble** | `ensemble-api.open-meteo.com/v1/ensemble` | 31-tagú GFS perturbed ensemble | `models=gfs_seamless`, `forecast_days=7`. `temperature_2m_member01..member30` + control |
| **NOAA** | `api.weather.gov/points/{lat,lon}` → `forecastHourly` | Csak US-i városokra extra signal | `User-Agent` header kötelező, °F-ban ad értéket |
| **Aviation Weather METAR** | `aviationweather.gov/api/data/metar` | Fallback settlement, DEB feedback | `ids=<ICAO>&format=json&hours=36`. T-group remark-ban van a precíz tenths-°C érték |

> **Megjegyzés:** **Minden 4 forrás public + zéró-auth** — egyetlen API-kulcs sem szükséges. Open-Meteo: 10 000 hívás/nap/IP rate limit (bőven elég 24 város × 4 tick/óra = 2 304 hívás/nap). NOAA + METAR: `User-Agent` header kötelező (hardcoded `"EdgeCalc-AutoTrader/1.0"`), különben 403. A `USE_ENSEMBLE` env nem auth, csak feature-flag.

### 3.B Opcionális adatforrás-upgrade-ek (jövőbeli fejlesztés)

A fenti 4-forrásos pipeline a paper trade-eken validáltan működik (2 closed trade real Polymarket resolution-on, 2026-05-10..13). Az alábbiak **NICE-TO-HAVE** upgrade-ek, amelyek **nem precondition** a live élesítéshez — a mai pipeline elég a sub-$1 000 weather trading-hez.

#### (a) ECMWF közvetlen API — teljes 51-tagú ensemble

- **Endpoint:** [`api.ecmwf.int`](https://api.ecmwf.int) (ECMWF Web API + MARS), saját kulcs.
- **Mit nyer:** A jelenleg fetchelt `ecmwf_ifs025` az Open-Meteo-n keresztül **csak a determinisztikus IFS futás**. A közvetlen API a teljes 51-tagú ECMWF-ENS-t adja — ezt második ensemble-forrásként a `fetchEnsemble` mellé bekötve javul a σ-becslés (jelenleg σ csak GFS 31-tagra épül, az ECMWF-perturbáció zaja nem mérhető).
- **Költség:** akadémiai use case-re ingyenes (jelszó-igénylés ~1 hét átfutás), kereskedelmi célra ~€2 000/hó MARS subscription.
- **Implementáció:** új modul `ecmwf-ensemble.mts` az `ensemble-forecast.mts` mintájára, és a `forecast-engine.mts` `Promise.all`-jában 5. fetch.
- **Becsült edge-növekedés:** +2–4% IC tail-bucket-eken (a kontinentális európai városokon szisztematikusan jobb: Madrid, Milan, Munich, Paris, Ankara).
- **Új env:** `ECMWF_API_KEY` + `ECMWF_API_EMAIL` (sajátkulcs-tárolás Netlify env-ben).
- **Verdict:** **legnagyobb edge-impact / mérsékelt komplexitás.** Akadémiai kulcsra érdemes várni; addig az Open-Meteo deterministic IFS marad.

#### (b) NOAA GFS GRIB2 közvetlen — bypass Open-Meteo aggregátort

- **Forrás:** [`noaa-gfs-bdp-pds`](https://registry.opendata.aws/noaa-gfs-bdp-pds/) S3 public bucket, zéró auth, zéró rate limit.
- **Mit nyer:** Az Open-Meteo ~5–15 perces késéssel szervírozza a fresh GFS futást (saját parsing-batch a háttérben). A közvetlen GRIB2 pull a futás után ~5 perccel kapja meg az adatot → frissebb model-edge, kevesebb model-lag (lásd `model-lag-detector.mts`).
- **Költség:** S3 transfer díj minimális (egy állomásra fókuszált GRIB2 ~0.5 MB / futás × 4 futás/nap × 24 város ≈ $0.05/hó). Zéró API-kulcs.
- **Implementáció:** GRIB2 parser kell — `grib2-simple` npm modul vagy `wgrib2` CLI binary. A Netlify Functions 10s timeout + cold start miatt a CLI-eszköz problémás; pure-JS parser használata feasible, de overhead jelentős.
- **Becsült edge-növekedés:** +5–10 perc model-freshness window-szélesedés, ~+1–2% extra reaktivitás. Marginális, hacsak nem 15-perces market-eken futunk.
- **Verdict:** **csak Hetzner-migráció (C1) után érdemes**, párhuzamosan a WebSocket-feedekkel. Netlify-on a parser overhead felemészti a freshness-nyereséget.

#### (c) Kereskedelmi időjárás-szolgáltatók

- **Jelöltek:** Tomorrow.io, Visual Crossing, AccuWeather Enterprise, Weather Underground PWS.
- **Költség:** $50–500/hó tier-től függően.
- **Mit nyer:** Jobb retrospektív validáció (10+ év historikus modell-output IC-kalibrációhoz), saját proprietary ensemble (pl. Tomorrow.io a Pangaea-modell-jét keveri GFS+ECMWF-fel), néhol sűrűbb update frequency.
- **Verdict:** **NEM ajánlott a jelenlegi skálán.** A GFS+ECMWF+DEB-blend forecast-minősége nem érdemben rosszabb a kereskedelmi szolgáltatóknál a 24–72h-os horizonton. A $50–500/hó költség csak ROI-pozitív, ha az aggregált weather-trade volume > $5 000/hó. Jelenleg a paper-mode bankroll $100 → 50–100x volume-növekedés kell hozzá.
- **Kivétel:** ha multi-day market-ekre (3–7 nap előre) bővítünk, és a 7-day GFS skill-drop kritikus lesz → akkor a Tomorrow.io "Beyond Tomorrow" tier (~$250/hó) megfontolható.

#### Mit NE csináljunk

- ❌ **Multiple Open-Meteo accounts a rate limit kerülésére.** A 10 000 hívás/nap/IP bőven elég, +4× headroom van.
- ❌ **OpenWeatherMap.** Pontatlan modell, korlátozott update freq, $40/hó. Strikt rosszabb az Open-Meteo-nál (egyező GFS/ECMWF backend, gyengébb post-processing).
- ❌ **GFS GRIB2 saját parsing Netlify Functions-on.** A 10s timeout + cold start + parser-init nem fér bele biztonságosan.

#### Prioritási sorrend (ha valamikor erőforrás lesz rá)

1. **(a) ECMWF közvetlen** — legnagyobb edge-impact, akadémiai kulcs ingyenes, ~3 nap implementáció.
2. **(b) NOAA GFS GRIB2** — csak C1 (Hetzner) után, mert Netlify-on a parser overhead = freshness-nyereség.
3. **(c) Kereskedelmi szolgáltató** — csak skálázódás után ($5k+/hó volume) vagy multi-day market-bővülés esetén.

**Tracking:** master-plan.md `🟢 NICE-TO-HAVE` 13. tétel hivatkozik vissza erre a szekcióra.

---

## 4. Forecast engine — ensemble matek

### 4.1 Bázis-ensemble (GFS + ECMWF + NOAA)

Ha legalább 1 modell sikerült (GFS / ECMWF / NOAA), a bázis-ensemble súlyozott átlag:

$$
T_{\text{ensemble}} = \frac{\sum_{m \in M} w_m \cdot T_m}{\sum_{m \in M} w_m}
$$

ahol:
- $T_m$ = adott modell napi maxja (°C-ban) a `targetDate`-en (filtrált station-tz lokál nappal)
- $w_m$ = DEB-súly (lásd 12. szekció) × **felhő-boost**:
  - `cloudCoverPct > 60` → ECMWF × 1.3, GFS × 0.8 (ECMWF erősebb borult, párás regime-en)
  - egyébként mindkettő × 1.0
- $M$ = sikeres modellek halmaza (legalább 1)

### 4.2 Konfidencia (bázis)

A bázis-konfidencia a modellek közötti `spread` alapján:

$$
\text{spread} = \max_{m \in M}(T_m) - \min_{m \in M}(T_m)
$$

$$
\text{confidence}_{\text{base}} = \text{clamp}\left(1 - \frac{\text{spread}}{5.0}, \; 0.30, \; 0.95\right)
$$

- `spread < 1°C` → confidence ≈ 0.80
- `spread > 3°C` → confidence ≈ 0.40

Egyetlen modell esetén `spread = 2.0` (fix prior).

### 4.3 31-tagú GFS ensemble (opcionális)

Ha `USE_ENSEMBLE=true` és a `fetchEnsemble()` legalább **5 tagot** ad vissza, az ensemble felülírja a bázist:

$$
T_{\text{ensemble}} = \mu = \frac{1}{N} \sum_{i=1}^{N} T_i^{(\text{member})}
$$

$$
\sigma = \sqrt{\frac{1}{N-1} \sum_{i=1}^{N} (T_i - \mu)^2}
$$

$$
\text{confidence}_{\text{ens}} = \text{clamp}\left(1 - \frac{\sigma}{4.0}, \; 0.30, \; 0.95\right)
$$

A 31-tagú ensemble jobb **signal-to-noise** mert:
1. ECMWF többször nem érhető el a futtatás határáig → bázis 1-modellesre esik vissza
2. A perturbed tagok közötti `σ` jobb proxy a tényleges modell-bizonytalanságra mint a két determinisztikus modell közötti spread

A legtöbb városra `σ ≈ 0.5–1.5°C`, ami `confidence ≈ 0.62–0.88`.

### 4.4 Bias-korrekció (city offset opcionális)

A `correctForecast(temp, offset)` két lépést alkalmaz:

```
stationTemp  = temp + offset    (csak ha applyCityOffset = true)
predictedMaxC = simulateMetarRounding(stationTemp)
```

Az offset **alapesetben 0** (`applyCityOffset = false`), mert az Open-Meteo a station koordinátáin (repülőtér) ad eredményt — már station-relatív érték. A korábbi (2026-05-09 előtti) verzió fixen hozzáadta az offsetet, ami szisztematikus ~1°C alulbecslést okozott a Hong Kong–EGLC–stb. piacokon.

> **Megjegyzés.** Ha valaki a Settings-ben bekapcsolja az `applyCityOffset`-et, az csak akkor helyes, ha az adott `getForecast()` mégis a város-centrum koordinátáin lekérdezett értéket adna. A jelenlegi `fetchOpenMeteo()` viszont mindig a `station.lat/lon`-on kérdez, ezért a flag használata most **kontraproduktív**.

A METAR-rounding pedig **mindig** alkalmazódik (lásd 6. szekció).

---

## 5. Bucket matching — Gauss CDF interval allokáció (v2, 2026-05-11)

A `matchBucket(predictedTempC, buckets, σ)` minden bucket-et **interval-ként** kezel, és a hozzá tartozó valószínűséget Gauss CDF integrálással számolja:

$$
P(\text{bucket}_i) = \Phi\!\left(\frac{\text{hi}_i - T_{\text{pred}}}{\sigma}\right) - \Phi\!\left(\frac{\text{lo}_i - T_{\text{pred}}}{\sigma}\right)
$$

ahol `[lo_i, hi_i]` minden bucket természetes intervalluma a szortírozott szomszédok félútjából származik:

- **Belső bucket** (`i > 0` és `i < N-1`): `lo = (T_{i-1} + T_i)/2`, `hi = (T_i + T_{i+1})/2`
- **Alsó tail** (`label tartalmazza "or below" / "or lower"`): `lo = -∞`, `hi = (T_0 + T_1)/2`
- **Felső tail** (`label tartalmazza "or higher" / "or above" / "or more"`): `lo = (T_{N-2} + T_{N-1})/2`, `hi = +∞`
- **Szélső, de nem tail**: a szomszéd felé félút, ellenkező oldalon `T_i ± fél-step` (graceful degradation single-bucket esetén)

A masszok pontosan 1-re összegződnek tail-completion esetén; ha nincs explicit tail, a numerikus normalizáció a bucket-listán belül megőrzi a valószínűség-tulajdonságot.

**Edge per bucket:**

$$
\text{edge}_i = P(\text{bucket}_i) - \text{price}_i^{\text{YES}}
$$

A bot a **legnagyobb |edge|-ű** bucket-en próbál kereskedni, irány = `edge > 0 ? YES : NO`.

### Miért CDF, nem PDF (a v1 hiba)

A 2026-05-11 audit kimutatta, hogy a v1 PDF-alapú matcher két strukturális torzítást okozott:

1. **Tail-bucketek pontmázsaként kezelve.** A `"84°F or higher"` típusú label `tempC=28.89` küszöbként parse-olódott, és a matcher a PDF-et a küszöb pontjában mintázta — a Polymarket viszont az **integrál** `[28.89, ∞)`-en settlel. A v1 ezért szisztematikusan alulbecslte a tail-buckete-k valószínűségét, ami a belső buckete-k masszáját túlbecsülte. Konkrét hatás: 2026-05-10 Austin pozíció `P(82-83°F) = 38.8%` (PDF) helyett **25.8%** (CDF), gross edge `22.3% → 8.8%` — a trade most már nem zsörös át a 12%-os küszöbön.

2. **Belső bucket-szélesség figyelmen kívül hagyva.** A v1 minden bucket-et 1 pontként mintázott, így pl. egy 2°F-es buckete (`"82-83°F"` ≈ 1.11°C-os szélesség) ugyanazt a súlyt kapott mint egy 0.55°C-os integer °C bucket. A CDF-integrál ezt a strukturális szélességkülönbséget korrektül kezeli.

Shanghai 25°C YES trade-en a változás minimális (PDF 20.3% → CDF 20.2%), mert ez egy belső, közel-modális bucket; a Gauss-PDF közelítése itt ~jó. A különbség élesedik a tail-közeli buckete-eknél.

### σ választás

| Felhőborítottság (avg GFS+ECMWF) | σ | Indoklás |
|------------------|---|----------|
| `< 60%` | **1.0°C** | Tiszta ég, kis radiation forecast hiba |
| `≥ 60%` | **1.5°C** | Borult, párás regime — nagyobb modell-residual |

A felhőborítás 2026-05-11 óta GFS + ECMWF **átlag** (előtte csak GFS-ből jött, ami a két modell közti diszparitásnál ingadozott).

**Empirical σ via 31-tagú ensemble.** Ha `USE_ENSEMBLE = true` (default 2026-05-11 óta), a `confidence` mező a 31 perturbed GFS-tag empirikus szórásából származik (`σ_emp`), nem a 1.0/1.5 hardcoded értékből. A bucket-matcher `σ` paramétere továbbra is a `cloudCoverPct`-alapú értéket használja, **de a `confidence` skálázás ennek finomabb visszacsatolása**.

> **Kalibráció TODO.** A bucket-matcher `σ` paramétere nincs historikus residual-eloszlásból mérve. Hosszú távon a DEB-hez hasonló per-város / per-évszak residual-tanulás kellene a `σ`-ra is.

---

## 6. Settlement-szimuláció: METAR Fahrenheit-rounding

A Polymarket az UMA-n keresztül **°F-egész**re kerekített METAR napi-max-on settlel. Ezt két helyen szimuláljuk:

**Forecast oldalon** (`metar-simulator.simulateMetarRounding`):

```
20.3°C  →  68.54°F  →  69°F (METAR round)  →  20.6°C
20.1°C  →  68.18°F  →  68°F                →  20.0°C
```

**METAR fallback oldalon** (`reconciler.runWeatherReconciler`):

```javascript
const f = metar.dailyMaxC * 9 / 5 + 32;
const settlementC = parseFloat((((Math.round(f) - 32) * 5) / 9).toFixed(2));
```

**Bias.** A 32 °F egységen belül a kerekítés ±0.28°C-os strukturális zaj. Egy 20.6°C–20.7°C közötti előrejelzés helyett a piac sokszor a 20°C, 21°C buckete-ket árazza — az aktuális kerekítés ezért aszimmetrikus edge-forrás lehet, főleg a bucket-határokhoz közeli forecast-oknál.

### Tail-bucket logika

A `bucketFromDailyMax` és a reconciler explicit ellenőrzi a "X°C or below" / "X°C or higher" labeleket regex-szel:

```javascript
const isLowerTail = /\bor\s+below\b|\bor\s+lower\b/i.test(label);
const isUpperTail = /\bor\s+(higher|above|more)\b/i.test(label);
```

- `isLowerTail && settlementC <= bucketTempC` → tail-bucket nyer
- `isUpperTail && settlementC >= bucketTempC` → tail-bucket nyer
- Egyébként a `settlementC`-hez **legközelebbi center**-ű bucket (1°C-es bucket-szélesség)

---

## 7. Decision engine — gate-ek

A `makeWeatherDecision()` 7 gate-en keresztül engedi át a trade-et. Mind a 7 megjelenik a UI "Why?" popoverében (pass/fail + actual + required + hint).

| # | Gate | Default küszöb | Mit néz | Bukás reason |
|---|------|----------------|---------|--------------|
| 1 | Confidence ≥ küszöb | `confidenceMin = 0.65` | `forecast.confidence` | Túl szétszórt ensemble — várjuk az új modellt |
| 2 | Idő settlementig ≥ küszöb | `exitBeforeMin = 45 min` | `(endDate - now) / 60_000` | Túl közeli endDate — nincs idő reagálni |
| 3 | Forecast model frissesség | `nearBoundary = next run < 15 min` | `detectModelLag()` | Modell-határ — várjuk az új run-t |
| 4 | Net edge ≥ küszöb | `edgeThreshold = 0.12` | `\|prob - price\| - feePct` | Edge alacsony, no-trade |
| 4b | Sanity cap (gross ≤ cap) | `maxEdgeCap = 0.40` | `\|prob - price\|` | "Too good to be true" — modell-hiba |
| 5 | Market disagreement ≤ küszöb | `marketDisagreeMaxC = 2.0°C` | `\|predTempC − marketModalTempC\|` | A bot túl messzire jósol a market modális bucketjétől — valószínűbb modellhiba mint alfa |
| 6 | Kelly méret ≤ cap | `KELLY_CAP = 0.15` | `clamp(Kelly, 0, 0.15)` | Strukturálisan nem bukhat el (clamp), de a UI ezzel mutatja a sizing-ot |

### Az 5-ös market-disagreement gate (2026-05-11 óta)

A `marketConsensusModalTempC(buckets)` a legmagasabban árazott bucket centerét adja vissza — ez a tömeg-szentiment modaljának proxy-ja. Ha a bot predikciója >2°C-kal eltér ettől, az tipikusan modellhibát jelez (rossz station, °F→°C tévedés, stale forecast), nem alfát. A 2.0°C ≈ 3.6°F default általában 1–2 bucket spread-en belül enged, ami a tipikus alfa-ablak.

Soft-fail: ha a market modal nem parse-olható (tail bucket parseolható center nélkül vagy üres lineup), a gate átmegy (passed=true, actual="no market modal").

### A 4b sanity cap miért fontos

A cap nem konzervativizmus, hanem **kalibráció-vízválasztó**. Egy 70% gross edge-ű forecast nem lehetőség, hanem hiba: vagy rossz station (`KJFK` vs `KLGA`), vagy °F→°C tévedés, vagy a `applyCityOffset` bug visszaütött. Ha a cap blokkolja a trade-et, a `Run log → Skipped events` szekciójában megjelenik a reason — ez a leghasznosabb diagnosztika a forecast-ről.

### Modell-lag detektor

GFS és ECMWF run-ok: 00/06/12/18 UTC. Adat ~30 perc után érhető el. A bot:
- `nearBoundary = (next available - now) < 15 min` → skip (modell-állás közeli)
- `hasLag = 15 ≤ modelAge ≤ 120 min` → optimális trading window (a piac még nem reagált)

---

## 8. Pozíciómérezés — Kelly

A `decision-engine` egy **konzervatív ¼-Kelly**-t használ confidence-skálázással:

$$
f^*_{\text{raw}} = \text{netEdge} \cdot \text{confidence} \cdot 0.25
$$

$$
f^*_{\text{capped}} = \min(f^*_{\text{raw}}, \; 0.15)
$$

$$
\text{positionSize}_{\text{USDC}} = \min(\text{bankroll} \cdot f^*_{\text{capped}}, \; \text{maxPositionUSD})
$$

Defaults:
- `maxPositionUSD = 25` (env `WEATHER_MAX_POSITION_USD`)
- `KELLY_CAP = 0.15` (hard kód)
- `bankroll = 100` (default, Settings-ben módosítható, lásd 9. session changelog)

A `confidence` szorzó miatt egy 30%-os edge-en is csak 0.30 × 0.65 × 0.25 = 4.875% Kelly fut, ami $4.88 a $100 bankrollon (max $25 cap mellett).

> **Eltérés a crypto bot-tól.** A crypto bot a signal-combiner Kelly-jét használja, ami signal-IC-ből származik. A weather Kelly egyszerűbb képlet, mert csak egy "signal" van (forecast vs piac). A `kellyFraction = 0` hard-skip (P2.1) **nem** vonatkozik a weather bot-ra — a confidence már szerepel a Kelly képletben.

---

## 9. Settlement / reconciler — Polymarket + METAR fallback

### Forrás-prioritás

1. **Polymarket (autoritatív)**: `fetchPolymarketResolution(conditionId)` lekérdezi a Gamma `/markets?condition_ids=…&closed=true`-t. Ha `closed=true` és `outcomePrices ∈ {[0,1], [1,0]}`, snap-elünk 0/1-re és lezárjuk a pozíciót.
2. **METAR fallback (`reconcileAfter + 6h` után)**: az `aviationweather.gov` API-ról húzzuk a 36-órás METAR-blokkot, station-tz-ben szűrjük a target napra, dailyMax-ot számolunk a pontos T-group remarkból. Az °C → °F → round → °C konverzióval szimuláljuk a settlement-et, és a tail-bucket / nearest-center logikával eldöntjük melyik bucket nyer.

### Időablakok

```
endDate ─────┬──── reconcileAfter ──── reconcileAfter + 6h
             │
             1h safety margin (settlement window kezdete)
             │
             ▼
         első reconcile-tick
         (Polymarket-only)
                                                │
                                                ▼
                                            Polymarket fail után
                                            METAR-fallback engedélyezve
```

A reconciler cron `*/15 * * * *` ütemen fut, és **minden** open position-t scannel — paper és live egyaránt.

### PnL képlet

```
proceeds = pos.shares * exitPrice
pnl      = proceeds - pos.costBasis
pnlPct   = pnl / pos.costBasis * 100
isWin    = exitPrice > 0.5
```

ahol:
- `pos.shares = sizeUSDC / entryPrice`
- `exitPrice = pos.direction === "YES" ? yesResolvedPrice : noResolvedPrice`

Polymarket esetén `yesResolvedPrice ∈ {0, 1}` és `noResolvedPrice = 1 - yesResolvedPrice`. METAR fallback esetén `exitPrice = bucketWon ? 1.0 : 0.0`, plusz az `isWin` ennek megfelelően.

> **KRITIKUS HIBA itt van.** Lásd 13.1 — `pos.conditionId` jelenleg a sub-market #0 conditionId-ja, nem a megfogadott bucket-é. A Polymarket-resolution így a **rossz** sub-market kimenetét kérdezi le, és attól fügően könyvel ki PnL-t.

---

## 10. Paper vs live parity

| Aspect | Paper | Live | Identikus? |
|--------|-------|------|------------|
| Market-keresés | Gamma /events | Gamma /events | ✅ |
| Forecast | Open-Meteo + NOAA + opc. ENS | Open-Meteo + NOAA + opc. ENS | ✅ |
| Decision-engine 6 gate | ugyanaz | ugyanaz | ✅ |
| `placeBuyOrder` | instant FILLED, `sizeUSDC / price` shares | CLOB createAndPostOrder | **❌** lásd 13.2 |
| Slippage | `entryPrice = marketPrice + 0.01` | tényleges fill price | ⚠️ idealizált |
| Settlement | Polymarket → METAR fallback | UMA → on-chain redeem | ⚠️ paper más útvonalon |
| PnL képlet | `shares × exitPrice − costBasis` | claim után USDC visszaérkezés | ✅ matematikailag azonos |
| `simVersion` gate | igen, `PAPER_SIM_VERSION` | n/a | n/a |

### Hol különbözik (szándékos idealizáció)

1. **Paper instant fill at marketPrice + 1¢**: a CLOB könyvelést nem szimuláljuk — feltételezzük hogy az 1¢ slippage alatt mindig találunk likviditást. Reális, ha a bucket-en `volume24h > 1000 USDC`, viszont `< 100 USDC`-s mid-prob bucket-eken túloptimista. A `dropped` log mutatja a kis volumenű piacokat.
2. **Paper conditionId-only resolution**: nem hívunk on-chain `redeem`-et, csak a Gamma resolution-t. Live módban a bot jelenleg sem redeem-el automatikusan a weather pozíciókra (csak a Polymarket UI-on manuálisan, vagy a `polymarket-redeem` function-nel).
3. **Paper nem fizet UMA dispute fees**: szignifikáns piacokon ritka (< 1% a tapasztalat szerint), de létezik. Live-on enyhe drawdown.

### Hol különbözik (NEM szándékos — bug)

Lásd 13. szekció, főleg:
- 13.1 – paper resolution **rossz sub-market**-et kérdez le → systematikus mis-pricing
- 13.2 – live execution NO direction-höz nem talál tokenId-t → REJECTED
- 13.3 – `negRisk: false` flag a CLOB hívásban → routing hiba

---

## 11. Live-readiness gate

A `computeLiveReadiness()` minden cron-tick előtt eldönti, hogy szabad-e élesedni. A weather kategória **prediction-driven**, ezért a teljes 7-gate set fut (kivéve `simVersion`, ami a code szerint `simVersionExpected: null`).

| Gate | Default | Why |
|------|---------|-----|
| Trade count ≥ 30 | 30 | Bootstrapping minimum |
| Win rate ≥ 50% | 0.50 | Pozitív expected value |
| Max \|IC\| ≥ 5% | 0.05 | Legalább 1 signal informatív |
| Calibration dev < 7% | 0.07 | A predicted prob ≈ realized hit rate |
| Sharpe ≥ 0.5 | 0.5 | Risk-adjusted return |
| Max drawdown < 25% | 25% | Survivability check |
| Session active | – | Nincs auto-stop trigger |

Ha bármelyik applicable gate megbukik → a következő cron tick **automatikusan paper módba kapcsol**, függetlenül a `paperMode = false` config-tól. Ezt a `shouldForcePaper()` enforce-olja, és a Telegram alarm session-ankent egyszer fut.

> **Gyengeség.** A `simVersionExpected: null` a weather oldalon azt jelenti, hogy egy esetleges `WEATHER_PAPER_SIM_VERSION` bump nem archiválja az old trade-eket — a 13.1 hiba javítása után a régi (buggy resolver-rel rögzített) closed-trade-ek **továbbra is beleszámítanak** a live-readiness IC / calibration gate-ekbe, és felülírhatják a friss adatokat. A javítás után **manual reset** kell.

---

## 12. DEB — Dynamic Error Balancing

A `getDebWeights(city)` minden forecast-fetch előtt egy per-város állapotot tölt be a Netlify Blobs-ból. Bootstrapping: `< 10` zárt trade → fixed defaults `{gfs: 0.6, ecmwf: 0.4, noaa: 0.5}`.

### Súly-számítás 10+ minta után

$$
\text{MAE}_m = \frac{1}{N_m} \sum_{i=1}^{N_m} |T_m^{(i)} - T_{\text{actual}}^{(i)}|
$$

$$
w_m^{\text{deb}} = \frac{1}{\text{MAE}_m + \epsilon}, \quad \epsilon = 0.2
$$

$$
w_m^{\text{final}} = 0.6 \cdot \frac{w_m^{\text{deb}}}{\sum_k w_k^{\text{deb}}} + 0.4 \cdot w_m^{\text{default}}
$$

A 60/40 blend megakadályozza a small-sample over-fitting-et.

### Mi triggereli a DEB sample-t

A reconciler **csak** akkor hívja a `recordDebSample()`-t, ha `actualMaxC` ismert. Polymarket settlement esetén nincs konkrét hőmérséklet (csak nyertes bucket), tehát csak a METAR-fallback ad DEB feedback-et.

> **Adathiány.** A 13.1 bug fix után a Polymarket resolution gyorsabb és gyakoribb lesz mint a METAR fallback. Ez azt jelenti, a DEB samples nagyon ritkán keletkezik, és a per-város súlyok lassan konvergálnak. A fix javasolt: minden settled trade után függetlenül indítsuk a METAR fetchet **csak** a DEB sample miatt (nem a PnL miatt).

---

## 13. Talált hibák (2026-05-10 audit)

### 13.1 ✅ JAVÍTVA (2026-05-10) — Bucket conditionId mismatch (mis-settlement)

> **Fix kommittelve.** `TemperatureBucket.conditionId` per-bucket mentve, és a `position.conditionId` a `match.bucket.conditionId`-ot használja, nem az event-szintűt.

**Hely:** `weather/market-finder.mts:255`
```typescript
conditionId: evt.markets?.[0]?.conditionId || "",  // not used for negRisk exec
```

**Bug:** A `WeatherMarket.conditionId` mindig az event ELSŐ sub-marketjének conditionId-ja, függetlenül attól melyik bucket-en nyit a bot pozíciót. A Polymarket-en minden bucket önálló binary sub-market saját conditionId-vel — empirikusan ellenőrizve:

```
Event: highest-temperature-in-hong-kong-on-may-10-2026
  19°C or below → 0xba734f939...  ← ezt menti a bot mindenhova
  20°C          → 0xe1ff5e8b87... ← ami valójában érvényes a 20°C bet-en
  21°C          → 0xdf99810...
  22°C          → 0x804f3283...
  23°C          → 0x26bd57d3e...
  24°C          → 0x66878a4f88...
```

A `position.conditionId = market.conditionId` (`weather/index.mts:370`) — szintén az #0-t menti.

A reconciler `fetchPolymarketResolution(pos.conditionId)` **a rossz bucket-et** kérdezi le. Ha a bot a 23°C bucket-re tett YES-t, de az #0 (`19°C or below`) lekérdezi (ami a normál nappokon NO-ra resolve-ol), akkor:
- `yesResolvedPrice = 0`, `noResolvedPrice = 1`
- `exitPrice = pos.direction === "YES" ? 0 : 1`

**Következmény (paper mód):**
- Minden YES bet az #0-tól eltérő bucket-en → `exit = 0` → **mindig "loss"** könyvelve
- Minden NO bet az #0-tól eltérő bucket-en → `exit = 1` → **mindig "win"** könyvelve
- Csak ha az #0 (lower-tail) ténylegesen YES-re resolve-ol (ritka), akkor véletlenül helyes az #0-ra fogadott pozíció

**Javítás:**
1. `parseBucketsFromEvent()`-ben a `TemperatureBucket` típushoz hozzáadni `conditionId: string` és `noTokenId: string` mezőt:
   ```typescript
   buckets.push({
     label, tempC, currentPrice: prices[0] ?? 0.5,
     tokenId:     clobIds[0] || "",   // YES
     noTokenId:   clobIds[1] || "",   // NO
     conditionId: m.conditionId || "",
   });
   ```
2. `index.mts`-ben a `position.conditionId = match.bucket.conditionId` (nem `market.conditionId`)
3. `toMarketInfo()`-ban átadni mindkét clob-tokenId-t (lásd 13.2)

**Hatás:** **Az összes eddigi paper closed trade érvénytelen** — manual reset kell a fix után.

### 13.2 ✅ JAVÍTVA (2026-05-10) — NO direction-höz nincs tokenId (live order REJECTED)

> **Fix kommittelve.** `TemperatureBucket.noTokenId` per-bucket mentve. `toMarketInfo()` `[bucket.tokenId, bucket.noTokenId]`-t ad át. A `position.tokenId` a direction szerint választódik (YES → bucket.tokenId, NO → bucket.noTokenId).

**Hely:** `weather/index.mts:117-132`
```typescript
function toMarketInfo(wm: WeatherMarket, tokenId: string): MarketInfo {
  return {
    ...
    clobTokenIds: [tokenId, ""],  // YES token, NO not used directly
    ...
  };
}
```

A `placeBuyOrder()` (crypto/execution.mts) így választ:
```typescript
const tokenId = direction === "YES" ? market.clobTokenIds[0] : market.clobTokenIds[1];
```

**Bug:** Ha a decision direction = NO, a bot a `""` üres string-et adja át token-ként a CLOB-nak. **Live módban azonnali REJECTED**, paper módban silently "FILLED" hamis tokenId-vel.

**Javítás:** `parseBucketsFromEvent` mentse el a NO tokenId-t is (`clobIds[1]`), és `toMarketInfo()` adjon vissza `[bucket.tokenId, bucket.noTokenId]`-t.

### 13.3 ✅ JAVÍTVA (2026-05-10) — `negRisk: false` flag a CLOB hívásban

> **Fix kommittelve.** `placeBuyOrder()` kapott egy `isNegRisk = false` opcionális paramétert. A weather oldali hívás `true`-val megy. A crypto bot változatlanul `false`-szal hív.

**Hely:** `crypto/execution.mts:107`
```typescript
{ tickSize: "0.01", negRisk: false },
```

**Bug:** A weather event-ek **negRisk** csoportok a Polymarket-en. A weather bot a `crypto/execution.mts`-t használja, ami hard-coded `negRisk: false`-szal hívja a `createAndPostOrder`-t. A CLOB ezt valószínűleg routing-hibára küldi.

**Javítás:** vagy
- külön `weather/execution.mts` `negRisk: true`-val, vagy
- `placeBuyOrder()`-be opcionális `isNegRisk = false` paraméter, és weather oldalon `true`-val hívni.

### 13.4 🟡 MEDIUM — `parseDateFromSlug` év-defaulting

**Hely:** `weather/market-finder.mts:91-93`
```typescript
const year = match[2] || new Date().getFullYear().toString();
```

**Bug:** Ha a slug `january-3` formátumú (év nélkül), és az aktuális napt 2026-12-31, a parser `2026-01-03`-at ad vissza (múlt) — viszont a market valójában `2027-01-03`-ra szól.

**Hatás:** Az `endDate < now` filter (lines 248) majd kidobja, így a market silently dropped lesz. **Nem korrupt**, csak adatvesztés cross-year határon.

**Javítás:** ha az `endDate` egyértelműen jövőbeli, override-olni az slug-parse-olt évet az `endDate` évével.

### 13.5 🟡 MEDIUM — σ (forecast uncertainty) nincs kalibrálva

**Hely:** `weather/index.mts:274`
```typescript
const sigma = forecast.cloudCoverPct > 60 ? 1.5 : 1.0;
```

**Bug:** A σ fix érték, nem zárt-trade-ek empirikus residual-eloszlásából mért. Ha a tényleges 1-day-ahead std 0.7°C, a bot túl-fluffy Gauss-szal allokál → minden bucket P-je egyenletesebb mint kellene → alulbecsült edge → kihagyott opportunity-k. Fordítva ha 2°C, a Gauss túl éles → felülbecsült edge → 4b sanity cap blokkol.

**Javítás:** per-város (vagy globális) rolling residual-window a `recordDebSample`-höz hasonlóan. 30+ minta után átállni az empirikus σ-ra.

### 13.6 🟡 LOW — `simVersionExpected: null` weather-en

**Hely:** `weather/index.mts:181`
```typescript
simVersionExpected: null,
```

**Bug:** A live-readiness gate nem ellenőrzi a paper-sim version-t weather-en. Ez most nem feltűnő, mert a weather-nek nincs külön `WEATHER_PAPER_SIM_VERSION` konstans-a — de ha 13.1 fix-után bumpoljuk, az old trade-ek továbbra is beleszámítanak az IC / calibration gate-ekbe.

**Javítás:** Bevezetni `WEATHER_PAPER_SIM_VERSION` (kezdeti érték = 1), és a `loadSession()`-ben weather kategóriára is futtatni az auto-archive-ot.

### 13.7 🟡 LOW — DEB samples csak METAR-fallbackből

**Hely:** `weather/reconciler.mts:204-216`

**Bug:** A `recordDebSample()` csak akkor fut, ha `actualMaxC !== null`, ami a Polymarket-resolution útján sosem teljesül (csak a METAR fallback hozza). A 13.1 fix után a Polymarket resolution lesz a normál útvonal, és a DEB **lassul** vagy leáll.

**Javítás:** Polymarket settle után is futtassuk a `fetchMetarDailyMax()`-t **csak a DEB feedback-hez** (PnL-t a Polymarket határozza meg).

### 13.8 ✅ JAVÍTVA (2026-05-14e) — Cross-position outcome-sum gate

**Hely:** `weather/decision-engine.mts` — új `Monotonicitás (egyéb nyitott pozíciók)` gate (WEATHER_GATE_LABELS[7]).

**Probléma:** A weather decision-engine **per-trade** értékelte a forecast vs bucket edge-et, de a már nyitott YES pozíciókat nem nézte. Polymarket weather event = negRisk csoport ahol a bucket-ek **kölcsönösen kizárók**, ezért `Σ predictedProb(YES pozíciók egy (city, date) csoporton) ≤ 1.0` matematikailag kötelező. Ha a bot mondjuk Shanghai 2026-05-15-re először nyit YES @ 21°C bucket-en `predProb=0.40`, majd egy következő tick-en YES @ 22°C bucket-en `predProb=0.40`, majd YES @ 23°C bucket-en `predProb=0.40` → `Σ = 1.20 > 1.0` az ensemble előrejelzés szerint, ami **modell-ellentmondás** (a 3 esemény egymást kizárja, a model szerint mindhárom 40%+ valószínűséggel megy).

**Fix**: új gate, csak YES kandidátusokon fut, group-key `${forecast.city}::${forecast.date}`. Számolja Σ `predictedProb` a már nyitott YES weather-pozíciók ugyanezen csoportján, majd hozzáadja a kandidátus `match.probability`-jét. Ha `> 1.0 + 1e-6` → block, hint mutatja a részleteket. NO oldali kandidátusok pass-olnak (egy NO implicit lefedi az összes többi bucket-et, nem akkumulál).

**Trigger / kontextus**: a 2026-05-14 paper session a Crypto bot 78K/80K monotonicitás-incidense után az 5-bot cross-position-consistency sweep része. A weather-bot esetén nem volt élő példa, de a strukturális kockázat ugyanaz mint a crypto bot-é — defense-in-depth a teljes lineup-on.

---

## 14. Tesztelési protokoll

### 14.1 Bug-fix után smoke test

1. **Reset:** Settings → Reset session (RESET szó begépelése), backup mentés JSON-ba.
2. **Cron disable:** `weatherCronEnabled = false`, manuális Scan-nel tesztelünk.
3. **Forecast sanity:** Egy ismert városon (pl. Hong Kong) 2-3 manuális Scan, ellenőrizni a `Run log → Forecast` szekciót:
   - `predictedMaxC` ≈ a Polymarket-en is látott "fair value" (±1°C)
   - `confidence` 0.60–0.85 között
   - `gross edge < 30%` (különben 4b blokkol)
4. **Bucket conditionId verifikáció:** Új trade nyitásakor manuálisan ellenőrizni a session blob-ot:
   - `pos.conditionId` legyen **az adott bucket** conditionId-ja, nem az #0-é
   - `pos.tokenId` legyen az adott bucket YES vagy NO token-je (irány szerint)
5. **Reconcile:** A market endDate után (settlement window-ban) manuálisan triggerelni a reconciler-t, ellenőrizni hogy a Polymarket válasz `outcomePrices` exact match a tényleges nyertes bucket-tel.
6. **METAR fallback:** Egy esetben szándékosan blokkolni a Polymarket-fetch-et (network) és a 6h-os timer után figyelni hogy az METAR-fallback helyesen settlel.
7. **Kalibráció:** 30+ closed trade után a Calibration Health badge legyen `good` (`|IC| ≥ 0.05`) vagy `weak` — ha `noise` (< 0.02), akkor a kalibrációs gyengeség valós, nem a 13.1 bug.

### 14.2 Paper vs Live cross-check

- A paper closed trade `exitPrice ∈ {0.0, 1.0}` (Polymarket) vagy `{0.0, 1.0}` (METAR).
- **Soha** nem szabad hogy bárhol `exitPrice ∈ (0, 1)` legyen (kivéve ha a UMA dispute után fractional resolution lett — akkor azt loggolni kell).

### 14.3 Periodikus audit checklist

Havi:
- [ ] Calibration deviation < 7%
- [ ] Max |IC| ≥ 0.05 valamelyik signal-on
- [ ] DEB súlyok mozogtak-e (nem bootstrapping)?
- [ ] City coverage: hány új város jelent meg a Polymarket-en de `dropped: no-city-mapped`-pal lett kihagyva?

Eseti:
- [ ] Új season-ba lépés (pl. nyár → ősz) — peak-hour-ek frissítése a `station-config.mts`-ben?
- [ ] Open-Meteo / NOAA / aviationweather API változás (pl. új rate limit, új mező)?

---

## Hivatkozások

- `netlify/functions/auto-trader/weather/forecast-engine.mts` – ensemble core
- `netlify/functions/auto-trader/weather/decision-engine.mts` – 6 gate
- `netlify/functions/auto-trader/weather/bucket-matcher.mts` – Gauss PDF allokáció
- `netlify/functions/auto-trader/weather/reconciler.mts` – Polymarket + METAR settle
- `netlify/functions/auto-trader/weather/metar-simulator.mts` – °F-egész round
- `netlify/functions/auto-trader/weather/deb.mts` – per-város súly tanulás
- `netlify/functions/auto-trader/shared/live-readiness.mts` – go-live gate
- `internal-docs/changelog/CHANGELOG-2026-05-09.md` – weather forecast fixek (city offset, target date filter, sanity cap, ensemble)
- `internal-docs/changelog/CHANGELOG-2026-05-10.md` – simVersion auto-reset, run-state cleanup
