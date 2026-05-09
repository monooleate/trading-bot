# Changelog — 2026-05-09

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
