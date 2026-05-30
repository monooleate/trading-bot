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
