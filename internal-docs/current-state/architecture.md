# EdgeCalc — Architecture (jelenállapot)

> **Dátum:** 2026-04-24
> **Verzió:** v8 frontend + v0.6.0 auto-trader (4 sprint: Resolution Risk → Hyperliquid → Funding Arb → Weather Patch)
> **Cél:** jelenállapot snapshot Claude Code folytatáshoz — mi működik, hol, milyen matematikával, mivel hívható.

Ez a dokumentum **nem roadmap és nem tutorial**, hanem "state of the codebase" egy session kezdetéhez. Ha új fejlesztést indítasz, először ezt olvasd, majd a tématípushoz tartozó részletes docot (`06-*.md` … `12-*.md`).

---

## 1. Projekt nagy kép

Az app **két teljesen különálló rétegre** bomlik:

```
┌─ SIGNAL + TOOLS RÉTEG ────────────────────────────────┐
│  Polymarket-specifikus szignál generálás, diagnosztika │
│  8 Netlify Function, 11 "Tools" tab (/tools)          │
│  → nem köt kereskedést, csak számol                   │
└────────────────────────────────────────────────────────┘
                          │  (HTTP, signal-combiner)
                          ▼
┌─ AUTO-TRADER RÉTEG ───────────────────────────────────┐
│  3 független végrehajtó motor, cron-vezérelt:         │
│    • Crypto (Polymarket BTC up/down binary)            │
│    • Weather (Polymarket temperature buckets)          │
│    • Hyperliquid (perp directional + funding-rate arb) │
│  Mindegyik: saját Blobs session, saját döntési gate   │
│  /trade/<category> útvonalon UI, cron: */3 perc        │
└────────────────────────────────────────────────────────┘
```

**Fontos:** a "signal" réteg független marad (`signal-combiner` a hub), az execution réteg ezt fogyasztja. Ha új execution-strategy jön, a signalt **ne írd újra**, csak hívd.

---

## 2. Stack és mappaszerkezet

```
Astro 5 + React 18 + TypeScript + Tailwind (utility-k nélkül, CSS var system)
Netlify Functions (.mts, esbuild)   — 16 function + 1 scheduled-scan
Netlify Blobs                       — session + cache tároló
Polymarket @polymarket/clob-client  — CLOB order placement
@nktkas/hyperliquid (lazy)          — HL perp order (live mode only)
viem                                — wallet signing (Polygon + HL)
ccxt (szkriptekben)                 — Bybit/Binance spot
```

```
src/
├── pages/
│   ├── index.astro           → HomePage (kategória kártyák)
│   ├── tools.astro           → ToolsDashboard (/tools)
│   └── trade/[category].astro→ CategoryDashboard (/trade/crypto|weather|hyperliquid)
├── components/
│   ├── HomePage.tsx          → 6 kártyás kategória picker
│   ├── Dashboard.tsx         → legacy /tools UI (11 tab — Scanner..ArbMatrix + auto-trader stub)
│   ├── CategoryDashboard.tsx → per-kategória dashboard shell
│   ├── shared/               → DashboardShell.tsx, dashboardStyles.ts
│   ├── trader/               → CryptoTrader, WeatherTrader, HyperliquidTrader, FundingArbPanel, CategorySelector
│   ├── EdgeTrackerPanel.tsx  → post-trade statisztika (6 KPI + 6 chart)
│   └── [8 panel].tsx         → OrderFlow, VolDiv, Apex, CondProb, SignalCombiner, ArbMatrix, Trading
└── styles/global.css         → CSS var rendszer (ne használj Tailwind utility-t!)

netlify/functions/
├── polymarket-proxy.mts      → Gamma API → frontend (CORS megkerülés, 1h cache)
├── signal-combiner.mts       → 8 szignál kombinátor + resolution-risk hub (3 perc cache)
├── vol-divergence.mts        → Yang-Zhang RV vs binary IV (2 perc)
├── orderflow-analysis.mts    → Kyle λ + VPIN + Hawkes (5 perc)
├── apex-wallets.mts          → top wallet Sharpe + consensus (5-10 perc)
├── cond-prob-matrix.mts      → complement + monotonicity violations (5 perc)
├── vwap-arb.mts              → per-block VWAP arbitrage scan (90 mp)
├── funding-rates.mts         → Bybit/Binance FR tickers (8h)
├── llm-dependency.mts        → Claude API market dependency (30 perc)
├── resolution-risk.mts       → settlement risk scorer (30 perc)
├── _resolution-risk.ts       → shared library (heurisztika + Claude fallback)
├── _auth-guard.ts            → JWT helper
├── auth.mts                  → SHA-256 + JOSE JWT login
├── user-settings.mts         → Blobs user prefs
├── polymarket-trade.mts      → CLOB order proxy (manual trade tab)
├── bybit-trade.mts           → Bybit order via ccxt
├── binance-trade.mts         → Binance order via ccxt
├── trade-logger.mts          → Supabase (ha van SUPABASE_URL) / Blobs fallback + IC calibration
├── scheduled-scan.mts        → óránkénti piac scan cache warmup
├── edge-tracker.mts          → closed trade aggregátor + statisztika
├── edge-tracker/             → mock-trades.mts, statistics.mts
├── auto-trader.mts           → cron entry (*/3 perc), category dispatcher
├── auto-trader-api.mts       → ugyanaz, non-scheduled (UI hívja)
└── auto-trader/
    ├── shared/               → config, logger, telegram, types (közös)
    ├── crypto/               → BTC up/down Polymarket engine
    ├── weather/              → Polymarket temperature bucket engine
    └── hyperliquid/          → perp + arb engine
        └── funding-arb/      → második réteg: delta-neutral carry
```

---

## 3. Tools réteg — 11 tab a `/tools` útvonalon

Diagnosztikai/explorációs dashboard. Ezek **nem** trade-elnek, csak számolnak és vizualizálnak. A `Dashboard.tsx` egy manuálisan karbantartott tab array-jel router.

| Tab | Komponens | Mit csinál |
|---|---|---|
| 01 Scanner | inline | Polymarket piac lista + EV kalkulátor + JSON import |
| 02 EV Kalk | inline | Interaktív EV/Kelly kalkulátor csúszkákkal |
| 03 Funding Arb | TradingPanel (demo mode) | Delta-neutral carry kalkulátor |
| 04 Swarm | inline | 32 ágensből álló swarm intelligence szimuláció + 2000 Monte Carlo |
| 05 Trading | TradingPanel | Bybit/Binance/Polymarket manual trade panel (JWT auth mögött) |
| 06 Order Flow | OrderFlowPanel | Kyle λ, VPIN, Hawkes vizualizáció |
| 07 Vol Harvest | VolDivergencePanel | IV-RV spread, locked profit |
| 08 Apex Wallets | ApexWalletsPanel | Leaderboard + profile + consensus |
| 09 Cond. Prob | CondProbPanel | Complement + monotonicity violations |
| 10 Signals | SignalCombinerPanel | Combined probability + IR + ajánlás |
| 11 Arb Matrix | ArbMatrixPanel | VWAP arb + Claude LLM dependency |
| 12 Auto-Trader | TraderStatus (category router) | Ugyanaz, mint `/` főoldal — relikvia |

**Design system:** minden komponens saját `<style>` blokkban definiálja az osztályait 2-3 karakteres prefix-szel (`of-`, `vd-`, `aw-`, `cp-`, `sc-`, `am-`, `et-`). Globális változók: `--bg`, `--surface`, `--surface2`, `--border`, `--text`, `--muted`, `--accent` (#c8f135 zöld), `--danger` (#f13535 piros), `--accent2` (#35c8f1 kék), `--warn` (#f1a035 narancs), `--mono` (JetBrains Mono), `--sans` (Inter). **Soha ne írj inline Tailwind utility-t.**

---

## 4. Signal layer — `signal-combiner.mts`

Ez a hub. 8 szignál párhuzamosan + 1 resolution-risk task. Output: `combined_probability`, `kelly.quarter`, `fundamental_law.ir`, `recommendation`.

### IC-k (Information Coefficient priorok)

```ts
const SIGNAL_ICS = {
  vol_divergence: 0.06,
  orderflow:      0.09,  // legmagasabb — mikrostruktúra erős
  apex_consensus: 0.08,
  cond_prob:      0.07,
  funding_rate:   0.05,  // globális, gyengébb
  momentum:       0.06,  // Kakushadze 3.1
  contrarian:     0.05,  // Kakushadze 10.3 (mean reversion vs index)
  pairs_spread:   0.07,  // Kakushadze 3.8 (pairs z-score)
};
```

**Ezek priorok, nem mért értékek.** 50+ lezárt trade után a `trade-logger.mts calibrate` action-je újraszámolja őket.

### Szignál-receptek (mind `signal-combiner.mts`-ben vannak megvalósítva)

1. **vol_divergence** — Binance futures 15 perces klines → log-return alapú RV annualizálva. IV visszaszámítás binary árból: `σ_impl ≈ 2·|p-0.5|/√T`. Spread = iv - rv, prob = clamp(0.5 - spread·0.4, 0.1, 0.9).
2. **orderflow** — CLOB `/book` token_id-ra. `bidPct = bidVol / (bid+ask)`. prob = clamp(0.3 + bidPct·0.4, 0.1, 0.9). Üres book esetén midpoint fallback.
3. **apex_consensus** — Data API `/trades?limit=500`, wallet aggregáció (PnL = ΣSELL·size·price - ΣBUY·size·price), top 10 wallet, szűrés az adott `conditionId`-re, `buyPct = buys/(buys+sells)`. Ha 0 trade → globális fallback.
4. **cond_prob** — `dev = |YES + NO - 1.0|` (complement gap) + related markets keyword-matchingje és monotonicity check (korábbi deadline ≤ későbbi). `totalViolation = |dev| + monotonViolation`, prob ebből.
5. **funding_rate** — Bybit primary, Binance futures fallback, CryptoCompare spot/futures premium proxy. prob = clamp(0.5 + rate·50, 0.1, 0.9). **Globális, BTC-specifikus** — minden piacra ugyanaz.
6. **momentum** — `Rcum = (p_now - p_past) / p_past`. Gamma `/markets/<slug>` adja az "past" referenciát (nem igazi idősor, inkább distance-proxy 0.5-től).
7. **contrarian** — top 15 piac átlag YES ára (`rm`), `dev = thisYes - rm`, prob = 0.5 - dev·0.3.
8. **pairs_spread** — keyword 2+ egyezésű piacok spreadje vs deadline-adjusted várt spread.

### Kombináció (Grinold-Kahn IR = IC × √N)

```ts
// signal-combiner.mts / combine()
mean = Σsignal / n
demeaned[k] = signal[k] - mean
w[k] = IC[k] · (1 + |demeaned[k]|·0.5)          // egyetértő signalokat súlyozza
combined = Σ (w[k] / Σw) · signal[k]
avg_ic = Σ IC[k] / n
eff_N = max(1, n · 0.6)                         // korrelált signalok → 60%
ir = avg_ic · √eff_N
b = 1/p - 1
kelly_full = (p·b - (1-p)) / b
cv_edge = max(0, 1 - ir·0.8)                    // CV proxy — NEM Monte Carlo!
kelly_q = kelly_full · (1 - cv_edge) · 0.25
```

**Fontos:** `cv_edge` jelenleg IR-ből becsült proxy, nem valódi Monte Carlo. Backtest után cserélni kell (roadmap).

### Recommendation

```
|edge| < 0.05 || ir < 0.1  → WAIT (LOW)
kelly_q < 0.005            → WATCH (LOW)
ir > 0.3                   → HIGH confidence
ir > 0.2                   → MEDIUM
else                       → LOW
action = "BUY YES" | "BUY NO" a combined - 0.5 előjele alapján
```

---

## 5. Resolution Risk Scorer — `_resolution-risk.ts`

Az `E[X]_adj = P(YES) - price - resolution_risk - execution_drag` formula 3. tagja.

- **Heurisztika-first:** BTC up/down → LOW (×0.97), weather METAR → MEDIUM (×0.85), vékony-szabályú politikai → HIGH (×0.70), SKIP kategória → ×0.
- **Claude API fallback**, ha a heurisztika inkonkluzív (30 perc Blobs cache, `resolution-risk-v1` store).
- 5 faktor súlyozva: source_clarity 25%, deadline_precision 20%, wording_ambiguity 25%, historical_disputes 15%, source_availability 15%.
- **Additív** a signal-combinerhez: ha `risk.category === "SKIP"` → `rec.action` downgrade SKIP-re, eredeti `original_action`-ben eltárolva.

---

## 6. Auto-Trader — 3 motor, közös shell

### 6.1 Közös rétegek (`auto-trader/shared/`)

- **`config.mts`** — env-driven `getTraderConfig()`, `getPolymarketConfig()`, `getTelegramConfig()`. `CORS`, `GAMMA_API`, `CLOB_API`, `DATA_API`, `FN` (belső függvény bázis URL).
- **`logger.mts`** — NDJSON event logger, in-memory `logBuffer` a status endpoint-hoz.
- **`telegram.mts`** — `alertTradeOpen`, `alertTradeClosed`, `alertSessionStop`, `alertError`. Bot token + chat ID env-ből.
- **`types.mts`** — `MarketInfo`, `AggregatedSignal`, `TradeDecision`, `OrderRecord`, `Position`, `SessionState`, `ClosedTrade` (Edge Tracker mezőkkel), `LogEvent`, `TraderConfig`, `PolymarketConfig`.

### 6.2 Dispatcher (`auto-trader/index.mts`)

```
POST /auto-trader { action, category?, layer? }
GET  /auto-trader?action=&category=&layer=
```

- `action`: `run` | `status` | `reset` | `stop` | `resume` (utóbbi csak HL/arb)
- `category`: `crypto` (default) | `weather` | `hyperliquid`
- `layer` (csak hyperliquid): `directional` | `arb`
- Cron: `*/3 * * * *` UTC → `runCryptoTrader` fut default-ban.
- **UI külön endpointot hív (`auto-trader-api.mts`)**, mert a scheduled function Netlify CLI-n nem tud direkt választ adni.

### 6.3 Crypto motor (`auto-trader/crypto/`)

```
findBtcMarkets → aggregateSignals → makeDecision → placeBuyOrder
  → handleBuyLifecycle → (paper: simulatePaperExit + handleSellLifecycle)
  → saveSession + Telegram
```

- **`btc-market-finder.mts`** — Gamma `/events?tag=crypto&order=volume24hr`, "btc|bitcoin" + "up|down|above|below" keyword szűrő. Skip `closed===true` vagy lejárt `endDate`. Token ID: `tokens[].token_id` vagy `clobTokenIds`. Liquidity filter: `minOpenInterest` ($500).
- **`signal-aggregator.mts`** — elsődleges: `/signal-combiner?slug=`. Fallback: 5 szignál parallel, IC-súlyozott átlag, quarter-Kelly saját számítás.
- **`decision-engine.mts`** — 7 gate (sorrendben):
  1. Session loss limit (`sessionLoss >= sessionLossLimit` → $20 default)
  2. `activeSignals < 2`
  3. Slug cooldown (300s, in-memory Map)
  4. `openInterest < minOpenInterest`
  5. `netEdge = grossEdge - roundtripFeePct` (3.6%), threshold 15%
  6. `kellyCapped = min(kellyFraction, 0.20)`, min pozíció $1
  7. Entry price: `direction==="YES" ? min(marketPrice+0.01, 0.99) : max(1-marketPrice+0.01, 0.01)`
- **`execution.mts`** — Viem walletClient → ClobClient derive API key → `createAndPostOrder` GTC, `{tickSize:"0.01", negRisk:false}`. Paper mode: instant fill szimuláció.
- **`order-lifecycle.mts`** — buy: poll fill, live; sell: GTC limit → timeout után FOK emergency sell (flat exit).
- **`session-manager.mts`** — Blobs `auto-trader-state / auto-trader-session[-live][-<category>]`. Paper/live split key. Paper close simuláció: `marketPrice + (finalProb - marketPrice) · 0.5`.

### 6.4 Weather motor (`auto-trader/weather/`)

Settlement airport METAR alapú bucket matching.

- **`station-config.mts`** — 10 város, `{icao, lat, lon, tz, city_offset, peakHoursUTC}`. **Fontos javítások 2026-04-21:** NYC = KLGA (nem KNYC/KJFK), London = EGLC (nem EGLL), Dallas = KDAL (nem KDFW), Tokyo = RJTT (nem RJAA). Regression test: `station-config.test.mts` (8/8 passed, `npx tsx`-szel fut).
- **`market-finder.mts`** — Gamma temperature markets, bucket outcome-ok parsing.
- **`forecast-engine.mts`** — 3 modell párhuzamosan: GFS (Open-Meteo `gfs_seamless`), ECMWF (`ecmwf_ifs025`), NOAA (csak US, `api.weather.gov/points/.../forecastHourly`). Cloud-boost: felhős (>60%) esetén ECMWF×1.3, GFS×0.8. Confidence = `1 - spread/5`, cap `[0.3, 0.95]`.
- **`ensemble-forecast.mts`** (opt-in `USE_ENSEMBLE=true`) — Open-Meteo 31 tagú ensemble. ≥5 member esetén mean + stddev → `confidence = 1 - sd/4`.
- **`deb.mts`** — Dynamic Error Balancing. Per-city 30 trade rolling MAE (Blobs: `weather-deb-v1`). <10 sample → fix default weights. 60/40 blend prior-ral.
- **`metar-simulator.mts`** — station_offset korrekció + METAR Fahrenheit kerekítés szimuláció.
- **`model-lag-detector.mts`** — GFS 6h ciklus (00/06/12/18 UTC). `nearBoundary` → skip (új adat várása).
- **`bucket-matcher.mts`** — normal distribution P(temp ∈ bucket), `sigma = cloud>60 ? 1.5 : 1.0`.
- **`decision-engine.mts`** — 4 gate:
  1. `forecast.confidence < confidenceMin` (0.65)
  2. `timeToResolutionMin < exitBeforeMin` (45 min)
  3. `modelLag.nearBoundary`
  4. `netEdge = |match.edge| - 0.01` < threshold (0.12)
  - Position: `min(bankroll · edge · conf · 0.25, min(0.15·bankroll, maxPositionUSD=25))`

### 6.5 Hyperliquid motor (`auto-trader/hyperliquid/`)

Perpetual futures directional — 3x leverage hard cap, 15% bankroll cap.

- **`config.mts`** — `ASSET_INDEX` (BTC=0, ETH=1, SOL=2, XRP=3, DOGE=5, AVAX=6), testnet/mainnet URL.
- **`signal-source.mts`** — signal-combiner-t hívja **érme-specifikus slug-gal** (de jelenleg BTC-re fókuszál a signal-combiner, szóval XRP/DOGE prob ≈ 0.5 lesz gyakran).
- **`hl-client.mts`** — REST `allMids`, `clearinghouseState`. Live mode: `@nktkas/hyperliquid` lazy load.
- **`volatility-gate.mts`** — 12×1h RV Binance futures (→ spot → CryptoCompare fallback). Live mode-ban blokkol ha RV > `volGateRvPct` (120%).
- **`kelly-sizer.mts`** — quarter-Kelly × min(leverage, 3) × min(maxPctBankroll, 15%). USD notional → coin size.
- **`decision-engine.mts`** — ordered gates (az első hiba állítja le):
  1. session stopped/paused/lossLimit/maxOpen/consecutiveLosses
  2. per-coin cooldown (300s) + "nincs duplikált coin pozíció"
  3. `activeSignals < 3`
  4. `resolutionCategory === "SKIP"`
  5. `netEdge = edge - roundtripFeePct (0.07%)` < threshold (paper 12%, live 18%)
- **`order-manager.mts`** — `placeHlEntry` + TP/SL auto-placement (2:1 RR: TP = entry·(1+edge·2), SL = entry·(1±edge·1)).
- **`session-manager.mts`** — Blobs `hyperliquid-session-v1` (paper/live split). Consecutive loss pause (3 loss → 1h pause).

### 6.6 Funding Arb — Hyperliquid második rétege (`auto-trader/hyperliquid/funding-arb/`)

**Delta-neutral carry:** SHORT HL perp + LONG Binance spot. Net directional = 0, jövedelem = `hlFundingRate - binanceFundingRate` óránként.

- **`fr-scanner.mts`** — HL `metaAndAssetCtxs` + Binance `premiumIndex`, óránkénti rátára normalizálva.
- **`arb-detector.mts`** — fee-aware viability: `netSpread = hlFr - binanceFr - feeHl/hours - feeBinance/hours`. Break-even nap check + ranking.
- **`hedge-manager.mts`** — Binance spot adapter: paper sim + live HMAC-SHA256 REST (csak SPOT permission).
- **`fr-executor.mts`** — atomic két-lábú open/close. **Auto-unwind partial failure esetén** — soha nem hagy naked directional exposure-t.
- **`fr-session.mts`** — külön Blobs `hyperliquid-arb-session-v1`, funding accrual matek minden run-on.
- **Close conditions:** spread < `FR_MIN_SPREAD_TO_CLOSE` (0.005%), spread negatívba fordul, `FR_MAX_HOLD_DAYS` (14) elérése.

UI: `/trade/hyperliquid` → "Funding Arb" tab (`FundingArbPanel.tsx`).

---

## 7. Edge Tracker — post-trade statisztika

- **Backend:** `edge-tracker.mts` + `edge-tracker/statistics.mts` + `edge-tracker/mock-trades.mts`.
- **Adatforrás:** `auto-trader-state` Blobs store → `session.closedTrades[]`. Filter: `mode=paper|live|both`, `category=all|crypto|weather`, `days=7|30|90|all`, `mock=1`.
- **Statisztikák:** Summary (win rate, avg PnL), Cumulative PnL, Calibration (predicted prob vs realized), Signal IC (ha van `signalBreakdown`), Edge Decay (edge→pnl bucketed), Win Rate Heatmap (nap×óra), PnL Distribution.
- **UI:** `EdgeTrackerPanel.tsx` — 6 KPI kártya + 6 SVG/CSS chart. Category-specifikus default a `CategoryDashboard.tsx`-ben.

---

## 8. Perzisztencia — Netlify Blobs store-ok

| Store | Key(s) | Tartalom | TTL |
|---|---|---|---|
| `polymarket-cache-v3` | `markets_cache` | Piac lista (polymarket-proxy) | 1h |
| `funding-cache-v3` | `funding_cache` | FR tickers | 8h |
| `signal-combiner-v3` | `combined:<slug>` | 8-signal output | 3 perc |
| `resolution-risk-v1` | `risk:<slug>` | Risk score + faktor | 30 perc |
| `auto-trader-state` | `auto-trader-session[-live][-<cat>]` | SessionState (crypto/weather) | ∞ |
| `hyperliquid-session-v1` | paper/live split | HlSessionState | ∞ |
| `hyperliquid-arb-session-v1` | paper/live split | ArbSessionState | ∞ |
| `weather-deb-v1` | `<city>` | 30-trade MAE window | ∞ |
| `trade-log-v1` | `trades` | Fallback, ha nincs Supabase | ∞ |
| `vol-divergence-v3`, `orderflow-v3`, `cond-prob-v3`, `apex-*-v3`, `vwap-arb-v3`, `llm-dep-v3` | signal cache-ek | egyes szignálok | 2-30 perc |

---

## 9. Útvonalak (routing)

```
/                → HomePage (6 kártya: Crypto, Hyperliquid, Sports[soon], Politics[soon], Weather, Macro[soon])
/tools           → ToolsDashboard → Dashboard.tsx (11 tab, diagnosztika)
/trade/crypto    → CategoryDashboard → CryptoTrader + EdgeTrackerPanel
/trade/weather   → CategoryDashboard → WeatherTrader + EdgeTrackerPanel
/trade/hyperliquid → CategoryDashboard → HyperliquidTrader + FundingArbPanel
```

A `CategoryDashboard.tsx` `getStaticPaths` jelenleg csak ezt a 3-at buildeli. Új kategória = egy új branch + új TraderPanel + `HomePage.tsx` `enabled: true`.

---

## 10. Auth

- SHA-256 password hash + JOSE JWT (HS256), HttpOnly Secure cookie, 8h session.
- `_auth-guard.ts` helper minden védett function-ben (pl. `polymarket-trade`, `bybit-trade`).
- Hash generálás: `node -e "console.log(require('crypto').createHash('sha256').update('jelszo').digest('hex'))"`
- A **scheduled auto-trader endpoint nem auth-olt** — env var-okkal titkolva (`POLY_PRIVATE_KEY` stb.), lokális fejlesztéshez `netlify dev` + `.env`.

---

## 11. Environment variables (teljes lista)

```env
# ── Auth ────────────────────────────────────────
JWT_SECRET=                   # 32+ random
AUTH_PASSWORD_HASH=           # sha256 hex

# ── External APIs ───────────────────────────────
ANTHROPIC_API_KEY=            # llm-dependency + resolution-risk fallback
SUPABASE_URL=                 # opcionális (trade-logger)
SUPABASE_ANON_KEY=

# ── Polymarket (Crypto + Weather auto-trader) ──
POLY_PRIVATE_KEY=0x...
POLY_FUNDER_ADDRESS=0x...
POLY_SIGNATURE_TYPE=1

# ── Bybit / Binance (manual trade + arb hedge) ─
BYBIT_API_KEY=
BYBIT_API_SECRET=
BYBIT_TESTNET=true
BINANCE_API_KEY=              # SPOT permission only!
BINANCE_API_SECRET=
BINANCE_TESTNET=true

# ── Auto-trader (crypto) ────────────────────────
PAPER_MODE=true               # MUST be "false" for live
SESSION_LOSS_LIMIT=20
MAX_KELLY_FRACTION=0.20
EDGE_THRESHOLD_CRYPTO=0.15
COOLDOWN_SECONDS=300

# ── Weather ─────────────────────────────────────
WEATHER_EDGE_THRESHOLD=0.12
WEATHER_CONFIDENCE_MIN=0.65
WEATHER_EXIT_BEFORE_MIN=45
WEATHER_MAX_POSITION_USD=25
USE_ENSEMBLE=false            # opt-in: 31-member GFS ensemble

# ── Hyperliquid (directional) ───────────────────
HL_PAPER_MODE=true
HL_PRIVATE_KEY=0x...
HL_WALLET_ADDRESS=0x...
HL_MAX_LEVERAGE=3
HL_MAX_PCT_BANKROLL=0.15
HL_SESSION_LOSS_LIMIT=50
HL_MAX_OPEN_POSITIONS=3
HL_EDGE_THRESHOLD_PAPER=0.12
HL_EDGE_THRESHOLD_LIVE=0.18
HL_COOLDOWN_SECONDS=300
HL_CONSEC_LOSS_LIMIT=3
HL_CONSEC_LOSS_PAUSE_HOURS=1
HL_VOL_GATE_RV_PCT=120
HL_ROUNDTRIP_FEE_PCT=0.0007

# ── Hyperliquid Funding Arb ─────────────────────
FR_MIN_SPREAD_HOURLY=0.0001
FR_MIN_OPEN_INTEREST=5000000
FR_MAX_ARB_POSITIONS=3
FR_MAX_CAPITAL_PCT=0.40
FR_MIN_POSITION_USDC=50
FR_MAX_HOLD_DAYS=14
FR_MIN_SPREAD_TO_CLOSE=0.00005
FR_FEE_ROUNDTRIP_HL=0.0009
FR_FEE_ROUNDTRIP_BINANCE=0.002

# ── Telegram ───────────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

---

## 12. Cron ütemezés (`netlify.toml`)

```toml
[functions."scheduled-scan"]   schedule = "0 * * * *"     # óránként
[functions."auto-trader"]      schedule = "*/3 * * * *"   # 3 percenként
```

A `scheduled-scan` a Gamma/CLOB cache-t melegen tartja. Az `auto-trader` default hívása `category=crypto, action=run`. A weather/hyperliquid/arb layer-ek **nem futnak automatikusan** — vagy külön cron-t kell nekik konfigurálni, vagy UI-ról fut kézzel. (Roadmap: per-layer cron.)

---

## 13. Matematikai appendix (gyors referencia)

```
Kyle's λ           Δp = λ·Q + ε            OLS regresszió signed volume-ra
VPIN               Σ|Vᴮ - Vˢ| / ΣV         bucket-olt, > 0.7 → toxic
Hawkes             λ*(t) = μ + Σα·exp(-β(t-tᵢ))   trade clustering
Grinold-Kahn       IR = IC · √N            active management fund. law
Kelly (full)       f* = (pb - q) / b       b = 1/price - 1
Kelly (quarter)    f_q = f* · 0.25         intézményi default
Yang-Zhang RV      σ² = σ_O² + k·σ_C² + (1-k)·σ_RS²   (egyszerűsítve close-to-close használva)
Implied Vol        σ ≈ 2·|p-0.5| / √T      binary option naiv közelítés
Payout Ratio       W̄ / L̄                  break-even WR = 1/(1+PR)
Complement gap     |P(YES) + P(NO) - 1|   monotonicity: korábbi deadline ≤ későbbi
Bregman            μ* = argmin D_KL(μ||θ)  marginal polytope projekció
E[X]_adjusted      P(YES) - price - resolution_risk - execution_drag
```

---

## 14. Jelen állapot — mi működik, mi nem

### ✓ Működő (éles)
- Signal-combiner 8 szignállal (BTC-ra optimalizálva)
- Resolution Risk heurisztika + Claude fallback
- Crypto auto-trader paper mode (signal → decision → execution → session)
- Weather auto-trader paper mode (GFS+ECMWF+NOAA ensemble, DEB, METAR kerekítés)
- Hyperliquid directional paper mode (3 coin scan: BTC/ETH/SOL)
- Hyperliquid funding arb paper mode (5 coin scan)
- Edge Tracker (closed trade aggregate + 6 chart)
- Tools dashboard 11 tab
- Telegram alerts
- Cron: `scheduled-scan` (óránként), `auto-trader` (3 percenként default crypto)

### ◐ Részben kész / kalibrálatlan
- **IC-k priorok**, nem mért értékek — 50+ trade után trade-logger `calibrate` akcióval frissíteni
- **cv_edge IR-ből becsült proxy** — valódi Monte Carlo kellene
- **Signal-combiner BTC-fókuszú** — crypto.slug-tól függetlenül a funding_rate és vol_divergence signalok BTCUSDT-re néznek. ETH/SOL/más piacokra félrevezető lehet.
- **Hyperliquid non-BTC coinokra** a signal-combiner prob ≈ 0.5 — érmenkénti signal-combiner slug kellene
- **Weather live-mode METAR reconciliation** nincs (TODO a `weather/index.mts`-ben — syntetikus actual megy DEB-be paper módban)
- **Trade logging Supabase integráció** csak ha `SUPABASE_URL` env megvan, különben Blobs fallback
- **Frank-Wolfe / Gurobi solver** a cond-prob polytope projekcióhoz **nincs implementálva** (IP solver licenc)
- **Real-time WebSocket VWAP** nincs — 90s cache REST
- **Csak crypto auto-trader fut cron-ban**, weather/HL/arb manuális UI-trigger

### ✗ Ismert bug (CLAUDE.md-ből)
- **apex-wallets consensus piac-nevek HIBÁSAK.** A `/trades` response tartalmazza a `title` és `slug` mezőt, de a jelenlegi kód külön Gamma lookup-ot csinál `conditionId` alapján, ami rossz neveket ad. **Fix: az aggregálás során tárold el a `title`/`slug`-ot a trade-ből, és ne csinálj Gamma lookup-ot.**
- Signal Combiner gyakran WAIT-et ad, mert kevés aktív szignál konvergál — a javítás az apex fix után várható.

### TODO prioritások (roadmap.md alapján)
1. Paper mode 10+ trading cycle validáció errors nélkül
2. Telegram bot setup + alert teszt
3. Session loss limit trigger teszt
4. Netlify deploy + cron verify
5. Apex wallet címek fix (fenti bug)
6. Per-coin signal-combiner slug map HL-hez
7. Weather live mode METAR reconciliation job
8. Supabase trade history + IC calibration 50+ trade után
9. Sprint 2-3-4: Sports / Politics / Macro alert-mode motorok
10. WebSocket real-time VWAP scanner

---

## 15. Fejlesztési belépési pont

### Új signal hozzáadása
1. `signal-combiner.mts`-ben új async `getXSignal(market): { prob, detail }`
2. `SIGNAL_ICS`-be új IC prior
3. `Promise.all([...])` tömbbe + `raw_signals`-be
4. `signal-aggregator.mts` (auto-trader) `SignalBreakdown` típus bővítése
5. Tesztelés: `curl /.netlify/functions/signal-combiner?slug=<slug>`

### Új auto-trader kategória
1. `auto-trader/<new>/` mappa: `index.mts`, `decision-engine.mts`, `market-finder.mts`, (opcionálisan `signal-source.mts`, ha eltér)
2. `auto-trader/index.mts` dispatcher-ben új branch
3. `src/pages/trade/[category].astro` `getStaticPaths`-be hozzá
4. `src/components/CategoryDashboard.tsx` új render branch
5. `src/components/trader/<New>Trader.tsx` UI
6. `src/components/HomePage.tsx` `CATEGORIES` array `enabled: true`
7. Blobs store key: `auto-trader-session-<new>[-live]`
8. Új env var-ok dokumentálása ebben a fájlban

### Új Tools tab
1. `src/components/<Name>Panel.tsx` (saját CSS prefix)
2. `Dashboard.tsx` TABS array + import + render branch
3. `netlify/functions/<name>.mts` (ha szerver kell) — CORS + Blobs cache pattern
4. `internal-docs/NN-<name>.md` matematika és architektúra

### Build és deploy
```bash
netlify dev             # localhost:8888 — functions + frontend együtt
npm run build           # dist/
netlify deploy --prod --dir=dist
git push                # auto-deploy ~1-2 perc
```

A `npm run dev` **csak frontend**, functions 404-et adnak — `netlify dev` kell.

---

## 16. Hol találod a többi docot

| Téma | Fájl |
|---|---|
| EV + Kelly matematika | `../math/02-ev-kelly.md` |
| Kyle λ / VPIN / Hawkes | `../math/06-orderflow.md` |
| Vol harvest IV-RV | `../math/07-vol-harvest.md` |
| Apex wallets bot detector | `../math/08-apex-wallets.md` |
| Conditional probability polytope | `../math/09-cond-prob.md` |
| Signal combiner Grinold-Kahn | `../math/10-signal-combiner.md` |
| VWAP arb + LLM dependency | `../math/11-arb-matrix.md` |
| WebSocket architecture (TODO) | `../math/12-realtime-websocket.md` |
| Akadémiai irodalom | `../math/151-Trading-Strategies.pdf` (Kakushadze) |
| Hyperliquid engine részletek | `hyperliquid.md` |
| Weather patch részletek | `weather-patch.md` |
| Auto-trader sprint state | `roadmap.md` |
| Deploy workflow | `DEPLOY.md` |
| Auto-trader eredeti prompt | `edgecalc-autotrader-prompt.md` |
| HL adaptáció prompt | `edgecalc-hyperliquid-prompt.md` |
| Funding arb patch prompt | `edgecalc-funding-arb-patch.md` |
| Weather patch prompt | `edgecalc-weather-patch.md` |
| Resolution risk prompt | `edgecalc-resolution-risk-prompt.md` |
| Session-by-session changelog | `../changelog/CHANGELOG.md`, `../changelog/CHANGELOG-2026-04-21.md` |

---

**Ha új session-t indítasz:** olvasd a `CLAUDE.md` + ezt a fájlt + a konkrét feladathoz tartozó `NN-*.md`-t, majd nyisd meg a releváns `.mts`-t és `.tsx`-et. Ne írd újra a signal layer-t. Ne használj Tailwind utility-t. Ne törd az NDJSON log sémát.
