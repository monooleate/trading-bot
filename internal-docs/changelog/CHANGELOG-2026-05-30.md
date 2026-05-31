# CHANGELOG 2026-05-30

## (a) — Weather bot diagnózis ("a fix óta egy trade sem") + Shenzhen lefedettség

### Trigger

User: *"még a módosítás óta egy weather trade sem született. jó a bot?"* (a Sprint 43 cron-fix után).

### Diagnózis — a bot egészséges, a 0 trade NEM hiba

Élő ellenőrzés (`category=weather`):

- **Fut**: `runStatus.source: cron`, 3 percenként, nincs stopped/bricked → a Sprint 43 fix működik.
- **Polymarket pillanatkép** (`/events?active=true&closed=false`): a fix óta eltelt egyetlen napi ablakban (2026-05-30 00:00–12:00 UTC) **2** hőmérséklet-piac volt:
  - `highest-temperature-in-shenzhen-on-may-30-2026` ($188k vol) → **Shenzhen nem volt lefedve** (nincs station) → helyesen eldobva.
  - `highest-temperature-in-london-on-may-30-2026` ($185k vol) → **London le van fedve** (EGLC). 21:35 UTC-kor már gyakorlatilag eldőlt (27°C bucket @ 99.85%) → **nincs edge** → helyes skip.
- **Egyéb okok**: a piacok `endDate = 12:00 UTC`, így a nap másik felében (12:00–24:00 UTC) **nincs** tradeable piac. A `parseTempFromLabel` **mind °C-t, mind °F-t** kezel (°C→°C, °F→°C konverzió), tehát a London (°C) feldolgozható — nincs unit-bug.

**Verdict**: a 0-trade egy szelektív, napi 1-2 covered-piacot látó botnál normális; a bot helyesen működik. Az egyetlen valós veszteség a **Shenzhen** ($188k) lefedetlensége volt.

### Fix — Shenzhen lefedettség

- `weather/station-config.mts`: új `shenzhen` állomás — **ZGSZ** (Bao'an Intl, lat 22.6393, lon 113.8107), `tz: Asia/Shanghai`, `city_offset: -0.5` (a Pearl River Delta-ban Hong Kong −1.0 és Guangzhou 0.0 között, coastal), peak band Guangzhou-val egyezően.
- `weather/market-finder.mts`: `CITY_PATTERNS` + `shenzhen: ["shenzhen"]` (eddig a slug `no-city-mapped`-re esett).
- `weather/station-config.test.mts`: új EXPECTED bejegyzés (ICAO ZGSZ + koordináta-pin). **9/9 station-teszt zöld.**
- `npx tsc --noEmit` (exit 0) + `npm run build` (10 oldal) zöld.

### Hatás

A bot mostantól a Shenzhen-piacokat is megfogja (a következő, future-endDate Shenzhen-eseménynél). A weather coverage 27 → **28** város.

---

## (b) — Weather market-discovery gyökérok-fix (tag-alapú lekérés)

### Trigger

A (a) diagnózis után a „next window megfigyelése": a may-31 piacok (London/Shenzhen/Hong-Kong/NYC/…) **már listázva** voltak (future endDate), de egy manuális `run` mégis „no active markets"-et adott. **Gyökérok feltárva.**

### A bug — top-100-by-volume láthatósági plafon

A `findWeatherMarketsDetailed` a `/events?order=volume24hr&ascending=false`-szal húzott, és a Gamma a választ **~100 sorra vágja**. Polymarketen routine-szerűen >100 aktív esemény van, **~$180k volume24hr floor-ral** a 100. helyen. A frissen listázott daily-temperature piacok **$5k–$65k/24h**-n ülnek a saját window-jukig → **a top-100 alá esnek → a bot nem látja őket**. Mérés: may-31 London $37.9k, Shenzhen $21.3k vs a 100. helyezett **$182.8k**. Ezért a bot effektíve csak a heavy-traffic csúcson „látott" egy weather-piacot — ez magyarázta a ritka kereskedést.

### Fix — `tag_slug=highest-temperature`

- A `findWeatherMarketsDetailed` mostantól a precíz **`tag_slug=highest-temperature`** taget (id 104596) kérdezi, ami **volumentől függetlenül** adja a bot pontos piac-típusát (mérés: 100/100 temperature, **~46 future-dated**). A korábbi „tag broken" megjegyzés a **broad** `weather` tagre (id 84) vonatkozott, ami eső/hó piacokat is kever — a specifikus highest-temperature tag tiszta.
- **Union + dedupe** a régi volumen-slice-szal `Promise.allSettled`-del: ha a tag valaha elromlana, a high-volume piacokra degradál (nem nullára); a title/slug szűrő végig megmarad defense-in-depth.

### Hatás

A bot most **37–46 future-dated weather-piacot lát folyamatosan** (London, Paris, Seoul, Toronto, Seattle, NYC, São Paulo, Shenzhen, …) szemben a korábbi ~2-vel. Korábbi belépés (nagyobb forecast-edge a window előtt, mielőtt a piac beárazódik) + sokkal több trade-lehetőség. `tsc` + `build` zöld.

---

## (c) — Pending pozíciók provisional nyer/veszít badge (crypto + weather + sports)

### Trigger

User: a „pending paper positions past endDate — awaiting Polymarket resolution" dobozban látszódjon, hogy nyert vagy vesztett, ha lehetséges — **minden** Polymarket-botra.

### Megoldás — valós piaci adatból (nem szimuláció)

Egy „pending" pozíció past-endDate, de a Gamma még nem jelentett végleges resolution-t (UMA propose→dispute→finalize ablak). A kimenetel viszont általában **már eldőlt**: a beárazódott piac a nyertes kimenetelt ≈1-re, a vesztest ≈0-ra árazza, jóval az UMA-véglegesítés előtt. A `outcomePrices` a **valós Polymarket-piac** ára (Gamma) — ugyanaz a forrás, amiből a bot a **tényleges** zárást is csinálja (a 2026-05-10 simV3-fix óta paper PnL == live PnL, valós resolution-only). A badge csak **korábban** olvassa ki.

- Új **`shared/provisional-outcome.mts`** — `probeProvisionalOutcome(conditionId, direction)`: a piac **closed-filter NÉLKÜLI** `outcomePrices`-át kéri (így a past-endDate de még nyitott piac is ad adatot), 90s Blobs-cache-sel. Tiszta classifier (`classifyProvisional`): `YES = outcomePrices[0]`; `YES ≥ 0.9` → YES nyer, `YES ≤ 0.1` → NO nyer, közte → „pending". Új `provisional-outcome.test.mts` (12 case) pin-eli a leképezést.
- **Crypto** (`getCryptoPendingPositions`), **Weather** (`getWeatherPendingForSettlement` + `reconciler.getPendingPositions` most `conditionId`-t is ad), **Sports** (új `getSportsPending` + új `pending` mező a statusban + a SportsTrader most külön **PendingPositionsCard**-ot renderel, az open card pedig csak az aktív, még-nem-lejárt pozíciókat mutatja) — mind a shared helpert hívja, pozíciónként párhuzamosan.
- **Frontend**: a megosztott `PendingPositionsCard` új badge-et renderel: **✓ áll: nyer** (zöld) / **✗ áll: veszít** (piros), tooltippel hogy valós piaci adat. A 3 trader (Crypto/Weather/Sports) átadja a `provisionalOutcome`-ot.
- **HL-perp / F-Arb**: nem alkalmazható — ezek perp-ár / funding alapján zárnak, nincs Polymarket-UMA „pending" fogalmuk.

### Verifikáció

`provisional-outcome.test.mts` 12 case zöld; `tsc --noEmit` + `npm run build` zöld.
