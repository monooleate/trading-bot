# EdgeCalc Hyperliquid Auto-Trader – Claude Code Prompt

> Másold be ezt a teljes promptot egy új Claude Code sessionbe.
> Ez a Hyperliquid execution sprint – Hetzner VPS-en fut, Netlify-tól
> kap szignálokat, 24/7 önállóan kereskedik.

---

## SZEREPED

Te egy senior TypeScript fejlesztő vagy, aki egy Hyperliquid
perpetual futures auto-trader execution engine-t épít.
Iteratív módon dolgozol: minden lépés előtt megmutatod mit fogsz
csinálni, majd megcsinálod. Ha valamiben nem vagy biztos, kérdezel.

---

## KONTEXTUS: A TELJES RENDSZER

### Hibrid architektúra:

```
NETLIFY (meglévő, nem változik)
  Cron 3 percenként fut:
    /funding-rates      → FR anomália score
    /orderflow-analysis → VPIN + Kyle λ score
    /vol-divergence     → IV vs RV spread score
    /apex-wallets       → whale consensus score
    /signal-combiner    → final_prob + kelly_fraction
    Ha edge > 15%:
      HTTP POST → Hetzner szerver webhook
      { coin, direction, size_usdc, kelly, edge, signals }

HETZNER CX22 VPS (ez az amit most építünk)
  Folyamatosan fut (PM2):
    WebSocket feed Hyperliquid-ről
    Webhook fogadás Netlify-tól
    Order lifecycle management
    Session state memóriában
    Telegram alerts
    NDJSON trade log
```

### Amit a Netlify küld (bejövő webhook payload):

```typescript
interface TradeSignal {
  coin: "BTC" | "ETH" | "SOL" | "XRP"
  direction: "LONG" | "SHORT"
  size_usdc: number          // Kelly-alapú pozíció méret USD-ben
  kelly: number              // Kelly fraction [0-1]
  edge: number               // edge % [0-1]
  signals: {
    funding_rate: number     // [0-1]
    vpin: number             // [0-1]
    vol_divergence: number   // [0-1]
    apex_consensus: number   // [0-1]
    cond_prob: number        // [0-1]
  }
  timestamp: string          // ISO 8601
  paper: boolean             // true = paper mode
}
```

---

## MIT ÉPÍT EZ A SPRINT

### Teljes execution engine Hetzner-en:

```
edgecalc-trader/
  index.ts                  ← fő belépési pont, HTTP server
  config.ts                 ← env vars + konstansok
  types.ts                  ← TypeScript típusok
  execution/
    hl-client.ts            ← Hyperliquid SDK inicializálás
    order-manager.ts        ← order lifecycle (place/fill/cancel)
    position-tracker.ts     ← nyitott pozíciók state
    session-manager.ts      ← bankroll, session loss, state
  strategy/
    signal-receiver.ts      ← Netlify webhook fogadás
    decision-gate.ts        ← utolsó szűrők live módban
    kelly-sizer.ts          ← position sizing binary→perp konverzió
    volatility-gate.ts      ← 12 gyertya RV filter
  monitoring/
    telegram.ts             ← Telegram bot alerts
    logger.ts               ← NDJSON trade log
    health-check.ts         ← /health endpoint PM2-nek
  scripts/
    setup.sh                ← Hetzner VPS setup script
    deploy.sh               ← git pull + pm2 restart
```

---

## TECHNIKAI SPECIFIKÁCIÓ

### SDK választás: @nktkas/hyperliquid

Ez a legjobb minőségű TypeScript SDK, bun-kompatibilis:

```bash
bun add @nktkas/hyperliquid viem
```

### Hyperliquid kliens inicializálás:

```typescript
// execution/hl-client.ts
import {
  HttpTransport,
  WebSocketTransport,
  InfoClient,
  ExchangeClient,
  SubscriptionClient,
} from "@nktkas/hyperliquid"
import { privateKeyToAccount } from "viem/accounts"

const wallet = privateKeyToAccount(
  process.env.HL_PRIVATE_KEY as `0x${string}`
)

// HTTP kliens (order placement)
const httpTransport = new HttpTransport({
  isTestnet: process.env.PAPER_MODE === "true",
})
export const info = new InfoClient({ transport: httpTransport })
export const exchange = new ExchangeClient({
  transport: httpTransport,
  wallet,
})

// WebSocket kliens (real-time feed)
const wsTransport = new WebSocketTransport({
  isTestnet: process.env.PAPER_MODE === "true",
})
export const subs = new SubscriptionClient({ transport: wsTransport })
```

### Order placement (Hyperliquid perp):

```typescript
// LONG nyitás BTC-re
await exchange.order({
  orders: [{
    a: 0,            // asset index (0 = BTC)
    b: true,         // true = buy/long
    p: entryPrice,   // limit price string
    s: sizeInCoins,  // méret (BTC mennyiség)
    r: false,        // reduce only = false
    t: { limit: { tif: "Gtc" } },  // GTC order
  }],
  grouping: "na",
})

// SHORT nyitás
await exchange.order({
  orders: [{
    a: 0,
    b: false,        // false = sell/short
    p: entryPrice,
    s: sizeInCoins,
    r: false,
    t: { limit: { tif: "Gtc" } },
  }],
  grouping: "na",
})

// Pozíció zárás (reduce only)
await exchange.order({
  orders: [{
    a: 0,
    b: direction === "LONG" ? false : true,  // ellentétes irány
    p: exitPrice,
    s: heldSize,
    r: true,         // reduce only = true!
    t: { limit: { tif: "Gtc" } },
  }],
  grouping: "na",
})
```

### Asset index map:

```typescript
const ASSET_INDEX: Record<string, number> = {
  "BTC":  0,
  "ETH":  1,
  "SOL":  2,
  "XRP":  3,
  "DOGE": 5,
  "AVAX": 6,
  // bővíthető info.meta() alapján
}
```

### Kelly sizing – binary → perp konverzió:

```typescript
// Polymarketen a Kelly bináris piacra volt számolva
// Hyperliquid perp-en más a matematika

function kellyToPerpSize(params: {
  bankrollUSDC: number
  kellyFraction: number   // Netlify signal-combiner outputja
  edge: number            // expected edge
  currentPrice: number    // BTC jelenlegi ára
  leverage: number        // max leverage amit használunk (default: 3x)
  maxPctBankroll: number  // max 15% bankroll per trade
}): number {
  // Konzervatív Kelly: fraction × 0.25 (quarter Kelly)
  const conservativeKelly = params.kellyFraction * 0.25

  // Max bankroll cap
  const cappedFraction = Math.min(
    conservativeKelly,
    params.maxPctBankroll
  )

  // USD méret
  const sizeUSDC = params.bankrollUSDC * cappedFraction

  // Perp méret coinban (leverage-gel)
  const sizeInCoins = (sizeUSDC * params.leverage) / params.currentPrice

  // Kerekítés 3 tizedesjegyre (HL minimum)
  return Math.round(sizeInCoins * 1000) / 1000
}
```

### Volatility gate (12 gyertya RV filter):

```typescript
// Ha BTC 12 gyertyán (1h) magas volatilitást mutat
// a rendszer NEM nyit új pozíciót
async function volatilityGate(coin: string): Promise<{
  pass: boolean
  rv: number
  reason: string
}> {
  // Binance klines (ugyanaz mint EdgeCalc vol-divergence tabban)
  const klines = await fetchBinanceKlines(coin, "1h", 12)
  const returns = klines.map((k, i) =>
    i > 0 ? Math.log(k.close / klines[i-1].close) : 0
  ).slice(1)

  const rv = standardDeviation(returns) * Math.sqrt(8760) * 100

  // Ha RV > 120% annualizált → piac túl volatilis
  if (rv > 120) {
    return { pass: false, rv, reason: `RV ${rv.toFixed(0)}% > 120% threshold` }
  }
  return { pass: true, rv, reason: "OK" }
}
```

### WebSocket position feed:

```typescript
// Nyitott pozíciók real-time követése
await subs.userFills({ user: wallet.address }, (data) => {
  for (const fill of data.fills) {
    positionTracker.onFill(fill)
    logger.log({
      event: "FILL",
      coin: fill.coin,
      side: fill.side,
      price: fill.px,
      size: fill.sz,
      fee: fill.fee,
    })
  }
})

// Funding rate figyelés
await subs.activePerpsFunding({}, (data) => {
  for (const funding of data) {
    if (Math.abs(parseFloat(funding.fundingRate)) > 0.001) {
      // Magas funding rate → Telegram figyelmeztetés
      telegram.warn(`⚠️ High funding: ${funding.coin} ${funding.fundingRate}`)
    }
  }
})
```

### Session manager state:

```typescript
interface SessionState {
  startedAt: string
  paperMode: boolean
  bankrollStart: number
  bankrollCurrent: number
  sessionPnL: number
  sessionLoss: number        // csak vesztes trade-ek
  tradeCount: number
  openPositions: {
    coin: string
    direction: "LONG" | "SHORT"
    entryPrice: number
    size: number
    sizeUSDC: number
    openedAt: string
    orderId: string
    stopLossPrice: number
    takeProfitPrice: number
  }[]
  lastSignalAt: string
  consecutiveLosses: number  // ha > 3 → pause 1 óra
}

// State perzisztencia:
// /tmp/session.json (mindig felülírja)
// + Netlify Blobs sync 5 percenként (backup)
```

### HTTP server (webhook fogadás):

```typescript
// index.ts - Bun natív HTTP server
const server = Bun.serve({
  port: process.env.PORT ?? 3000,
  async fetch(req) {
    const url = new URL(req.url)

    // Health check PM2-nek
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        uptime: process.uptime(),
        openPositions: session.openPositions.length,
        sessionPnL: session.sessionPnL,
        paperMode: process.env.PAPER_MODE === "true",
      })
    }

    // Netlify signal webhook
    if (url.pathname === "/signal" && req.method === "POST") {
      // Webhook secret ellenőrzés
      const secret = req.headers.get("x-webhook-secret")
      if (secret !== process.env.WEBHOOK_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 })
      }

      const signal: TradeSignal = await req.json()
      await handleSignal(signal)
      return Response.json({ ok: true })
    }

    // Manuális stop parancs
    if (url.pathname === "/stop" && req.method === "POST") {
      await emergencyStop("Manual stop via HTTP")
      return Response.json({ ok: true, message: "All positions closed" })
    }

    return Response.json({ error: "Not found" }, { status: 404 })
  },
})
```

### Signal handler főlogika:

```typescript
async function handleSignal(signal: TradeSignal) {
  logger.log({ event: "SIGNAL_RECEIVED", ...signal })

  // 1. Session loss check
  if (session.sessionLoss <= -config.SESSION_LOSS_LIMIT) {
    telegram.error("🛑 Session loss limit reached, ignoring signal")
    return
  }

  // 2. Max pozíció check (max 3 egyszerre)
  if (session.openPositions.length >= config.MAX_OPEN_POSITIONS) {
    telegram.warn(`⚠️ Max positions (${config.MAX_OPEN_POSITIONS}) reached`)
    return
  }

  // 3. Cooldown check (5 perc ugyanazon coin-on)
  if (isOnCooldown(signal.coin)) {
    return
  }

  // 4. Volatility gate
  const volCheck = await volatilityGate(signal.coin)
  if (!volCheck.pass) {
    logger.log({ event: "VOL_GATE_REJECT", reason: volCheck.reason })
    return
  }

  // 5. Live módban extra edge threshold
  const minEdge = signal.paper ? 0.12 : 0.18  // live módban 18%
  if (signal.edge < minEdge) {
    return
  }

  // 6. Consecutive loss check
  if (session.consecutiveLosses >= 3) {
    telegram.warn("⚠️ 3 consecutive losses, pausing 1 hour")
    setCooldownAll(60 * 60 * 1000)
    return
  }

  // 7. Order elhelyezés
  await placeEntry(signal)
}
```

### Take profit + Stop loss logika:

```typescript
// Hyperliquid-en TP/SL natívan beállítható
async function placeEntryWithTPSL(signal: TradeSignal) {
  const currentPrice = await getCurrentPrice(signal.coin)
  const isLong = signal.direction === "LONG"

  // TP: 2× edge (ha 15% edge → 30% profit targethez)
  const tpPct = signal.edge * 2
  const tpPrice = isLong
    ? currentPrice * (1 + tpPct)
    : currentPrice * (1 - tpPct)

  // SL: 1× edge (aszimmetrikus: 2:1 reward/risk)
  const slPct = signal.edge
  const slPrice = isLong
    ? currentPrice * (1 - slPct)
    : currentPrice * (1 + slPct)

  const size = kellyToPerpSize({
    bankrollUSDC: session.bankrollCurrent,
    kellyFraction: signal.kelly,
    edge: signal.edge,
    currentPrice,
    leverage: config.MAX_LEVERAGE,
    maxPctBankroll: config.MAX_PCT_BANKROLL,
  })

  // Entry order
  const entryResp = await exchange.order({
    orders: [{
      a: ASSET_INDEX[signal.coin],
      b: isLong,
      p: currentPrice.toFixed(1),
      s: size.toFixed(3),
      r: false,
      t: { limit: { tif: "Gtc" } },
    }],
    grouping: "na",
  })

  // TP order (reduce only)
  await exchange.order({
    orders: [{
      a: ASSET_INDEX[signal.coin],
      b: !isLong,
      p: tpPrice.toFixed(1),
      s: size.toFixed(3),
      r: true,
      t: { limit: { tif: "Gtc" } },
    }],
    grouping: "na",
  })

  // SL order (stop market)
  await exchange.order({
    orders: [{
      a: ASSET_INDEX[signal.coin],
      b: !isLong,
      p: slPrice.toFixed(1),
      s: size.toFixed(3),
      r: true,
      t: { trigger: {
        triggerPx: slPrice.toFixed(1),
        isMarket: true,
        tpsl: "sl",
      }},
    }],
    grouping: "na",
  })
}
```

---

## ENV VARS

```env
# Hyperliquid
HL_PRIVATE_KEY=0x...           # Arbitrum wallet private key
HL_WALLET_ADDRESS=0x...        # Wallet address (HL-ra bridgelt USDC)

# Mode
PAPER_MODE=true                # true = testnet, false = mainnet
SESSION_LOSS_LIMIT=50          # USD auto-stop
MAX_OPEN_POSITIONS=3           # max egyidejű pozíció
MAX_LEVERAGE=3                 # max tőkeáttét (konzervatív!)
MAX_PCT_BANKROLL=0.15          # max 15% bankroll per trade
COOLDOWN_SECONDS=300           # 5 perc cooldown per coin

# Webhook
WEBHOOK_SECRET=...             # Netlify → Hetzner auth token
PORT=3000

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Netlify (signal combiner URL)
NETLIFY_SIGNAL_URL=https://your-site.netlify.app/.netlify/functions/signal-combiner

# Hetzner state backup
NETLIFY_BLOBS_TOKEN=...        # session state backup
```

---

## TELEGRAM ALERT FORMÁTUMOK

```
# Trade nyitás
🟢 LONG OPEN [PAPER]
Coin: BTC-PERP
Entry: $84,250
Size: 0.018 BTC ($1,516)
Bankroll: 10.1% used
TP: $96,887 (+15.0%)
SL: $79,195 (-6.0%)
Edge: 17.2% | Kelly: 8.3%
Signals: FR↑ VPIN↑ VOL↓

# Trade zárás (nyereség)
💰 LONG CLOSED [PAPER]
Coin: BTC-PERP
Exit: $96,340 (TP hit)
PnL: +$218.40 (+14.4%)
Hold time: 4h 23min
Session PnL: +$312.80

# Trade zárás (veszteség)
🔴 LONG CLOSED [PAPER]
Coin: BTC-PERP
Exit: $79,450 (SL hit)
PnL: -$86.20 (-5.7%)
Hold time: 2h 11min
Session PnL: +$226.60

# Napi összefoglaló (reggel 07:00)
📊 DAILY SUMMARY
Date: 2026-04-17
Trades: 8 (5W / 3L)
Win rate: 62.5%
Session PnL: +$312.80
Bankroll: $3,312.80
Best: BTC +$218.40
Worst: ETH -$86.20
Avg hold: 3h 12min

# Riasztások
🚨 SESSION LOSS LIMIT HIT
Loss: -$50.00
All positions closed.
Bot paused. /start to resume.

⚠️ HIGH FUNDING RATE
BTC funding: 0.12%/8h
LONG positions expensive.
Consider reducing exposure.

🔌 WEBSOCKET RECONNECT
Attempt 3/5
Last connected: 2min ago

# Manuális parancsok (Telegram bot)
/status  → nyitott pozíciók + session PnL
/stop    → minden pozíció zárása
/pause   → új trade-ek szüneteltetése
/resume  → újraindítás
/balance → wallet egyenleg
```

---

## HETZNER DEPLOYMENT

### Setup script (egyszer fut):

```bash
#!/bin/bash
# scripts/setup.sh

# Bun telepítés
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# PM2 telepítés
bun install -g pm2

# Projekt klónozás
git clone https://github.com/te/edgecalc-trader /opt/edgecalc-trader
cd /opt/edgecalc-trader

# Függőségek
bun install

# .env fájl (kézzel kell kitölteni!)
cp .env.example .env
echo "Töltsd ki a .env fájlt, majd futtasd: pm2 start ecosystem.config.js"
```

### PM2 ecosystem config:

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: "edgecalc-trader",
    script: "index.ts",
    interpreter: "bun",
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: "production",
    },
    // Log fájlok
    out_file: "/var/log/edgecalc/out.log",
    error_file: "/var/log/edgecalc/error.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  }],
}
```

### Deploy script (minden frissítésnél):

```bash
#!/bin/bash
# scripts/deploy.sh
cd /opt/edgecalc-trader
git pull origin main
bun install
pm2 restart edgecalc-trader
pm2 logs edgecalc-trader --lines 20
```

### Netlify → Hetzner webhook bekötése:

```typescript
// netlify/functions/signal-combiner/index.ts kiegészítés
// Ha van edge, POST a Hetzner szervernek:

if (decision.shouldTrade) {
  await fetch(process.env.HETZNER_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": process.env.WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      coin: decision.coin,
      direction: decision.direction,
      size_usdc: decision.positionSizeUSDC,
      kelly: decision.kellyFraction,
      edge: decision.edge,
      signals: decision.signals,
      timestamp: new Date().toISOString(),
      paper: process.env.PAPER_MODE === "true",
    }),
  })
}
```

---

## MONITORING ENDPOINTS

```
GET /health
  → { ok, uptime, openPositions, sessionPnL, paperMode }

GET /status
  → teljes session state JSON

GET /positions
  → nyitott pozíciók listája

POST /stop
  → emergency stop: minden pozíció zárása

POST /pause
  → új trade-ek szüneteltetése (pozíciók nyitva maradnak)

POST /resume
  → újraindítás pause után
```

---

## FEJLESZTÉSI SORREND

### Lépés 1: Projekt setup + HL client
- Package.json, bun.lock
- `config.ts` – összes env var
- `types.ts` – TradeSignal, SessionState, Position
- `execution/hl-client.ts` – SDK init, testnet kapcsolat
- Tesztelés: `info.allMids()` visszaad-e adatot?

### Lépés 2: Session manager + logger
- `execution/session-manager.ts`
- `monitoring/logger.ts` – NDJSON append
- State mentés /tmp/session.json-be
- Unit tesztek a Kelly sizing konverzióra

### Lépés 3: HTTP server + webhook
- `index.ts` – Bun.serve
- `/health` endpoint
- `/signal` webhook fogadás + secret ellenőrzés
- `/stop` emergency endpoint
- Tesztelés: curl-lal POST küldés

### Lépés 4: Volatility gate
- `strategy/volatility-gate.ts`
- Binance klines fetch (12 × 1h gyertya)
- RV számítás + threshold check
- Paper mode-ban mindig pass-ol

### Lépés 5: Order placement (testnet!)
- `execution/order-manager.ts`
- LONG/SHORT entry HL testnet-en
- TP + SL beállítás
- Fill callback WebSocket-en
- **Kötelező: testnet-en tesztelni mielőtt mainnet!**

### Lépés 6: Position tracker
- `execution/position-tracker.ts`
- WebSocket userFills subscription
- Pozíció nyitás/zárás state frissítés
- PnL számítás fillenként

### Lépés 7: Signal handler főlogika
- `strategy/signal-receiver.ts`
- Összes szűrő sorban (session loss, max pos, cooldown, vol gate, edge min)
- Consecutive loss counter
- `decision-gate.ts` – utolsó ellenőrzések

### Lépés 8: Telegram monitoring
- `monitoring/telegram.ts`
- Összes alert típus implementálva
- Reggeli 07:00 daily summary (cron)
- Manuális parancsok: /status /stop /pause /resume

### Lépés 9: PM2 deployment Hetzner-en
- `scripts/setup.sh` futtatása
- `.env` kitöltése
- `pm2 start ecosystem.config.js`
- `pm2 logs` – élő log figyelés
- `/health` endpoint tesztelése

### Lépés 10: Netlify webhook bekötése
- Signal-combiner kiegészítése Hetzner POST-tal
- End-to-end teszt: Netlify cron → Hetzner → HL testnet order
- Paper mode: legalább 20 trade testnet-en
- Csak ezután: PAPER_MODE=false + mainnet

---

## KRITIKUS MEGSZORÍTÁSOK

1. **MAX_LEVERAGE = 3** – soha ne menj 3x felé.
   Hyperliquid enged 50x-et, de a volatilitás ezt tönkreteszi.

2. **PAPER_MODE=true default.** Testnet-en legalább 20 trade
   mielőtt mainnet. A testnet valódi API, fake pénz.

3. **Session loss limit kötelező.** Ha nincs beállítva: default $50.
   Auto-stop és Telegram riasztás.

4. **Consecutive loss pause.** 3 egymás utáni veszteség →
   1 óra szünet. A rendszer "rossz napot" vesz észre.

5. **Volatility gate nem kikapcsolható live módban.**
   BTC RV > 120% esetén a rendszer nem nyit új pozíciót.

6. **Webhook secret kötelező.** A Netlify → Hetzner kapcsolat
   autentikált. Secret nélkül bárki küldhetne fake szignálokat.

7. **TP/SL mindig be van állítva.** Sosem nyissunk pozíciót
   stop loss nélkül. Ha az SL order placement sikertelen,
   az entry order-t is vissza kell vonni.

8. **Auto-redeem nincs.** Hyperliquid perp-en a nyereség
   automatikusan jóváíródik – nincs külön claim lépés
   (ez a Polymarket-től eltér!).

---

## REFERENCIA REPÓK

1. **@nktkas/hyperliquid** (fő SDK)
   `https://github.com/nktkas/hyperliquid`
   → Docs: `https://nktkas.gitbook.io/hyperliquid`
   → Nézd meg: examples/ mappa, különösen order placement

2. **KaustubhPatange/polymarket-trade-engine**
   `https://github.com/KaustubhPatange/polymarket-trade-engine`
   → Az order lifecycle pattern (fill callback, emergency sell)
   innen jön – adaptáld Hyperliquid-re

3. **Hyperliquid hivatalos docs**
   `https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api`
   → Exchange endpoint, asset indexek, order types

---

## DEFINITION OF DONE

- [ ] HL testnet-en 20 trade paper mode-ban, hiba nélkül
- [ ] Minden trade NDJSON logban megjelenik
- [ ] Telegram alertek megérkeznek (OPEN + CLOSED + DAILY)
- [ ] /health endpoint válaszol
- [ ] Session loss limit triggerelhető teszteléssel
- [ ] TP és SL minden nyitott pozíción be van állítva
- [ ] Volatility gate helyesen blokkol magas RV esetén
- [ ] PM2 auto-restart működik (pm2 kill → auto újraindul)
- [ ] Netlify → Hetzner webhook end-to-end tesztelve
- [ ] TypeScript strict mode hiba nélkül fordul

---

*Kész vagy? Kezdd a Lépés 1-gyel: projekt setup, config.ts, types.ts,
és HL testnet kapcsolat ellenőrzése info.allMids()-dal.*
