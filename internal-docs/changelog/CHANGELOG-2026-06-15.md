# CHANGELOG 2026-06-15

## Weather trade-history audit (valós?) + nagy nyeremények + B28 longshot floor

A user kérte a weather trade-history ellenőrzését + a nagy nyeremények azonosítását.
Az audit után bevezettünk egy min-ár floort (B28), hogy a paper-eredmény realisztikus
legyen.

### 1. Audit — a history VALÓS ✅

A 2026-06-13-i reset óta **11 closed trade**, +$392.33 PnL (36% WR, profitFactor 4.17).

- **PnL bit-pontosan reprodukálható** (weather = fee-mentes: `pnl = shares × (exit − entry)`):
  mind a 11 trade eltérése **+0.000**.
- **Bankroll rekonciliál:** $250 start + $392.33 − $100 (4 open) = **$542.33**.
- **Polymarket Gamma cross-check** (`closed=true`) — a két nagy nyeremény valódi:
  - Hong Kong jún-14: a **29°C** bucket `['1','0']` (YES) → a bot YES-e nyert.
  - Hong Kong jún-15: a **29°C** bucket `['1','0']` (YES) → a bot YES-e nyert.

  A bot mindkét napra eltalálta a hongkongi napi csúcsot (29°C), miközben a piac azt
  ~4.6¢-re árazta.

### 2. A nagy nyeremények

| # | Piac | Oldal | Entry | Shares | PnL |
|---|------|-------|-------|--------|-----|
| 1 | Hong Kong jún-14, 29°C | YES | ~5.6¢ | 355.68 | **+$335.94** |
| 2 | Hong Kong jún-15, 29°C | YES | ~5.6¢ | 155.14 | **+$146.53** |
| 3 | Tokyo jún-15 | YES | 35.5¢ | 30.76 | +$19.84 |
| 4 | Seoul jún-14 | NO | 62.5¢ | 36.51 | +$13.69 |

A két hongkongi tail-bucket adja a bruttó profit **~98%-át** (+$482 a +$392-ból).

### 3. Probléma — paper-fill realizmus (a fő finding)

Mindkét monster-win egy **~5¢-os mély-OTM bucket**, paper módban a jegyzett áron,
teljes mérettel kitöltve (355 ill. 155 share). Élesben egy 5¢-os tail-bucket order
book-ja túl vékony ahhoz, hogy $20-t fillelj ott → **a paper PnL (+157%) felfelé
torzul** nem-realizálható tail-találatoktól. Szimmetrikus a NO-oldalon is (Seoul
jún-13 NO @ 1.4¢ egy 99.6%-os bucketre — bukott). `evGap = −$486` is jelzi: a modell
túlbecsüli a tail-edge-et; a profit pozitív-skew tail-találat (2/11), nem kalibrált edge.

### 4. Fix — B28 weather longshot floor (min bet-side price)

[`weather/decision-engine.mts`](../../netlify/functions/auto-trader/weather/decision-engine.mts) —
új gate a Kelly-cap után:

```
betSidePrice = direction === "YES" ? bucketPrice : 1 − bucketPrice
minPriceOk   = config.minPrice <= 0 || betSidePrice >= config.minPrice
```

- A megfogadott (executed `direction`) oldal market-ára < `minPrice` → blokk. **Szimmetrikus**
  (longshot-YES + upset-NO). 0 = OFF (régi viselkedés).
- Új `minPrice` mező a `WeatherConfig`-ban; `getWeatherConfig` (`WEATHER_MIN_PRICE` env,
  default 0.05) + `getEffectiveWeatherConfig` (`weatherMinPrice` override).
- Új `weatherMinPrice` Settings-knob (`trader-settings.mts` SCHEMA, range 0–0.5);
  presetek: **loose 0.03 / normal 0.05 / strict 0.08**.
- A sports `sportsMinPrice` floor (B24) weather-megfelelője.
- Teszt: `adverse-selection-fixes.test.mts` +4 B28 case (blocks-longshot-YES,
  blocks-upset-NO, off-noop, passes-sane). `npx tsc --noEmit` + `npm run build` + a teljes
  suite zöld.

### Hatás

A bot mostantól kihagyja a sub-5¢ mély-OTM tail-bucketeket (mindkét oldalon) → a paper-
eredmény közelebb lesz az élesben realizálhatóhoz, és nem gyűjt nem-tölthető lottószelvény-
fogadásokat. A meglévő +$392-os session **nem** lett resetelve (a user a floort kérte, nem
új resetet) — a már meglévő nyeremények valósak, csak a JÖVŐBELI belépőkre hat a floor.

### Maradó

- `n=11` + 2 tail-találat → magas variancia, még nem statisztikailag robusztus. A floorral
  tisztább adat gyűlik.
- A weather σ-kalibráció továbbra is post-50-trade tárgy → sprints.md B15.
