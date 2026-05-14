# 2026-05-14d — Edge Tracker Tier-1 metric expansion

## Kontextus

User kérése: az Edge Tracker analízis után **kezd el az implementálást és mindegyik
bot esetén**. Az elemzés három "MOST megcsinálható" tételt azonosított:

1. SummaryCards bővítése standard quant-metrikákkal (Profit Factor, Sortino,
   Expectancy, Payoff Ratio, streak, EV-gap)
2. Underwater drawdown curve a Cumulative PnL chart alá
3. Sharpe bootstrap CI a Sharpe card sub-szövegébe

Mindhárom **shared code path-on** él (`edge-tracker/statistics.mts` +
`EdgeTrackerPanel.tsx`), és a `CategoryDashboard /trade/{category}/edge-tracker`
routing miatt **mind az 5 kategóriára (crypto / weather / hyperliquid /
funding-arb / sports) automatikusan kiterül** — per-bot kód-duplikáció nincs.

## Backend változások — `netlify/functions/edge-tracker/statistics.mts`

### Új `SummaryStats` mezők

| Mező | Számítás | Jelentés |
|------|----------|---------|
| `sharpeCiLo` / `sharpeCiHi` | 200-resample bootstrap, percentile method, deterministic LCG seed | 95% CI Sharpe-ra. Ha brackets-zero → "n.s." (not significant) — kis N-en azonnal látszik hogy a Sharpe szám zaj |
| `sortinoRatio` | `(avgReturn − rf) / downsideStd(returns < 0)` | Downside-only Sharpe — nem-normális PnL eloszlásnál releváns |
| `profitFactor` | `Σwins / |Σlosses|`, max 999 | Standard robusztusság-jel; <1 = veszteséges, 1-1.5 = marginal, >1.5 = healthy |
| `expectancy` | `p × avgWin − q × avgLoss` USD/trade | Per-trade várható nyereség, $-ban kifejezve |
| `payoffRatio` | `avgWin / avgLoss` | Mennyiszer akkora az átlag-nyertes mint az átlag-vesztes |
| `longestWinStreak` / `longestLossStreak` | Egy passz a `streakStats` helperben, predikátum `t.pnl > 0` | Tail-risk indikátor |
| `currentStreak` | Signed integer (+N nyertes, −N vesztes, 0 = no trades) | Operator-pszichológia + drawdown-onset jelzés |
| `evGap` | `Σactual − Σev`, `tradeEv()` direction-aware binary payout-model | **Leading indicator edge-decay-re**: ha persistálva negatív → fee/slippage/regime drift. HL perpre collapse-ol 0-ra (binary collapse) |
| `maxDrawdownDuration` | Trade-ek száma a peaktől a worst troughig | Quasi-time-to-recovery proxy |

### Új `CumulativePoint` mezők

```ts
drawdown: number;   // runningCum − runningPeak (≤ 0)
peak: number;       // running peak of actualCum at this index
```

A frontend egyetlen response-ból megkapja a teljes underwater idősort —
nincs külön endpoint.

### Bootstrap CI implementáció

Mulberry32-szerű LCG (`lcgFactory`), seeded `(Σreturns + n·0.001)`-vel.
A determinisztikus seed garantálja, hogy ugyanaz a trade-lista mindig
ugyanazt a CI band-ot adja → nincs panel-jittering két refresh között.
200 resample × 80 trade = ~50µs lokálisan, irreleváns overhead.

### `tradeEv()` direction-aware

`computeCumulativePnl` EV-számítás (`isYesLike` invertálás NO/SHORT-on)
ki van emelve külön helperbe és újrahasznosítva az `evGap` summary-stat-ben,
hogy a két érték konzisztens legyen.

## Frontend változások — `src/components/EdgeTrackerPanel.tsx`

### SummaryCards — két soros KPI-grid

- **Top sor (változatlan):** Total PnL · Win Rate · Sharpe · Avg Edge · Max DD · Kelly Eff
- **Extended sor (új):** Profit Factor · Sortino · Expectancy · Payoff · EV Gap · Streak
- Extended sor `surface2` háttéren elválasztva — vizuálisan második rendű info
- **Kis N guard**: minden new card `ec-muted` (szürke) ha `totalTrades < 10` —
  a 3 trade-en futó "Profit Factor 4.46" zöld jelölés félrevezető lenne
- **Sharpe sub-text** mostantól `95% CI [lo, hi]` formátum; ha brackets-zero →
  `[lo, hi] — n.s.`
- **Max DD sub** mostantól `XX% · Yt deep` (Y trades a peaktől)

### `UnderwaterDrawdownChart` komponens

- Új chart közvetlenül a CumulativePnlChart alatt
- Area fill `var(--danger)` 18% opacity, outline 1.5px
- Worst-drawdown circle marker + USD annotation
- Header: `worst $XX.XX · Nt deep`
- Mobile: ugyanaz a viewBox-skálázás mint a többi `et-svg` chart

### `ec-muted` osztály

Hozzáadva a globális `dashboardStyles.ts`-be (`color: var(--muted)`) hogy
a többi panel is használhassa konzisztensen.

## Mit jelent ez per-bot

A `CategoryDashboard` per-kategória `EdgeTrackerPanel`-t render-el a
`defaultCategory` prop-pal, ami szűri a `?category=` query param-ot a
`edge-tracker` endpoint-on. Mind az 5 kategória ugyanazt a panelt látja:

| Bot | Mit nyer |
|-----|----------|
| **Crypto** (3 closed) | Streak +1W/2L, evGap mostantól látható. Kis N → minden new card szürke |
| **Weather** (2 closed) | Ugyanaz, kis N. EV-gap weather-en is binary (predictedProb használt) |
| **HL Perp** (4 closed) | evGap=0 (perp collapse). Underwater chart az 1h-pause utáni "3 loss row" vizuálisan mutat |
| **F-Arb** (0 closed) | Üres summary (zero-trade branch) |
| **Sports** (0 closed) | Üres summary |

## Validáció

Backend sanity-test (`npx tsx` + 80 mock trade):

```
summary: {
  sharpeCi: [0.18, 0.41],
  sortinoRatio: 1.62,
  profitFactor: 4.46,
  expectancy: 26.72,
  payoffRatio: 3.29,
  longestWin: 8, longestLoss: 4, currentStreak: -4,
  evGap: 1268.72,
  maxDD: 68.36, maxDDDuration: 4
}
determinism CI same: true
```

`npm run build` ✓ tisztán átment. Astro 5 client bundle:
`CategoryDashboard.BF5jr2uB.js 184.42 kB` (gzip 45.99 kB).

## Fájlok érintve

- `netlify/functions/edge-tracker/statistics.mts` — `SummaryStats` interface +
  `lcgFactory` + `bootstrapSharpeCi` + `streakStats` + `tradeEv` + bővített
  `computeSummary` + `CumulativePoint` új mezők + `computeCumulativePnl`
  underwater curve
- `src/components/EdgeTrackerPanel.tsx` — `SummaryStats` típus + két soros
  `SummaryCards` + `UnderwaterDrawdownChart` komponens + render-blokk
  integráció + extended-grid CSS
- `src/components/shared/dashboardStyles.ts` — új `ec-muted` osztály
- `CLAUDE.md` — AKTUÁLIS ÁLLAPOT 2026-05-14d + 38. session

## Mi nincs benne (későbbi tickets)

- **Tier-2 reliability diagram per-prediction-bin** Wilson-CI-vel — 200+ closed
  trade precondition (Legközelebbi prioritások #2)
- **PnL by edge-bucket** bar chart — szintén kis-N gated
- **Paper vs live parity split** a CumulativePnlChart-on — Live mód
  indulásakor lesz aktuális
- **Lag-1 ACF / Durbin-Watson** a Bonferroni SE-becsléshez — akadémiai
  nice-to-have
- **Calmar / Ulcer Index** — Sortino bekerült, ez a kettő nem kritikus

## Acceptance criteria

- [x] Backend új mezők TypeScript-tisztán fordul (`npm run build`)
- [x] Bootstrap CI determinisztikus (rerun → same lo/hi)
- [x] HL/perp esetén evGap = 0 (binary collapse)
- [x] `currentStreak` előjeles (+nyertes / −vesztes)
- [x] Underwater chart soha pozitív (`drawdown ≤ 0`)
- [x] Kis N (`<10`) esetén extended cards szürkék
- [x] Sharpe CI brackets-zero → "n.s." flag a sub-szövegben
- [x] Mind az 5 kategória ugyanazt a panel-bővülést kapja routingon át

---

## Follow-up: CryptoPriceTicker live spot reference

Same-day kiegészítés: a 3 crypto-érintett trader oldalra (Crypto / HL Perp / F-Arb)
kerül egy live spot price strip a RecommendationsCard fölé. A bot scan-eredmények
chip-jei (mp 60¢ / pred 58%) implicit feltételezik, hogy az operátor tudja, hol
áll most BTC — a widget ezt explicitté teszi.

### Backend — `netlify/functions/binance-price.mts`

- GET `/.netlify/functions/binance-price?symbols=BTCUSDT,ETHUSDT,SOLUSDT`
- **Bybit primary** (`/v5/market/tickers?category=spot`), **Binance fallback**
  (`/api/v3/ticker/24hr`) — ugyanaz a pattern mint `funding-rates.mts`-ben,
  mert a Binance Netlify-en geo-blokkolt lehet
- Returns: `{ symbol, price, change24h, changePct24h, high24h, low24h, volume24h }[]`
- **Cache**: 15s Netlify Blobs (`binance-price-cache-v1`). Frontend poll 30s-enként
  → minden második hit cache-ből, ~2 origin req/min/widget
- Cap at 10 symbol per kérés (anti-abuse), sort to requested order

### Frontend — `src/components/shared/CryptoPriceTicker.tsx`

UX best practices:
- **Visibility-pause**: `document.visibilityState === "hidden"` → poll stop;
  re-visible → azonnali refresh + restart. Background tab nem fogyaszt.
- **Staleness badge**: ha `Date.now() - fetchedAt > 2.5 × pollMs`, "stale" pill
  warn-színnel — soha ne olvasson az operátor frozen árat live-ként.
- **Flash colors**: ár-up → 800ms-ig zöld background fade, ár-down → piros.
  Subtle "live" feeling without busy animation.
- **Per-card title**: hover tooltip 24h volume + range — info-on-demand,
  nem zsúfolja a layoutot.
- **`auto-fill` grid** (NEM `auto-fit`): single-coin Crypto-n a card ~180px
  marad, nem nyúlik ki 848px-re. Multi-coin (3) responsive divide.

Mobile (≤640px):
- `display: grid` → `display: flex` váltás
- `overflow-x: auto` + `scroll-snap-type: x mandatory`
- `-webkit-overflow-scrolling: touch` (iOS momentum)
- Native scrollbar elrejtve a cleanebb look-ért
- Card flex-basis 158px → 3 coin fér ki egymás mellett 375px-en (első mindig
  fully visible, a többit horizontal scroll-snap)

### Per-bot integráció

| Bot | Symbols | Indok |
|-----|---------|-------|
| Crypto | `BTCUSDT` | A bot kizárólag BTC short-markets-et tradezi Polymarket-en |
| HL Perp | `BTCUSDT, ETHUSDT, SOLUSDT` | HL bot a 3 coin-on egyaránt nyit |
| F-Arb | `BTCUSDT, ETHUSDT, SOLUSDT` | Funding spread mind a 3-on lehet |

### Validáció

DOM-inspekció netlify-dev-en (Bybit feed live):
- **Desktop (1280×800) Crypto**: 1 BTC card, w=206px, text `BTC $79,692 ▼-1.62%`
- **Desktop HL**: 3 cards 206px (BTC + ETH + SOL), grid-template
  `"206px 206px 206px 206px"` (1 üres track auto-fill-ből — invisible)
- **Mobile (375×812) Crypto**: 1 BTC card 158×76px, no scroll
- **Mobile HL**: 3 cards 158px, `rowClientW=295 < rowScrollW=490` →
  horizontal scroll-snap működik, BTC fully in view (x=40), ETH fully in view
  (x=206), SOL part. visible (x=372) — scroll required → expected UX

### Fájlok érintve

- `netlify/functions/binance-price.mts` — új proxy
- `src/components/shared/CryptoPriceTicker.tsx` — új komponens
- `src/components/trader/CryptoTrader.tsx` — import + `<CryptoPriceTicker symbols={["BTCUSDT"]} />`
- `src/components/trader/HyperliquidTrader.tsx` — import + 3-symbol ticker
- `src/components/trader/FundingArbPanel.tsx` — import + 3-symbol ticker
- `.claude/launch.json` — netlify-dev preview config (mobil-test reproduceálhatóságához)
