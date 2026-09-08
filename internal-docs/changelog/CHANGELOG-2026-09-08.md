# CHANGELOG — 2026-09-08 (81. session)

## B51 — Crypto multi-coin scan-bővítés (BTC-only → BTC/ETH/SOL)

### Kontextus / trigger

A user kérdése: „állítsuk lejebb a küszöböt hogy több trade legyen és több adat, vagy azok elvinnék a modell-állítást rossz irányba? a crypto alig kereskedik." + „nézd meg", majd „bővíthető-e több strike-ra/coin-ra, mikor érdemes ránézni a gyűjtött adatra és kalibrálni?", végül: „mérd fel a coin-bővítést, vedd sprintbe, végezd el, ellenőrizd vissza."

**Élő diagnózis (boxon, `ssh analytics`):** a crypto fut (paper, 3-perces tick, nincs auto-stopolva), de 2 óra alatt **0 nyitás / 120 skip**. A scan-ablakban 3 BTC-piac: 2× `above-78k` (a **resolution-risk gate** blokkolja — BTC $78,529 ≈ a strike-on → lejárathoz közel megjósolhatatlan) + 1× `up-or-down` (a **combiner-confidence gate** blokkolja — output 0.51–0.53, valódi zaj). **Következtetés:** a szűk kereskedés oka **piac-kínálat-szűke + coinflip-ablak**, NEM tight-küszöb → a küszöb-lazítás nem hatna a gate-blokkolt piacokra, és csak coinflip-zajt engedne be (hígítva a realized-IC-t). A helyes kar a **piac-szélesség**: több coin. A Gamma-verifikáció megerősítette: ETH-nek is sok napi piaca fut (`ethereum-above-1900…3000-on-…`, literál strike; `ethereum-up-or-down-on-…`), a scan mégis BTC-only volt, és a 8 combiner-jelből 7 hardcode-olta a `BTCUSDT`-t.

### Mit csináltam

Teljes multi-coin bekötés — `tsc` exit 0 + **45/45 teszt** (44→45) + web-build zöld, `main`.

**1. SSOT új pure modul** [`packages/core/src/coin.mts`](../../packages/core/src/coin.mts) + [teszt](../../packages/core/src/coin.test.mts) (7 csoport):
- `coinFromText(text)` → `CoinInfo { base, binance, coingecko, fsym, deribit }` (szó-határos alias-match; `deribit` csak BTC/ETH-nek).
- `parseCryptoAboveStrike(slug)` → `{ coin, K, closingKey }`: a **3 korábban duplikált** strike-regex (combiner `parseThresholdK` + gates `parseBtcAboveSlug` + a threshold-teszt lokális másolata) egyetlen forrásba. Kezeli a **BTC „k"** (78k→78000) ÉS az **ETH literál** (3000→3000) konvenciót; `K` USD-ben; `closingKey` **coin-scoped** (`"BTC:…"`) → cross-coin sosem hasonlítódik.

**2. Finder** [`btc-market-finder.mts`](../../services/worker/src/pillars/crypto/btc-market-finder.mts): `isBtcUpDown` → `detectCryptoUpDown` (coinFromText + `CRYPTO_COINS` allowlist, default `BTC,ETH,SOL`); `MarketInfo.coin` tag (új opcionális mező a [types.mts](../../packages/core/src/types.mts)-ben).

**3. Combiner** [`signal-combiner.mts`](../../services/api/src/routes/signal-combiner.mts) — a 7 BTC-hardcode coin-aware (`coinOf(market)`, default BTC):
- `fetchCloses` / `fetchDailyOHLC` / `fetchBtcPriceAt` (Binance/CoinGecko/CryptoCompare a coin symbol/id-jével);
- `getFundingSignal(coin)` (Bybit/Binance/premium-proxy a coin symbol/fsym-jével);
- Deribit `fetchDeribitRaw/Smile(currency)` + **per-currency cache**; a #7 Deribit-IV út csak `coin.deribit`-tel (BTC/ETH), másnak model-σ fallback;
- `getCondProbSignal` related-match **coin+K identitásra** (nem csak K — elkerüli a cross-coin USD-kollíziót);
- `parseThresholdK` / `parseCoinSymbol` a shared SSOT-ra delegálva.

**4. Aggregator** [`signal-aggregator.mts`](../../services/worker/src/pillars/crypto/signal-aggregator.mts): az order-book imbalance a piac saját coinjára (`coinFromText(slug).binance`, fallback BTC).

**5. Gates** [`cross-position-gates.mts`](../../services/worker/src/pillars/shared/cross-position-gates.mts): `parseBtcAboveSlug` delegál (K USD + coin-scoped key); a [decision-engine](../../services/worker/src/pillars/crypto/decision-engine.mts) monotonicity/overlap display `$X` formátumra (K már USD).

### Biztonság / regresszió

- **BTC-viselkedés bit-azonos:** minden fetch default BTC (`BTC_DEFAULT` / `?? "BTCUSDT"`), a BTC slug-ok ugyanúgy parse-olnak → 0 regresszió a meglévő BTC-trade-ekre. Az ETH/SOL a deploy után élesedik; `CRYPTO_COINS=BTC` visszaszűkíti.
- A 16 crypto gate coin-agnosztikus vagy coin-scoped (entry-window duration-alapú, longshot-band ár-alapú, monotonicity/overlap coin-scoped, paper-resolver valós Polymarket-rezolúción). A Kelly/loss-limit/beta-cap/DD-kill érintetlen.
- Két érintett teszt frissítve a coin-scoped/USD-kontraktusra (`cross-position-gates.test.mts`, `signal-combiner-threshold.test.mts` — ez utóbbi most a shared parsert importálja a lokális másolat helyett).

### Verifikáció

`tsc` exit 0 · `node scripts/run-tests.mjs` → 45/45 · `npm run build` zöld. Push `main` → GitHub Actions CI+deploy → box-log-verifikáció (ETH-piacok a scan-listán + ETH-signal-tick).

### Doksi

[math/36-multi-coin.md](../math/36-multi-coin.md) · [sprints.md B51](../roadmap/sprints.md) · [env-vars.md `CRYPTO_COINS`](../current-state/env-vars.md).

### Follow-up (Backlog)

Per-coin realized-IC (a calibration jelenleg kategória-szintű) ha az ETH-edge eltér a BTC-től; ETH Deribit-IV élő-teszt; SOL a piacai megjelenésekor automatikusan bejön.
