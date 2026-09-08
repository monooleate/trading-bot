# 36 — Crypto multi-coin scan (BTC / ETH / SOL)

> Sprint: **B51** (2026-09-08). Kód: [`packages/core/src/coin.mts`](../../packages/core/src/coin.mts), [`btc-market-finder.mts`](../../services/worker/src/pillars/crypto/btc-market-finder.mts), [`signal-combiner.mts`](../../services/api/src/routes/signal-combiner.mts), [`signal-aggregator.mts`](../../services/worker/src/pillars/crypto/signal-aggregator.mts), [`cross-position-gates.mts`](../../services/worker/src/pillars/shared/cross-position-gates.mts).

## Miért

A crypto bot BTC-only volt: a market finder csak `bitcoin`/`btc` kulcsszóra admittált, és a 8 combiner-jelből **7 hardcode-olta a `BTCUSDT`-t** (momentum-anchor spot+σ, vol-divergence spot/σ/openedAt-K, funding, order-book imbalance). Egyetlen jel (`oi_delta`, B49 #5) volt natívan multi-coin.

Következmény: amikor kevés a near-the-money BTC napi piac (pl. BTC egy kerek strike-on ül → mind coinflip → a `resolution-risk` + `combiner-confidence` gate helyesen blokkol), a bot **alig kereskedik és alig gyűjt fill-adatot** — miközben a Polymarketen párhuzamosan sok ETH napi piac fut (`ethereum-above-1900…3000-on-…`, `ethereum-up-or-down-on-…`). A megoldás nem a küszöb-lazítás (az vagy nem hat a gate-blokkolt piacokra, vagy coinflip-zajt enged be), hanem **több coin** — dekorrelált piac-kínálat.

## SSOT: `@core/coin.mts`

Egyetlen pure modul azonosítja a coint és parse-olja a strike-ot; három korábban duplikált regex (combiner `parseThresholdK`, gates `parseBtcAboveSlug`, a threshold-teszt lokális másolata) ide olvad.

- **`coinFromText(text)`** → `CoinInfo | null`: `{ base, binance, coingecko, fsym, deribit }`. Szó-határos alias-match (`bitcoin|btc`, `ethereum|eth`, `solana|sol`, +xrp/doge/avax/bnb). `deribit` csak BTC/ETH-nek nem-null (options-chain currency); a többinek `null` → a #7 Deribit-IV út kimarad, model-σ fallback.
- **`parseCryptoAboveStrike(slug)`** → `{ coin, K, closingKey } | null`. Két strike-konvenció:
  - **BTC**: `bitcoin-above-90k-on-…` — a `k` szuffixum ×1000 → K = 90000.
  - **ETH**: `ethereum-above-3000-on-…` — literál USD → K = 3000.
  - `K` mindig **USD-ben** (a valódi rezolúciós strike) → a vol-jel BS-digitálja és a cond_prob monotonicitás-család ugyanabban az egységben.
  - `closingKey` **coin-scoped** (`"BTC:september-8-2026"`) → a cross-position gate-ek sosem hasonlítanak ETH-strike-ot egy azonos napon rezolváló BTC-strike-hoz.
  - Nem parse-ol: up-or-down / nem-coin (`laptop-fdv-above-100m`) / nem-horgonyzott suffix (`ratio-bitcoin-above-80k-something`).

## Bekötés

| Réteg | Változás | Coin forrása |
|---|---|---|
| **Finder** | `detectCryptoUpDown(question, slug)` a `CRYPTO_COINS` allowlist-tel; `MarketInfo.coin` tag | `coinFromText(slug+question)` |
| **Combiner** (7 jel) | `coinOf(market)` → `fetchCloses/fetchDailyOHLC/fetchBtcPriceAt(…, coin)`, `getFundingSignal(coin)`, Deribit `currency`+per-currency cache, cond_prob related = coin+K identitás | `coinOf(market)` (default BTC) |
| **Aggregator** | order-book imbalance `coinFromText(slug).binance` | slug |
| **Gates** | `parseBtcAboveSlug` → `parseCryptoAboveStrike` (K USD, coin-scoped key); display `$X` | slug |

**Default-BTC fallback mindenhol** (`BTC_DEFAULT` / `?? "BTCUSDT"`): ha egy hívó nem tud coint azonosítani, BTC-t áraz — a pre-B51 viselkedés bit-azonos. A BTC slug-ok ugyanúgy parse-olnak (78k→78000) → **0 regresszió a meglévő BTC-trade-ekre**.

## Guardrail-ek változatlanul

Az összes crypto gate (16) coin-agnosztikus vagy coin-scoped: az entry-window duration-alapú, a longshot price-band [0.10,0.90] ár-alapú, a monotonicity/overlap coin-scoped, a paper-resolver valós Polymarket-rezolúción áll. A Kelly/loss-limit/beta-cap/DD-kill érintetlen.

## Konfiguráció

- **`CRYPTO_COINS`** (env, default `BTC,ETH,SOL`) — vesszős base-allowlist a finderben. Szűkítsd `BTC`-re a pre-B51 viselkedéshez. → [env-vars.md](../current-state/env-vars.md).

## Korlátok / follow-up (B51-Backlog)

- A realized-IC kalibráció **kategória-szintű** (crypto), nem coin-szintű — ha az ETH-edge strukturálisan eltér a BTC-től, coin-particionált IC kellhet.
- A #7 Deribit-IV ETH-chainen még nem élő-tesztelt (default-OFF).
- SOL-nak jelenleg nincs napi above-K piaca a crypto-tagben → a scan automatikusan felveszi, amint megjelenik.
