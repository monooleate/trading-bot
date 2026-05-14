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
  gates: [...]   ← teljes 15 gate lista, "Net edge ≥ küszöb" sora failed=true
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
  gates: [...15 gate...], reason: "..."
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
`DecisionGate { label, passed, actual, required, hint }` objektumot kap.
A motor **MINDEN** gate-et kiértékel (nincs short-circuit), és csak a
végén dönt `shouldTrade = gates.every(g => g.passed)` — így a UI a
teljes pass/fail listát megjeleníti a "Why?" panel-en. A `reason` mező
az első bukó gate üzenetét hordozza, hogy a sor footer-en olvasható maradjon.

### A 15 gate (2026-05-14e cross-position consistency után)

| # | Gate | Match rule | Default | Where to tune |
|---|------|------------|---------|---------------|
| 1 | **Session loss limit** | `sessionLoss < cfg.sessionLossLimit` | $20 | `SESSION_LOSS_LIMIT` env / Settings `sessionLossLimit` |
| 2 | **Aktív signal források** | `signal.activeSignals ≥ minActiveSignals` | 2 (Loose) / 3 (Normal) / 5 (Strict) | Settings `cryptoMinActiveSignals` |
| 3 | **Combiner confidence (\|p − 0.5\|)** ✦ | `\|finalProb − 0.5\| ≥ combinerConfidenceMin` | 0.05 | `COMBINER_CONFIDENCE_MIN` env / Settings `combinerConfidenceMin` |
| 4 | **Combiner recommendation** ✦ | `!signal.combinerRecommendation.startsWith("SKIP")` | hard-coded | – (a `signal-combiner` `recommend()` outputja) |
| 5 | **Combiner trust (WATCH + extrém edge)** ✦✦ | `!(rec === "WATCH" && grossEdge > watchExtremeEdgeThreshold)` | WATCH + 20%+ blokk | Settings `watchExtremeEdgeThreshold` |
| 6 | **Resolution-risk gate** ✦ | `signal.tradeRecommendedByRisk !== false` | hard-coded | – (a `signal-combiner` `analyseResolutionRisk()` helper-éből) |
| 7 | **Market cooldown** | `now - lastTrade(slug) ≥ cooldownSeconds * 1000` | 300s | `COOLDOWN_SECONDS` / Settings `cooldownSeconds` |
| 8 | **Open interest** | `market.openInterest ≥ cfg.minOpenInterest` | $500 | `minOpenInterest` (kódban — nincs Settings knob) |
| 9 | **Entry window** ⚠ | csak ha `market.openedAtEstimate != null`. `ageMs ∈ [start, end]` | [60s, 180s] | `BTC_ENTRY_WINDOW_*` env / Settings `btcEntryWindow*Ms` |
| 10 | **OB imbalance konvergencia** | `signal.obImbalance.direction != decision.direction.opposite` | UP ≥ 1.80, DOWN ≤ 0.55 | `obImbalanceUpRatio` / `obImbalanceDownRatio` |
| 11 | **Net edge ≥ küszöb** | `\|finalProb − marketPrice\| − roundtripFeePct ≥ edgeThreshold` | 15% (3.6% fee után) | `EDGE_THRESHOLD_CRYPTO` / Settings `edgeThreshold` |
| 12 | **Sanity cap (gross edge ≤ cap)** ✦✦ | `grossEdge ≤ maxEdgeCap` | 40% | Settings `cryptoMaxEdgeCap` |
| 13 | **Kelly méret ≥ minimum** ✦ | `bankroll * kellyCapped ≥ minPositionSizeUSDC` | $0.50 | `MIN_POSITION_SIZE_USDC` env / Settings `minPositionSizeUSDC` |
| 14 | **Kelly méret ≤ cap** (informational) | `min(kellyFraction, maxKellyFraction)` | 8% bankroll | `MAX_KELLY_FRACTION` / Settings `maxKellyFraction` |
| 15 | **Monotonicitás (egyéb nyitott pozíciók)** ✦✦✦ | `findMonotonicityViolation(cand, open BTC-above-K positions) === null` | hard-coded | – (cross-position-gates.mts) |

✦ Új gate-ek a 2026-05-11 audit fixből (3 új konvergencia-gate + Kelly minimum gate). A korábbi 9 gate listából a régi "Kelly conviction (combiner > 0)" gate-et kivettem — a "Kelly méret ≥ minimum" (#13) funkcionálisan ekvivalens, csak a tényleges $ méreten ellenőriz, nem a 0-küszöbös conviction-en.

✦✦ Új gate-ek a 2026-05-12 expansion-ből: a Combiner trust + Sanity cap blokkolja az alacsony-IR kombinátor + extrém edge ("hallucinated alpha") és a > 40% gross-edge model-error eseteket. Részletek a 2026-05-12 changelog-ban.

✦✦✦ Új gate a 2026-05-14e cross-position consistency sweep-ből — lásd §9.5 "Cross-market consistency gate (monotonicity)". Trigger: 2026-05-14 paper session 78K-NO @ 52% + 80K-YES @ 53% incidens.

⚠ Az **#9 entry window** csak rövid (5m/15m) BTC piacokon aktív. Daily piacokon idle, mert az `openedAtEstimate` null — ekkor a gate "n/a (daily market)" actual-lal és `passed: true`-val szerepel a listán, hogy Y = 15 stabil maradjon a UI-on.

### A 3 új konvergencia-gate miértje (2026-05-11 audit)

A 2026-05-11 audit kimutatta, hogy a 9-gates verzió átengedte a 3 nyitott
paper pozíciót, miközben:

- `finalProb = 0.505` — **a 8 signal súlyozott átlaga**, ahol minden
  egyes signal default 0.5 ha nincs jel (vol_divergence, momentum,
  contrarian, pairs_spread mind 0.5-höz konvergál input nélkül).
  Tehát `finalProb ≈ 0.5` **NEM "modell-szerinti 50/50"** — hanem "nincs
  konvergens jel". A decision-engine ezt mégis összehasonlította a
  marketPrice = 0.255-szel és 25% edge-et detektált.
- `kelly.quarter = 0.0003` (0.03%) — a combiner saját `recommend()`
  függvénye `WATCH`-ot ad vissza (`kellyQ < 0.005`), de a régi
  `kellyFraction > 0` gate átengedte.
- `trade_recommended = false` (resolution-risk veto) — a combiner UI
  blokkolta volna, de a trader sose olvasta ezt a mezőt.

A 3 új gate (#3, #4, #5) ezt a 3 réteget zárja: matematikai konvergencia
(|p − 0.5| ≥ 5%), combiner saját ajánlása (BUY*), és resolution-risk
verdict (`!== false`). Mindhárom **párhuzamosan védi** a botot, mert
minden réteg külön failure mode-ot fog. Részletek:
`changelog/CHANGELOG-2026-05-11.md` "(c)" szekció.

### A "Kelly méret ≥ minimum" gate (#11) miértje

A pre-audit verzióban a `positionSize = Math.max(1, bankroll * kellyCapped)`
**$1 hard floor**-t alkalmazott. Ez 13× over-sized minden paper trade-et
0.03% Kelly mellett ($250 bankroll × 0.0003 = $0.075 javasolt, de $1
ténylegesen került allokálva). Az új gate **explicit gate-ként** kezeli
a floor-t: ha `bankroll * kellyCapped < minPositionSizeUSDC` → SKIP
("Kelly méret ≥ minimum" gate bukik), nem padding $1-re.

**Live deployment note:** a Polymarket CLOB minimum order size **$5 USDC**.
Live módra kapcsolás előtt a Settings tabon a `minPositionSizeUSDC`-t
$5.00-ra (vagy magasabbra) kell állítani, különben a CLOB visszadob
minden $5 alatti orderet. A $0.50 default csak paper módra optimális.

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

A pozíció méret USDC-ben (2026-05-11 audit fix után — **nincs többé $1
floor**):

$$
\text{positionSize} = \text{bankroll} \cdot f_{\text{used}}
$$

A floor most az **#11 "Kelly méret ≥ minimum" gate-ként** él, $0.50 default
küszöbbel. Ha a Kelly-méret a küszöb alatt van, a bot SKIP-pel, nem
padding-eli fel. Live módra emelni kell $5-re (CLOB minimum order size).

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
| `minPositionSizeUSDC` ✦ | 0.50 | 0.10 / 50 | Risk & sizing — **live módra emelni $5-re (CLOB minimum)** |
| `combinerConfidenceMin` ✦ | 0.05 | 0.01 / 0.20 | Risk & sizing — gate #3 küszöb |
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

### 2026-05-11 Tier 1 — vol_divergence Black-Scholes redesign + collinearity + Bonferroni IC

A 8 cikkből (Neural Networks / Quant Roadmap / Game Theory / Mean-reversion /
Hedge Fund Dataset / Hermes Agent / Black-Scholes / Trillion Equation)
szintetizált **3 független, struktúrális fix**, mind a crypto botra +
cross-bot edge-trackerre. Mind a 3 ott javít ahol a rendszerben konkrét
matematikai gyengeség volt; egymástól független, sorrendi függés nélkül.

#### 1. vol_divergence → Black-Scholes digital pricing

| Komponens | Előtte | Utána |
|-----------|--------|-------|
| Képlet | `iv = 2 \|yp-0.5\| / √T × 100`; `spread = iv − rv`; `prob = clamp(0.5 − spread × 0.4, 0.1, 0.9)` | `fair YES = N(d₂)`, ahol `d₂ = [ln(S/K) − σ²/2 × T] / (σ × √T)` |
| `S` (spot) | nem használt | Binance/CoinGecko BTC current close |
| `K` (strike) | nem használt | `fetchBtcPriceAt(openedAt)` — Binance 1m kline a piac kezdetekor |
| `T` (lejárat) | hours | years (`hours / (365 × 24)`) |
| `σ` | RV15 annualizált | RV20 annualizált (ugyanaz a logika, kicsit szélesebb ablak) |
| Output | normalizált [0.1, 0.9] score | **fair YES price közvetlenül** [0, 1] |
| Short-horizon gate | `< 1h → null` (kötelező, mert degenerált) | **eltörölve** — d₂ T → 0 limit-en jól viselkedik |

Az új output **közvetlenül összevethető a market YES árhoz** — `edge = fairYes − marketYes` formálisan értelmes. A signal-combiner ezt 0–1-es valószínűségként súlyozza a Grinold-Kahn IR keretbe.

**Hatás 5m/15m BTC piacokra**: az 1h gate kikerült → a `vol_divergence` signal MOST aktív rövid piacokon is, ahol eddig `null`-t adott. Várhatóan `activeSignals` 7 → 8 a leggyakoribb piacokon. A combiner IR növekszik **realisztikusan** mert az új signal nem degenerált zaj.

**Strike-source fallback**: ha a piac kezdete > 24h-val ezelőtt vagy nem parseolható durationMs, `K = S` (ATM fallback) → `d₂ ≈ −σ√T/2`, `fairYes ≈ 0.5` (semleges signal). Daily piacokon ez idle viselkedést ad — ami helyes.

#### 2. Collinearity matrix a 8 signal-on

A Grinold-Kahn `IR = IC × √N` képlet **statisztikai függetlenséget feltételez**. Az új `computeSignalCollinearity()` Pearson-mátrixot ad a 8 signal-vektorra a closed trade-eken:

- `signals[]` — a legalább 20 pair-observation-val rendelkező signalok
- `matrix[][]` — Pearson korrelációs mátrix (NaN-safe, joint-finite filter)
- `highPairs[]` — `|ρ| > 0.7` párok (Grinold-Kahn sértve)
- `effectiveSignalCount` — pszeudo-rank: nominal N haircut by collinearity. Egyszerű proxy: minden signal `1 − max|ρ|` súllyal hozzájárul, sorrendben.

**Mit jelez**: ha pl. `momentum` és `pairs_spread` ρ = 0.85, a `√N` valójában nem √8 hanem √6.4 — vagyis a Kelly méreted ~12% over-szám. A UI a `Calibration Health` mellé renderelheti az `effectiveSignalCount` értéket.

Exposed: `/.netlify/functions/edge-tracker` response `collinearity` mező.

#### 3. Bonferroni-korrigált IC threshold

A `computeCalibrationHealth` eddigi küszöbei (`|IC| ≥ 0.05` good, `≥ 0.02` weak, `< 0.02` noise) **statikus számok** voltak, multi-comparison korrekció nélkül. 8 signal egyszerre tesztelve `α = 0.05`-on familywise error rate **~33%** — a 8 jó-signal közül ~3 véletlenül átment.

Új Bonferroni-derived threshold:

| Komponens | Képlet |
|-----------|--------|
| Per-signal α | `α_familywise / signal_count = 0.05 / 8 = 0.00625` |
| `z_{α/2}` | inverz normal CDF (Beasley-Springer-Moro), `≈ 2.73` 8 signal-on |
| Pearson SE | `1 / √(n − 2)` (H₀: ρ=0 alatt) |
| `weakThreshold` | `z × SE × 1.0` (egy SE) |
| `goodThreshold` | `z × SE × 2.0` (két SE) |

Numerikus példa: **n=143, 8 signal** → `weakThreshold ≈ 0.082`, `goodThreshold ≈ 0.164`. Ez **lényegesen szigorúbb** mint a régi `0.02 / 0.05`. A `signalCount` adaptív: weather kategória csak `forecast_edge`-et populál → 1 signal → threshold ≈ `1.96 × SE`, ami a 8-signal verzióhoz képest tágabb (nincs multi-comparison büntetés ha csak 1 signal van).

**Hatás a `live-readiness` gate-re**: ami eddig "good" volt 0.05 IC-vel, MOST `weak` lehet → live trading suspended. Ez intent szerinti — a rendszer akkor enged át, ha **statisztikailag bizonyítható** edge van, nem ha "valami signal random átszaladt 0.05-ön".

Exposed: a `CalibrationHealth` típus most tartalmazza `goodThreshold`, `weakThreshold`, `signalCount` mezőket (transparency in UI/logs).

#### Implementációs file-ok

| Fix | File | Sor |
|-----|------|-----|
| 1. Black-Scholes vol_divergence | `signal-combiner.mts` | 280–425 |
| 2. Collinearity matrix | `edge-tracker/statistics.mts` | 510–620 |
| 3. Bonferroni IC threshold | `edge-tracker/statistics.mts` | 332–470 |
| API exposure | `edge-tracker.mts` | 22, 189, 224 |

#### Hatás a `live-readiness` gate-re

A 3 fix **együttesen szigorítja a paper → live átkapcsolást**:

- (1) több signal aktív rövid piacokon → IR realisztikusabb (nincs degenerált zaj-signal)
- (2) IR-haircut látható: ha nominálisan 8 signal IC × √8, de effektív 5 → ténylegesen IR × √5
- (3) IC küszöb adaptív és Bonferroni-szigorúbb → false-positive átengedés blokkolva

Eredmény: kevesebb fals "ready" jel a live-átkapcsoláshoz. **Paper aktivitás
azonban gyakorlatilag azonos** — a Bonferroni `shouldSuspendLive` flag csak
Telegram alertet ad paper módban, a bot folytatja a paper trade-eket
(`auto-trader/index.mts:393-414`). A korábbi "kevesebb trade" megfogalmazás
**csak a live aktiválásra** vonatkozik, paper-en nem.

#### Settings tab override-ok (B opció, 2026-05-11)

A 3 fix belső konstansai mind tunable-k a `trader-settings.mts` SCHEMA-n
keresztül:

| Field | Default | Tier 1 belső konstans | Hatás |
|-------|---------|----------------------|-------|
| `bonferroniAlpha` | 0.05 | familywise α | magasabb → enyhébb gate |
| `bonferroniGoodMultiplier` | 2.0 | good küszöb SE × multiplier | magasabb → szigorúbb 'good' |
| `collinearityHighThreshold` | 0.7 | highPairs ρ küszöb | magasabb → kevesebb highPair (observability only) |
| `volSignalEnabled` | 1 | kill-switch | 0 → vol_divergence `null` (7-signal combiner) |
| `volStrikeFetchEnabled` | 1 | strike fetch toggle | 0 → K=S fallback (ATM, semleges signal) |

Default = bit-azonos a Tier 1 implementáció előtti viselkedéshez.
Részletek: CHANGELOG-2026-05-11.md "(j)" szekció.

### 2026-05-11 mély-audit round 2 — 8 új signal-layer + arithmetic hiba

A 6-fix gate-layer audit után a user mély-elemzést kért minden rétegre.
Az audit a **signal matematikai validitását** és a **session arithmetic
invariánsát** vizsgálta. 8 új hiba, mind javítva.

| ID | Réteg | Pre-fix bug | Fix |
|----|-------|-------------|-----|
| **A** | Signal: `vol_divergence` | `iv = 2 × \|yp − 0.5\| / √T × 100` rövid horizonton degenerált (T → 0). 15min BTC piacon iv ≈ 7,490%, mindig clamp 0.1 → konstans NO-bias. | (initial) `VOL_MIN_HORIZON_HOURS = 1` gate, `<1h` piacokon `prob: null`. **(superseded 2026-05-11 Tier 1)**: a teljes képlet kicserélve Black-Scholes digital N(d₂)-re, az 1h gate eltörölve — lásd §9 Tier 1. |
| **B** | Session arithmetic | `closePosition` `bankrollCurrent += shares × exitPrice` (gross proceeds, fee nélkül), `sessionPnL` viszont net pnl. Invariáns sértve, drift ~3.6%/trade. | `bankrollCurrent += trade.pnl + costBasis`. Lookup a `buyOrderId`-vel. |
| **C** | Signal: `apex_consensus` | `walletMap.pnl` cash flow only (`SELL → +cash, BUY → -cash`). Settlement-bevétel nincs benne → "top 10" = top sellers. | Activity-score: `notional × √distinct markets`. |
| **D** | Signal: `cond_prob` | `violationDir` csak complement-irányt vett. Monoton-violation magnitúdó vakon hozzáadva, ellentétes irányok nem oltották ki egymást. | `complementSigned + monotonSigned` signed SUM. |
| **E** | Signal: `momentum` | Polymarket YES-midpoint Rcum-ja minden mozgásra trend-folytatást jelzett (`prob = 0.5 + rcum × 2.0`). Gyors mozgások (>5%) likviditás-driven, mean-revert. | Regime-aware: `\|rcum\| < 5%` → trend (× 2.0), `≥ 5%` → contrarian (× 1.0). |
| **F** | Statistics chart | `computeCumulativePnl` EV baseline NEM kezelte NO-trade direction-t. | `winProb = direction === "NO" ? 1 − predictedProb : predictedProb`. |
| **G** | Frontend | `${activeSignals}/5 signals` chip; subtitle 5 signalt sorol; config interface hiányos. | `/8`, full 8-signal subtitle, interface bővítve. |
| **H** | (G-vel együtt) | UI félrevezetés. | Lásd G. |

#### Részletek

**A — vol_divergence horizon gate**. A `getVolSignal` képlete a Black-
Scholes binary option pricing közelítése, ami `T → 0` limit-en
divergens (√T → 0 a nevezőben). A BTC 5m piacon `T = 5min / (365 × 24 × 60)
= 9.5e-6`, `√T = 0.003`. Bármely `yp ≠ 0.5` esetén az iv hatalmas (több
ezer %), spread = iv − rv_60% szintén nagy, prob = clamp 0.1. **A
signal a teljes BTC short-piac univerzumban konstans 0.1.**

Empirikus verifikáció: a 3 nyitott pozíció (28. session) mindegyikén
`vol_divergence: 0.1` volt. A fix után `null` → `activeSignals` 8 → 7.

**B — bankroll invariáns**. Bizonyítás:
- `addOpenPosition`: `bankrollCurrent ← bankrollCurrent − costBasis`
- `closePosition` (régi): `bankrollCurrent ← bankrollCurrent + shares × exitPrice = bankrollCurrent + proceeds`
- `sessionPnL ← sessionPnL + trade.pnl` (= `proceeds − fee − costBasis`)
- net: `Δbankroll = proceeds − costBasis = pnl + fee`
- `ΔsessionPnL = pnl`
- **drift per trade = fee** (~3.6% × notional)

Új képlet: `bankrollCurrent ← bankrollCurrent + (trade.pnl + costBasis)`
→ `Δbankroll = pnl + costBasis − costBasis = pnl`. ✓

**C — apex activity score**. A `/data-api.polymarket.com/trades` feed
NEM tartalmaz settlement-eseményeket. Egy wallet ami csak BUY-olt és
nyert nem mutat realised PnL-t ezen az endpoint-on. A régi képlet
ezért szisztematikusan a **top sellers**-t hozta vissza, NEM a top
profitable wallets-et. Az új score `notional × √markets` a wallet
**aktivitását + diverzitását** méri, ami arányos proxy az informált
flow-ra.

**D — cond_prob direction-aware**. A monotonicity violation
matematikailag: ha P(A by t_earlier) > P(A by t_later) + ε →
arbitrage. A korábbi market YES > later market YES → vagy a later
underpriced (YES bias erre) vagy a earlier overpriced (NO bias arra).
Az adott piacunk irányát a relatív pozíció határozza meg. A régi kód a
magnitúdót vette, de az irányt csak a complement-check-ből származtatta
→ a két komponens **mismatched** vehetett.

**E — momentum regime**. Empirikus megfigyelés a Polymarket
microstructure-ben: a YES midpoint kis (\|Rcum\| < 5%) mozgásai
információ-driven (Jegadeesh-Titman trend), nagy mozgásai likviditás-
shock (mean-revert). A két regime ellentétes irányba prediktál ugyanazon
piacra; nem szabad ugyanazt a coefficient-et használni.

#### Hatás a paper-validációra

A 8 fix után a `Calibration Health` badge mostantól érdemi IC-t kellene
mérnie 30+ trade után. A jelek tisztábbak (vol nincs konstans bias,
apex top-N pontosabb, cond_prob és momentum direction-aware). Ha a
badge továbbra is `noise`, a `signal-aggregator` IC-súlyok kalibrálása
következik (Hova nyúlj legközelebb #1 a 30. session-ben).

---

### 2026-05-11 audit round 1 — 6 új hiba (gate layer)

A bot live `mj-trading.netlify.app/trade/crypto/` 3 nyitott paper pozícióját
vizsgáltam. A 9-gates rendszer mindhárom trade-et átengedte azonos mintázat
mellett: `finalProb ≈ 0.505`, `kellyRaw = 0.03%`, $1 méret. A combiner saját
ajánlása "WATCH"/"WAIT" volt, a resolution-risk vétót vetózott, de a trader
egyik mezőt sem nézte.

| ID | Probléma (pre-fix) | Status | Fix lényege |
|----|---------------------|--------|-------------|
| **#1** | `Math.max(1, bankroll * kellyCapped)` $1 hard floor — 0.03% Kelly × $250 = $0.075 javasolt, de $1 lett ténylegesen allokálva (13× over-sized). | ✅ FIXED | `decision-engine.mts:230` floor eltávolítva. Új gate #11 "Kelly méret ≥ minimum" explicit pass/fail kontroll. `MIN_POSITION_SIZE_USDC` env var (default 0.50) + Settings knob `minPositionSizeUSDC`. |
| **#2** | `signal-aggregator.mts:77-83` csak `combined_probability` + `kelly.quarter`-t olvasott. A combiner saját `recommendation.action`-je + `trade_recommended` flag-je teljesen ignorálva. | ✅ FIXED | `AggregatedSignal`-re 3 új optional mező: `combinerRecommendation`, `tradeRecommendedByRisk`, `adjustedProbability`. Aggregator most átemeli ezeket a combiner válaszából. |
| **#3** | Combiner saját `recommend()`-je `WAIT`/`WATCH`/`SKIP`-et adott, de a trader nem nézte. Egyetlen védelem (`kellyFraction > 0`) átengedett 0.0001 Kelly-t is. | ✅ FIXED | Új gate #4 "Combiner recommendation" — pass csak ha `recAction.startsWith("BUY")`. WAIT/WATCH/SKIP/null mind blokk. |
| **#4** | `finalProb ≈ 0.5` valójában "nincs signal" (a 8 raw jelzés mindegyike 0.5-höz konvergál input nélkül), de a trader 25%-os edge-et látott a 0.255-ös marketPrice ellenében. | ✅ FIXED | Új gate #3 "Combiner confidence (\|p − 0.5\|)" — küszöb 5% default, megegyezik a combiner saját `recommend()` WAIT-küszöbével. |
| **#5** | `data.trade_recommended = false` (resolution-risk veto) a UI-on látszott, de a trader nem olvasta. | ✅ FIXED | Új gate #5 "Resolution-risk gate" — pass csak ha `tradeRecommendedByRisk !== false`. `null` = helper nem futott → gate passes (defensive). |
| **#6** | `paper-resolver.mts` `pnl = proceeds − costBasis` képletet használt, fee nélkül. Decision-engine `netEdge = grossEdge − 0.036` küszöböléssel gate-elt, így paper PnL szisztematikusan optimistábbnak látszott mint live. | ✅ FIXED | `applySettlementFee(pnlGross, proceeds, costBasis, feePct)` helper. Fee = `max(proceeds, costBasis) × roundtripFeePct`. A `PAPER_RESOLVED` log entry mostantól `pnlGross + pnlNet + feePct` mind kiírja. |

**Nem-trivialis következmény:** a régi 9-gates rendszerből a "Kelly conviction (combiner > 0)" gate KIKERÜLT. Az új "Kelly méret ≥ minimum" (#11) funkcionálisan ekvivalens (mindkettő blokkolja a 0-Kelly trade-et), csak konkrét $ küszöbön ellenőriz a 0-küszöb helyett. Y: 9 → 12. UI auto-rendererel a `gates.length`-ből.

**Magyarázat a UI gate-listán:** sorrendben mostantól 12 chip jelenik meg a "Why?" panelen + a scan row inline blocker line-on. A 3 új konvergencia-gate (#3 #4 #5) a "Aktív signal források" után, a "Market cooldown" előtt, hogy a kemény gate-ek elöl legyenek.

### 2026-05-10 audit — 6 régi hiba

Az alábbi 6 hiba 2026-05-10-ben került javításra ugyanazon a napon. A status oszlop a deployment utáni állapotot mutatja.

| ID | Probléma (pre-fix) | Status | Fix lényege |
|----|---------------------|--------|-------------|
| **A** | Live exit code (`checkExitConditions` / `handleSellLifecycle` / `emergencySell`) definiált, de **NEM hívott** semmiből. Sem TP/SL early exit, sem live settlement reconciliation. | ✅ FIXED | (1) Új `live-price.mts:fetchYesMidpoint`. (2) Új `runLiveEarlyExits` orchestrator a `runCryptoTrader`-ben, max 3 pozíció/tick, endDate ASC sorted, paperMode skip. (3) `paper-resolver.mts:resolvePendingPositions` általánosítva — paper + live módra is fut, live close `requiresRedeem: true` flag-gel logol (manuális `/polymarket-redeem` szükséges). (4) `Position.clobTokenIds` mező hozzáadva hogy a sell-side tudja a token-id-kat lookup nélkül. |
| **B** | `netlify.toml` `auto-trader` schedule közvetlenül a function URL-t hívta, így `?source=cron` query nem érkezett meg → run-state "manual"-ként tag-elte. | ✅ FIXED | `auto-trader/index.mts` body parse mostantól `body.next_run` jelenlétét ellenőrzi (Netlify scheduled function payload jellemzője). Ha jelen → `isScheduledTick=true` → source override "cron"-ra. HL + weather útvonalakra is alkalmazva. |
| **C** | `SignalBreakdown` típus 5 mezős, de a `signal-combiner` 8 jelzést számol. A 3 új jelzés bemegy a Kelly-be, de UI "Why?" panel + IC számítás nem érinti őket. | ✅ FIXED | `types.mts:SignalBreakdown` 8 mezőre kibővítve. `extractBreakdown` + fallback path + `formatSignalArrows` + `edge-tracker/statistics.mts:SIGNAL_NAMES` + `mock-trades.mts` + UI `SIGNAL_ORDER` + `TraderResults.tsx:SIGNAL_LABELS` mind 8 jelzéssel. HL signal-source már korábban populated 8 mezőt; most a típus is matchel. |
| **D** | `sessionSummary()` helper nem tartalmazta `simVersion`-t. `getCryptoRunStatus` stale-result invalidation csak a `liveReadiness.summary.simVersion` fallback-on át működött. | ✅ FIXED | `sessionSummary` mostantól `simVersion: s.simVersion ?? null`-t is visszaad. |
| **E** | Live `handleBuyLifecycle` `shares = size / placement_price`-t használ, nem a tényleges fill price-t — partial fill / better-than-limit fill esetén a session state pontatlan. | ✅ FIXED | Új `execution.mts:fetchOrderFillDetail(orderId)` → `getOrder` → `size_matched` + `price`. `handleBuyLifecycle` live FILLED ágban most ezt használja, fallback a placement értékekre ha az API nem ad jó adatot. Defensive field-name spelling: `size_matched ?? sizeMatched ?? executedSize ?? filledSize`. |
| **F** | `getMomentumSignal` ugyanazon slug `?slug=` lekéréssel vette a "past price"-t → ugyanazt az aktuális ár-t kapta vissza. A `Math.abs(...) < 0.001` branch elsült, "distance proxy"-ra esett — effektíven a market polaritását mérte, nem momentum-ot. | ✅ FIXED | `signal-combiner.mts:getMomentumSignal` átírva. Új `momentum-snapshots` Blobs store, per-slug `{ ts, yes }` snapshot. Minden hívás: olvas snapshot, ha age ∈ [60s, 1h] → real Rcum vs snapshot, ha túl friss/régi → neutral 0.5. Snapshot mindig frissítve a current value-ra. A combiner 3min cache miatt 3-15 min look-back ablakot ad. |

### 2026-05-14e — Cross-market consistency gate (monotonicity)

**Trigger**: az élő paper session 2026-05-14-én demonstrálta hogy a
decision-engine **per-trade** értékel, a már nyitott pozíciókat nem
nézi. A bot nyitotta `bitcoin-above-78k-on-may-14` NO @ pred=52% és
`bitcoin-above-80k-on-may-14` YES @ pred=53% pozíciókat — `{>80K} ⊂
{>78K}` matematikailag, ezért `P(>78K) ≥ P(>80K)` invariáns. A 52% <
53% **monotonicitás-sértés**, és a $79K körüli zóna mindkét pozíciónak
loser.

**Fix**: új non-short-circuit gate `Monotonicitás (egyéb nyitott
pozíciók)` a `CRYPTO_GATE_LABELS[14]` pozícióban. A `makeDecision()`
új opcionális paramétere `openPositions: Position[] = []` — az
`auto-trader/index.mts` átadja a live `updatedSession.openPositions`-t.
A gate logika:

1. Parse-old a kandidátus slug-ot `parseBtcAboveSlug()`-gal — ha nem
   illik a `(?:bitcoin|btc)-(?:be-)?above-(\d+(?:\.\d+)?)k(?:-on-(.+))?`
   mintára, `n/a (nem BTC-above-K piac)` és pass.
2. Gyűjtsd ki az openPositions BTC-above-K elemeit + parseolt
   `predictedProb`-jukat (ami a model YES-prob a belépéskor).
3. A `findMonotonicityViolation()` shared helper csoportosít
   `closingKey` szerint és ellenőrzi:
   - `K_new > K_existing && predNew > predExisting` → violation
   - `K_new < K_existing && predNew < predExisting` → violation
   - Equal K-knál nincs monotonicitás-kérdés (pass).

A predicted-YES probability mindig a model finalProb (függetlenül attól
hogy a bot YES vagy NO oldalt választott a piacon — a model belief
attribútuma a YES-prob, nem a side-é).

**Reprodukció**: a `shared/cross-position-gates.test.mts` lefedi a
2026-05-14 inputot:

```ts
findMonotonicityViolation(
  { K: 80, closingKey: "may-14", predictedYesProb: 0.53 },
  [{ K: 78, closingKey: "may-14", predictedYesProb: 0.52, slug: "..." }],
) !== null;  // PASS — violation flagged
```

A test 6 case-t fed le: live-incident, reverse-direction, consistent
monotonic, different closingKey, equal K, empty list.

---

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
│   ├── decision-engine.mts            ← 15 gate, Kelly, edge, direction, monotonicity (cross-position)
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
- `current-state/architecture.md` — Cross-bot architektúra snapshot
- `archive/paper-pnl-v2-bug.md` — A v2 fake-PnL bug forensic analízise
- `changelog/CHANGELOG-2026-05-09.md` — simVersion 2 → 3 átmenet
- `changelog/CHANGELOG-2026-05-10.md` — Kelly conviction gate + Why? panel
