# EdgeCalc Funding Rate Arbitrage – Patch Prompt

> Ez a patch az előző Hyperliquid execution prompthoz adandó hozzá.
> Előbb add be az `edgecalc-hyperliquid-prompt.md` tartalmát,
> majd ezt közvetlenül utána – ugyanabban a Claude Code sessionben.

---

## KONTEXTUS: MIT BŐVÍTÜNK

Az előző prompt megépítette az execution engine-t direktcionális
LONG/SHORT kereskedésre. Ez a patch egy második stratégiát ad hozzá:
**Funding Rate Arbitrage** – delta-neutral, irány kockázat nélkül.

A rendszer mostantól **3 rétegen** kereskedik:

```
RÉTEG 1: HLP Vault (passzív, nem kódolunk)
  → Manuálisan beteszel USDC-t app.hyperliquid.xyz/vaults-ra
  → ~20%/év, semmi tennivaló

RÉTEG 2: Funding Rate Arbitrage (ezt most építjük)
  → Delta-neutral: SHORT HL + LONG Binance spot
  → ~25-40%/év, market-neutral
  → Automatikus, napi 5 perc figyelés

RÉTEG 3: EdgeCalc Signal Trading (előző prompt)
  → Direktcionális LONG/SHORT
  → Már meg van építve
```

---

## A STRATÉGIA LOGIKÁJA

### Mi az a Funding Rate Arbitrage?

```
Hyperliquid-en az on-chain traderek hajlamosan LONG-ok
→ magas pozitív funding rate → SHORTOLÓK kapnak pénzt óránként

Ha HL BTC funding: +0.05%/óra
   Binance BTC spot: 0% (nincs funding)

Strategy:
  1. SHORT 1 BTC Hyperliquid-en  → kapsz 0.05%/óra funding-ot
  2. BUY 1 BTC Binance spot-on   → hedge, nincs irány kockázat
  
Nettó pozíció: 0 BTC irány kockázat
Nettó bevétel: 0.05%/óra = 43.8%/év (ha ez a rate tart)
```

### Mikor NEM érdemes?

```
Ha HL funding < 0.005%/óra → túl alacsony (~4.4%/év)
  → nem éri meg a végrehajtási kockázat
  
Ha funding negatív → LONG-ok kapnak, SHORT-ok fizetnek
  → stratégia megfordul: LONG HL + SHORT Binance
  → de shortozni spotban nehezebb → SKIP
  
Ha Open Interest HL < $5M az adott coinon
  → likviditás túl alacsony → SKIP
```

---

## MIT ADJUNK HOZZÁ A MEGLÉVŐ KÓDHOZ

### Új fájlok (a meglévő struktúra bővítése):

```
edgecalc-trader/
  execution/
    funding-arb/
      fr-scanner.ts        ← HL + Binance FR lekérés + összehasonlítás
      arb-detector.ts      ← divergencia detektálás + score
      hedge-manager.ts     ← Binance spot pozíció kezelés
      fr-executor.ts       ← teljes arb nyitás/zárás logika
      fr-session.ts        ← arb pozíciók state kezelése
  strategy/
    funding-arb-handler.ts ← a fő arb loop (5 percenként fut)
```

### Meglévő fájlok módosítása:

```
index.ts          → új /fr-status endpoint + arb loop indítás
session-manager.ts → arbPositions[] hozzáadása a state-hez
monitoring/telegram.ts → új FR arb alert típusok
config.ts         → FR arb specifikus env vars
```

---

## TECHNIKAI SPECIFIKÁCIÓ

### Hyperliquid Funding Rate lekérés:

```typescript
// fr-scanner.ts
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid"

const info = new InfoClient({ transport: new HttpTransport() })

interface FundingData {
  coin: string
  hlFundingRate: number      // óránkénti ráta (pl. 0.0005 = 0.05%/h)
  hlFundingAnnualized: number // éves % (hlFundingRate * 8760 * 100)
  openInterest: number       // USD értékben
  markPrice: number
}

async function getHLFundingRates(
  coins: string[]
): Promise<FundingData[]> {
  // HL meta + assetCtxs endpoint
  const resp = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  })
  const [meta, ctxs] = await resp.json()

  return meta.universe
    .map((asset: any, i: number) => ({
      coin: asset.name,
      hlFundingRate: parseFloat(ctxs[i].funding),
      hlFundingAnnualized: parseFloat(ctxs[i].funding) * 8760 * 100,
      openInterest: parseFloat(ctxs[i].openInterest) *
                    parseFloat(ctxs[i].markPx),
      markPrice: parseFloat(ctxs[i].markPx),
    }))
    .filter((d: FundingData) => coins.includes(d.coin))
}
```

### Binance Funding Rate lekérés (meglévő EdgeCalc logika):

```typescript
// A meglévő /funding-rates Netlify Function már hívja a Binance-t
// A Hetzner szerveren közvetlenül hívjuk:

async function getBinanceFundingRate(symbol: string): Promise<number> {
  // Binance 8 óránként fizet → átváltás óránkénti rátára
  const resp = await fetch(
    `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}USDT`
  )
  const data = await resp.json()
  const rate8h = parseFloat(data.lastFundingRate)
  return rate8h / 8  // óránkénti ráta
}
```

### Arbitrage detektor:

```typescript
// arb-detector.ts
interface ArbOpportunity {
  coin: string
  hlFundingHourly: number      // HL óránkénti ráta
  binanceFundingHourly: number // Binance óránkénti ráta
  spread: number               // hlFunding - binanceFunding
  spreadAnnualized: number     // spread * 8760 * 100 (%)
  openInterestHL: number       // USD
  markPrice: number
  isViable: boolean
  reason: string
}

function detectArbOpportunity(
  hlData: FundingData,
  binanceFundingHourly: number,
  config: FRConfig
): ArbOpportunity {
  const spread = hlData.hlFundingRate - binanceFundingHourly
  const spreadAnnualized = spread * 8760 * 100

  // Minimum spread: 0.005%/óra = ~43%/év fölött érdemes
  // De figyelembe vesszük a díjakat:
  // HL taker fee: 0.045% entry + 0.045% exit = ~0.09% roundtrip
  // Binance spot fee: 0.1% entry + 0.1% exit = ~0.2% roundtrip
  // Összesen: ~0.29% díj → minimum 0.01%/óra spread kell
  //           hogy 30 nap után pozitív legyen

  const minSpread = 0.0001  // 0.01%/óra minimum

  if (spread < minSpread) {
    return {
      ...hlData, spread, spreadAnnualized,
      binanceFundingHourly, isViable: false,
      reason: `Spread ${(spread*100).toFixed(4)}%/h < min ${(minSpread*100).toFixed(4)}%/h`
    }
  }

  if (hlData.openInterest < config.MIN_OPEN_INTEREST_USD) {
    return {
      ...hlData, spread, spreadAnnualized,
      binanceFundingHourly, isViable: false,
      reason: `OI $${(hlData.openInterest/1e6).toFixed(1)}M < min $${(config.MIN_OPEN_INTEREST_USD/1e6).toFixed(0)}M`
    }
  }

  return {
    ...hlData, spread, spreadAnnualized,
    binanceFundingHourly, isViable: true,
    reason: `Spread ${(spreadAnnualized).toFixed(1)}%/yr annualized`
  }
}
```

### Arb pozíció nyitása:

```typescript
// fr-executor.ts
interface ArbPosition {
  id: string
  coin: string
  sizeUSDC: number
  sizeCoins: number            // HL short mérete
  hlShortOrderId: string       // HL short order ID
  binanceSpotOrderId: string   // Binance spot buy order ID
  openedAt: string
  entryHLFunding: number       // belépéskori HL funding ráta
  entrySpread: number          // belépéskori spread
  accumulatedFunding: number   // eddig gyűjtött funding (USDC)
  hlEntryPrice: number
  binanceEntryPrice: number
  status: "OPEN" | "CLOSING" | "CLOSED"
}

async function openArbPosition(
  opp: ArbOpportunity,
  sizeUSDC: number
): Promise<ArbPosition> {
  const sizeCoins = sizeUSDC / opp.markPrice

  // 1. HL SHORT (perp)
  const hlResp = await exchange.order({
    orders: [{
      a: ASSET_INDEX[opp.coin],
      b: false,               // sell/short
      p: opp.markPrice.toFixed(1),
      s: sizeCoins.toFixed(3),
      r: false,
      t: { limit: { tif: "Gtc" } },
    }],
    grouping: "na",
  })

  // 2. Binance SPOT BUY (hedge)
  const binanceResp = await fetch(
    "https://api.binance.com/api/v3/order",
    {
      method: "POST",
      headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY },
      body: new URLSearchParams({
        symbol: `${opp.coin}USDT`,
        side: "BUY",
        type: "MARKET",
        quoteOrderQty: sizeUSDC.toFixed(2),
        timestamp: Date.now().toString(),
        signature: hmacSign(...),
      }),
    }
  )

  const position: ArbPosition = {
    id: `arb-${Date.now()}`,
    coin: opp.coin,
    sizeUSDC,
    sizeCoins,
    hlShortOrderId: hlResp.response.data.statuses[0].resting?.oid.toString(),
    binanceSpotOrderId: (await binanceResp.json()).orderId.toString(),
    openedAt: new Date().toISOString(),
    entryHLFunding: opp.hlFundingRate,
    entrySpread: opp.spread,
    accumulatedFunding: 0,
    hlEntryPrice: opp.markPrice,
    binanceEntryPrice: opp.markPrice,
    status: "OPEN",
  }

  logger.log({ event: "ARB_OPEN", ...position })
  telegram.send(formatArbOpenAlert(position, opp))

  return position
}
```

### Arb pozíció zárása (mikor kell zárni?):

```typescript
// Zárási feltételek:
// 1. Spread < minimumra csökkent (funding rate megfordult)
// 2. Elért egy maximum tartási időt (pl. 14 nap)
// 3. Manuális /arb-close parancs Telegramon
// 4. Binance API probléma vagy egyenleg alacsony

async function closeArbPosition(pos: ArbPosition, reason: string) {
  pos.status = "CLOSING"

  // 1. HL SHORT zárása (reduce only market)
  await exchange.order({
    orders: [{
      a: ASSET_INDEX[pos.coin],
      b: true,               // buy back (short zárás)
      p: "0",                // market order
      s: pos.sizeCoins.toFixed(3),
      r: true,               // reduce only!
      t: { limit: { tif: "Ioc" } },  // immediate or cancel
    }],
    grouping: "na",
  })

  // 2. Binance SPOT SELL
  await fetch("https://api.binance.com/api/v3/order", {
    method: "POST",
    headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY },
    body: new URLSearchParams({
      symbol: `${pos.coin}USDT`,
      side: "SELL",
      type: "MARKET",
      quantity: pos.sizeCoins.toFixed(5),
      timestamp: Date.now().toString(),
      signature: hmacSign(...),
    }),
  })

  pos.status = "CLOSED"
  logger.log({ event: "ARB_CLOSE", reason, ...pos })
  telegram.send(formatArbCloseAlert(pos, reason))
}
```

### Fő arb loop (5 percenként fut):

```typescript
// strategy/funding-arb-handler.ts
const WATCHED_COINS = ["BTC", "ETH", "SOL", "XRP", "AVAX"]

async function runFundingArbLoop() {
  // 1. Aktuális funding rate-ek lekérése
  const hlRates = await getHLFundingRates(WATCHED_COINS)
  const binanceRates = await Promise.all(
    WATCHED_COINS.map(c => getBinanceFundingRate(c))
  )

  // 2. Lehetőségek azonosítása
  const opportunities = hlRates.map((hl, i) =>
    detectArbOpportunity(hl, binanceRates[i], config)
  ).filter(o => o.isViable)

  // 3. Meglévő pozíciók ellenőrzése
  for (const pos of session.arbPositions.filter(p => p.status === "OPEN")) {
    const currentSpread = await getCurrentSpread(pos.coin)

    // Zárás ha spread túl alacsony
    if (currentSpread < config.MIN_SPREAD_TO_CLOSE) {
      await closeArbPosition(pos, `Spread dropped to ${(currentSpread*100).toFixed(4)}%/h`)
      continue
    }

    // Funding accumulation tracking (óránként)
    const hoursOpen = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000
    pos.accumulatedFunding = pos.sizeUSDC * pos.entrySpread * hoursOpen
  }

  // 4. Új pozíciók nyitása
  const openCoins = new Set(session.arbPositions
    .filter(p => p.status === "OPEN")
    .map(p => p.coin))

  for (const opp of opportunities) {
    // Max 3 arb pozíció egyszerre
    if (session.arbPositions.filter(p => p.status === "OPEN").length >= 3) break

    // Ne nyiss ugyanarra a coinra kétszer
    if (openCoins.has(opp.coin)) continue

    // Max tőke az arb rétegre: bankroll 40%-a
    const maxArbCapital = session.bankrollCurrent * 0.40
    const usedArbCapital = session.arbPositions
      .filter(p => p.status === "OPEN")
      .reduce((sum, p) => sum + p.sizeUSDC, 0)

    if (usedArbCapital >= maxArbCapital) break

    const posSize = Math.min(
      opp.markPrice * 0.1,   // max 0.1 coin egységnyi
      (maxArbCapital - usedArbCapital) * 0.5  // tőke felét nyitja egyszerre
    )

    if (posSize < 50) continue  // min $50 pozíció

    const pos = await openArbPosition(opp, posSize)
    session.arbPositions.push(pos)
    openCoins.add(opp.coin)
  }

  // 5. State mentés
  await saveSessionState()
}
```

---

## ENV VARS (hozzáadandók a meglévő .env-hez)

```env
# Funding Rate Arb
BINANCE_API_KEY=...            # Binance spot trading
BINANCE_API_SECRET=...         # Binance API secret

FR_MIN_SPREAD_HOURLY=0.0001    # 0.01%/óra minimum spread
FR_MIN_OPEN_INTEREST=5000000   # $5M minimum OI az adott coinon
FR_MAX_ARB_POSITIONS=3         # max egyidejű arb pozíció
FR_MAX_CAPITAL_PCT=0.40        # bankroll max 40%-a arb-ra
FR_MAX_HOLD_DAYS=14            # max 14 nap tartás
FR_MIN_SPREAD_TO_CLOSE=0.00005 # ennél kisebb spreadnél zárunk
FR_SCAN_INTERVAL=300           # 5 percenként scan (másodpercben)
```

---

## TELEGRAM ALERT FORMÁTUMOK (új típusok)

```
# Arb pozíció nyitás
⚖️ ARB OPEN [PAPER]
Coin: BTC
HL Short: 0.018 BTC @ $84,250
Binance Long: 0.018 BTC @ $84,270
Size: $1,516 (20.2% of arb capital)
HL Funding: +0.052%/h
Binance Funding: +0.011%/h
Spread: +0.041%/h = ~36%/yr
Est. daily yield: $0.62

# Funding összesítő (óránként)
💸 FUNDING RECEIVED
BTC arb: +$0.62
ETH arb: +$0.38
Total today: +$4.20
Arb capital deployed: $3,032

# Arb pozíció zárás
⚖️ ARB CLOSE
Coin: BTC
Hold time: 8d 14h
Funding collected: +$42.40 (+2.79%)
HL PnL: -$1.20 (fees)
Binance PnL: +$0.80 (fees)
Net PnL: +$42.00 (+2.77%)
Reason: Spread dropped to 0.003%/h

# Napi arb összefoglaló
📊 ARB DAILY SUMMARY
Open positions: 2 (BTC, ETH)
Deployed capital: $3,032 / $4,000 max
Today's funding: +$8.40
Total funding (all time): +$42.40
Avg spread: 0.038%/h = 33.3%/yr
```

---

## SESSION STATE BŐVÍTÉS

```typescript
// session-manager.ts kiegészítés
interface SessionState {
  // ... meglévő mezők ...

  // Arb réteg (új)
  arbPositions: ArbPosition[]
  totalFundingCollected: number   // USDC, összes idők
  todayFundingCollected: number   // USDC, ma
  arbCapitalDeployed: number      // USDC, jelenleg
}
```

---

## /fr-status ENDPOINT (hozzáadás az index.ts-hez)

```typescript
// index.ts-ben új route:
if (url.pathname === "/fr-status") {
  const hlRates = await getHLFundingRates(WATCHED_COINS)
  const openArbs = session.arbPositions.filter(p => p.status === "OPEN")

  return Response.json({
    ok: true,
    openPositions: openArbs.length,
    totalFundingToday: session.todayFundingCollected,
    totalFundingAllTime: session.totalFundingCollected,
    capitalDeployed: session.arbCapitalDeployed,
    topOpportunities: hlRates
      .sort((a, b) => b.hlFundingAnnualized - a.hlFundingAnnualized)
      .slice(0, 5)
      .map(r => ({
        coin: r.coin,
        fundingAnnualized: r.hlFundingAnnualized.toFixed(1) + "%/yr",
        openInterest: "$" + (r.openInterest / 1e6).toFixed(1) + "M",
      }))
  })
}
```

---

## FEJLESZTÉSI SORREND (patch)

### Lépés A: FR Scanner
- `execution/funding-arb/fr-scanner.ts`
- HL `metaAndAssetCtxs` endpoint hívás
- Binance `premiumIndex` endpoint hívás
- Normalizálás óránkénti rátára
- Unit teszt: valós adatokkal fut-e?

### Lépés B: Arb detektor
- `execution/funding-arb/arb-detector.ts`
- Spread számítás + fee levonás
- Minimum threshold szűrők
- OI szűrő

### Lépés C: Binance hedge manager
- `execution/funding-arb/hedge-manager.ts`
- Binance REST API autentikáció (HMAC SHA256)
- Spot buy + sell market orderek
- Paper mode: csak logol, nem küld

### Lépés D: FR Executor
- `execution/funding-arb/fr-executor.ts`
- Pozíció nyitás (HL short + Binance long)
- Pozíció zárás (mindkét láb)
- Error handling: ha az egyik láb sikerül a másik nem

### Lépés E: Session + state bővítés
- `execution/funding-arb/fr-session.ts`
- ArbPosition state kezelés
- Funding accumulation tracking
- Session state bővítése

### Lépés F: Fő arb loop
- `strategy/funding-arb-handler.ts`
- 5 perces scan loop
- Opportunity detection → position management

### Lépés G: Integráció
- `index.ts` bővítése: `/fr-status` endpoint + loop indítás
- `monitoring/telegram.ts` bővítése: új alert típusok
- `config.ts` bővítése: FR arb env vars

### Lépés H: Tesztelés
- Paper mode-ban legalább 48 óra futás
- Ellenőrizd: a funding accumulation helyesen számolódik?
- Ellenőrizd: a zárási feltételek helyesen triggerelnek?
- Ellenőrizd: a Binance hedge leg helyesen párosítja az HL pozíciót?

---

## KRITIKUS FIGYELMEZTETÉSEK

**1. Binance API szükséges külön**
A Binance spot hedge lábhoz Binance API kulcs kell.
Ez KÜLÖNBÖZIK a meglévő Bybit kulcstól.
Regisztrálj Binance-ra, és csak SPOT trading jogot adj az API kulcsnak
(futures és withdrawal jogot NE engedélyezz!).

**2. Két láb szinkron kockázata**
Ha az HL short sikerül de a Binance buy nem:
→ Nyitott direktcionális SHORT pozíció marad HL-en
→ Ez NEM delta-neutral, ez kockázatos!
→ Ezért: ha a Binance láb sikertelen, az HL lábat is azonnal zárd

**3. Funding rate megfordulás**
Ha a HL funding negatívba fordul:
→ SHORT pozíciók FIZETNEK funding-ot ahelyett hogy kapnának
→ Ez veszteséget generál!
→ Az arb-loop 5 percenként ellenőrzi ezt és azonnal zárja a pozíciót

**4. Minimális pozíció méret**
Binance minimum order: ~$10
HL minimum order: coin-függő (~$5-20)
Ne nyiss $50 alatti arb pozíciót – a díjak felfalják a profitot

**5. Tőke allokáció**
Az arb réteg MAX bankroll 40%-a
A direktcionális réteg MAX bankroll 20%-a
A maradék 40% HLP vault-ban vagy szabad tartalék
NE menj 100% kihasználtságra – mindig kell buffer

---

## DEFINITION OF DONE (patch)

- [ ] FR scanner valós HL + Binance adatot ad vissza
- [ ] Arb detektor helyesen számol spreadet fee levonással
- [ ] Paper mode-ban arb pozíció nyitás + zárás végigmegy
- [ ] Funding accumulation 48 óra alatt helyesen számolódik
- [ ] Ha Binance láb sikertelen → HL láb automatikusan zárul
- [ ] /fr-status endpoint valós adatot mutat
- [ ] Telegram arb alertek megérkeznek
- [ ] Session state arbPositions[] perzisztálódik
- [ ] TypeScript strict mode hiba nélkül fordul

---

*Kész vagy a patch implementálásával?
Kezdd az A lépéssel: fr-scanner.ts megírása és tesztelése valós adaton.*
