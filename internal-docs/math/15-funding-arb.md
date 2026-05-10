# Funding Rate Arbitrage Bot – Implementation Reference

> **Scope:** ez a doksi a `category: "hyperliquid", layer: "arb"` bot
> **élő futási logikáját** írja le, ahogy a
> `netlify/functions/auto-trader/hyperliquid/funding-arb/` fán jelenleg
> implementálva van (2026-05-10 állapot, F1+F5 fix után). Ez a directional
> HL bot **mellett** futó, teljesen független strategy — saját session blob,
> saját cron-fan-out target, saját UI.

---

## 1. Bot célja és stratégia

| Szempont | Érték |
|----------|-------|
| **Venue 1 (perp)** | Hyperliquid mainnet — SHORT leg |
| **Venue 2 (hedge)** | Binance Spot — LONG leg (paying NO funding) |
| **Underlying** | BTC / ETH / SOL / XRP / AVAX |
| **Cron** | `*/3 * * * *` (`auto-trader-multi-cron` schedule, layer=arb) |
| **Side** | DELTA-NEUTRAL: short HL perp + long Binance spot ⇒ net direction = 0 |
| **Stratégia** | Cross-venue carry trade. Ha HL pozitív hourly funding-ot fizet a shorts-nak (long-bias on HL), és Binance kevesebbet fizet futures-on, akkor a SHORT-on HL collect-elünk minden órán, a LONG spot semleges. **Income:** `currentNotional × hlFundingHourly × hours` |
| **Exit triggerek** | (a) `currentSpread < minSpreadToClose` (0.005%/h default), (b) `spread < 0` (HL flipped, shorts now pay), (c) `hold ≥ maxHoldDays` (14d default) |
| **Bankroll forrás** | A directional HL session `bankrollCurrent` mezője (közös $200 USDC pool, `maxCapitalPct=40%` cap) |

**Miért működik:** a funding-rate arb klasszikus piacsemleges carry. A HL
és Binance USDT-M funding-rátái nem konvergálnak tökéletesen (eltérő
likviditás, fee-struktúra, kereskedők), így marad spread. Hetente
0.05-0.15%/d net income reális (annualized 18-55%) konzervatív bankroll
allocation mellett.

---

## 2. Futási pipeline

```
┌──────────────────────────────────────────────────────────────┐
│  CRON: */3 min — auto-trader-multi-cron fan-out              │
│  (POST /auto-trader { category: "hyperliquid",               │
│                       layer: "arb" }, ?source=cron)          │
└────────────────────────────┬─────────────────────────────────┘
                             │
                  runFundingArbLoop(source)
                             │
       ┌─────────────────────┼─────────────────────────┐
       │                     │                         │
       ▼                     ▼                         ▼
loadArbSession       computeLiveReadiness()    scanFundings([5 coins])
(separate blob)      + shouldForcePaper()      ├── HL metaAndAssetCtxs
                                               └── Binance premiumIndex
       │                     │                         │      / fundingInfo
       └─────────────────────┴─────────────────────────┘
                             │
                accrueFunding(session, NOW, hlSnapshotByCoin)
                             │     ← MARK-TO-MARKET (sizeCoins × markPrice × rate × hours)
                             ▼
                for pos of session.positions where status="OPEN":
                  if maxHoldDays elapsed OR spread < minSpreadToClose
                  OR spread < 0:
                    closeArbPosition(pos, reason)
                             │     ← HL IOC buy-back + Binance spot SELL
                             ▼
                ranked = rankOpportunities(viable)
                for opp of ranked:
                  if maxArbPositions reached: break
                  if openCoinSet.has(opp.coin): continue
                  sizeUSDC = min(headroom × 0.5, openInterest × 0.1%)
                  if sizeUSDC < minPositionUSDC: skip
                  openArbPosition(opp, sizeUSDC, entryDecision)
                             │     ← HL IOC SHORT + Binance spot BUY
                             │     ← Atomic: ha Binance fail → HL unwind
                             ▼
                saveArbSession() → markArbRunFinish()
```

---

## 3. Funding scanner (`funding-arb/fr-scanner.mts`)

### HL — `metaAndAssetCtxs` POST

```
POST https://api.hyperliquid.xyz/info  { type: "metaAndAssetCtxs" }
```

A response `[meta, ctxs]` tuple:
- `meta.universe[i].name` → coin ticker
- `ctxs[i].funding` → **HOURLY rate as decimal STRING** (e.g. `"0.0000125"` = 0.00125%/h)
- `ctxs[i].markPx` → mark price string
- `ctxs[i].openInterest` → COIN UNITS (NOT USD), kell `× markPx`-et szorozni

A `meta.universe[i].isDelisted=true` skip (stale ctx data).

### Binance — `premiumIndex` + `fundingInfo`

```
GET /fapi/v1/premiumIndex?symbol=BTCUSDT
GET /fapi/v1/fundingInfo                      ← cache 6h
```

`lastFundingRate` per CYCLE (8h default, **DE** BTC/ETH/SOL és pár más
major 4h cycle-en megy 2023 óta). A `fundingInfo` cache megadja a
nem-default intervalokat. Hourly konverzió:

```
hourlyRate = ratePerCycle / fundingIntervalHours  // 4h or 8h
```

> 🔴 **Korábbi bug (2026-05-09 fix):** a kód hard-coded `/8`-cal osztott,
> ezért a 4h symbol-ok (BTC/ETH/SOL) hourly rate-jét 2× alulbecsülte,
> spread-et 2× felülbecsülte → bogus arb belépéseket triggerelhetett.
> Most symbol-onként valós interval-lal oszt.

### `FundingData` output

```ts
{
  coin:                "BTC",
  hlFundingHourly:     0.0000125,        // 0.00125%/h
  hlFundingAnnualized: 10.95,             // %/yr
  binanceFundingHourly: 0.0000063,        // 0.00063%/h
  openInterestUSD:     2_400_000_000,     // $2.4B
  markPrice:           65431.5,
  fetchedAt:           "2026-05-10T..."
}
```

---

## 4. Opportunity detection (`funding-arb/arb-detector.mts`)

```ts
spread           = hlFundingHourly − binanceFundingHourly
spreadAnnualized = spread × 8760 × 100   // %/yr
```

**3 viability gate** (mindegyik bukásra `isViable = false`):

| Gate | Default | Magyarázat |
|------|---------|------------|
| `spread >= minSpreadHourly` | 0.0001 (0.01%/h) | Pozitív + fee-aware küszöb |
| `breakEvenDays <= maxHoldDays` | ≤ 14d | `breakEvenH = (feeRoundtripHl + feeRoundtripBinance) / spread` — fee-recovery |
| `openInterestUSD >= minOpenInterestUSD` | $5M | Likviditás floor (slippage) |

**Ranking:** `sort(opps, (a, b) => b.spread − a.spread)`. Minden tickkor
a top 1-3 viable opportunity kerül entry-konfirmációra.

---

## 5. Entry decision gates (`funding-arb/index.mts`)

A 5 gate sorrendben — a `EntryDecisionSnapshot.gates[]` ezeket építi:

| # | Gate | Forrás | Default | Bukás |
|---|------|--------|---------|-------|
| 1 | Spread ≥ küszöb | `opp.spread >= minSpreadHourly` | 0.0001/h | (arb-detector korábban filterezi) |
| 2 | Open interest ≥ küszöb | `opp.openInterestUSD >= minOpenInterestUSD` | $5M | (arb-detector) |
| 3 | Per-coin uniqueness | `!openCoinSet.has(opp.coin)` | – | A coinra már van nyitott pozíció |
| 4 | Position count ≤ max | `openArbPositions(session).length < maxArbPositions` | 3 | "Capital cap reached" |
| 5 | Capital cap (sizing) | `sizeUSDC >= minPositionUSDC AND headroom >= 0` | $50 min, 40% bankroll cap | "Size $X < min $50" |

### Sizing képlet

```ts
maxCapital = bankroll × maxCapitalPct                    // 40% default
headroom   = maxCapital − deployedCapital(session)
oiCap      = openInterestUSD > 0
             ? min(openInterestUSD × 0.001, headroom)    // 0.1% of OI
             : headroom
sizeUSDC   = min(headroom × 0.5, oiCap)                  // 50% of headroom
```

A `0.001 × OI` cap garantálja, hogy soha nem leszünk a könyv mérhető része
(pl. $2.4B BTC OI → max $2.4M position; nem fogjuk a piacot mozdítani).

---

## 6. Order placement (`funding-arb/fr-executor.mts`)

### Open

**Atomic 2-leg open.** Ha az egyik leg sikeres, a másik nem → emergency unwind.

| Lépés | Venue | Side | Order | TIF | Slippage band |
|-------|-------|------|-------|-----|---------------|
| 1 | HL | SHORT | limit @ markPrice × 0.995 | IOC | 0.5% (entry) |
| 2 | Binance | LONG | spot MARKET (`quoteOrderQty`) | – | book-driven |
| Unwind | HL | LONG (reduce-only) | limit @ markPrice × 1.005 | IOC | 0.5% |

> **Paper mode:** `paperFill()` generálja a fake `orderId`-t és visszaadja
> a `markPrice`-t entryPrice-ként. 0 slippage, 0 fee at this stage.
> Live módban a Binance fill `entryPrice` a fills array weighted average
> (vagy `cummulativeQuoteQty / executedQty` fallback).

### Close

| Lépés | Venue | Side | Order | TIF | Slippage band |
|-------|-------|------|-------|-----|---------------|
| 1 | HL | LONG (reduce-only, buy-to-close short) | limit @ closeRefPrice × 1.010 | IOC | **1.0%** |
| 2 | Binance | SELL spot (`quantity`) | spot MARKET | – | book-driven |

> 🟠 **2026-05-10 fix (F5):** korábban a close 0.5% slippage band volt,
> ami volatilis ticken (BTC drift > 0.5% a 3min cron-gap között) IOC
> miss-t adott — a close újrapróbálkozott minden tickre, és csak a
> `maxHoldDays` safety net mentett ki. **Aszimmetrikus design:** entry
> 0.5% (inkább miss mint overpay), close 1.0% (a leg-et biztosan
> exit-elni kell, slippage cost OK).

A close fee-modell:

```ts
fees   = sizeUSDC × (feeRoundtripHl + feeRoundtripBinance)
       = sizeUSDC × (0.0009 + 0.002) = sizeUSDC × 0.0029  // 0.29%
netPnl = pos.accumulatedFunding − fees
```

> Note: a `fees` egyszer kerül levonásra at close, nem entry-nél. Ezért
> az `accumulatedFunding` érték a UI-n GROSS (fees nélkül). Az
> `entryDecision.netEdge` mező (spread − totalFees) megmondja a "real"
> hourly edge-et.

### Binance hedge — kritikus részletek

`MARKET` order BUY uses `quoteOrderQty` (USD), SELL uses `quantity` (coin).

> 🔴 **Korábbi bug (2026-05-09 fix):** `data.price` MARKET-nél mindig
> `"0.00000000"`. A kód korábban erről olvasott → `entryPrice = 0` mentődött
> a closed-trade summary-be. Most `fills[]` weighted average + `cumQuote /
> execQty` fallback. `newOrderRespType=FULL` explicit.

> 🟠 **F7 még nyitott:** `quantity = sizeCoins.toFixed(5)` a SELL-en. Egyes
> Binance trading pairs (DOGE lot 1, AVAX lot 0.01) a 5-decimal precíziót
> elutasíthatják. Ha live-ra mész, per-symbol lot precision lookup kell.

---

## 7. Funding accrual (`funding-arb/fr-session.mts:accrueFunding`)

### v2 (2026-05-10 fix F1) — mark-to-market

```ts
hours       = (now − pos.lastFundingUpdateAt) / 3600s
hourlyRate  = currentHlByCoin.get(pos.coin)?.rate ?? pos.entryHlFunding
markPrice   = currentHlByCoin.get(pos.coin)?.markPrice ?? pos.hlEntryPrice
notional    = |pos.sizeCoins| × markPrice          // CURRENT, not entry
delta       = notional × hourlyRate × hours        // SHORT receives if rate > 0
pos.accumulatedFunding += delta
pos.lastFundingUpdateAt = now
```

> 🔴 **2026-05-10 fix (F1):** a v1 `accrueFunding` `pos.sizeUSDC × hourlyRate
> × hours`-t használt — `sizeUSDC` FIXÁLT entry-time érték. Real HL
> funding-ot a `position_size_in_coins × current_mark_price × rate`-en
> fizet. Ha BTC 5-10% drift a hold alatt, a v1 modell 5-10% delta-t adott
> el a real PnL-hez képest. A v2 mark-to-market notional minden tickkor a
> legfrissebb markPrice-szal súlyoz, így paper PnL ≈ live PnL.

### Backwards compat

A `currentHlByCoin: Map<string, number | AccrueSnapshot>` típus mind a régi
rate-only és az új `{rate, markPrice}` snapshot-ot elfogadja. Régi caller-
ek (pl. közvetlen rate map) a `pos.hlEntryPrice` markPrice fallback-ra
estek vissza — funkcionalitás megőrizve, paper PnL drifttel.

### Discrete vs continuous

A HL valójában **diszkrét** (minden órán) fizet funding-ot, a paper-resolver
és accrueFunding **folytonosan** modellezi (`rate × hours`). Tick-szinten
ez bias, ~3min ticken belül azonban átlagol és semleges.

---

## 8. Session storage (`funding-arb/fr-session.mts`)

```
Netlify Blobs store: "hyperliquid-arb-session-v1"
  ├── arb_paper           ← élő paper session
  └── arb_live            ← élő live session
```

ArbSessionState shape:

```ts
{
  startedAt:           "2026-05-09T...",
  paperMode:           true,
  positions:           [ArbPosition, ...],   // open + closed
  totalFundingAllTime: 12.34,                 // USDC
  totalFundingToday:   "2026-05-10:0.45",    // YYYY-MM-DD:amount
  stopped:             false,
  stoppedReason:       null
}
```

> 🟡 **F8:** `totalFundingToday` string-format fragile. Midnight UTC
> rollover esetén az új napra `today() !== stored prefix` → `todayTotal = 0`
> reset jó. De ha a system clock visszaugorhat, dupla-counting lehet.
> Low priority.

### Bankroll source

Funding-arb-nak NINCS saját bankrollja. A `bankroll = (await loadHlSession
(paperMode)).bankrollCurrent` a directional HL bot session-jéből húz. Ha
a directional bot `bankrollCurrent`-je csökken (loss), az arb capital cap
csökken. Cross-bot dependency — dokumentálva.

---

## 9. Paper / live PnL parity matrix

| Feature | v1 paper | v2 paper (2026-05-10) | Live |
|---------|----------|------------------------|------|
| Entry fill price | markPrice (0 slippage) | markPrice | IOC limit ±0.5% |
| Close fill price | markPrice | markPrice | IOC limit +1.0% |
| Fee model | sizeUSDC × roundtrip | sizeUSDC × roundtrip | actual taker fees |
| Funding accrual rate | live HL rate | live HL rate | HL native (hourly) |
| Funding notional | **entry sizeUSDC** ❌ | **sizeCoins × current markPrice** ✅ | sizeCoins × markPrice |
| HL/Binance discrete vs continuous | continuous | continuous | discrete (hourly tick) |
| Delta-neutrality | exact (no slippage) | exact | ±0.5-1% basis at entry |
| Cross-venue execution race | n/a | n/a | non-atomic (HL fills first) |

A divergencia paper → live: 
1. **Slippage:** ~0.5-1% on entry + 1% on close = 1.5-2% one-time hit per round-trip.
2. **Discrete funding:** ±0.5h timing variance, washes out over ≥5 cycles.
3. **Execution race:** rare — but if HL fills then Binance fails, the bot
   unwinds HL aggressively (1.005× limit) and reports `error` without
   booking the trade.

---

## 10. Ismert limitációk és technikai debt

| ID | Severity | Probléma | Fixelve? |
|----|----------|----------|----------|
| F1 | 🔴 → ✅ | Funding accrual entry sizeUSDC-vel (nem mark-to-market) | ✅ v2 (2026-05-10) |
| F5 | 🟠 → ✅ | HL close IOC slippage 0.5% retry-loop volatilis ticken | ✅ v2 (2026-05-10) |
| F2 | 🟠 | Delta-neutrality csak ~entry-szinten | ❌ Inherently non-atomic cross-venue |
| F3 | 🟠 | Live close slippage cost paper-ben nincs modellezve | ❌ Konzervatív paper bias |
| F7 | 🟠 | Binance SELL `quantity.toFixed(5)` pair-onkénti lot precision | ❌ Élesedés előtt fix kell |
| F8 | 🟡 | totalFundingToday string format | ❌ Low priority |

### F2/F3 részletei

A két leg cross-venue, atomic execution nincs. A workflow:
1. HL SHORT IOC (fillel vagy rejected)
2. Binance LONG MARKET (fillel vagy rejected)

Ha (1) ✓ és (2) ✗ → HL unwind aggressive 1.005× IOC. **Marad ~0.5-1%
slippage cost** (két IOC × 0.5%) — a paper ezt nem modellezi, így paper
PnL `+0.5-1%` slight upper bound.

### F7 részletei

Binance `LOT_SIZE` filter `stepSize` alapján lehet 0.00001 (BTC), 0.001
(ETH), 0.01 (SOL/AVAX), 1 (DOGE). A `toFixed(5)` az utóbbi 2 esetén
**precision-overshoot** rejection-t adhat. Élesedés előtt:

```ts
GET /api/v3/exchangeInfo  → symbols[X].filters[LOT_SIZE].stepSize
                         → roundDownToStep(sizeCoins, stepSize)
```

vagy a `fr-executor` build-time-ban map-elj le egy `BINANCE_LOT_PRECISION`
táblát.

---

## 11. Validációs protokoll

A bot **paper-only** módban fut (`HL_PAPER_MODE=true` default).

- **First 24h:** session friss, várhatóan 0-1 nyitott pozíció (ha a spread
  nem éri el a 0.01%/h-t és OI ≥ $5M).
- **3-7 nap:** 2-5 lezárt arb. Net PnL várhatóan kis pozitív (0.5-2 USDC),
  ha a spread > fees / hold_time.
- **30+ trade után:** Live readiness gate ellenőrzhető. Funding-arb-nak
  IC nem applicable (rate-driven), tehát a Trade count + Sharpe + Drawdown
  + Sim version + Session-active gates számítanak.

Diagnosztika — current spread snapshot:

```bash
# HL hourly rates
curl -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"metaAndAssetCtxs"}' | jq '.[1] | map({funding, openInterest, markPx})'

# Binance per-cycle rate (BTC példa)
curl 'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT' | jq '.lastFundingRate'
curl 'https://fapi.binance.com/fapi/v1/fundingInfo' | jq '.[] | select(.symbol=="BTCUSDT")'

# Arb session state
curl 'https://mj-trading.netlify.app/.netlify/functions/auto-trader-api?action=status&category=hyperliquid&layer=arb'
```

---

## 12. File → szerep map

| File | Szerep |
|------|--------|
| `index.mts` | Main loop: scan → accrue → close-check → open-check |
| `fr-scanner.mts` | HL `metaAndAssetCtxs` + Binance `premiumIndex` + cycle interval cache |
| `arb-detector.mts` | Spread → ArbOpportunity, viability gates, ranking |
| `fr-executor.mts` | Atomic 2-leg open + close, emergency unwind |
| `hedge-manager.mts` | Binance Spot adapter (HMAC sign, fills weighted avg) |
| `fr-session.mts` | Blobs persistence + accrueFunding (mark-to-market) |
| `arb-run-state.mts` | UI status pill state |
| `config.mts` | env defaults, fee/threshold knobs |
| `types.mts` | Type definitions, AccrueSnapshot |
