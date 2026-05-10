# Environment Variables — Részletes referencia

> **Utolsó frissítés:** 2026-05-11
> **Verzió:** v1
> **Hely:** Netlify Site Settings → Environment variables (production) /
> `.env` fájl lokális `netlify dev`-hez.

Ez a doksi minden Netlify Function által olvasott `process.env.*` változót
részletez. A projektben **61 env-változó** van használatban, kategorizálva
az alábbiak szerint.

---

## Tartalomjegyzék

1. [Tervezési elvek](#tervezési-elvek)
2. [Kritikus auth + secret változók](#1-kritikus-auth--secret)
3. [Polymarket integráció](#2-polymarket-integráció)
4. [Hyperliquid integráció](#3-hyperliquid-integráció)
5. [Binance API (spot + futures)](#4-binance-api-spot--futures)
6. [Bybit API](#5-bybit-api)
7. [Anthropic (Claude API)](#6-anthropic-claude-api)
8. [Telegram alerts](#7-telegram-alerts)
9. [Supabase (opcionális logger)](#8-supabase-opcionális-logger)
10. [Globális mód-flagek](#9-globális-mód-flagek)
11. [Crypto bot tunable-ok](#10-crypto-bot-tunable-ok-11-db)
12. [Hyperliquid Perp bot tunable-ok](#11-hyperliquid-perp-bot-tunable-ok-13-db)
13. [Funding-Arb bot tunable-ok](#12-funding-arb-bot-tunable-ok-9-db)
14. [Weather bot tunable-ok](#13-weather-bot-tunable-ok-9-db)
15. [Minimum env-szettek](#minimum-env-szettek)
16. [Settings tab vs env var prioritás](#settings-tab-vs-env-var-prioritás)

---

## Tervezési elvek

1. **Env = baseline default.** A `trader-settings.mts` Blobs runtime
   override store felülírhatja az env defaultokat redeploy nélkül. A bot
   `getEffectiveCryptoConfig()` / `getEffectiveWeatherConfig()` /
   `getEffectiveHlConfig()` async wrapper-ek mergelik a két forrást.
2. **Secrets soha ne legyenek committed.** Minden API key, private key,
   password hash, Telegram token Netlify env változóban él. Lokális
   fejlesztéshez `.env` fájl, ami gitignore-ban van.
3. **Paper-mode default biztonságos.** A `PAPER_MODE` és `HL_PAPER_MODE`
   default `true` (ill. csak `PAPER_MODE=false` írott string oldja fel
   a paper-flag-et). Soha nem futtatunk live tőkével hacsak nem
   expliciten engedélyezed.
4. **Live trading előfeltétele:** `live-readiness` gate (per bot:
   trade count ≥ 30, IC ≥ 5%, Sharpe ≥ 0.5, drawdown &lt; 25%, session
   active). Az env-flag csak ENGEDÉLYEZI a live mode-ot, a gate-ek
   védik a tőkét.

---

## 1. Kritikus auth + secret

A Settings tab és minden authentikált endpoint ezekkel működik.

### `JWT_SECRET` 🔴 KÖTELEZŐ

- **Mire való:** A `/login` endpoint által generált JWT cookie aláírására,
  és minden védett endpoint (Settings, Bybit/Binance/Polymarket trade,
  trader-settings) bejövő kérésének authentikálására.
- **Hol használt:** `netlify/functions/auth.mts:33`, `_auth-guard.ts:22`
- **Formátum:** legalább 32 karakteres random string. Generálható:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **Default:** nincs — ha hiányzik, az auth endpoint 500-as hibát ad.
- **Kockázat:** kompromittálódás esetén mindenki tudna védett
  endpointokra hívni. Rotáláskor minden user kijelentkezik.

### `AUTH_PASSWORD_HASH` 🔴 KÖTELEZŐ

- **Mire való:** Az admin jelszó SHA-256 hash-e. A `/login` endpoint
  ezzel hasonlítja össze a beküldött jelszót.
- **Hol használt:** `netlify/functions/auth.mts:79`
- **Generálás:**
  ```bash
  node -e "console.log(require('crypto').createHash('sha256').update('jelszo').digest('hex'))"
  ```
- **Default:** nincs — a `/login` 500-as hibát ad ha hiányzik.

---

## 2. Polymarket integráció

A crypto + weather bot Polymarket-en kereskedik. **Csak live mode-hoz
kellenek** — paper mode nem érinti őket.

### `POLY_PRIVATE_KEY` 🔴 LIVE-ONLY

- **Mire való:** A Polygon hálózati EOA / proxy wallet privát kulcsa,
  amivel a CLOB order-eket aláírja a bot.
- **Hol használt:** `netlify/functions/auto-trader/shared/config.mts:93`
- **Formátum:** `0x` prefixxel + 64 hex karakter.
- **Default:** üres string — paper mode-ban nem szükséges, **live
  mode-ban dob: `"POLY_PRIVATE_KEY required for live trading"`**.
- **Biztonság:** ez van a USDC fölött. **NIKAKKOR ne commit-old.**
- **Tipikus érték:** kis testnet wallet, vagy egy dedikált trading
  wallet kis bankrollal (max $200).

### `POLY_FUNDER_ADDRESS` 🟠 LIVE-RECOMMENDED

- **Mire való:** A funder address ahonnan a USDC jön (Polygon proxy
  wallet, ami a Polymarket account-hoz tartozik). Live trade
  building-hez kell, hogy a CLOB tudja, melyik wallet biztosítja a
  fedezetet.
- **Hol használt:** `netlify/functions/auto-trader/shared/config.mts:99`
- **Formátum:** `0x...` Polygon cím (40 hex).
- **Default:** üres string.

### `POLY_SIGNATURE_TYPE` 🟡 OPCIONÁLIS

- **Mire való:** Polymarket order signature type — `1` EOA, `2`
  MagicLink/proxy.
- **Hol használt:** `netlify/functions/auto-trader/shared/config.mts:100`
- **Default:** `1` (EOA — a leggyakoribb).

---

## 3. Hyperliquid integráció

A HL Perp directional bot + a Funding-Arb bot HL leg-je.

### `HL_PRIVATE_KEY` 🔴 LIVE-ONLY

- **Mire való:** Hyperliquid Arbitrum L2 wallet privát kulcs.
- **Hol használt:** `netlify/functions/auto-trader/hyperliquid/hl-client.mts:240`
- **Formátum:** `0x` + 64 hex (32 byte).
- **Default:** nincs. A `@nktkas/hyperliquid` SDK adapter cache-eli a
  hibát: `"HL_PRIVATE_KEY env var not set"` vagy `"HL_PRIVATE_KEY must
  be 0x-prefixed 32-byte hex"`.
- **Biztonság:** HL margin account fölött. Külön wallet ajánlott a
  Polymarket-től.

---

## 4. Binance API (spot + futures)

A Binance USDT-M futures fundinghoz, BTC kline-okhoz (vol-divergence,
signal-combiner), és a Funding-Arb hedge leg-hez kell.

### `BINANCE_API_KEY` 🟠 SEMI-LIVE

- **Mire való:** Binance API kulcs read-only adatokhoz + Funding-Arb
  hedge leg spot orderhez.
- **Hol használt:** `netlify/functions/binance-trade.mts:37`,
  `netlify/functions/auto-trader/hyperliquid/funding-arb/hedge-manager.mts:135`
- **Default:** nincs — paper mode-ban (Bybit/Binance trade endpoint)
  hibát dob: `"BINANCE_API_KEY required"`.
- **Biztonság:** ha csak Binance-ről BTC kline-ot húzol (vol-divergence
  function), key NEM szükséges (a `/api/v3/klines` public endpoint).
  Csak live trading-hez kell.

### `BINANCE_API_SECRET` 🟠 SEMI-LIVE

- **Pár:** a `BINANCE_API_KEY`-hez tartozó HMAC SHA256 secret.
- **Hol használt:** ugyanott + Funding-Arb hedge-manager HMAC-aláíráshoz.

### `BINANCE_TESTNET` 🟡 OPCIONÁLIS

- **Mire való:** Ha `"true"` → Binance testnet endpointokat használ.
- **Hol használt:** `netlify/functions/binance-trade.mts:23`
- **Default:** ha hiányzik vagy nem `"true"` → mainnet.
- **Ajánlott:** **élesedés előtt mindig `true`-n** (CLAUDE.md instrukció).

---

## 5. Bybit API

A `/trade/bybit/` manual trader + a signal-combiner funding signal-ja.

### `BYBIT_API_KEY` 🟠 SEMI-LIVE

- **Mire való:** Bybit V5 unified API kulcs.
- **Hol használt:** `netlify/functions/bybit-trade.mts:40`
- **Default:** nincs — manual Bybit trader-en hibát dob.
- **Megjegyzés:** A signal-combiner `getFundingSignal()` Bybit `/v5/market/tickers`
  PUBLIC endpointot hív, nem kell auth — csak a manual order placement-hez.

### `BYBIT_API_SECRET` 🟠 SEMI-LIVE

- **Pár:** a `BYBIT_API_KEY`-hez tartozó HMAC secret.

### `BYBIT_TESTNET` 🟡 OPCIONÁLIS

- **Mire való:** Testnet váltás (api-testnet.bybit.com).
- **Default:** ha nem `"true"` → mainnet.
- **Ajánlott:** **élesedés előtt mindig `true`**.

---

## 6. Anthropic (Claude API)

### `ANTHROPIC_API_KEY` 🟠 OPCIONÁLIS DE AJÁNLOTT

- **Mire való:** Két helyen használjuk:
  1. **LLM Dependency detector** (`llm-dependency.mts`) — az Arb Matrix
     Tab B-jén futtatott pár-elemzés (Claude Sonnet generálja a JSON
     dependency-választ).
  2. **Resolution risk score** (`_resolution-risk.ts`) — a Signal
     Combiner UMA dispute/ambiguity kockázat-becslése. Csak akkor
     hívja Claude-ot, ha az `ANTHROPIC_API_KEY` jelen van; egyébként
     heurisztikus baseline-t használ.
- **Hol használt:** `llm-dependency.mts:31`, `_resolution-risk.ts:246,431`
- **Default:** üres — a két feature visszaesik egyszerűbb fallback-re,
  de a bot összességében működik.
- **Formátum:** `sk-ant-...`
- **Költség:** Sonnet 4.6/4.7 hívásonként ~$0.003-0.01. Combiner 3-perces
  cache-szel napi ~480 hívás max → ~$2-5/nap.

---

## 7. Telegram alerts

### `TELEGRAM_BOT_TOKEN` 🟡 OPCIONÁLIS

- **Mire való:** Telegram bot token az alarmokhoz (calibration warning,
  live mode start, session stop, stb.).
- **Hol használt:** `netlify/functions/auto-trader/shared/config.mts:108`
- **Default:** üres → alarmok némán droppolódnak (log marad).
- **Generálás:** @BotFather → /newbot → token.

### `TELEGRAM_CHAT_ID` 🟡 OPCIONÁLIS

- **Pár:** a chat ID ahova az alertek mennek (saját private chat, vagy
  csoport).
- **Hol használt:** `netlify/functions/auto-trader/shared/config.mts:109`
- **Generálás:** @userinfobot küldés → chat ID.

---

## 8. Supabase (opcionális logger)

A `signal-combiner` "Log Trade" gomb által hívott `trade-logger`
endpoint. Ha nincs konfigurálva, a trade-ek csak a Netlify Blobs
edge-tracker storage-ba kerülnek.

### `SUPABASE_URL` 🟡 OPCIONÁLIS

- **Mire való:** Supabase project URL — trade history hosszú-távú
  perzisztálásához.
- **Hol használt:** `netlify/functions/trade-logger.mts:40`
- **Default:** üres → trade-logger 200-at ad de nem ír sehova
  (`hasSupabase = false`).

### `SUPABASE_ANON_KEY` 🟡 OPCIONÁLIS

- **Pár:** Supabase anon JWT kulcs (a public schema-hoz INSERT permission-nel).

---

## 9. Globális mód-flagek

### `PAPER_MODE` 🟠 KRITIKUS

- **Mire való:** A **crypto bot** mode-jának kontrollja. Ha NEM
  `"false"` → paper mode (default). Csak `PAPER_MODE=false` engedi át
  live mode-ba.
- **Hol használt:** több helyen — `auto-trader/shared/config.mts:27`,
  `auto-trader/weather/decision-engine.mts:59`, `env-status.mts:95,96`
- **Megjegyzés:** ez egyszerre a **crypto** és **weather** bot live-flagje.
  A Hyperliquid bot saját külön `HL_PAPER_MODE`-ot használ.

### `HL_PAPER_MODE` 🟠 KRITIKUS

- **Mire való:** Hyperliquid bot + Funding-Arb bot mode-flag-je. Külön
  van választva a Polymarket bot-tól, mert nem akarjuk hogy egyetlen
  switch egyszerre élesítse mind a kettőt.
- **Hol használt:** `auto-trader/hyperliquid/config.mts:40`,
  `auto-trader/hyperliquid/funding-arb/config.mts:6`
- **Default:** ha NEM `"false"` → paper. **`live-readiness` gate** kell
  hozzá HL-en is.

### `URL` 🟡 OPCIONÁLIS (Netlify auto-set)

- **Mire való:** A Netlify environment automatikusan beállítja a deploy
  URL-t (pl. `https://mj-trading.netlify.app`). A bot ezt használja a
  function-to-function hívásokhoz (signal-aggregator → signal-combiner).
- **Hol használt:** `auto-trader/shared/config.mts:10`
- **Default:** `http://localhost:8888` (`netlify dev` mód).
- **Manuálisan állítani nem kell** — Netlify build-time injection.

---

## 10. Crypto bot tunable-ok (11 db)

A crypto bot kereskedési paraméterei. Mind override-olható a Settings
tab-ról redeploy nélkül.

| Env var | Default | Mit kontrollál |
|---------|---------|----------------|
| `EDGE_THRESHOLD_CRYPTO` | `0.15` | Min net edge (15%) a trade engedélyezéséhez. |
| `MAX_KELLY_FRACTION` | `0.08` | ¼-Kelly utáni hard cap a bankroll 8%-án. |
| `COOLDOWN_SECONDS` | `300` | Anti-revenge cooldown coin-onként loss után. |
| `SESSION_LOSS_LIMIT` | `20` | $20 session loss → auto-stop. |
| `BTC_TP_TARGET` | `0.75` | Take-profit ár-cél (YES @ 0.75). |
| `BTC_SL_TARGET` | `0.35` | Stop-loss ár-cél (YES @ 0.35). |
| `BTC_ENTRY_WINDOW_START_MS` | `60000` | Trade entry tilos market open utáni 60s alatt. |
| `BTC_ENTRY_WINDOW_END_MS` | `180000` | Trade entry tilos market open után 180s-nél. |
| `BTC_HOLD_TO_END_CUTOFF_MS` | `60000` | &lt; 60s before end → hold-to-end (ne korai exit). |
| `BTC_MIN_PRICE_BAND` | `0.10` | Min YES ár 10% (kizárja a deep-OTM $0.01 fill artefaktokat). |
| `POLYMARKET_CRYPTO_TAG_ID` | `21` | Polymarket Gamma tag ID a crypto market-finderhez. |

**Forrásfájlok:** `netlify/functions/auto-trader/shared/config.mts:27-47`,
`auto-trader/crypto/btc-market-finder.mts:93,98`

---

## 11. Hyperliquid Perp bot tunable-ok (13 db)

| Env var | Default | Mit kontrollál |
|---------|---------|----------------|
| `HL_MAX_LEVERAGE` | `3` | Max leverage (HL max 50x, mi 3x-ra clamp-elünk). |
| `HL_MAX_PCT_BANKROLL` | `0.15` | Egy pozíció max a bankroll 15%-án. |
| `HL_EDGE_THRESHOLD_PAPER` | `0.12` | Paper mode min edge. |
| `HL_EDGE_THRESHOLD_LIVE` | `0.18` | Live mode min edge (szigorúbb!). |
| `HL_SESSION_LOSS_LIMIT` | `50` | $50 session loss → auto-stop. |
| `HL_COOLDOWN_SECONDS` | `300` | Per-coin cooldown loss után. |
| `HL_MAX_OPEN_POSITIONS` | `3` | Egyszerre max 3 nyitott perp pozíció. |
| `HL_CONSEC_LOSS_PAUSE_HOURS` | `1` | Konzekutív loss limit után 1h pause. |
| `HL_CONSEC_LOSS_LIMIT` | `3` | 3 konzekutív loss → pause. |
| `HL_VOL_GATE_RV_PCT` | `120` | Realized vol > 120%/yr → ne trade-eljünk (volatilis nap). |
| `HL_ROUNDTRIP_FEE_PCT` | `0.0007` | HL roundtrip fee 0.07% (0.035% × 2). |
| `HL_TP_PCT_MAX` | `0.02` | TP price target max 2% távolság. |
| `HL_SL_PCT_MAX` | `0.01` | SL price target max 1% távolság. |

**Forrásfájl:** `netlify/functions/auto-trader/hyperliquid/config.mts:40-53`

---

## 12. Funding-Arb bot tunable-ok (9 db)

Delta-neutral funding rate arbitrage HL perp + Binance spot között.

| Env var | Default | Mit kontrollál |
|---------|---------|----------------|
| `FR_MIN_SPREAD_HOURLY` | `0.0001` | Min hourly funding spread 0.01%/h (= 0.876%/yr) az opportunity-hez. |
| `FR_MIN_OPEN_INTEREST` | `5000000` | Min HL open interest $5M (likviditás). |
| `FR_MAX_ARB_POSITIONS` | `3` | Egyszerre max 3 arb pozíció. |
| `FR_MAX_CAPITAL_PCT` | `0.40` | Az összes arb max a (HL) bankroll 40%-án. |
| `FR_MIN_POSITION_USDC` | `50` | $50 alatti pozíció skip. |
| `FR_MAX_HOLD_DAYS` | `14` | Max hold 14 nap (safety net). |
| `FR_MIN_SPREAD_TO_CLOSE` | `0.00005` | Ha spread &lt; 0.005%/h → close (spread decay). |
| `FR_FEE_ROUNDTRIP_HL` | `0.0009` | HL roundtrip fee 0.09% (0.045% × 2). |
| `FR_FEE_ROUNDTRIP_BINANCE` | `0.002` | Binance spot roundtrip 0.2% (0.1% × 2). |

**Forrásfájl:** `netlify/functions/auto-trader/hyperliquid/funding-arb/config.mts:6-15`

---

## 13. Weather bot tunable-ok (9 db)

A weather bot Open-Meteo + ECMWF + GFS + NOAA ensemble forecast →
Polymarket negRisk weather buckets.

| Env var | Default | Mit kontrollál |
|---------|---------|----------------|
| `WEATHER_EDGE_THRESHOLD` | `0.12` | Min net edge 12% (gross − fees) trade engedélyezéséhez. |
| `WEATHER_CONFIDENCE_MIN` | `0.65` | Bucket-match confidence min 65%. |
| `WEATHER_EXIT_BEFORE_MIN` | `45` | Ha &lt; 45 perc van settlement-ig → ne trade-eljünk. |
| `WEATHER_MAX_POSITION_USD` | `25` | Max $25 / pozíció. |
| `WEATHER_MAX_EDGE_CAP` | `0.40` | Gross edge cap 40% — efölött "likely model error", no-trade. |
| `WEATHER_FORECAST_DAYS` | `0` | Open-Meteo forecast napok (0 = today only). |
| `WEATHER_APPLY_CITY_OFFSET` | `false` | Ha `"true"` → city offset applied (legacy bug compatibility). Default: OFF. |
| `WEATHER_CRON_ENABLED` | `false` | `"true"` → weather bot cron */5 min aktív. |
| `USE_ENSEMBLE` | `false` | `"true"` → multi-model ensemble (GFS+ECMWF+NOAA). |

**Forrásfájlok:** `auto-trader/weather/decision-engine.mts:54-64`,
`auto-trader/weather/ensemble-forecast.mts:142`

---

## Minimum env-szettek

### A. Csak elemzés (no trading)

Ha csak a `/tools/` dashboardot akarod használni (Scanner, EV, Vol
Harvest, Apex Wallets, Cond Prob, Signals, Arb Matrix):

```bash
JWT_SECRET=<32+ char random>
AUTH_PASSWORD_HASH=<sha256 hash of your password>
# Opcionálisan:
ANTHROPIC_API_KEY=sk-ant-...  # llm-dependency + resolution-risk
```

### B. Paper trading (default ajánlott)

Az auto-trader bot-okhoz paper mode-ban:

```bash
JWT_SECRET=...
AUTH_PASSWORD_HASH=...
PAPER_MODE=true          # implicit default
HL_PAPER_MODE=true       # implicit default
# Opcionálisan a paper alarmokhoz:
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ANTHROPIC_API_KEY=...    # signal-combiner resolution-risk feature
```

### C. Live Polymarket (csak gate-ek átengedése után!)

```bash
JWT_SECRET=...
AUTH_PASSWORD_HASH=...
PAPER_MODE=false
POLY_PRIVATE_KEY=0x...64hex
POLY_FUNDER_ADDRESS=0x...
POLY_SIGNATURE_TYPE=1
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ANTHROPIC_API_KEY=...
```

### D. Live Hyperliquid + Funding-Arb

```bash
# C-ből minden, plusz:
HL_PAPER_MODE=false
HL_PRIVATE_KEY=0x...64hex
BINANCE_API_KEY=...        # funding-arb hedge leg
BINANCE_API_SECRET=...
BINANCE_TESTNET=false      # vagy true élesedés előtt
```

### E. Bybit / Binance manual trader

```bash
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
BYBIT_TESTNET=true         # ajánlott élesedés előtt
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_TESTNET=true
```

---

## Settings tab vs env var prioritás

A `trader-settings.mts` endpoint Netlify Blobs-ban tárolt override-okat
ad. A prioritás:

```
1. Settings tab Blobs override (legmagasabb prioritás)
2. process.env.* érték
3. Beégett default (kódban)
```

Az `auto-trader/shared/config.mts` `getEffectiveCryptoConfig()` async
wrapper mergeli a kettőt. Példa:

```typescript
// User setting (Blobs): EDGE_THRESHOLD_CRYPTO = 0.20
// Env: EDGE_THRESHOLD_CRYPTO=0.18
// Code default: 0.15
// → Effective: 0.20 (Blobs wins)
```

**Tunable env-változók a Settings tab-ról is állíthatóak** (és ez az
ajánlott módja — redeploy nem kell). A Settings tab által nem
elérhető változók (secret-ek, API key-ek, mode flagek) csak env-ből.

A Settings tab által konfigurálható env-ek (a `trader-settings.mts`
SCHEMA-ban):

- Crypto: `EDGE_THRESHOLD_CRYPTO`, `MAX_KELLY_FRACTION`, `COOLDOWN_SECONDS`,
  `SESSION_LOSS_LIMIT`, BTC_*, `BTC_MIN_PRICE_BAND`
- HL: `HL_MAX_LEVERAGE`, `HL_MAX_PCT_BANKROLL`, `HL_EDGE_THRESHOLD_*`,
  `HL_SESSION_LOSS_LIMIT`, `HL_COOLDOWN_SECONDS`, `HL_MAX_OPEN_POSITIONS`,
  `HL_CONSEC_LOSS_*`, `HL_VOL_GATE_RV_PCT`, `HL_TP_PCT_MAX`, `HL_SL_PCT_MAX`
- FR-arb: minden `FR_*`
- Weather: minden `WEATHER_*` + `USE_ENSEMBLE`
- Live readiness gate-ek (NEM env, csak Blobs): `liveReadyMinTrades`,
  `liveReadyMinWinRate`, `liveReadyMinIC`, `liveReadyMinSharpe`,
  `liveReadyMaxDrawdownPct`

**Secret / kritikus változók — CSAK env-ből (NEM Settings):**

- `JWT_SECRET`, `AUTH_PASSWORD_HASH`
- Minden `*_PRIVATE_KEY`, `*_API_KEY`, `*_API_SECRET`
- `PAPER_MODE`, `HL_PAPER_MODE` (biztonság miatt redeploy kell live váltáshoz)
- `TELEGRAM_*`, `SUPABASE_*`, `ANTHROPIC_API_KEY`

---

## Biztonsági szempontok

1. **Secret rotáció:** ha a `JWT_SECRET`, bármely `*_PRIVATE_KEY`, vagy
   API key kompromittálódik (commit, screenshot, log leak), **azonnal**:
   - Generálj újat
   - Frissítsd Netlify-on (Site Settings → Environment variables)
   - Trigger redeploy (env változás nem auto-deploy)
   - Polymarket / HL wallet kompromittálódásakor: kicseréld a wallet-et,
     ne csak a private key-t (a Polygon / Arbitrum címek nem visszahúzhatók)

2. **Paper-to-live váltás:** mindig 2-fázisos:
   - 1. fázis: `live-readiness` gate átengedi (30+ trade IC ≥ 5%, …)
   - 2. fázis: env-en `PAPER_MODE=false` (csak akkor!) + Netlify redeploy

3. **Testnet előbb:** `BINANCE_TESTNET=true`, `BYBIT_TESTNET=true`,
   `HL_PRIVATE_KEY=<testnet wallet>` egy hetes próbaüzem után váltani
   mainnet-re.

4. **CI / GitHub Actions:** ha CI használ env-eket, **soha** ne logold
   ki őket (még error-ban se). Netlify build environment automatikusan
   maszkolja a `*_SECRET`, `*_KEY`, `*_TOKEN` mintázatú változókat a
   build log-ban.

---

## Hova nyúlj legközelebb

- **Új tunable env hozzáadása:** 1) Add a megfelelő `config.mts`-hez a
  `process.env.X || "default"` mintát, 2) ha runtime-állítható kell
  legyen, vedd fel a `trader-settings.mts` SCHEMA-jába, 3) frissítsd
  ezt a doksit (`internal-docs/current-state/env-vars.md`).
- **Új API integráció:** kövesd a Bybit / Binance mintát: `*_API_KEY`,
  `*_API_SECRET`, `*_TESTNET` triót. A trade endpointban első dolog
  legyen az env-hiány error.
- **Lokális dev:** `.env` fájl a projekt root-jában, `netlify dev`
  automatikusan beolvassa. Ne commit-old. (`.gitignore`-ban van.)
