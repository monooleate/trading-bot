# Crypto Auto-Trader – Implementation Reference

> **Scope:** ez a doksi a `category: "crypto"` bot **élő futási logikáját** írja le
> ahogy a `netlify/functions/auto-trader/` fán jelenleg implementálva van
> (simVersion 3, 2026-05-10 állapot a 6 audit-fix után). A signal-szintű
> matematika a `math/06-orderflow.md`–`math/11-arb-matrix.md` fájlokban él;
> ez a doksi azt szedi össze, **mit használ valójában a bot, milyen
> sorrendben, milyen paraméterekkel.**

---

## 1. Bot célja és stratégia

| Szempont | Érték |
|----------|-------|
| **Venue** | Polymarket CLOB (Polygon, Gamma + CLOB API) |
| **Underlying** | Rövid lejáratú binary BTC up/down piacok (5m / 15m / órás) |
| **Cron** | `*/3 * * * *` (`auto-trader` schedule a `netlify.toml`-ban) |
| **Side** | Long-only (BUY YES vagy BUY NO; nincs short / nincs sell-side entry) |
| **Stratégia** | EV-pozitív belépés a `signal-combiner` 8-jelzéses ¼-Kelly outputja alapján, sessionönkénti loss limit + ¼-Kelly + 8% bankroll-cap mellett |
| **Paper exit** | **Kizárólag Polymarket settlement** (UMA-resolved outcome 0 / 1). Nincs TP/SL — lásd §7 paper-vs-live invariáns |
| **Live exit** | (a) TP/SL korai exit per-tick (BTC short markets) + (b) Polymarket settlement automatikus close + (c) on-chain CTF redemption a `/polymarket-redeem` end-pointon manuális |
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

## 2.1 Részletes runtime walkthrough (egy teljes cron tick)

Az alábbi annotated-trace végigmegy egy `*/3 min` cron tick teljes
életciklusán. A számozás megegyezik a `runCryptoTrader()` függvény
sorrendjével (`auto-trader/index.mts`). Példa adatok: paper mode, $150
bankroll, 0 nyitott pozíció, üres closedTrades.

### Lépés 0 — Cron trigger

A Netlify scheduled function `*/3 * * * *` cron-on tüzel és POST-ot küld
a `/.netlify/functions/auto-trader` URL-re egy `{ next_run: "..." }` body-val.

```
POST /.netlify/functions/auto-trader
Content-Type: application/json
Body: { "next_run": "2026-05-10T19:33:00Z" }
```

A handler parser-e (`index.mts:79-100`):
- `body.action` hiányzik → default `"run"`
- `body.category` hiányzik → default `"crypto"`
- `body.next_run` jelen → `isScheduledTick = true`
- Crypto branch source detektálja: `?source=cron` nincs, de
  `isScheduledTick = true` → `source = "cron"` (audit-fix #B után — előtte
  "manual"-ként lett tag-elve).

### Lépés 1 — `markRunStart(source)` → `crypto-runtime` Blobs

```
{ startedAt: "2026-05-10T19:30:01Z", source: "cron" }
```

UI az 5s status pollon ezt látja → "Scanning… (cron)" pulse a status pill-en.

### Lépés 2 — Effective config build

Két forrás merge-e:

```
env defaults (config.mts:getTraderConfig)
  ↓ async merge
trader-settings runtime overrides (Netlify Blobs / "trader-settings" store)
  ↓
config = {
  paperMode: true,                       ← PAPER_MODE env (default true)
  edgeThreshold: 0.15,                   ← Settings UI override-olható
  maxKellyFraction: 0.08,
  cooldownSeconds: 300,
  sessionLossLimit: 20,
  minOpenInterest: 500,
  roundtripFeePct: 0.036,
}

btcExit = {
  tpTarget: 0.75,
  slTarget: 0.35,
  entryWindowStartMs: 60_000,
  entryWindowEndMs:   180_000,
  holdToEndCutoffMs:  60_000,
}

obUp = 1.80, obDown = 0.55, btcMinPriceBand = 0.10
```

### Lépés 3 — `loadSession(paperMode=true, $150, "crypto")`

```
GET Blobs.auto-trader-state.get("auto-trader-session")
```

Ha üres → `defaultSession($150, true)` jön létre. Ha létezik:
- `parsed.paperMode !== paperMode` → friss session (mode-mismatch védelem).
- `parsed.simVersion < PAPER_SIM_VERSION (3)` → archiválás:
  - Save: `auto-trader-session-archive-paper-v2` ← régi blob
  - Save: `auto-trader-session` ← új fresh session (audit-fix 10. session
    óta a fő key-be is, nem csak archive-ba)
  - Log `SESSION_START { reason: "auto_reset_simversion" }`
- Ha `parsed.simVersion === undefined` → backfill simVersion-nel.

Példa eredmény: `session = { startedAt, bankrollStart: 150, bankrollCurrent: 150, sessionPnL: 0, …, simVersion: 3 }`.

### Lépés 4 — `computeLiveReadiness(...)` + `shouldForcePaper()`

8 gate evaluálva (lásd `live-readiness.mts`):

| Gate | Ráta | Default | Példa |
|------|------|---------|-------|
| Trade count | `totalTrades ≥ minTrades` | ≥ 30 | 0/30 ❌ |
| Win rate | `winRate ≥ 0.50` | ≥ 50% | n/a (0 trade) |
| Signal IC max | `maxAbsIC ≥ 0.05` | ≥ 5% | n/a |
| Calibration dev | `< 0.07` | < 7% | n/a |
| Sharpe | `≥ 0.5` | ≥ 0.5 | n/a |
| Max drawdown | `< 25%` | < 25% | n/a |
| Session active | `!stopped` | active | active ✓ |
| Sim version | `= PAPER_SIM_VERSION` | = v3 | v3 ✓ |

Ready: false (insufficient data). `shouldForcePaper(false → ?)`:
- Ha env `PAPER_MODE=true` → `forcePaper=false` (már paper).
- Ha env `PAPER_MODE=false` és readiness nem ready → **`config.paperMode` `true`-ra flippelve a tickre**, Telegram alert (sessiononként egyszer a `calibrationAlertSentAt` flag-gel).

### Lépés 5 — Settlement-resolver (paper + live)

Audit-fix #A után **mindkét módra fut**, nem csak paper-re:

```
if (session.openPositions.length > 0) {
  const r = await resolvePendingPaperPositions(session);
  ...
}
```

Üres `openPositions` esetén skip. Ha vannak pozíciók:

1. Minden nyitott pozícióra:
   - Skip ha `now < endDate + 30s` (még aktív piac).
   - Skip ha `conditionId` hiányzik.
   - Lekér: `GET Gamma /markets?condition_ids=<id>&closed=true`
   - Parse `outcomePrices` → `closed === true && (yes ≤ 0.001 || yes ≥ 0.999)` ⇒ resolved.
   - Exit price = direction === "YES" ? yesOutcomePrice : 1 - yesOutcomePrice.
   - Snap clean 0 vagy 1.
   - `pnl = shares * exitSnap - costBasis`.
   - `closePosition(session, buyOrderId, ClosedTrade)` ⇒ session bankroll/PnL/trade count frissítve.
   - Log `PAPER_RESOLVED { mode: "paper"|"live", requiresRedeem: !paperMode }`.
   - Live módban: a `requiresRedeem: true` flag jelzi az operatornak, hogy futtassa a `/polymarket-redeem` endpointot a CTF on-chain redemption-höz (USDC visszaszerzéshez).
2. Telegram alert minden lezárt trade-re.

### Lépés 6 — Live early-exit pass (csak live módban)

Audit-fix #A új komponens: `runLiveEarlyExits(session, btcExit)`.
Paper módban **kihagyva** (sim invariáns).

1. `openPositions` rendezése `endDate ASC` (legközelebbi settlement-ű elsőként).
2. Top `LIVE_EXIT_BUDGET_PER_TICK = 3` pozíción iterál (Netlify timeout védelem).
3. Minden pozícióra:
   - Skip ha hiányzik `clobTokenIds` (régebbi pozíció a fix előtt).
   - `fetchYesMidpoint(clobTokenIds[0])` ⇒ `GET CLOB /midpoint?token_id=<YES>`.
   - Skip ha midpoint null (CLOB temporary error).
   - `checkExitConditions(position, minimalMarket, yesMid, now, btcExit)`:
     - `positionPrice = direction === "YES" ? yesMid : 1 - yesMid`.
     - Hold-to-end: ha `endDate - now ≤ holdToEndCutoffMs (60s)` ⇒ `{ shouldExit: false, reason: "RESOLUTION_IMMINENT" }` (settlement-resolver fogja zárni).
     - TP: `positionPrice ≥ tpTarget (0.75)` ⇒ exit.
     - SL: `positionPrice ≤ slTarget (0.35)` ⇒ exit.
   - Ha `shouldExit`:
     - `handleSellLifecycle(position, market, exitPrice, paperMode=false)`:
       - `placeSellOrder` GTC limit a position-side áron a CLOB-on (clob-client `createAndPostOrder`).
       - Polling 6 × 5s = 30s a fill-re (`checkOrderStatus` → `getOrder`).
       - Ha timeout: `emergencySell` (10 × 100ms FOK retry a best bid-en).
     - `closePosition(session, buyOrderId, enrichedTrade)` ⇒ session frissítve.
     - Log `TRADE_CLOSED`, Telegram alert.

### Lépés 7 — Calibration noise alarm

```
const health = computeCalibrationHealth(session.closedTrades, 30);
```

A `closedTrades`-en végigmegy és 8 jelzésre Pearson-korrelációt számol a win/loss kimenetekkel. Ha ≥ 30 trade ÉS minden `|IC| < 0.02` → `shouldSuspendLive = true`.

- Paper módban: Telegram alert (sessiononként egyszer), session megy tovább.
- Live módban: `stopSession(session, "Calibration noise: …")` + `alertSessionStop` + early return.

### Lépés 8 — Session stopped check

```
if (session.stopped) {
  return finish({ action: "skipped", reason: `Session stopped: ...` });
}
```

Ha a user manuálisan stop-olta vagy session-loss-limit-et ért el az előző tickkor.

### Lépés 9 — `findBtcMarkets(minOI=500, btcMinPriceBand=0.10)`

```
GET Gamma /events?tag_id=21&active=true&closed=false&limit=30&order=volume24hr&ascending=false
```

Returnedeli a top 30 active crypto event-et volume24h szerint csökkenő sorrendben. A bot végigjárja a `events[].markets[]`-eket és filtereket alkalmaz — lásd §3.

Példa eredmény: 7 BTC up/down piac találva. Top 3: `bitcoin-up-or-down-on-may-10-15min-X`, `bitcoin-up-or-down-on-may-10-15min-Y`, `bitcoin-above-100k-on-may-10`.

A 4–7. piacok `droppedMarkets` array-be kerülnek `reason: "below_top_3"` címkével — UI rendereli őket "what else is out there" listként.

### Lépés 10 — Per-market loop (max 3)

Minden market-re párhuzamosan **NEM** — szigorúan szekvenciális:

#### 10a. Session loss limit re-check

```
if (updatedSession.sessionLoss >= config.sessionLossLimit) {
  updatedSession = stopSession(updatedSession, "Session loss limit reached");
  break;
}
```

A loop közben is ellenőrzi (egy korábbi market-en lezárult vesztes trade még abban a tickben triggerelheti).

#### 10b. Duplicate position guard

```
if (updatedSession.openPositions.some(p => p.market === market.slug)) {
  results.push({ action: "skip", reason: "Already has open position" });
  continue;
}
```

Egy slug-ra max 1 nyitott pozíció.

#### 10c. `aggregateSignals(market.slug, { up: 1.80, down: 0.55 })`

Két párhuzamos hívás:

**Primary**: `GET /.netlify/functions/signal-combiner?slug=<slug>`
- A combiner 8 jelzést számol (vol_div, orderflow, apex, cond_prob, funding_rate, momentum, contrarian, pairs_spread) — lásd `math/10-signal-combiner.md`.
- IR-súlyozott Kelly-output.
- 3 perc cache (signal-combiner-v3 Blobs store).

**Concurrent**: `fetchOrderBookImbalance("BTCUSDT")`
- `GET https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20`
- `bidDepth = sum(bids[0..10].size)`, `askDepth = sum(asks[0..10].size)`
- `ratio = bidDepth / askDepth`
- 30s in-process cache.
- Direction: `ratio ≥ 1.80 → UP`, `ratio ≤ 0.55 → DOWN`, egyébként `NEUTRAL`.

Példa eredmény:
```
signal = {
  finalProb: 0.62,             ← combined_probability
  kellyFraction: 0.04,         ← kelly.quarter
  signalBreakdown: { funding_rate: 0.55, orderflow: 0.68, vol_divergence: 0.51,
                    apex_consensus: 0.60, cond_prob: 0.58,
                    momentum: 0.65, contrarian: 0.45, pairs_spread: 0.62 },
  activeSignals: 8,
  obImbalance: { ratio: 2.1, direction: "UP" },
  timestamp: "..."
}
```

Log: `SIGNAL { market, finalProb: 0.62, marketPrice: 0.50, edge: 0.12, kelly: 0.04, activeSignals: 8 }`.

#### 10d. `makeDecision(signal, market, $150, $0, config, btcExit)`

8 ordered gate (§4):

```
Gate 1 (Session loss limit):  $0 < $20 ✓
Gate 2 (Active signals):      8 ≥ 2 ✓
Gate 3 (Cooldown):            ready ✓
Gate 4 (Open interest):       $1500 ≥ $500 ✓
Gate 4b (Entry window):       90s ∈ [60s, 180s] ✓ (csak ha openedAtEstimate van)
Gate 5b (OB imbalance):       UP & we want YES → aligned ✓
Gate 6 (Net edge):            netEdge = 0.12 - 0.036 = 0.084 < 0.15 ✗ → SKIP
```

Itt **bukik** a példában — `netEdge < edgeThreshold`. A `noResult` early-return ad vissza:

```
{
  shouldTrade: false, direction: "YES", positionSizeUSDC: 0, edge: 0.084,
  reason: "Net edge 8.4% < threshold 15.0%",
  gates: [...]   ← első 6 gate, a 6. failed=true
}
```

UI: a sor **skip** action-ként jön vissza, narancssárga keret + halvány bg + "✗ Net edge ≥ küszöb (8.4%, ≥ 15.0%)" inline blocker.

Ha minden gate átment volna:
```
direction = YES, positionSize = $150 * 0.04 = $6, entryPrice = 0.51
```

#### 10e. (csak ha `shouldTrade=true`) `placeBuyOrder(...)`

**Paper mode**:
```
record = {
  orderId: "paper_<ts>_<rand>", status: "FILLED",
  filledShares: 6 / 0.51 = 11.76, filledAt: now
}
```
Instant. Log `ORDER_PLACED` + `ORDER_FILLED`.

**Live mode**:
```
client.createAndPostOrder({ tokenID: <YES>, price: 0.51, side: "BUY", size: 6 },
                          { tickSize: "0.01", negRisk: false }, "GTC")
```
Returns `{ orderID: "..." }` vagy throw. Status `PLACED`, polling kezdődik.

#### 10f. `handleBuyLifecycle(buyOrder, market, paperMode)`

**Paper**: rögtön visszatér a `Position`-nel.

**Live**: 6 × 5s polls a `getOrder(orderID)`-ra, max 30s. Ha `MATCHED`:
- Audit-fix #E után: `fetchOrderFillDetail(orderID)` → real `size_matched` + `price`.
- `shares = filledUsdc / fillPrice` (a tényleges fill-en, nem a placement price-on).
- Position object visszaadva.

Ha `EXPIRED`/`CANCELLED`/timeout → `null`, a market `failed` action-nel a results-ban.

#### 10g. EntryDecisionSnapshot + Position augmentation

```
entryDecision = {
  decidedAt, finalProb: 0.62, marketPrice: 0.50, grossEdge: 0.12, netEdge: 0.084,
  feePct: 0.036, direction: "YES", kellyRaw: 0.04, kellyCapped: 0.04, kellyCap: 0.08,
  positionSizeUSDC: 6, entryPrice: 0.51, activeSignals: 8,
  signalBreakdown: { ... }, obImbalance: { ratio: 2.1, direction: "UP" },
  gates: [...8 gate...], reason: "..."
}

paperPosition = {
  ...position,
  clobTokenIds:       ["YES_TOKEN_ID", "NO_TOKEN_ID"],   ← audit-fix #A
  conditionId:        "0x...",
  endDate:            "2026-05-10T20:00:00Z",
  marketPriceAtEntry: 0.50,
  predictedProb:      0.62,
  signalBreakdown:    { ... },
  category:           "crypto",
  entryDecision,
}
```

#### 10h. `addOpenPosition(session, paperPosition)` + `setCooldown(slug)`

```
session.openPositions = [...existing, paperPosition]
session.bankrollCurrent -= 6   ← $150 → $144
cooldownMap.set("bitcoin-up-or-down-on-may-10-15min-X", now)
```

#### 10i. `alertTradeOpen(...)` Telegram

```
🟢 PAPER · Bitcoin Up or Down (15m) · BUY YES @ $0.51 · $6.00 size
   bankroll: $144 · edge 8.4% · ¼-Kelly 4.0% · FR↑ VPIN↑ VOL↑ APEX↑ CP↑ MOM↑ CTR↓ PRS↑
```

A `formatSignalArrows` audit-fix #C után 8 nyíllal jön (előtte csak 5).

### Lépés 11 — `saveSession(updatedSession)` → Blobs

```
PUT Blobs.auto-trader-state.set("auto-trader-session", JSON.stringify(session))
```

### Lépés 12 — `markRunFinish(payload)` → `crypto-runtime` Blobs

```
{
  startedAt: null,           ← Scanning pulse off
  lastRunAt: now,
  lastResult: {
    ok: true, action: "run", paperMode: true, marketsScanned: 7,
    marketsConsidered: 3, results: [...], droppedMarkets: [...],
    config: {...}, session: {... simVersion: 3 ...},   ← audit-fix #D
    liveReadiness: {...}, source: "cron", finishedAt: now
  },
  source: "cron"
}
```

UI az 5s pollra ezt visszakapja → "last run: 12s ago" + a 3 sor (1 trade open + 2 skip) megjelenik a `ScanResultsCard`-on.

### Lépés 13 — HTTP response a Netlify-nek

```
HTTP 200
{ ok: true, action: "run", ...enriched payload... }
```

A Netlify ennek a respose-ának a státuszát logoja, de nem dolgozza fel — a következő `*/3 min` tickre vár.

### Tick teljes time-budget (paper, üres state)

| Lépés | Tipikus latency |
|-------|----------------|
| Lépés 0–3 (load) | ~150ms |
| Lépés 4 (readiness) | <10ms |
| Lépés 5 (resolver, 0 pozíció) | ~5ms |
| Lépés 6 (live exit, paper skip) | 0ms |
| Lépés 7 (calibration) | <10ms |
| Lépés 9 (Gamma events) | 200–500ms |
| Lépés 10 × 3 markets | 3 × (combiner ~800ms + OB 100ms + decision <5ms) ≈ 2.7s |
| Lépés 11–12 (save) | ~100ms |
| **Total** | **~3.3s** |

Live módban (1 nyitott pozíció TP-hit-tel): + ~30s `handleSellLifecycle` GTC poll
+ esetleg + 1s emergency FOK = ~33s extra. Limit `LIVE_EXIT_BUDGET_PER_TICK = 3` ⇒ worst-case ~100s, Netlify scheduled function 15min budget alatt OK.

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

## 9. Audit findings + fix history

A 2026-05-10 audit során 6 hibát azonosítottunk; **mindegyiket javítottuk**
ugyanazon a napon. A status oszlop a deployment utáni állapotot mutatja.

| ID | Probléma (pre-fix) | Status | Fix lényege |
|----|---------------------|--------|-------------|
| **A** | Live exit code (`checkExitConditions` / `handleSellLifecycle` / `emergencySell`) definiált, de **NEM hívott** semmiből. Sem TP/SL early exit, sem live settlement reconciliation. | ✅ FIXED | (1) Új `live-price.mts:fetchYesMidpoint`. (2) Új `runLiveEarlyExits` orchestrator a `runCryptoTrader`-ben, max 3 pozíció/tick, endDate ASC sorted, paperMode skip. (3) `paper-resolver.mts:resolvePendingPositions` általánosítva — paper + live módra is fut, live close `requiresRedeem: true` flag-gel logol (manuális `/polymarket-redeem` szükséges). (4) `Position.clobTokenIds` mező hozzáadva hogy a sell-side tudja a token-id-kat lookup nélkül. |
| **B** | `netlify.toml` `auto-trader` schedule közvetlenül a function URL-t hívta, így `?source=cron` query nem érkezett meg → run-state "manual"-ként tag-elte. | ✅ FIXED | `auto-trader/index.mts` body parse mostantól `body.next_run` jelenlétét ellenőrzi (Netlify scheduled function payload jellemzője). Ha jelen → `isScheduledTick=true` → source override "cron"-ra. HL + weather útvonalakra is alkalmazva. |
| **C** | `SignalBreakdown` típus 5 mezős, de a `signal-combiner` 8 jelzést számol. A 3 új jelzés bemegy a Kelly-be, de UI "Why?" panel + IC számítás nem érinti őket. | ✅ FIXED | `types.mts:SignalBreakdown` 8 mezőre kibővítve. `extractBreakdown` + fallback path + `formatSignalArrows` + `edge-tracker/statistics.mts:SIGNAL_NAMES` + `mock-trades.mts` + UI `SIGNAL_ORDER` + `TraderResults.tsx:SIGNAL_LABELS` mind 8 jelzéssel. HL signal-source már korábban populated 8 mezőt; most a típus is matchel. |
| **D** | `sessionSummary()` helper nem tartalmazta `simVersion`-t. `getCryptoRunStatus` stale-result invalidation csak a `liveReadiness.summary.simVersion` fallback-on át működött. | ✅ FIXED | `sessionSummary` mostantól `simVersion: s.simVersion ?? null`-t is visszaad. |
| **E** | Live `handleBuyLifecycle` `shares = size / placement_price`-t használ, nem a tényleges fill price-t — partial fill / better-than-limit fill esetén a session state pontatlan. | ✅ FIXED | Új `execution.mts:fetchOrderFillDetail(orderId)` → `getOrder` → `size_matched` + `price`. `handleBuyLifecycle` live FILLED ágban most ezt használja, fallback a placement értékekre ha az API nem ad jó adatot. Defensive field-name spelling: `size_matched ?? sizeMatched ?? executedSize ?? filledSize`. |
| **F** | `getMomentumSignal` ugyanazon slug `?slug=` lekéréssel vette a "past price"-t → ugyanazt az aktuális ár-t kapta vissza. A `Math.abs(...) < 0.001` branch elsült, "distance proxy"-ra esett — effektíven a market polaritását mérte, nem momentum-ot. | ✅ FIXED | `signal-combiner.mts:getMomentumSignal` átírva. Új `momentum-snapshots` Blobs store, per-slug `{ ts, yes }` snapshot. Minden hívás: olvas snapshot, ha age ∈ [60s, 1h] → real Rcum vs snapshot, ha túl friss/régi → neutral 0.5. Snapshot mindig frissítve a current value-ra. A combiner 3min cache miatt 3-15 min look-back ablakot ad. |

### Maradó (post-fix) limitációk

- **Cooldown map in-memory**: `decision-engine.mts:cooldownMap` egy
  `Map<string, number>` ami a Netlify function cold-start után elvész. Ha
  egy market 5 percen belül 2× passol minden gate-en és a függvény közben
  cold-startol → 2× nyithat ugyanarra a slug-ra. Mitigation: `addOpenPosition`
  post-check (`openPositions.some(p => p.market === slug) → skip`) megfogja,
  de csak a tényleges Position rekord után. **Nem fixelve** — Blobs-perzisztálás
  trade-off: 1 plusz Blobs read/write/tick. Tesztelési protokoll alatt
  monitorozandó.

- **Live early-exit Netlify timeout**: `LIVE_EXIT_BUDGET_PER_TICK = 3`-mal
  worst case 3 × ~30s GTC poll = 90s. Netlify scheduled function 15 min
  budgetje bőven elég, de standard sync function timeout 26s. Ha valaha
  átkerül a bot egy nem-scheduled függvénybe, ez áttervezést igényel.

- **On-chain CTF redemption manuális**: live-mode close után az USDC nem
  jön vissza automatikusan a funder address-re. `PAPER_RESOLVED.requiresRedeem:
  true` log-bejegyzés és Telegram alert jelzi, hogy a user futtassa a
  `/polymarket-redeem` end-pointot. Auto-redeem opcionálisan beépíthető,
  de jelenleg intent-only minta (security-conscious default).

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
├── index.mts                          ← runCryptoTrader() + runLiveEarlyExits() orchestrator
├── crypto/
│   ├── btc-market-finder.mts          ← Gamma /events?tag_id=21 + filterek
│   ├── signal-aggregator.mts          ← /signal-combiner + Binance OB enrichment
│   ├── decision-engine.mts            ← 8 gate, Kelly, edge, direction
│   ├── execution.mts                  ← clob-client BUY/SELL + fetchOrderFillDetail (audit-fix #E)
│   ├── order-lifecycle.mts            ← TP/SL checkExitConditions + handleSellLifecycle (live, audit-fix #A)
│   ├── live-price.mts                 ← CLOB /midpoint fetcher a live early-exit pass-hez
│   ├── paper-resolver.mts             ← resolvePendingPositions (paper + live, audit-fix #A)
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
