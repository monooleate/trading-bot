# EdgeCalc Auto-Trader – Claude Code Prompt

> Másold be ezt a teljes promptot egy új Claude Code sessionbe.  
> A rendszer Sprint 1-gyel indul: Crypto Execution Core.

---

## SZEREPED

Te egy senior TypeScript fejlesztő vagy, aki egy Polymarket auto-trading rendszert épít.
A rendszer neve: **EdgeCalc Auto-Trader**.
Iteratív módon dolgozol: minden lépés előtt megmutatod mit fogsz csinálni, majd megcsinálod.
Ha valamiben nem vagy biztos, kérdezel – nem találsz ki dolgokat.

---

## KONTEXTUS: MI MÁR VAN (EdgeCalc v8)

Egy működő Polymarket elemző dashboard létezik az alábbi Netlify Functions endpointokkal,
amelyeket újrahasználunk (NEM írjuk újra):

| Endpoint | Mit csinál | Cache |
|---|---|---|
| `/funding-rates` | Binance funding rate anomália score | 8 óra |
| `/orderflow-analysis` | Kyle λ + VPIN + Hawkes MLE score | 5 perc |
| `/vol-divergence` | IV vs RV spread (Binance klines + PM implied vol) | 2 perc |
| `/apex-wallets` | Top wallet tracking + bot detector + consensus | 5-10 perc |
| `/signal-combiner` | IR = IC × √N kombinátor, 5 szignál aggregálva | 3 perc |
| `/cond-prob-matrix` | Monotonicity violation scanner | 5 perc |
| `/polymarket-trade` | CLOB order execution alap (kibővítjük) | – |

### Signal-combiner IC súlyok (meglévő logika):
```
vol_divergence:  IC = 0.06
orderflow:       IC = 0.09  ← legerősebb
apex_consensus:  IC = 0.08
cond_prob:       IC = 0.07
funding_rate:    IC = 0.05
```

Output: `final_prob` [0–1] + `kelly_fraction` [0–1]

### Tech stack:
- Frontend: Astro 5 + React 18
- Backend: Netlify Functions (TypeScript)
- Cache: Netlify Blobs KV store
- Auth: JWT + SHA-256

---

## A RENDSZER FELÉPÍTÉSE (4 KATEGÓRIA)

A felhasználó az elején kategóriát választ. Minden kategóriának saját strategy engine-je van.

### Kategória választó flow:

```
START
  │
  ▼
┌─────────────────────────────────────────┐
│         KATEGÓRIA VÁLASZTÓ              │
├──────────┬──────────┬──────────┬────────┤
│ 🪙 CRYPTO│ ⚽ SPORTS│🏛️ POLITICS│📊 MACRO│
│ 18% vol  │ 39% vol  │ 34% vol  │ ~9%   │
│ fee: 1.8%│ fee: 0.6%│ fee: ~1% │ fee:? │
│ AUTO     │ ALERT    │ ALERT    │ ALERT │
└──────────┴──────────┴──────────┴────────┘
```

### Kategóriák részletesen:

**🪙 CRYPTO** – Sprint 1, teljesen automatizált
- Edge: funding rate + VPIN + vol divergence + whale consensus
- Fő piac: BTC 5m és 15m Up/Down piacok
- Min. edge threshold: **15%** (fee 1.8% miatt magasabb!)
- EdgeCalc szignál infrastruktúra 80%-a kész

**⚽ SPORTS** – Sprint 2, alert-alapú + manuális konfirmáció
- Edge: statisztikai modell vs. fan/narratíva bias
- Piacok: NBA, NFL, Premier League, Champions League
- Min. edge threshold: **8%** (fee csak 0.6%)
- Új logika kell: form, head-to-head, home advantage stats

**🏛️ POLITICS** – Sprint 3, alert-alapú + manuális konfirmáció
- Edge: LLM news sentiment + poll aggregation vs. crowd
- Claude API már be van kötve az EdgeCalc-ban
- Slow-moving piacok, napokban mérjük a reakcióidőt

**📊 MACRO/EGYÉB** – Sprint 4, threshold alert
- Edge: NOAA weather data, Fed calendar, economic indicators
- Legkevésbé hatékony piacok → legnagyobb potenciális edge
- Szignál: Open-Meteo API, Fed meeting schedule, CPI dátumok

---

## SPRINT 1: CRYPTO EXECUTION CORE

**Ez az egyetlen sprint amit most megvalósítunk.**
A többi kategória csak placeholder struktúra (üres mappák + TODO kommentek).

### Teljes rendszer architektúra (Sprint 1):

```
┌─────────────────────────────────────────────────────────┐
│  SIGNAL LAYER  (EdgeCalc örökölt – csak hívjuk)         │
│                                                         │
│  GET /funding-rates     → fr_score [0-1]                │
│  GET /orderflow-analysis → vpin_score, lambda_score     │
│  GET /vol-divergence    → vol_score [0-1]               │
│  GET /apex-wallets      → consensus_score [0-1]         │
│  GET /signal-combiner   → final_prob, kelly_fraction    │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│  DECISION ENGINE  (új)                                  │
│                                                         │
│  edge = |final_prob - market_price|                     │
│  edge_threshold:    > 0.15 (15%)                        │
│  kelly_cap:         max 20% bankroll per trade          │
│  min_liquidity:     $500 open interest minimum          │
│  cooldown:          300s ugyanazon market_slug után     │
│  session_loss_limit: konfigurálható (pl. -$50)          │
│  direction:         YES ha final_prob > market_price    │
│                     NO  ha final_prob < market_price    │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│  EXECUTION LAYER  (polymarket-trade.ts kibővítve)       │
│                                                         │
│  Library:  @polymarket/clob-client-v2 + viem            │
│  WebSocket: @polymarket/real-time-data-client           │
│                                                         │
│  Order types:                                           │
│    GTC – normál limit order (default)                   │
│    FOK – fill or kill (emergency exit)                  │
│                                                         │
│  Order lifecycle:                                       │
│    postOrder() → orderId                                │
│    onFilled()  → sell trigger (take profit)             │
│    onExpired() → emergency sell (FOK best bid)          │
│    onFailed()  → retry logika (max 3x buy, ∞ sell)     │
│                                                         │
│  PAPER_MODE=true → minden logika fut, POST nem megy ki  │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│  MONITORING                                             │
│                                                         │
│  Telegram: trade alert, fill confirm, PnL, /stop        │
│  NDJSON log: minden trade esemény időbélyeggel          │
│  Session state: JSON file (paper: session.json,         │
│                             live: session-live.json)    │
└─────────────────────────────────────────────────────────┘
```

---

## FÁJL STRUKTÚRA

```
/netlify/functions/
  auto-trader/
    index.ts                  ← fő belépési pont + kategória router
    crypto/
      btc-market-finder.ts    ← Gamma API: aktuális BTC 5m/15m piacok
      signal-aggregator.ts    ← EdgeCalc endpointok hívása + aggregálás
      decision-engine.ts      ← edge threshold + kelly + cooldown
      execution.ts            ← clob-client-v2 order management
      order-lifecycle.ts      ← fill/expire/emergency sell callbacks
      session-manager.ts      ← bankroll, session loss, state
    sports/
      index.ts                ← TODO: Sprint 2
    politics/
      index.ts                ← TODO: Sprint 3
    macro/
      index.ts                ← TODO: Sprint 4
    shared/
      telegram.ts             ← Telegram bot alerts
      logger.ts               ← NDJSON trade log
      types.ts                ← közös TypeScript típusok
      config.ts               ← env vars + konstansok

/src/components/trader/
  CategorySelector.tsx        ← 4 kategória választó UI
  CryptoTrader.tsx            ← crypto trader dashboard
  TraderStatus.tsx            ← paper/live státusz, session PnL
```

---

## TECHNIKAI SPECIFIKÁCIÓ

### Env vars (hozzáadandók a meglévő EdgeCalc .env-hez):

```env
# Polymarket
POLY_PRIVATE_KEY=0x...          # Polygon wallet private key
POLY_FUNDER_ADDRESS=0x...       # Polymarket proxy wallet address
POLY_SIGNATURE_TYPE=1           # 1=Magic/email, 0=MetaMask/EOA

# Auto-trader config
PAPER_MODE=true                  # true=paper trading, false=live
SESSION_LOSS_LIMIT=50            # USD, auto-stop ha eléri
MAX_KELLY_FRACTION=0.20          # max 20% bankroll per trade
EDGE_THRESHOLD_CRYPTO=0.15       # 15% minimum edge crypto piacokon
COOLDOWN_SECONDS=300             # 5 perc cooldown per market

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### Polymarket API endpointok:

```typescript
// Gamma API – piac discovery
const GAMMA_API = "https://gamma-api.polymarket.com"

// BTC 5m piacok keresése:
GET /markets?tag=crypto&slug=btc-updown-5m-*&active=true&order=volume&limit=5

// CLOB API – order execution
const CLOB_API = "https://clob.polymarket.com"

// WebSocket – real-time order book
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
```

### clob-client-v2 inicializálás:

```typescript
import { ClobClient } from "@polymarket/clob-client-v2"
import { createWalletClient, http } from "viem"
import { polygon } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"

const account = privateKeyToAccount(process.env.POLY_PRIVATE_KEY as `0x${string}`)
const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http()
})

const clobClient = new ClobClient({
  host: "https://clob.polymarket.com",
  chain: 137,
  signer: walletClient,
  creds: await clobClient.createOrDeriveApiKey()
})
```

### Order elhelyezés pattern:

```typescript
// BUY order (GTC)
const order = await clobClient.createAndPostOrder(
  {
    tokenID: market.clobTokenIds[side],  // YES vagy NO token
    price: entryPrice,                   // 0.00–1.00
    side: Side.BUY,
    size: positionSizeUSDC,
  },
  { tickSize: "0.01", negRisk: false },
  OrderType.GTC
)

// Emergency SELL (FOK – best bid)
const bestBid = orderBook.getBestBid(side)
const sellOrder = await clobClient.createAndPostOrder(
  {
    tokenID: market.clobTokenIds[side],
    price: bestBid,
    side: Side.SELL,
    size: heldShares,
  },
  { tickSize: "0.01", negRisk: false },
  OrderType.FOK
)
```

### Decision engine logika:

```typescript
interface TradeDecision {
  shouldTrade: boolean
  direction: "YES" | "NO"
  positionSizeUSDC: number
  entryPrice: number
  reason: string
}

function makeDecision(
  finalProb: number,         // signal-combiner output
  kellyFraction: number,     // signal-combiner output
  marketPrice: number,       // current YES price on CLOB
  bankrollUSDC: number,
  config: TraderConfig
): TradeDecision {
  const edge = Math.abs(finalProb - marketPrice)
  const direction = finalProb > marketPrice ? "YES" : "NO"

  if (edge < config.edgeThreshold) {
    return { shouldTrade: false, reason: `Edge ${(edge*100).toFixed(1)}% < threshold ${(config.edgeThreshold*100)}%` }
  }

  const kellyCapped = Math.min(kellyFraction, config.maxKellyFraction)
  const positionSize = bankrollUSDC * kellyCapped

  return {
    shouldTrade: true,
    direction,
    positionSizeUSDC: positionSize,
    entryPrice: direction === "YES" ? marketPrice + 0.01 : 1 - marketPrice - 0.01,
    reason: `Edge ${(edge*100).toFixed(1)}%, Kelly ${(kellyCapped*100).toFixed(1)}%`
  }
}
```

### Session manager (state persistence):

```typescript
interface SessionState {
  startedAt: string
  bankrollStart: number
  bankrollCurrent: number
  sessionPnL: number
  sessionLoss: number          // csak vesztes trade-ek összege
  tradeCount: number
  openPositions: Position[]
  paperMode: boolean
}

// State mentés minden trade után:
// paper mode: /tmp/session.json
// live mode:  Netlify Blobs "auto-trader-session" key
```

### Telegram alert formátum:

```
🟢 TRADE OPEN [PAPER]
Market: BTC Up/Down 5m
Direction: YES (UP)
Entry: $0.47
Size: $12.50 (8.3% bankroll)
Edge: 17.2% | Kelly: 9.1%
Signals: FR↑ VPIN↑ VOL↑
─────────────────
💰 TRADE CLOSED [PAPER]
Result: +$4.20 (+33.6%)
Session PnL: +$8.40
Open positions: 0
```

### NDJSON log formátum:

```json
{"ts":"2026-04-12T10:00:00Z","event":"SIGNAL","market":"btc-updown-5m-1234","final_prob":0.64,"market_price":0.47,"edge":0.17,"kelly":0.091}
{"ts":"2026-04-12T10:00:01Z","event":"ORDER_PLACED","orderId":"abc123","direction":"YES","price":0.48,"size":12.50,"paper":true}
{"ts":"2026-04-12T10:05:00Z","event":"ORDER_FILLED","orderId":"abc123","filledShares":26.04,"cost":12.50}
{"ts":"2026-04-12T10:10:00Z","event":"SELL_PLACED","orderId":"def456","price":0.62,"shares":26.04}
{"ts":"2026-04-12T10:10:30Z","event":"TRADE_CLOSED","pnl":4.20,"pnl_pct":33.6,"session_pnl":8.40}
```

---

## REFERENCIA REPÓK (tanulmányozd ezeket először)

1. **@polymarket/clob-client-v2** (official, legfrissebb)
   `https://github.com/Polymarket/clob-client-v2`
   → Ez az execution library. Nézd meg az `/examples` mappát.

2. **@polymarket/real-time-data-client** (official WebSocket)
   `https://github.com/Polymarket/real-time-data-client`
   → Order book WebSocket feed. A subscribe pattern kritikus.

3. **KaustubhPatange/polymarket-trade-engine** (legjobb community referencia)
   `https://github.com/KaustubhPatange/polymarket-trade-engine`
   → Nézd meg: `engine/market-lifecycle.ts` és `engine/strategy/simulation.ts`
   → Az order lifecycle pattern (GTC → onFilled → sell chain) innen jön.

4. **Polymarket/agents** (official AI agent referencia)
   `https://github.com/Polymarket/agents`
   → Gamma API market discovery pattern, connector struktúra.

---

## FEJLESZTÉSI SORREND SPRINT 1-EN BELÜL

Az alábbi sorrendben haladjunk, minden lépést tesztelj paper mode-ban:

### Lépés 1: Projekt setup
- `@polymarket/clob-client-v2` és `viem` hozzáadása a package.json-hoz
- `@polymarket/real-time-data-client` hozzáadása
- Env vars hozzáadása
- `shared/types.ts` és `shared/config.ts` megírása

### Lépés 2: BTC market finder
- `crypto/btc-market-finder.ts`
- Gamma API hívás: aktuális aktív BTC 5m piacok lekérése
- Output: `{ slug, tokenIds, currentPrice, openInterest, timeRemaining }`
- Szűrés: csak aktív piacok, min. $500 open interest

### Lépés 3: Signal aggregator
- `crypto/signal-aggregator.ts`
- Párhuzamos fetch: mind az 5 EdgeCalc endpoint
- Timeout: 8 másodperc (ha valamit nem kap meg, kihagyja)
- Output: `{ finalProb, kellyFraction, signalBreakdown }`

### Lépés 4: Decision engine
- `crypto/decision-engine.ts`
- Edge számítás, threshold check, kelly cap
- Cooldown tracker (in-memory Map)
- Session loss check

### Lépés 5: Execution layer
- `crypto/execution.ts` + `crypto/order-lifecycle.ts`
- clob-client-v2 inicializálás
- PAPER_MODE branch: log helyett küld
- GTC buy → fill callback → GTC sell
- Expire callback → FOK emergency sell

### Lépés 6: Session manager
- `crypto/session-manager.ts`
- State olvasás/írás (paper: /tmp, live: Netlify Blobs)
- PnL számítás
- Session loss auto-stop

### Lépés 7: Monitoring
- `shared/telegram.ts` – Telegram Bot API (nem library, natív fetch)
- `shared/logger.ts` – NDJSON append
- Alert típusok: SIGNAL_FOUND, TRADE_OPEN, TRADE_CLOSED, SESSION_STOP

### Lépés 8: Fő belépési pont
- `auto-trader/index.ts`
- Netlify Function handler
- Kategória router (most csak crypto ág aktív)
- Scheduled trigger: minden 3 percben fut (netlify.toml cron)

### Lépés 9: CategorySelector UI
- `src/components/trader/CategorySelector.tsx`
- 4 gomb: Crypto, Sports, Politics, Macro
- Crypto aktív, többi "Hamarosan" badge-dzsel
- Kiválasztás után: CryptoTrader.tsx betölt

### Lépés 10: Paper trading teszt
- Legalább 10 kör paper mode-ban
- NDJSON log ellenőrzése
- Telegram alertek tesztelése
- Csak ezután kerülhet szóba a live mode

---

## FONTOS MEGSZORÍTÁSOK

1. **Soha ne commitold a .env fájlt.** POLY_PRIVATE_KEY különösen kritikus.

2. **PAPER_MODE=true legyen default.** Live mode-hoz explicit `PAPER_MODE=false` kell.

3. **Session loss limit kötelező.** Ha nincs beállítva env varban, default: $20.

4. **Fee számítás:** Minden edge kalkulációban vond le a 1.8% taker fee-t MINDKÉT oldalról (entry + exit). Valódi edge = gross_edge - 0.036 (3.6% roundtrip).

5. **Partial fill kezelés:** `onFilled(filledShares)` értéket használd, NEM az eredeti `size`-t.

6. **Emergency sell retry:** Ha FOK rejected (bid moved), várj 100ms, olvasd újra a best bid-et, próbáld újra. Maximum a slot végéig.

7. **Cooldown Map** memóriában él – Netlify Function restart törli. Ez elfogadható.

8. **Rate limits:** Gamma API: max 10 req/sec. CLOB API: max 100 req/sec. WebSocket: 1 connection per market.

---

## DEFINÍCIÓ OF DONE (Sprint 1)

- [ ] Paper mode-ban legalább 10 kereskedési kör lefut hiba nélkül
- [ ] Minden trade esemény NDJSON logban megjelenik
- [ ] Telegram alertek megérkeznek (OPEN + CLOSED)
- [ ] Session loss limit triggerelhető teszteléssel
- [ ] CategorySelector UI megjelenik, Crypto tab betölt
- [ ] A kód átmegy TypeScript strict mode ellenőrzésen
- [ ] README.md a `/netlify/functions/auto-trader/` mappában

---

## MIRE NE VESZTEGESD AZ IDŐT

- Ne írj új szignál logikát – az EdgeCalc endpointok már megcsinálják
- Ne implementálj saját WebSocket reconnect logikát – a real-time-data-client kezeli
- Ne csinálj UI-t a trade history-hoz most – az a Sprint 4 Tab 12-je lesz
- Ne optimalizálj teljesítményt – először működjön paper mode-ban

---

*Kész vagy? Kezdd a Lépés 1-gyel: projekt setup és types.ts.*
