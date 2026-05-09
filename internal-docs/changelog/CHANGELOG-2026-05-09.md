# Changelog — 2026-05-09

## Hyperliquid: split into 2 separate bots + atomic API audit + bugfixes

### Háttér

A felhasználó kérte:
1. A `/trade/hyperliquid/` oldalon eddig egy "Hyperliquid Perp" doboz alatt
   ténylegesen **két különálló bot** futott (directional perp trader +
   funding-rate arbitrage). A főoldalon külön dobozban kell látni őket.
2. Ellenőrizni kell, hogy minden HL és Binance API hívás megfelel-e a
   hivatalos dokumentációnak ("atombiztos legyen minden hívás").

### A — UI split (1 doboz → 2 doboz)

- `src/pages/trade/[category].astro` — új `funding-arb` static path.
- `src/components/CategoryDashboard.tsx` — `hyperliquid` és `funding-arb`
  most külön top-level kategóriák, mindegyiknek saját 3-tabos layout
  (autotrader / edge-tracker / settings).
- `src/components/HomePage.tsx` — execution-grid mostantól két kártyát
  jelenít meg: **Hyperliquid Perp** és **Funding Rate Arbitrage**, külön
  href-fel (`/trade/hyperliquid/` és `/trade/funding-arb/`).
- A live-readiness gates banner anchor-ja már nem ugrik vissza HL-re a
  funding-arb sorra; mindkét sor a saját aloldalára visz.

### B — API hívások audit a hivatalos doksi alapján

Áttekintve:
- HL Info endpoint (`/info`, POST + JSON):
  - `allMids` — válasz: `Record<string, string>`. ✅ `parseFloat` szigorítva
    `Number.isFinite + > 0` ellenőrzéssel.
  - `metaAndAssetCtxs` — válasz: `[meta, ctxs]` tuple. `funding` HOURLY
    decimal string (HL hourly funding cycle). `openInterest` COIN UNITS
    (nem USD), tehát `× markPx` kell — ez már jól volt, csak validáció
    szigorítva (NaN/0 markPx-et és invalid funding-ot droppol).
  - `clearinghouseState` — body: `{type, user}` ✅ + 0x40-hex address
    validáció a hívás előtt.
  - Minden Info call most 1× retry-t kap network/5xx-en, 4xx permanent
    error → azonnal dob diagnosztikus üzenettel.
- HL Exchange endpoint (`/exchange`):
  - SDK (`@nktkas/hyperliquid`) használata megfelel a doksinak: `t.limit`
    vs `t.trigger`, `grouping`. Trigger orderhez most `positionTpsl`
    grouping kerül (TP/SL a pozícióhoz kötve), entry-nél `na`.
  - Order ID extraction: `resting.oid ?? filled.oid`. Hozzáadva: explicit
    `status0.error` és `resp.status !== "ok"` ellenőrzések.
  - `HL_PRIVATE_KEY` formátum-ellenőrzés (0x + 64 hex) az SDK betöltése
    előtt — különben confusing viem error fut le.
  - Adapter eredmény cache-elve cold-start-onként + `liveAdapterError()`
    helper, ami a hibát publikussá teszi a hívóknak.
- Binance USDT-M futures:
  - `/fapi/v1/premiumIndex.lastFundingRate` — **per-cycle**, nem hourly.
    Eddig hard-kódolt `/8` osztott. **Bug**: BTC/ETH/SOL és pár másik
    major Binance-en 4h cycle-en megy 2023 óta — `/8` 2× alulbecsülte
    az hourly rate-et, ami felfelé torzította a HL−Binance spread-et és
    bogus arb belépéseket triggerelhetett. **Fix**: új `fundingInfo`
    endpoint cache (6h TTL) — symbol-onként a tényleges
    `fundingIntervalHours`-zel osztunk.
- Binance Spot order:
  - `data.price` MARKET-rendelésnél mindig "0.00000000" → eddig 0-ként
    rögzítettük az entryPrice-t. **Fix**: `fills[]` weighted average,
    fallback `cummulativeQuoteQty / executedQty`. `newOrderRespType=FULL`
    explicit. `executedQty <= 0` esetén ok=false (a paper úton változatlan).

### C — Trade-logikai bugfixek

1. **Paper-resolver elveszti a signal metadatát**
   `paper-resolver.mts` eddig hard-coded `edgeAtEntry: 0`,
   `predictedProb: 0.5`-t írt a `HlClosedTrade`-be → IC-számolás a
   live-readiness gate-ben működésképtelen volt HL-re. **Fix**:
   `HlPosition` kapott opcionális `predictedProb` / `edgeAtEntry` /
   `signalBreakdown` mezőket; `placeHlEntry` rögzíti, paper-resolver
   átemeli a closed trade-be. Régi nyitott pozíciók fallback 0/0.5-re.

2. **Funding-arb spread-of-spot-funding számítási hiba**
   `accrueFunding` eddig `entrySpread × hours × notional`-lal accrue-olt,
   pedig a hedge leg **Binance SPOT** (nincs funding). Az `entrySpread`
   beleszámította a Binance funding-ot mintha az pénzkifolyás lenne, és
   az entry-time spread-et fagyasztotta tickek között. **Fix**: most
   `entryHlFunding × hours`-t használ, és a fő loop minden tickben átadja
   a friss HL hourly rate-et a `currentHlFundingByCoin` Map-ben →
   realisztikus, decay-ző accrual.

3. **fr-scanner operator-precedence bug**
   `if (!hl.markPrice == null || !hl.hlFundingHourly == null)` — a
   precedence miatt a jobb oldal mindig `false`. **Fix**: explicit
   `Number.isFinite + > 0` markPrice check, NaN-funding drop.

4. **Funding-arb live close `pos.hlEntryPrice`-ot használt IOC limitnek**
   Volatilis tick után az IOC ekkora limittel sosem fillel. **Fix**:
   a fő loop átadja az aktuális markPrice-ot (`current?.markPrice`),
   amit a `closeArbPosition` ±0.5% slippage band-del IOC limitté alakít.
   Ha mark missing live módban → fresh `getCurrentPrice` lookup, ha az
   sem → entry-price ±0.5%. SHORT entry IOC most `Ioc + (mark − 0.5%)`-en
   megy be (előbb `Gtc` volt entryPrice-on, ami lassabb fill).

5. **Funding-arb hiányzó run-state**
   `FundingArbPanel` UI permanently `Idle / no runs yet`, mert
   `getArbStatus` nem adott vissza `runStatus`/`cronEnabled`-t. **Fix**:
   új `arb-run-state.mts` (mirrors HL directional `run-state.mts`),
   `runFundingArbLoop` most start/finish marker-ekkel hívódik, dispatcher
   átadja a `?source=cron` paramot, panel a megszokott pill cluster-t
   (`Scanning… (cron) · cron ON · 3 min · last (cron): 12s ago`)
   automatikusan megkapja.

6. **`simulatePaperPnl` dead code**
   `order-manager.mts`-ből kikerült. A paper-mode már markPrice-driven
   resolution-on megy a `paper-resolver.mts`-en keresztül.

7. **OI cap kifejezés egyszerűsítés**
   `opp.markPrice * opp.markPrice > 0` → `opp.openInterestUSD > 0`.

### D — POST-PUSH P0: Hard-coded HL ASSET_INDEX rossz volt

A push utáni live API audit (`POST https://api.hyperliquid.xyz/info` →
`{type:"meta"}`) felfedte, hogy a `config.mts`-ben statikusan deklarált
asset index tábla **HÁROM coinnál hibás** a tényleges HL universe-hez
képest:

| Coin | Régi (statikus) | Élő universe index |
|------|-----------------|--------------------|
| BTC  | 0  | 0 ✅ |
| ETH  | 1  | 1 ✅ |
| **SOL**  | **2**  | **5** (index 2 = ATOM!) |
| **XRP**  | **3**  | **25** (index 3 = MATIC, delisted!) |
| **DOGE** | **5**  | **12** (index 5 = SOL!) |
| AVAX | 6  | 6 ✅ |

**Mit jelentett ez ténylegesen:**
- `getHlFundings` az ATOM funding/markPx/OI adatát írta be a `SOL`
  ArbOpportunity rekordba — a ranking és viability gate-ek mind rossz
  számokon dolgoztak.
- A delisted MATIC (index 3) adatát rögzítettük XRP-ként → soha nem
  matchel viable opportunity-ra (markPx=0), de tényleges XRP funding
  spread-eket teljesen nem láttunk.
- Live order placement `placeOrder({ a: ASSET_INDEX[coin], ... })`-ot
  küldött volna → SOL-nak szánt SHORT az ATOM-on landolt volna.

**Fix:**
- `config.mts`: `ASSET_INDEX` constant törölve, helyette
  `STATIC_ASSET_INDEX_FALLBACK` (csak BTC + ETH, ezek index-stabilak).
- `hl-client.mts`: új `lookupAssetIndex(coin, paperMode)` async helper —
  cache-eli a `meta` endpoint `universe[].name` listáját 6h TTL-lel,
  átugrik `isDelisted: true` entry-ken. Cache miss + meta unreachable →
  `null`-t ad, és a `placeOrder` / `cancelOrder` ekkor refuse-olja a
  rendelést ahelyett, hogy rossz asset-re küldené.
- `fr-scanner.mts`: `getHlFundings` mostantól universe[].name-mel
  matchel, nem statikus index-szel. Delisted entry-k automatikusan
  kihagyódnak.

Ez a fix paper módban is kritikus, mert az eddigi paper-mode session
funding-arb data-ja a rossz coin-on alapult, ezért a live-readiness
gate-ek (trade count / Sharpe / drawdown) a tévesen címkézett trade-ek
alapján mértek.

### Hova nyúlj legközelebb (HL + Funding-Arb)

- **Két külön kártya a főoldalon**: Hyperliquid Perp + Funding Rate
  Arbitrage. Minden bot saját edge-tracker tab-bal érhető el.
- **Live-readiness banner**: Funding-Arb most külön sorban, `/trade/funding-arb/`-re
  visz.
- **Új tunable knob a Settings tab-on**: nincs, az új `fundingInfo` cache
  TTL hard-coded (6h) — ha valaki kísérletezik, env-en keresztül később
  override-olható.
- **Élesedés**: a két bot külön live-readiness gate alatt áll,
  funding-arb nem kapja meg az IC/calibration kapukat (rate-driven, nem
  prediction-driven). Trade count + winrate + Sharpe + drawdown + sim
  version + session-active gate-ek vonatkoznak rá.
- **`@nktkas/hyperliquid` továbbra sincs telepítve** — paper-only az
  egyetlen futtatható mód. Ha valaki élesít, `npm i @nktkas/hyperliquid viem`
  + `HL_PRIVATE_KEY` env (0x + 64 hex). Adapter most pontos diagnosztikus
  üzenetet ad vissza, ha valami hiányzik.

---



## Weather trader: 6 bug fix + tunable Settings + live status

### Háttér

Élő scan a `mj-trading.netlify.app/trade/weather/`-en azt mutatta, hogy a Hong
Kong May 9 piacon a modell 24.4°C-t jósolt — egy olyan piac ellen, ahol a
crowd 85.5%-os konszenzussal a 26°C bucketre állt. Az 70%-os edge nem
opportunity volt, hanem összetett model error.

### Javítások

#### A — `city_offset` mis-application
`netlify/functions/auto-trader/weather/forecast-engine.mts` — Open-Meteo a
station ICAO koordinátáin lett lekérdezve, tehát a válasz **már station-relatív**
volt. A `correctForecast()` mégis hozzáadta a `city_offset`-et, dupla-korrekcióval.
HK-nál (-1.0) kb. 1°C-os szisztematikus alulbecslés.

**Fix:** `getForecast(city, station, date, opts)` új `applyCityOffset` opcióval.
Default `false`. `forecast-engine.mts:213` a `correctForecast` hívás már 0-t kap,
ha az opció ki van kapcsolva. Smoke teszt eredmény: HK predikció 23.9°C → 25°C.

#### B — `forecast_days=2` global max
`fetchOpenMeteo()` az egész 48 órás ablakra futtatott `Math.max`-et, nem szűrt
target dátumra. Bizonyos esetekben a következő nap csúcsát fogta be.

**Fix:** target dátum prefix szűrő (`hourly.time[i].startsWith(targetDate + "T")`),
fallback global max-ra ha a dátum nincs a válaszban. `fetchNOAA()` ugyanígy
átírva (NOAA `startTime` ISO date-portion alapján szűr).

#### C — `dallas` + `tokyo` hiányoztak a `CITY_PATTERNS`-ből
A station-config tartalmazta őket, de a slug-matcher nem. Csendben dropoltak.

**Fix:** mindkettő hozzáadva a `market-finder.mts:CITY_PATTERNS`-be.

#### D — Coverage gap
A Polymarket Gamma jelenleg `madrid`, `paris`, `milan`, `munich`, `ankara`,
`lagos`, `sao-paulo`, `austin` eseményeket is ad — egyik sem volt konfigurálva.

**Fix:** mind a 8 város hozzáadva mind a `station-config.mts`-hez (airport ICAO
+ koordináták + UTC peak hours), mind a `CITY_PATTERNS`-hez. `findWeatherMarkets`
mostantól `findWeatherMarketsDetailed` is van, ami visszaadja a kihagyott
eseményeket okkal együtt (`no-city-mapped` / `no-station` / `no-date` /
`no-buckets` / `expired`).

#### E — Nincs sanity check az edge nagyságára
A 70% edge egy 85% konszenzussal álló piac ellen majdnem biztosan model error.

**Fix:** `WeatherConfig.maxEdgeCap` (default 0.40), checkelve a
`makeWeatherDecision`-ben az edge-threshold után. Ha `grossEdge > maxEdgeCap`,
no-trade `"likely model error"` reason-nel. Smoke teszt megerősítve: a HK
-60% edge most blokkolva.

#### F — Paper mode self-validates (dokumentálva)
A `closePosition` paper-módban `match.probability`-ből sorsolja a "valódi"
kimenetelt → bankroll a modell saját konzisztenciáját méri, nem a prediktív
pontosságát. Ez nem új probléma; az `index.mts:223` TODO megerősíti hogy live
módban valós METAR settlement reconciliation szükséges.

### Tunable paraméterek

`netlify/functions/trader-settings.mts` SCHEMA bővítve `category: "weather"`
fieldekkel:

| Key                       | Default | Min   | Max   | Egység |
|---------------------------|---------|-------|-------|--------|
| `weatherEdgeThreshold`    | 0.12    | 0.02  | 0.40  | frac   |
| `weatherConfidenceMin`    | 0.65    | 0.30  | 0.95  | frac   |
| `weatherExitBeforeMin`    | 45      | 10    | 240   | min    |
| `weatherMaxPositionUSD`   | 25      | 5     | 500   | USD    |
| `weatherMaxEdgeCap`       | 0.40    | 0.10  | 0.95  | frac   |
| `weatherForecastDays`     | 0=auto  | 0     | 7     | days   |
| `weatherApplyCityOffset`  | 0       | 0     | 1     | bool   |
| `weatherUseEnsemble`      | 0       | 0     | 1     | bool   |
| `weatherCronEnabled`      | 0       | 0     | 1     | bool   |

Új helper: `getEffectiveWeatherConfig()` — env defaults + Blobs runtime overrides
merge.

### Settings tab

A `/trade/weather/` oldalra felkerült egy **⚙ Beállítások** tab, ami a generikus
`SettingsPanel`-t használja `category="weather"` filterrel. A `SettingsPanel`
bővítve a `bool` unit kezelésével (toggle UI), `min`/`days` formatterekkel.

### Live status

`weather/index.mts` új Blobs store (`weather-runtime/v1`):
- `startedAt` — futás kezdete (90s után stale guard)
- `lastRunAt` — utolsó befejezett futás ISO
- `lastResult` — utolsó futás összegzése
- `source` — `"manual"` vagy `"cron"`

`runWeatherTrader(config, source)` minden start-end tranzakcióban frissíti a
state-et. `getWeatherRunStatus()` exportálva, az `auto-trader/index.mts`
`getStatus` weather-ágában visszaadja.

`WeatherTrader.tsx` új status-cluster:
- 🟢 **Scanning... (manual/cron)** vagy **Idle** — élő pulse animációval
- **cron ON · 5 min** vagy **cron OFF** — Settings tabból állítható
- **last (manual/cron): 2m ago** — relatív idő, 1s-enként frissül lokálisan,
  5s-enként pollol szervert

### Cron schedule

Új scheduled function: `netlify/functions/auto-trader-weather-cron.mts`,
`*/5 * * * *` schedule. Csak akkor csinál bármit, ha a Settings tabon a
`weatherCronEnabled` toggle be van kapcsolva. Default OFF — paper-mode user
nem kap kéretlen háttér futást.

### Érintett fájlok

```
netlify/functions/auto-trader/weather/station-config.mts    +8 city
netlify/functions/auto-trader/weather/market-finder.mts     +findWeatherMarketsDetailed +DroppedEvent
netlify/functions/auto-trader/weather/forecast-engine.mts   +ForecastOptions, target-date filter, applyCityOffset
netlify/functions/auto-trader/weather/decision-engine.mts   +maxEdgeCap, getEffectiveWeatherConfig
netlify/functions/auto-trader/weather/index.mts             +getWeatherRunStatus, run-state Blobs
netlify/functions/auto-trader/index.mts                     weather → effective config + runStatus
netlify/functions/trader-settings.mts                       SCHEMA bővítés (9 weather knob)
netlify/functions/auto-trader-weather-cron.mts              ÚJ: scheduled cron wrapper
netlify.toml                                                +auto-trader-weather-cron schedule
src/components/SettingsPanel.tsx                            bool toggle UI + új unit formatterek
src/components/CategoryDashboard.tsx                        már wired (Settings tab)
src/components/trader/WeatherTrader.tsx                     status cluster + dropped events + cfg line
```

### Ellenőrzés

```bash
npm run build                                                              # OK
npx tsx netlify/functions/auto-trader/weather/station-config.test.mts      # 8/8 passed
```

Smoke test (egyszeri diagnosztika, törölve):

```
HK city_offset OFF: predicted=25°C  (real fix vs. korábbi 23.9°C)
HK city_offset ON:  predicted=23.9°C  (régi bugos viselkedés)
HK bucket match:    edge=-59.7% → BLOCKED by maxEdgeCap=0.40 ✓
```

### Mi marad TODO

- Real METAR reconciliation a live mode paper-self-validation problémához
  (Bug F) — egy külön cron job-ban
- Per-city DEB súlyok kalibrálása az új coverage cityk-hez 10+ trade után

---

## Crypto paper trader: realisztikussá tett szimulátor (v2) + calibration alarm

### Háttér

A `paper-pnl-analysis.md` (2026-05-08) megmutatta hogy a `/trade/crypto/`-n
látott $150 → $3050 (98.6% WR, 143 trade) **paper sim artefakt**:

1. `simulatePaperExit` halfway-toward-prediction logikája: `exitPrice = mp + (finalProb - mp) * 0.5` → a saját predikciónk profitba tolta a kimenetet, így bármilyen zajos signal "nyereséges" lett.
2. Az 5 signal mindegyikére `IC = 0.000` (zaj), tehát a 141 nyertes trade nem a signal-ekből jött.
3. Az entry ár 141-szer konstans $0.01 — `btc-market-finder` deep-OTM piacokat választott, ahol élesben ezen az áron nem lehetne fillelni.
4. Inverz kalibráció: 0.526 predikció → 100% WR, 0.758 → 0% WR.

### Javítások

#### 1 — Új paper-resolver modul (`auto-trader/crypto/paper-resolver.mts`)

`simulatePaperExit` teljesen kivéve az `index.mts`-ből. Helyette két egymást
kiegészítő útvonal — **mindkettő `finalProb`-tól független**, így az
edge-tracker IC számítása valódi prediktív erőt mér:

- **Real Polymarket resolution (gold standard):** a paper position nyitva
  marad amíg a piac le nem zárul. Az új `resolvePendingPaperPositions()`
  minden cron tick elején lefut, lekéri a Gamma API-tól a
  `outcomePrices`-t, és a tényleges `[1,0]` / `[0,1]` kimenettel zárja a
  pozíciót. A trade history így valós piaci eredményekkel dolgozik.

- **Brownian-bridge fallback:** ha 30+ perccel a market endDate után sem
  jött vissza valid resolution, logit-tér Brownian híddal szimulál. A
  terminal kimenet `Bernoulli(marketPriceAtEntry)`-ből sorsolt
  (efficient-market null), nem `finalProb`-ból. TP/SL crossing ellenőrzés
  a path mentén. Sigma tunable: `paperBrownianSigma` (default 0.45 σ/√min).

#### 2 — `btc-market-finder` deep-OTM szűrő

Új `MIN_PRICE_BAND` (env `BTC_MIN_PRICE_BAND`, default 0.10): kihagyja
azokat a piacokat, ahol a YES mid < 0.10 vagy > 0.90. Ezek azok ahol a
top-of-book gyakran 1-2 share market-maker quote → "fill" nem realisztikus.

Tunable runtime-ban: `btcMinPriceBand` knob a `trader-settings`-ben.

#### 3 — Calibration health alarm

Új `computeCalibrationHealth(trades, minTrades)` az
`edge-tracker/statistics.mts`-ben. Visszaadja:

- `status`: `"good"` (max |IC| ≥ 0.05) / `"weak"` (≥ 0.02) / `"noise"` (< 0.02) / `"insufficient"` (< minTrades)
- `topSignal`, `maxAbsIC`, `tradeCount`, `shouldSuspendLive`, `message`

Wired in:
- `auto-trader/index.mts:runCryptoTrader` minden tick elején lefut, ha 30+ trade van és minden signal IC < 0.02:
  - **Paper mód:** Telegram alert (egyszer/session, `calibrationAlertSentAt` flag), session folytatódik.
  - **Live mód:** session auto-stop + Telegram.
- `edge-tracker.mts` GET válaszában is: `calibrationHealth` payload mező.

Új Telegram helper: `alertCalibrationNoise(paper, message, tradeCount, maxAbsIC)`.

#### 4 — UI Calibration Health Badge (közös komponens)

Új közös komponens `src/components/shared/CalibrationHealthBadge.tsx`, amit **két helyen** is használ a UI:

1. **Edge Tracker tab tetején** (`EdgeTrackerPanel.tsx`) — `variant="full"`, a már lekért `data.calibrationHealth`-et propként kapja, plusz `category`/`days` átkerül hogy refresh esetén ugyanazokkal a filterekkel kérjen.

2. **Crypto Trader tab tetején** (`trader/CryptoTrader.tsx`) — `variant="compact"`, saját maga fetcheli a `/.netlify/functions/edge-tracker?mode=paper&category=crypto&days=30`-ot. A `refreshKey` prop minden Run/Reset/Stop akció után bumpolódik, így az új trade lezárása után frissül a verdict.

Így a kereskedő nem kell tab-ot váltson, hogy lássa a paper signal-szett egészségét: már az autotrader oldalon megjelenik a verdict a session-statok fölött.

Színkódok:

| Status         | Háttér   | Border       | Kit jelez          |
|----------------|----------|--------------|--------------------|
| good           | dark zöld | `--accent`  | max \|IC\| ≥ 0.05  |
| weak           | dark narancs | `--warn` | 0.02 ≤ max < 0.05  |
| noise          | dark piros | `--danger` | < 0.02 (≥30 trade) |
| insufficient   | szürke   | `--muted`    | < 30 trade        |

A badge a Summary kártyák **fölött** jelenik meg, hogy az első dolog amit
látsz a Tab 12 Edge Tracker-en az legyen "calibrated/noise".

#### 5 — Session simVersion auto-reset

`session-manager.mts:PAPER_SIM_VERSION = 2`. A `loadSession()` ellenőrzi:
ha a betöltött paper session `simVersion < 2`, akkor:
- A régi `closedTrades`-t archiválja az `auto-trader-state` Blobs storage
  `auto-trader-session-archive-paper-v1` kulcsa alá (nem törölve, később
  forensic elemzéshez).
- Új tiszta default session-t ad vissza.

Ez automatikusan kitisztítja a 143 régi (halfway-sim) trade-et a
deploy után, **explicit reset hívás nélkül**. A user az új sim-mel kezd
nullról.

#### 6 — Új tunable knobok

`trader-settings.mts` SCHEMA bővítve crypto paper-resolver knobokkal:

| Key                    | Default | Min   | Max     | Egység | Group           |
|------------------------|---------|-------|---------|--------|-----------------|
| `paperFallbackAfterMs` | 1800000 | 60000 | 21600000| ms     | Paper resolver  |
| `paperBrownianSigma`   | 0.45    | 0.10  | 1.50    | σ      | Paper resolver  |
| `btcMinPriceBand`      | 0.10    | 0.02  | 0.30    | frac   | Market finder   |

A Settings tabon (Tab 13) ezek runtime-ban állíthatók — a következő cron
tick már az új értékekkel fut.

### Érintett fájlok

```
netlify/functions/auto-trader/crypto/paper-resolver.mts          ÚJ
netlify/functions/auto-trader/crypto/btc-market-finder.mts       MIN_PRICE_BAND szűrő
netlify/functions/auto-trader/crypto/session-manager.mts         simVersion auto-reset + archive
netlify/functions/auto-trader/index.mts                          resolvePendingPaperPositions hívás + calibration alarm
netlify/functions/auto-trader/shared/types.mts                   Position resolver-meta + SessionState.simVersion + új LogEvent-ek
netlify/functions/auto-trader/shared/telegram.mts                alertCalibrationNoise
netlify/functions/edge-tracker/statistics.mts                    computeCalibrationHealth
netlify/functions/edge-tracker.mts                               calibrationHealth a GET response-ban
netlify/functions/trader-settings.mts                            SCHEMA + 3 új knob
src/components/shared/CalibrationHealthBadge.tsx                 ÚJ közös komponens (full + compact variant)
src/components/EdgeTrackerPanel.tsx                              használja a közös badge-et
src/components/trader/CryptoTrader.tsx                           compact badge a session-statok fölött
```

### Ellenőrzés

```bash
npx tsc --noEmit -p tsconfig.json   # 0 új error az érintett fájlokban
                                    # (1 preexisting weather/Category mismatch a mock-trades-ben)
```

### Mit kell tennie a usernek deploy után

1. **Semmit kötelezőt** — a régi 143 trade auto-archiválódik első cron tickkor (`simVersion < 2` → reset). A bankroll visszaáll $150-re, a closed trades üres.
2. Aki manuálisan akarja nullázni élesedés előtt: `POST /auto-trader { action: "reset" }` (auth-protected).
3. Hagyni futni 30+ trade-ig (~1.5-3 nap a 3-perces cron-nal és kb. 80% skip ratettel a P1.2/P1.3 filterek miatt). 
4. A Tab 12 Edge Tracker tetején a Calibration Health badge színe azonnal megmutatja: zöld = signal-ek valódi prediktív erővel, piros = noise → live váltás tilos.
5. A Settings tabon (Tab 13) finomhangolható: `paperBrownianSigma`, `paperFallbackAfterMs`, `btcMinPriceBand`.

### Crypto Trader UI parity-pass weather-rel (2026-05-09 második passz)

A felhasználó kérte hogy a crypto trader oldal mutassa ugyanazokat az infókat mint
a weather: élő status pillek + a scan során vizsgált piacok + miért tradel /
miért skippel a model. Ezért:

- **Új `auto-trader/crypto/run-state.mts` modul** — ugyanaz a Blobs-alapú
  RunState shape mint a weather-é (`startedAt`, `lastRunAt`, `source`,
  `lastResult`). `markRunStart` / `markRunFinish` / `getCryptoRunStatus`.
- **`runCryptoTrader(initialConfig, source)`** — fogad `manual` / `cron` source paramétert. A handler `?source=cron` query alapján állítja be (auto-trader-multi-cron passzolja). Belül:
  - `markRunStart(source)` a futás elején
  - `finish(payload)` helper: minden return ágon át megy, a payload-ot eltárolja `markRunFinish`-en keresztül és visszaküldi mint HTTP response
  - Minden `results.push()` `marketContext`-tel (slug + title + marketPrice + predictedProb + edge + netEdge + direction + kelly/kellyUsed + activeSignals + signalBreakdown + obImbalance + endDate)
  - `droppedMarkets` field — a top 3 alatti BTC piacok listája hogy a UI „nem evaluated this tick" infót adhasson
  - `config` field — `traderConfigSummary()`: edge threshold, max-kelly, TP/SL, entry-band, fees stb.
- **`getStatus(category="crypto")`** kiegészítve `runStatus` + `cronEnabled: true` mezővel (a crypto cron `*/3` mindig fut).
- **`CryptoTrader.tsx` rewrite** — Weather-szerű:
  - Header status cluster: `Scanning… (manual/cron)` / `Idle` pulse pill, `cron ON · 3 min` pill, `last (manual): 2m ago` pill (1s-enként frissül lokálisan, 5s-enként pollol szervert)
  - `cfgline`: aktív edge/kelly/TP/SL/band/fees egy sorban
  - Per-market `ScanResultRow` komponens: market title, mp / model% / edge / direction / kelly / 5/5 signals / OB↑↓ pill-ek + 5 signal-arrow (FR↑ VPIN↓ VOL↑ APEX· CP↓), action chip (skip/position_opened/error/failed), reason / size / pnl
  - Dropped markets `<details>` section (top 3 alatti piacok)
- A `CalibrationHealthBadge` továbbra is ott van compact variantban a status alatt.

### Érintett fájlok (UI parity)

```
netlify/functions/auto-trader/crypto/run-state.mts                ÚJ Blobs-alapú RunState store
netlify/functions/auto-trader/index.mts                          source param, finish() helper, marketContext, droppedMarkets, traderConfigSummary, runStatus crypto status válaszban
src/components/trader/CryptoTrader.tsx                           rewrite: status cluster, ScanResultRow, dropped section, polling
```

### Mi marad TODO

- **Per-tick TP/SL polling paper módban**: jelenleg a paper position holding-to-end vagy Brownian-fallback útján zár. Élesben a `order-lifecycle` poll-olja a YES árat és TP/SL-en zár. A paper-be is lehetne CLOB midprice polling 30s-onként, hogy a TP/SL profile éles és paper között 1:1 legyen. Most még nem szükséges (real-resolution az igazi mérce).
- **`auto-trader-multi-cron` `?source=cron` passzolása** — ha még nem teszi, hozzáadni hogy a runStatus.source pontosan tükrözze a cron-eredetű futásokat is.

---

## Egységes live-readiness gate (mind a 4 traderre)

A felhasználó kérése: "minden bot szimulálja a kereskedést paper-ben, és csak akkor menjen élesbe ha a sim valid". Ezért:

### 1. `auto-trader/shared/live-readiness.mts` — single source of truth

Új modul. `computeLiveReadiness(args)` minden trader category-ben ugyanazt a 7 gate-et ellenőrzi a session.closedTrades alapján:

| Gate              | Default     | Crypto | Weather | HL  | Funding-arb |
|-------------------|-------------|--------|---------|-----|-------------|
| Trade count       | ≥ 30        | ✓      | ✓       | ✓   | ✓           |
| Win rate          | ≥ 50%       | ✓      | ✓       | ✓   | ✓           |
| Max \|IC\|        | ≥ 5%        | ✓      | ✓       | —   | —           |
| Calibration dev   | < 7%        | ✓      | ✓       | —   | —           |
| Sharpe ratio      | ≥ 0.5       | ✓      | ✓       | ✓   | ✓           |
| Max drawdown      | < 25%       | ✓      | ✓       | ✓   | ✓           |
| Sim version       | == current  | ✓      | —       | —   | —           |
| Session active    | not stopped | ✓      | ✓       | ✓   | ✓           |

A funding-arb rate-driven (nem prediction-driven), így az IC + calibration gates N/A. A többi 4 gate ott is alkalmazandó.

`shouldForcePaper(configuredPaperMode, readiness)` az enforcement helper: ha `paperMode=false` és `readiness.ready=false`, akkor `{ forcePaper: true, reason: ... }`.

### 2. Cron-path enforcement minden traderben

Mind a 4 cron loop (`runCryptoTrader`, `runWeatherTraderInner`, `runHyperliquidTraderInner`, `runFundingArbLoop`) elején lefut a gate. Ha `shouldForcePaper.forcePaper === true`:

- `config.paperMode = true` (mutable clone) — strukturálisan lehetetlenné teszi a live trade-et a tickben
- `alertLiveBlocked(category, reason, failedGates)` Telegram alarm
- `log(ERROR, { liveBlocked: true })` audit-trailre
- A futás ennek ellenére folytatódik paper-ben, így a paper PnL továbbra is gyűlik

### 3. Status response + UI

Új `getStatus`-ban (auto-trader/index.mts) minden category-re a `liveReadiness` payload visszamegy. HL-nek és funding-arb-nak külön getter (mert saját session shape-jük van — generic `ClosedTrade`-re konvertálnak inline).

### 4. `src/components/shared/LiveReadinessBadge.tsx` — közös UI

Két variant: `full` (gate-rows) és `compact` (egysoros verdict). Minden trader landing oldalon (Crypto, Weather, HL, FundingArb) megjelenik. Színkódok:

- 🟢 LIVE-READY (zöld) — minden alkalmazandó gate átment
- 🟠 PAPER ONLY (narancs) — legalább egy gate failed → live trading auto-suspended

Self-fetcheli a `/auto-trader-api?action=status&category=…`-ot. Refresh-key bumpolódik minden Run/Reset/Stop akció után.

### 5. Settings — egységes konfigurálható thresholds

Új `category: "common"` SCHEMA fields a `trader-settings.mts`-ben, "Live readiness" group:

| Key                       | Default | Min | Max | Unit  |
|---------------------------|---------|-----|-----|-------|
| `liveReadyMinTrades`      | 30      | 10  | 300 | n     |
| `liveReadyMinWinRate`     | 0.50    | 0.30 | 0.80 | frac |
| `liveReadyMinIC`          | 0.05    | 0.01 | 0.30 | frac |
| `liveReadyMaxCalibDev`    | 0.07    | 0.01 | 0.30 | frac |
| `liveReadyMinSharpe`      | 0.5     | 0   | 5.0 | ratio |
| `liveReadyMaxDrawdownPct` | 25      | 5   | 80  | pct   |

Egy globális tuning surface — minden trader ezt olvassa.

### 6. Telegram

Új helper: `alertLiveBlocked(category, reason, failedGates)`. Egyszer/session küld (a calibrationAlertSentAt flag már ott volt).

### Érintett fájlok

```
netlify/functions/auto-trader/shared/live-readiness.mts          ÚJ közös modul
netlify/functions/auto-trader/shared/telegram.mts                + alertLiveBlocked
netlify/functions/auto-trader/index.mts                          crypto gate + getStatus liveReadiness
netlify/functions/auto-trader/weather/index.mts                  weather gate + early returns
netlify/functions/auto-trader/hyperliquid/index.mts              HL gate + getHlStatus liveReadiness
netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts  funding-arb gate (rate-driven, IC kihagyva)
netlify/functions/trader-settings.mts                            6 új "common" knob
src/components/shared/LiveReadinessBadge.tsx                     ÚJ közös UI komponens (full + compact variant)
src/components/trader/CryptoTrader.tsx                           badge a header alatt
src/components/trader/WeatherTrader.tsx                          badge
src/components/trader/HyperliquidTrader.tsx                      badge
src/components/trader/FundingArbPanel.tsx                        badge
```

### Mit jelent ez gyakorlatban

A user nem tud véletlenül élesre menni paper-validálás nélkül. Akármi is a `PAPER_MODE` env, ha a session.closedTrades nem tölti be a 7 gate-et, a cron loop minden tick-en visszaállítja paper-be. Ez **strukturális garancia** — nem UI-szintű figyelmeztetés.

A 4 paper sim már független a saját predikciótól (audit eredménye):

- **Crypto**: real Polymarket settlement + Brownian-bridge fallback (Bernoulli(marketPriceAtEntry) null)
- **Weather**: real Polymarket settlement + METAR daily-max fallback
- **Hyperliquid**: live HL markPrice TP/SL crossing
- **Funding-arb**: real funding spreads (rate-driven by design)

Tehát az IC/Sharpe/win-rate/drawdown gates **valós piaci kimenetelekre** alapulnak.

---

## HomePage live-block banner + mobil parity-pass (2026-05-09 negyedik passz)

### Live-block banner

A főoldalon (`/`) egy új useEffect lekérdezi mind a 4 auto-trader liveReadiness verdict-jét (`/auto-trader-api?action=status&category=…`, ami már computeLiveReadiness-t hív szerverside). 30 másodpercenként pollol, így a flip vissza paper-be ~fél perc alatt megjelenik.

Két új szekció a fejléc alatt, az "Aggregated session" előtt:

1. **`hp-live-blocked` banner** — csak akkor renderel, ha `envStat.paperMode === false` ÉS legalább egy bot `liveReadiness.ready === false`. Animált piros háttér (`hp-blocked-pulse` 3s-os shadow ciklus), 🚦 emoji, "Live trading auto-suspended on N bots" cím + per-bot kártyák. A kártyán látszik a verdict reason + per-gate fail listája (`✗ Trade count`, `✗ Sharpe ratio` stb.). A kártyák kattintással a megfelelő `/trade/<venue>/` oldalra visznek.

2. **`hp-readiness-grid` per-trader rács** — mind a 4 bot verdict-je 4 oszlopban (mobil-on 2 / 1). Bal-szélső border-color zöld (READY) / sárga (PAPER) / szürke (lekérdezés alatt). Akkor is megjelenik ha `envStat.paperMode === true` — a user lássa hogy hol tartanak a gates.

### Mobile parity-pass

Új media query-ket kapott az összes érintett komponens, hogy a 480px alatt is használható legyen:

| Komponens | Breakpoint | Mit csinál |
|-----------|-----------|------------|
| `HomePage` | 760px | Summary stats 4 → 2 kolóna, readiness grid 4 → 2 |
| `HomePage` | 600px | Per-category breakdown row 5-col grid → 3-area stack (cat+status / bk+pnl / trades) |
| `HomePage` | 480px | Padding csökken, logo kisebb, header wrap |
| `HomePage` | 380px | Summary stats 1 kolóna, readiness grid 1 kolóna |
| `LiveReadinessBadge` | 480px | Gate row 4-col → 2-col grid-area (mark/label/actual/req stack) |
| `traderShellStyles` | 600px | Wrap padding csökken, status cluster wrap, kontroll gombok 2-onkénti grid |
| `traderShellStyles` | 380px | Stats 1 kolóna, kontrollok 1 kolóna full-width |
| `SettingsPanel` | 600px | Header column align, action buttons full-width, range slider 100% width, num input keskenyebb |

A meglévő 720px-es breakpointok (env grid, capability cards) változatlanok.

### Érintett fájlok

```
src/components/HomePage.tsx                    + READINESS_CATEGORIES, useEffect 30s polling, 2 új section, animált banner CSS, mobil breakpointok
src/components/SettingsPanel.tsx               header wrap + 600px action stacking + slider full-width
src/components/shared/LiveReadinessBadge.tsx   480px gate-row 2-col stack
src/components/shared/traderShellStyles.ts     600px / 380px tighter packing minden trader oldalon
```
- **IC kalibráció:** ha 50+ valós paper trade után a IC értékek tényleg ≥0.05-re jönnek fel, akkor a `signal-combiner` IC weightingjét újrahangolni az új mérési értékekre.
- **Edge-decay alarm:** ha az IC eleinte jó volt majd 0-ra esett, az is alarm-érték (signal degradálódik). Most még nincs benne.

---

## Auto-Trader UI unification (4 bots → 1 shell)

### Háttér

A 4 trader oldal (Crypto, Weather, Hyperliquid, Funding-Arb) eddig 4 különálló
React komponensben volt, mind saját CSS prefixszel (`ct-`, `wt-`, `hl-`, `fa-`),
saját polling loop-pal, saját button stílussal és saját result-row markup-pal.
Ugyanaz a "Run Scan" gomb mindenhol kicsit másképp nézett ki, és a per-market
validálási értékek (mp / model / edge / direction / kelly / signals) csak a
Crypto trader-en voltak rich chip-formában — a többiekben minimális szöveg.

### Refaktor

Új shared modulok (`src/components/shared/`):
- **`TraderShell.tsx`** — egyetlen wrapper komponens. Kezeli: header
  (title + mode badge + 3-pill status cluster: live/cron/last-run), opcionális
  `LiveReadinessBadge` + `CalibrationHealthBadge`, subtitle info, stats grid,
  alerts (stopped/paused), controls. Exportál `useAutoTraderStatus(category, layer?)`
  és `useTraderAction(category, layer?)` hookokat — minden trader 5s status
  poll + 1s relativ-time tick + POST action runner közös.
- **`TraderResults.tsx`** — `ScanResultsCard`, `ScanResultRow` (chips +
  signals + action chip + extra/pnl + reason footer), `PendingPositionsCard`
  (weather paper trades), `OpenPositionsCard` (funding-arb), `OpportunitiesCard`
  (funding-arb spreads), `DroppedCard` (collapsible skipped/coverage gap).
  Egyetlen `ResultChip` API (label + tone + outline + title), egyetlen
  `SignalArrow` API (név + score → ↑/↓/· szín-aware).
- **`traderShellStyles.ts`** — egy `ts-` prefix CSS modul az összes új
  komponenshez. Az addigi 4 stílussor (>1500 LOC összesen) eltűnik.

### A 4 trader minden feature-t megkapott (table-pipa cél)

| Feature                          | Crypto | Weather | HL  | F-Arb |
|----------------------------------|:------:|:-------:|:---:|:-----:|
| Header + mode badge              | ✓      | ✓       | ✓   | ✓     |
| 3-pill status cluster            | ✓      | ✓       | ✓   | ✓ új  |
| LiveReadinessBadge               | ✓      | ✓       | ✓   | ✓     |
| CalibrationHealthBadge           | ✓      | ✓ új    | ✓ új| ✓ új  |
| Stats grid                       | ✓      | —       | ✓ 5 | ✓ 4   |
| Stopped alert                    | ✓      | ✓       | ✓   | ✓     |
| Paused alert (HL)                | n/a    | n/a     | ✓   | n/a   |
| Run / Reset / Stop / Refresh     | ✓      | ✓       | ✓   | ✓     |
| Resume button (when stopped)     | ✓ új   | n/a     | ✓   | ✓     |
| Reconcile pending (weather only) | n/a    | ✓       | n/a | n/a   |
| Validation chips                 | rich   | rich új | rich új | rich új |
| Signal arrows                    | ✓      | n/a     | n/a | n/a   |
| Config line                      | ✓      | ✓       | —   | —     |
| Pending positions card           | n/a    | ✓       | n/a | n/a   |
| Open positions card              | n/a    | n/a     | n/a | ✓     |
| Opportunities card               | n/a    | n/a     | n/a | ✓     |
| Dropped/skipped collapsible      | ✓      | ✓       | —   | —     |

### Validálási értékek mostantól minden boton ugyanúgy néznek ki

Egy tipikus row chip-szettje (consistent palette: `pos`/`neg`/`warn`/`info` +
`outline` direction chip):
- `mp 54¢` — live market price (hover: 2 decimal precision)
- `model 67%` — combined model probability for YES
- `edge +13.0%` — net edge after fees, color-coded (green ≥5%, orange ≥0, red <0)
- `YES`/`NO` outline chip — direction (green/red)
- `kelly 1.7%` — ¼-Kelly fraction of bankroll
- `3/5 signals` — number of contributing signals
- `OB ↑` (crypto) — Binance top-10 bid/ask imbalance arrow
- Signal arrows row (crypto): `FR↑ VPIN↓ VOL· APEX↑ CP↓` — score-driven

A user kérdése ("ha belép miért lép be?") mostantól egy pillantás alatt
megválaszolható: a chip-szett megmondja, miért fogadta el (pos edge, conf
elég, signals konvergáltak), és a `reason` footer adja a végső döntés
indoklását.

### Backwards-compat

A `CategoryDashboard.tsx` API-ja változatlan. Az `auto-trader-api`
végpontok shape-je is változatlan — csak a frontend renderelés egységesül.
A szerver-oldali `liveReadiness` és `cronEnabled` mezőket a meglévő hook
forwardolja a badge-be, így a `LiveReadinessBadge` extra fetch-et nem indít.

### Érintett fájlok

```
új: src/components/shared/TraderShell.tsx          (shell + 2 hook)
új: src/components/shared/TraderResults.tsx        (5 reusable card)
új: src/components/shared/traderShellStyles.ts     (egy CSS forrás)
átírva: src/components/trader/CryptoTrader.tsx     (532 → 248 LOC)
átírva: src/components/trader/WeatherTrader.tsx    (429 → 196 LOC)
átírva: src/components/trader/HyperliquidTrader.tsx (304 → 161 LOC)
átírva: src/components/trader/FundingArbPanel.tsx  (250 → 173 LOC)
```

### Future-proof

Új trader hozzáadása mostantól ~150 LOC adapter, nem 400+ — `TraderShell` +
`useAutoTraderStatus` + a megfelelő cards-szel. Új feature (pl. pozíció-
részletek modal, edge sparkline) egyetlen helyen kerül be és minden bot
megkapja.

---

## Polymarket Gamma API hívások megerősítése (atomgyilag biztos paraméterek)

### Kontextus

Élő smoke-test mutatta, hogy a crypto auto-trader Run Scan minden tickkor
"Too few active signals: 0 < 2" reasonnel skipel — soha nem nyit pozíciót.
Ez ahhoz a következményhez vezet, hogy a paper IC sosem mérhető és a
live readiness gate (30+ trade) soha nem fog billenni. A nyomozás a
Gamma API hívások paraméter-szintű hibáit mutatta ki.

A hivatalos Polymarket Gamma docs (`docs.polymarket.com/developers/gamma-markets-api`)
és a hivatalos Python SDK (`Polymarket/agents` repo) + élő API-cross-check
alapján dokumentált tények:

- **`tag` (string) NEM létezik** — a paraméter csendben ignoráltatik, és
  a kérés top-by-volume eredményt ad bármi tagre. A doksi szerint
  `tag_id` (numeric) a helyes filter (crypto = `tag_id=21`).
- **`condition_id` (singular) NEM létezik** — szintén silent-ignored,
  a top-volume market jön vissza. A helyes `condition_ids` (plural).
- **`tokens` mező NEM jön vissza** sem a `/markets`, sem a `/events`
  válaszában. Csak `clobTokenIds` JSON-encoded string. A SDK is így olvassa.
- **`/markets/{id}` path-style** csak NUMERIC id-vel működik — slug-gal
  `validation error: id is invalid`-ot ad. A helyes lookup `/markets?slug=`
  query-vel, ami array-t ad.
- **`/events?slug=`** event slug-ot vár; a market slug-gal NEM talál.
  A helyes market lookup `/markets?slug={market_slug}`.

### Javítások

#### 1. `auto-trader/crypto/btc-market-finder.mts`
- **`tag=crypto`** → **`tag_id=21`** (override-able env-vel:
  `POLYMARKET_CRYPTO_TAG_ID`).
- Az url új formája:
  `events?tag_id=21&active=true&closed=false&limit=30&order=volume24hr&ascending=false`.
- Pre-fix nélkül a market-finder alkalomszerűen NBA / NFL eseményeket is
  felvett volna, amelyeket csak a szöveg-alapú `isBtcUpDown` szűrő dobott el.
  Empirikusan: 11 BTC piacból 1 esett a [10%, 90%] band-be — most már stabil.

#### 2. `signal-combiner.mts` — `resolveMarket`
- Új **fast path**: market-slug-first `/markets?slug={slug}` lookup. A
  Gamma válasz `events: [{slug}]` mezőjéből az event slug kinyerhető URL-hez.
- Régi event-slug lookup VÁLTOZATLAN backward compat miatt — ha valaki
  event slug-ot ad át, az is működik.
- Új `parseTokenIds` és `parseYesNoPrices` shared helperek a defensive
  parsing-hoz (clobTokenIds elsődleges, tokens fallback forward-compat).

A signal-aggregator előtt minden BTC up/down market `Market not found`
404-et kapott (mert a market slug → event slug remap nem működött), és
az aggregator fallback `fetchIndividualSignals`-be esett, ami `signal_score`
mezőre hivatkozott amit egyik signal endpoint sem ad — emiatt **mindig
0 active signal**, mindig `finalProb=0.5`, mindig skip. A primary path
visszaállítása megoldja a teljes pipeline-t.

#### 3. `signal-combiner.mts` — Momentum signal
`/markets/{slug}?limit=1` (path-style) sosem működött — csak numeric id-vel.
Cseréljük `/markets?slug={slug}&limit=1` query-re és array deserialize-ra.

#### 4. `apex-wallets.mts` — consensus market name lookup
`condition_id=` (singular) → `condition_ids=` (plural). A korábbi forma
silent-ignored volt, és **a top-volume marketet adta vissza minden
consensus-piachoz**, ami azt jelenti hogy a Tab 8 Apex Consensus piac
nevek **rosszak voltak**. (A kód sajátja egyébként is fallback-elt a
question-mentes esetre, de a wrong-market hibás title-t inject-elt.)

#### 5. `vol-divergence.mts` — CLOB midpoint pipeline
- `m.tokens || []` → `extractTokenIds(m)` shared helper, amely a
  `clobTokenIds` JSON-encoded stringet parse-olja először.
- A korábbi kód **mindig üres tokens listát** kapott, így a CLOB midpoint
  fetch nem futott semmire, és minden Polymarket BTC piac IV-je 0.5/0.5
  default-ra esett — ami a `fetchMidpoints` egész értelmét megsemmisítette.
- Új fallback: ha a CLOB midpoint nincs (rate-limit / 404), Gamma stored
  `outcomePrices`-ra esik, így minimum statikus piac-ár van.

#### 6. `polymarket-proxy.mts` és `polymarket-trade.mts`
A `(m.tokens || []).map(...)` referencia mindkét helyen üres listát adott
(a `tokens` mező nem létezik a Gamma válaszban). Cseréljük `clobTokenIds`
JSON-parse-ra, így a **Tab 1 piac listán a tokens helyesen jelennek meg**
és a `polymarket-trade markets` action végre tényleg ad token_id-t a
további CLOB hívásoknak (orderbook, midpoint, prices).

### Hatás

- Crypto auto-trader: a signal pipeline atomgyilag rendbe kerül. A
  signal-combiner happy path-ja működik minden BTC up/down piacon, az
  active_signals 0-ról 5-8 közé ugrik, és a netEdge számítás végre
  reális. Live readiness gate-felszabadulás 30+ paper trade után
  kalibráció szerint (eddig el sem indult a számláló).
- Apex Consensus (Tab 8): a piac nevek helyesek lesznek a következő
  invalidálás után (`apex-wallets.mts` 10 perces cache).
- Vol Divergence (Tab 6): a Polymarket IV oldal helyesen mér.
- Polymarket Proxy (Tab 1) és Trade Panel (Tab 5): tokenek helyesen
  jönnek a UI-nak — eddig a token_id mező üres volt minden piacon.

### Érintett fájlok

```
módosítva: netlify/functions/auto-trader/crypto/btc-market-finder.mts (tag → tag_id)
módosítva: netlify/functions/signal-combiner.mts (resolveMarket fast path + Momentum)
módosítva: netlify/functions/apex-wallets.mts (condition_ids plural)
módosítva: netlify/functions/vol-divergence.mts (clobTokenIds + fallback)
módosítva: netlify/functions/polymarket-proxy.mts (clobTokenIds parse)
módosítva: netlify/functions/polymarket-trade.mts (clobTokenIds parse)
```

### Smoke test (deploy után)

```bash
# 1. signal-combiner happy path most már működik market slug-on:
curl 'https://mj-trading.netlify.app/.netlify/functions/signal-combiner?slug=bitcoin-above-80k-on-may-9' \
  | python -c "import sys, json; d=json.load(sys.stdin); print('ok=', d.get('ok'), '| active=', d.get('active_signals'))"
# Expected: ok=True, active=5..8 (eddig 'Market not found')

# 2. crypto auto-trader Run Scan:
curl -X POST 'https://mj-trading.netlify.app/.netlify/functions/auto-trader-api' \
  -H 'Content-Type: application/json' -d '{"action":"run","category":"crypto"}' \
  | python -c "import sys, json; d=json.load(sys.stdin); print(d['results'][0]['activeSignals'])"
# Expected: > 0 (eddig 0)
```
