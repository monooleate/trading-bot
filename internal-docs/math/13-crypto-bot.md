# Crypto Auto-Trader – Implementation Reference

> **Scope:** ez a doksi a `category: "crypto"` bot **élő futási logikáját** írja le
> ahogy a `netlify/functions/auto-trader/` fán jelenleg implementálva van
> (simVersion 3, 2026-05-10 állapot). A signal-szintű matematika a
> `math/06-orderflow.md`–`math/11-arb-matrix.md` fájlokban él; ez a doksi
> azt szedi össze, **mit használ valójában a bot, milyen sorrendben, milyen
> paraméterekkel.**

---

## 1. Bot célja és stratégia

| Szempont | Érték |
|----------|-------|
| **Venue** | Polymarket CLOB (Polygon, Gamma + CLOB API) |
| **Underlying** | Rövid lejáratú binary BTC up/down piacok (5m / 15m / órás) |
| **Cron** | `*/3 * * * *` (`auto-trader` schedule a `netlify.toml`-ban) |
| **Side** | Long-only (BUY YES vagy BUY NO; nincs short / nincs sell-side entry) |
| **Stratégia** | EV-pozitív belépés a `signal-combiner` 8-jelzéses ¼-Kelly outputja alapján, sessionönkénti loss limit + ¼-Kelly + 8% bankroll-cap mellett |
| **Exit** | **Kizárólag Polymarket settlement** (UMA-resolved outcome 0 / 1). Nincs TP/SL early exit éles vagy paper módban — lásd §6 ismert limitációk |
| **Default bankroll** | $150 USDC (paper init); UI override-olható reset-tel |

A bot **nem** copy-trade és **nem** arbitrázs — saját predikció kontra mid-price, position sizing Grinold-Kahn IR és Kelly criterion alapján.

---

## 2. Futási pipeline

```
┌──────────────────────────────────────────────────────────────┐
│  CRON: */3 min — auto-trader schedule (netlify.toml)         │
└────────────────────────────┬─────────────────────────────────┘
                             │
                  runCryptoTrader(config, source)
                             │
       ┌─────────────────────┼─────────────────────────┐
       │                     │                         │
       ▼                     ▼                         ▼
loadSession()       resolvePending          computeLiveReadiness()
+ simVersion         PaperPositions()       + shouldForcePaper()
  archive gate                              + calibrationHealth alarm
       │                     │                         │
       └─────────────────────┴─────────────────────────┘
                             │
                  findBtcMarkets(minOI, minPriceBand)
                             │      ← Gamma /events?tag_id=21&active=true
                             ▼
                  for market of markets.slice(0, 3):
                    aggregateSignals(slug, obThresholds)
                             │      ← /signal-combiner (8 jelzés) + Binance OB
                             ▼
                    makeDecision(signal, market, ...)
                             │      ← 8 ordered gate (lásd §4)
                             ▼
                    placeBuyOrder(...) → handleBuyLifecycle()
                             │      ← clob-client GTC limit (live) /
                             ▼        instant fill (paper)
                    addOpenPosition(session, paperPosition)
                             │
                             ▼
                    saveSession() + Telegram alert
                             │
                             ▼
                  markRunFinish(payload)
```

---

## 3. Market-finder (`crypto/btc-market-finder.mts`)

### Forrás

```
GET https://gamma-api.polymarket.com/events
    ?tag_id=21              ← crypto vertical (env: POLYMARKET_CRYPTO_TAG_ID)
    &active=true
    &closed=false
    &limit=30
    &order=volume24hr&ascending=false
```

> ⚠ A `tag=crypto` (string) silently ignorálva van Gamma-n — NBA/NFL események jönnének vissza. **Csak `tag_id=21` (numeric) működik.**

### Filterek

| Szűrő | Forrás | Default | Magyarázat |
|-------|--------|---------|------------|
| Question keywords | `m.question` | `["btc"\|"bitcoin"]` ∩ `["up"\|"down"\|"above"\|"below"]` | BTC up/down formátum-felismerés |
| Closed | `m.closed === true` | skip | Lezárult market |
| Expired | `m.endDate < now` | skip | Múltbéli endDate |
| `MIN_PRICE_BAND` | `process.env.BTC_MIN_PRICE_BAND` | **0.10** | Deep-OTM ($yes < 0.10$) és deep-ITM ($yes > 0.90$) skip — itt 1-2 share market-maker quote dominál, paper-fill nem realisztikus |
| `minOpenInterest` | `m.liquidityNum` | **$500** | Vékony piacon nem trade-elünk |

A találatok `volume24h` szerint csökkenő sorrendbe rendezve, a top **3** lesz scan-elve egy cron tickben.

### `openedAtEstimate`

A market-finder a question-ből parseol time hint-et (`(\d+)\s*(second|minute|hour)`) és kiszámolja az `openedAtEstimate = endDate - durationMs`-t. Ezt használja a `decision-engine` az **entry window** gate-hez (§4). **Daily / órás piacokon** (ha a question pl. csak "Will BTC be above 100k by EOD?") a duration parser null-t ad → entry-window gate idle.

---

## 4. Decision engine (`crypto/decision-engine.mts`)

A `makeDecision()` egy **rendezett gate-listát** épít. Minden gate egy
`DecisionGate { label, passed, actual, required, hint }` objektumot kap;
az első bukó gate után rögtön visszatér a `noResult(reason)`-nel, de a
`gates[]` lista tartalmazza az addig kiértékelteket — ezt a UI rendereli
a "Why?" panel-en.

### A 8 gate

| # | Gate | Match rule | Default | Where to tune |
|---|------|------------|---------|---------------|
| 1 | **Session loss limit** | `sessionLoss < cfg.sessionLossLimit` | $20 | `SESSION_LOSS_LIMIT` env / Settings `sessionLossLimit` |
| 2 | **Aktív signal források** | `signal.activeSignals ≥ 2` | 2 (hard-coded) | – (kódban) |
| 3 | **Market cooldown** | `now - lastTrade(slug) ≥ cooldownSeconds * 1000` | 300s | `COOLDOWN_SECONDS` / Settings `cooldownSeconds` |
| 4 | **Open interest** | `market.openInterest ≥ cfg.minOpenInterest` | $500 | `minOpenInterest` (kódban — nincs Settings knob) |
| 4b | **Entry window** ⚠ | csak ha `market.openedAtEstimate != null`. `ageMs ∈ [start, end]` | [60s, 180s] | `BTC_ENTRY_WINDOW_*` env / Settings `btcEntryWindow*Ms` |
| 5b | **OB imbalance konvergencia** | `signal.obImbalance.direction != decision.direction.opposite` | UP ≥ 1.80, DOWN ≤ 0.55 | `obImbalanceUpRatio` / `obImbalanceDownRatio` |
| 6 | **Net edge ≥ küszöb** | `\|finalProb − marketPrice\| − roundtripFeePct ≥ edgeThreshold` | 15% (3.6% fee után) | `EDGE_THRESHOLD_CRYPTO` / Settings `edgeThreshold` |
| 7 | **Kelly conviction** ⚠ | `signal.kellyFraction > 0` | hard-coded | – (a `signal-combiner` `kelly.quarter` outputja) |
| 8 | **Kelly cap** (informational) | `min(kellyFraction, maxKellyFraction)` | 8% bankroll | `MAX_KELLY_FRACTION` / Settings `maxKellyFraction` |

⚠ A **#4b entry window** csak rövid (5m/15m) BTC piacokon aktív. Daily piacokon idle, mert az `openedAtEstimate` null.

⚠ A **#7 Kelly conviction gate** 2026-05-10-ben került be (lásd
`changelog/CHANGELOG-2026-05-10.md`). Korábban a `Math.max(1, bankroll * 0)`
$1-os floor miatt akkor is nyílt $1-os pozíció, ha a `kelly.quarter = 0` (és
ezzel a combiner `recommendation = WAIT` volt) — ez 3 fantom paper trade-et
generált, mielőtt a hard-skip bekerült.

### Math: edge

$$
\text{grossEdge} = |p_{\text{final}} - p_{\text{market}}|
\quad,\quad
\text{netEdge} = \text{grossEdge} - 0.036
$$

ahol $p_\text{final} = $ `signal.finalProb` (a 8-jelzéses kombinátor outputja) és $p_\text{market} = $ Polymarket YES mid-price. A 3.6% = 1.8% entry + 1.8% exit (Polymarket maker fee tier).

### Math: irány

$$
\text{direction} = \begin{cases}
\text{YES} & \text{ha } p_{\text{final}} > p_{\text{market}} \\
\text{NO}  & \text{egyébként}
\end{cases}
$$

### Math: Kelly

A `signal-combiner` már ¼-Kelly-vel ad vissza:

$$
f_{\text{combiner}} = \underbrace{\frac{p\,b - q}{b}}_{\text{full Kelly}} \cdot \underbrace{(1 - \text{cv\_edge})}_{\text{IR confidence shrink}} \cdot \underbrace{0.25}_{\text{¼-Kelly}}
$$

ahol $b = \frac{1}{\text{combined}} - 1$, $q = 1 - \text{combined}$ és
$\text{cv\_edge} = \max(0, 1 - \text{IR} \cdot 0.8)$.

A bot a `signal.kellyFraction = data.kelly.quarter`-t használja:

$$
f_{\text{used}} = \min(f_{\text{combiner}},\ \text{maxKellyFraction})
$$

A pozíció méret USDC-ben:

$$
\text{positionSize} = \max(1,\ \text{bankroll} \cdot f_{\text{used}})
$$

A `Math.max(1, ...)` $1-os floor csak a **#7 Kelly conviction gate** után fut,
így csak akkor érvényesül, ha $f_{\text{used}} > 0$.

### Math: entry price (1-tick agresszív)

YES esetén egy tick-kel a market mid felett:

$$
p_{\text{entry, YES}} = \min(p_{\text{market}} + 0.01,\ 0.99)
$$

NO esetén:

$$
p_{\text{entry, NO}} = \max((1 - p_{\text{market}}) + 0.01,\ 0.01)
$$

Ez lényegében "fizess egy tick fölé a piaci ár felett, hogy fillelődjön." Live módban GTC limit, paper módban azonnali instant-fill (lásd §7).

---

## 5. Signal aggregator (`crypto/signal-aggregator.mts`)

### Primary path

```
GET /.netlify/functions/signal-combiner?slug=<market-slug>
```

A combiner 8 jelzést számol párhuzamosan minden bejövő piacra (lásd `math/10-signal-combiner.md` a részletes matekért). A bot az alábbi mezőket használja a response-ból:

| Mező | Forrás | Felhasználás |
|------|--------|--------------|
| `combined_probability` | IR-súlyozott kombinátor | `signal.finalProb` |
| `kelly.quarter` | `(p·b−q)/b · (1−cv_edge) · 0.25` | `signal.kellyFraction` |
| `active_signals` | non-null jelzések száma (8-ból) | `signal.activeSignals` (gate #2) |
| `raw_signals` | object 8 jelzéssel | `signal.signalBreakdown` (csak 5 mezőt extractolunk: vol/orderflow/apex/cond/funding) |

⚠ **Mismatch:** a combiner 8 jelzést számol (`vol_divergence`, `orderflow`,
`apex_consensus`, `cond_prob`, `funding_rate`, `momentum`, `contrarian`,
`pairs_spread`), de a bot a `SignalBreakdown` típusban csak 5-öt tárol. A
3 új jelzés (momentum / contrarian / pairs_spread) **számít** a
`combined_probability`-be és a Kelly-be, de nem szerepel a UI "Why?"
panel-én. Az `active_signals` count viszont mind a 8-at tartalmazza —
így a #2 gate (`≥ 2 aktív`) átmehet úgy, hogy a UI-on egyetlen jelzés
sem látszik.

### Fallback path

Ha a combiner endpoint hibázik vagy `ok: false`-t ad, a bot a `fetchIndividualSignals(slug)` ágra esik, ami csak az 5 régi signal-t hívja:

```
GET /.netlify/functions/vol-divergence?slug=...
GET /.netlify/functions/orderflow-analysis?slug=...
GET /.netlify/functions/apex-wallets?mode=consensus
GET /.netlify/functions/cond-prob-matrix?slug=...
GET /.netlify/functions/funding-rates
```

majd egy egyszerű IC-súlyozott átlaggal kombinálja. A `signal_score`
mezőket vesszük csak. Ez a fallback nem használja a momentum / contrarian /
pairs_spread jelzéseket → 5 jelzéssel megy tovább.

### OB imbalance enrichment

A combinerrel párhuzamosan a `fetchOrderBookImbalance("BTCUSDT")` lefut a Binance Spot Public REST `/api/v3/depth`-en (top-10 bid+ask depth). 30s in-process cache. A ratio:

$$
r = \frac{\sum_{i=1}^{10} \text{bidSize}_i}{\sum_{i=1}^{10} \text{askSize}_i}
$$

A direction:

$$
\text{obImbalance.direction} = \begin{cases}
\text{UP} & r \geq \text{upThreshold} \quad\text{(default 1.80)} \\
\text{DOWN} & r \leq \text{downThreshold} \quad\text{(default 0.55)} \\
\text{NEUTRAL} & \text{egyébként}
\end{cases}
$$

A decision engine #5b gate-jében ez konvergencia filter: ha az OB UP-ot
mutat, mi NO-t akarunk venni, az ütközés → skip.

---

## 6. Position open / Resolve

### Open

A `placeBuyOrder()` után a `handleBuyLifecycle()` csinál egy `Position`
objektumot. A `runCryptoTrader()` ezt **kibővíti** paper-resolver
metaadatokkal és `EntryDecisionSnapshot`-tal, majd `addOpenPosition`-nel
session-be teszi. A `cooldownMap`-be is bekerül a slug.

### Live exit (settlement)

**Nincs aktív live exit kód.** A `crypto/order-lifecycle.mts` definiál egy
`checkExitConditions()` pure függvényt és `handleSellLifecycle()` /
`emergencySell()` runtime-ot a TP/SL korai exit-hez, **de a
`runCryptoTrader()` orchestrátor sosem hívja meg ezeket**. A live position
egy `addOpenPosition` után a session blob-ban marad — a Polymarket
on-chain settlement nem tükröződik vissza a session state-be.

**Ez egy ismert limitáció** (lásd §9). Live mode-ot **nem szabad** futtatni
amíg ez nincs befejezve, és a `live-readiness` gate is csak akkor enged
át live-ra, ha a paper track record passol.

### Paper exit

A `crypto/paper-resolver.mts:resolvePendingPaperPositions()` minden cron
tick elején lefut (csak paper módban, csak ha `openPositions.length > 0`).
Logikája:

1. Skip ha `now < endDate + 30s` (még aktív piac).
2. Skip ha `conditionId` hiányzik a position rekordról.
3. Lekér: `GET https://gamma-api.polymarket.com/markets?condition_ids=<id>&closed=true`
   - ⚠ A `&closed=true` query **kötelező** — nélküle a Gamma silently filterezi a lezárult market-eket és üres array-t ad. v2-ben ez okozta a 9 fantom trade fake-PnL-jét.
4. Parse `outcomePrices`. Resolved akkor van, ha `closed === true && (yes ≤ 0.001 || yes ≥ 0.999)`.
5. Exit price:

$$
p_{\text{exit}} = \begin{cases}
\text{yesOutcomePrice} & \text{ha direction = YES} \\
1 - \text{yesOutcomePrice} & \text{ha direction = NO}
\end{cases}
$$

majd snap-elés clean 0 vagy 1-re.

6. Build `ClosedTrade { entryPrice, exitPrice, pnl, pnlPct, … }` és
   `closePosition()`. A bankroll, sessionPnL, sessionLoss, tradeCount
   mind frissítődik.

**Garantált invariáns** (simVersion 3): paper PnL == live PnL lett volna,
mert mindkettő ugyanazon az `outcomePrices`-on settle-elne. A Brownian
sim teljesen ki van véve.

### Stuck pending

Ha a market `endDate` lejárt de a Polymarket még nem publikált outcome-ot
(UMA voting / dispute window), a position a `pending` listán marad. A UI
külön kártyán mutatja "awaiting Polymarket resolution / X ago". A bot
minden tickkor újra lekéri Gammát; nincs simulator fallback.

---

## 7. Paper vs Live invariánsok

| Lépés | Paper | Live | Eltérés |
|-------|-------|------|---------|
| Market discovery | Real Gamma `/events` | Real Gamma `/events` | – |
| Signal sources | Real (CLOB `/book`, Data API `/trades`, Binance funding, Bybit funding, Coingecko OHLC) | Ugyanaz | – |
| Decision engine | Pure function, paperMode-ról nem tud | Ugyanaz | – |
| Entry order | `placeBuyOrder(paperMode=true)` → instant fill at requested limit price | `placeBuyOrder(paperMode=false)` → `clob-client.createAndPostOrder` GTC limit | Paper feltételezi 100% fill az exact limit price-on; live-ban a CLOB lehet partial / slip / nem fill |
| Buy lifecycle | `handleBuyLifecycle` rögtön visszatér a paper Position-nel | 5s pollok, max 30s; `checkOrderStatus` → MATCHED/LIVE/CANCELLED/EXPIRED | Live mode-ban a fill timing valós, paper-ban instant |
| Position state | `Position` rekord 100%-ban szimmetrikus (YES/NO, shares = size/price) | Ugyanaz | – |
| Exit | `resolvePendingPaperPositions()` minden cron tickkor; csak Polymarket settlement-en zár | **NINCS aktív exit kód** (lásd §9) | ⚠ paper exit-tel rendelkezik egyetlen forrás (real outcome), live-nak nincs egyenértékű |

**Egyetlen szándékos divergencia:** paper-ben az entry-fill instant, a
limit price-on garantált. Live-ban ez egy GTC limit; ha a CLOB nem
tud filltetni 30s-on belül, `ORDER_EXPIRED` lesz és a position meg sem
nyílik. Ezért a paper PnL felülbecsülheti a live-t azokon a piacokon, ahol
a one-tick-fölé entry-ár nem fillelne live-ban. Ez kicsi: a bot az
`openInterest ≥ $500` és `[0.10, 0.90]` price band gate-tel filtereli ki
az ilyen piacokat.

---

## 8. Konfigurációs forrás-precedencia

A bot effektív configje két forrás merge-e (a Settings tab knobjai szigorúan felülírják az env defaults-okat):

```
env defaults (config.mts:getTraderConfig + getBtcExitConfig)
        ↓ merge
trader-settings runtime overrides (Netlify Blobs)
        ↓ merge per cron tick
config (immutable for the rest of the tick) → makeDecision(config)
```

### Live overrides (Settings tab → `trader-settings.mts`)

Csak az alábbi kulcsok érvényesek crypto botra (a többi `category: "weather"` vagy `category: "common"`):

| Kulcs | Default | Min/Max | Group |
|-------|---------|---------|-------|
| `edgeThreshold` | 0.15 | 0.02 / 0.30 | Risk & sizing |
| `maxKellyFraction` | 0.08 | 0.01 / 0.25 | Risk & sizing |
| `cooldownSeconds` | 300 | 30 / 3600 | Risk & sizing |
| `sessionLossLimit` | 20 | 5 / 1000 | Risk & sizing |
| `btcTpTarget` | 0.75 | 0.55 / 0.95 | BTC short-market exit (⚠ unused, lásd §9) |
| `btcSlTarget` | 0.35 | 0.05 / 0.45 | BTC short-market exit (⚠ unused) |
| `btcEntryWindowStartMs` | 60000 | 0 / 600000 | BTC short-market exit |
| `btcEntryWindowEndMs` | 180000 | 30000 / 900000 | BTC short-market exit |
| `btcHoldToEndCutoffMs` | 60000 | 10000 / 300000 | BTC short-market exit (⚠ unused) |
| `obImbalanceUpRatio` | 1.80 | 1.10 / 5.00 | OB imbalance |
| `obImbalanceDownRatio` | 0.55 | 0.20 / 0.95 | OB imbalance |
| `btcMinPriceBand` | 0.10 | 0.02 / 0.30 | Market finder |

### Live-readiness overrides (`category: "common"`)

A `liveReady*` knobok minden bot-ra (crypto / weather / HL / FR-arb) érvényesek:

| Kulcs | Default | Magyarázat |
|-------|---------|------------|
| `liveReadyMinTrades` | 30 | Minimum closed paper trades |
| `liveReadyMinWinRate` | 0.50 | Min paper win rate |
| `liveReadyMinIC` | 0.05 | Max abs. IC a 5 jelzés között |
| `liveReadyMaxCalibDev` | 0.07 | Calibration deviation cap |
| `liveReadyMinSharpe` | 0.5 | Min Sharpe ratio |
| `liveReadyMaxDrawdownPct` | 25 | Max drawdown a starting bankrollhoz képest |

A `live-readiness.mts:computeLiveReadiness()` 8 gate-et evaluál. Ha bármelyik
applicable gate buk → `shouldForcePaper()` true-t ad vissza, a bot a paper
módra kapcsol vissza arra a tickre, és Telegram alarm lemegy (sessiononként
egyszer).

---

## 9. Ismert limitációk és technikai debt

### A. Live exit code unused

`crypto/order-lifecycle.mts:checkExitConditions / handleSellLifecycle / emergencySell`
**definiált, de a `runCryptoTrader()` orchestrátor sosem hívja meg**. Ezért:

- **TP/SL korai exit nincs sem paper, sem live módban.** A `BTC_TP_TARGET` /
  `BTC_SL_TARGET` env-ek és a Settings UI ezekhez tartozó knobjai **idle**.
- **Live mode-ban nincs settlement reconciliation:** a Polymarket on-chain
  outcome nem írja vissza a session state-et. Egy live position örökre nyitva
  marad a session blob-ban. (A paper mode-nak van — `paper-resolver.mts`.)

A `live-readiness` gate ezért a default thresholds mellett szándékosan szigorú
(30+ trade, IC ≥ 5%, calib dev < 7%, Sharpe ≥ 0.5, DD < 25%) — **de még a
gate átengedése után sem szabad live-ra kapcsolni**, amíg ez a két dolog nem
épül meg.

**Fix terv** (ha valaki nekiáll):

1. A `runCryptoTrader()` for-loopja előtt új blokk: minden `openPosition`-re
   `checkExitConditions()`. Live módban → `handleSellLifecycle()`. Paper
   módban → szándékosan **nem** hívjuk (paper csak settlement-en zár, lásd
   "garantált invariáns" §6).
2. Új `crypto/live-resolver.mts` ami a `clob-client.getMarketTrades()` /
   on-chain Polymarket events-et figyeli és lezárja a settled live
   positionöket. Mintaként a `paper-resolver.mts` és a HL `position-monitor`
   kombóját lehet venni.

### B. Cron source label

A `netlify.toml`-ban az `auto-trader` cron közvetlen schedule, **nem fan-out**.
Amikor ez fired, a Netlify a function URL-t hívja query string nélkül. A
`runCryptoTrader()` source detektora `?source=cron` paramra figyel, így a
közvetlen cron tick-ek **"manual"-ként** lesznek tag-elve a run-state-ben.

A homepage status pill ezért nem mutatja a "(cron)" badge-et a crypto
botra. Funkcionális hatás nincs — csak UX. A `multi-cron`-os fan-out
(HL + arb) helyesen passol `?source=cron`-t.

**Fix:** `netlify.toml:21` `[functions."auto-trader"]` alá `path =
"/auto-trader?source=cron"` config — vagy közvetlenül a `runCryptoTrader()`-ben
detektálni a `req.headers.get("user-agent")?.includes("netlify")` jelet.

### C. SignalBreakdown shape lemarad

A `signal-combiner` 8 jelzést számol, de a `SignalBreakdown` típus csak 5
mezőt tárol (`vol_divergence`, `orderflow`, `apex_consensus`, `cond_prob`,
`funding_rate`). A momentum / contrarian / pairs_spread jelzések az IR-súlyozott
combined-be belemennek (és így a Kelly-be), de a UI "Why?" panel-én nem
jelennek meg, és a `pearsonCorrelation` IC számítás se érinti őket.

**Fix:** kibővíteni a `SignalBreakdown`-t 8 mezőre, és a `extractBreakdown`-ben
a 3 új mezőt is kiolvasni.

### D. Session summary missing simVersion

A `sessionSummary()` helper (`auto-trader/index.mts:749`) nem tartalmazza
a `simVersion` mezőt, ezért a `run-state.mts:getCryptoRunStatus()` a
`lastResult?.session?.simVersion` lekérdezésen nem találja. Szerencsére a
fallback `lastResult?.liveReadiness?.summary?.simVersion`-on át működik a
stale-result invalidation. **Fix:** add hozzá `simVersion: s.simVersion`-t
a `sessionSummary`-hez.

### E. Live entry-fill nem tükrözi a valós fill price-t

A `handleBuyLifecycle` live ágában (`order-lifecycle.mts:97`):

```
shares: buyOrder.size / buyOrder.price
```

Ez a placement price-t használja, **nem** a tényleges fill price-t. Ha a CLOB
egy jobb áron filled (tipikusan 1 tick lejjebb a YES-en), a bot kevesebb
shares-t könyvel mint amennyit valójában megvett. Az on-chain on-chain
position helyes, csak a session state alulbecsüli.

**Fix:** `client.getOrder(orderId)`-t hívni fill után és `filledSize / fillPrice`-t
használni. (A v3 paperrel ez nem érdekes mert paper-ben definiáltan az
exact entry price-on filled.)

### F. Momentum signal degenerated

A `signal-combiner` getMomentumSignal a "past price" referenciát ugyanazon
slug `?slug=` lekéréssel veszi → ugyanazt az aktuális ár-t kapja vissza. A
`Math.abs(currentMid - pastPrice) < 0.001` branch elsül és "distance proxy"-t
használ (eltávolodás 0.5-től). Effektíven a momentum signal **nem momentum-ot
mér**, hanem a market polaritását. IC szempontjából ez nullára közeli, de
nem zéró súlyú a kombinátorban.

---

## 10. Paper-mode validációs protokoll

Új feature-ök bevezetése után a bot **csak paper módban** induljon, és a
következő sanity check-eken menjen át, mielőtt a `live-readiness` gate-et
megnyitjuk:

1. **24-48h paper run.** Hagyni a botot futni, semmi config tweak közben.
2. **closedTrades exit-jei mind 0 vagy 1.** Bármi a `[0.01, 0.99]`
   tartományban → bug. (Ez a v2 Brownian-fallback artefakt, ami a
   simVersion 3-ban már nem létezhet.)
3. **Calibration health zöld.** `computeCalibrationHealth(trades, 30).maxAbsIC ≥ 0.05`
   és a Settings UI-on "Calibration Health" badge `good` (zöld).
4. **No fantom trades.** A homepage `multi-status` "trade count" mező
   egyezik a `/trade/crypto/` Tab 1 stats grid-jével.
5. **Session loss limit nincs sosem elérve egyetlen 24h-s ablakban sem.**
   Ha igen → `edgeThreshold`-ot fel, vagy `maxKellyFraction`-t le.

Ha mindegyik pass → a `live-readiness` gate átengedhető. **De live-ra
kapcsolás előtt** §9.A-t (live exit code) be kell fejezni.

---

## 11. Hivatkozott modulok (file → szerep)

```
netlify/functions/auto-trader/
├── index.mts                          ← runCryptoTrader() orchestrator
├── crypto/
│   ├── btc-market-finder.mts          ← Gamma /events?tag_id=21 + filterek
│   ├── signal-aggregator.mts          ← /signal-combiner + Binance OB enrichment
│   ├── decision-engine.mts            ← 8 gate, Kelly, edge, direction
│   ├── execution.mts                  ← clob-client BUY/SELL (paper instant fill)
│   ├── order-lifecycle.mts            ← ⚠ definiált TP/SL exit, NEM HÍVOTT
│   ├── paper-resolver.mts             ← Real Polymarket settlement (simV3)
│   ├── session-manager.mts            ← Blobs persistence + simVersion archive
│   └── run-state.mts                  ← UI status pill data (manual/cron)
└── shared/
    ├── config.mts                     ← env defaults + getEffectiveTraderConfig
    ├── types.mts                      ← MarketInfo, Position, EntryDecisionSnapshot
    ├── live-readiness.mts             ← 8 gate live-go evaluator
    ├── logger.mts                     ← NDJSON event log + getLogBuffer
    └── telegram.mts                   ← Alert dispatcher

netlify/functions/
├── trader-settings.mts                ← Settings UI backend (Blobs override store)
├── signal-combiner.mts                ← 8-signal combiner (Grinold-Kahn IR)
├── vol-divergence.mts                 ← Fallback signal (IV-RV)
├── orderflow-analysis.mts             ← Fallback signal (CLOB book imbalance)
├── apex-wallets.mts                   ← Fallback signal (smart money)
├── cond-prob-matrix.mts               ← Fallback signal (monotonicity)
├── funding-rates.mts                  ← Fallback signal (Bybit/Binance funding)
└── auto-trader-multi-cron.mts         ← Fan-out cron HL + FR-arb-hoz (NEM crypto)
```

---

## 12. Kapcsolódó dokumentumok

- `math/02-ev-kelly.md` — EV + Kelly criterion alapok
- `math/06-orderflow.md` — Kyle λ + VPIN + Hawkes (orderflow signal háttere)
- `math/07-vol-harvest.md` — IV vs RV (vol_divergence signal háttere)
- `math/08-apex-wallets.md` — Smart money detector (apex_consensus signal)
- `math/09-cond-prob.md` — Monotonicity violations (cond_prob signal)
- `math/10-signal-combiner.md` — Grinold-Kahn IR + 8-jelzés kombinátor
- `math/11-arb-matrix.md` — VWAP arb scanner (orthogonal eszköz, a crypto bot nem használja)
- `app/architecture.md` — Cross-bot architektúra snapshot
- `app/paper-pnl-analysis.md` — A v2 fake-PnL bug forensic analízise
- `changelog/CHANGELOG-2026-05-09.md` — simVersion 2 → 3 átmenet
- `changelog/CHANGELOG-2026-05-10.md` — Kelly conviction gate + Why? panel
