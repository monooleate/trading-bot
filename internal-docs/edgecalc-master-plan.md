# EdgeCalc Trading Rendszer – Megvalósítási Összefoglaló

> Ez a dokumentum az összes eddigi trading témájú megbeszélés
> alapján készült. Claude Code-nak átadható, prioritásokkal ellátott
> fejlesztési terv.

---

## A TELJES RENDSZER ARCHITEKTÚRA

```
NETLIFY (signal réteg, ingyenes)
  Cron 3 percenként:
    /funding-rates        → Binance FR anomália
    /orderflow-analysis   → VPIN + Kyle λ
    /vol-divergence       → IV vs RV spread
    /apex-wallets         → whale consensus
    /signal-combiner      → IR = IC × √N → final_prob + kelly
    /resolution-risk      → settlement kockázat scorer
    Ha edge > threshold:
      HTTP POST → Hetzner webhook

HETZNER CX22 (execution réteg, €4/hó)
  Folyamatosan fut (PM2 + bun):
    WebSocket: Binance kline_1s + PM CLOB
    Divergencia detektor
    LP refresh window detektor
    Order lifecycle management
    Session state + PnL tracking
    Telegram alerts

POLYMARKET (execution célpont 1)
  BTC 5m/15m Up/Down piacok
  Weather temperature piacok

HYPERLIQUID (execution célpont 2)
  BTC/ETH/SOL perp trading
  Funding rate arbitrage (delta-neutral)
  HLP Vault (passzív, manuális)
```

---

## PRIORITÁS 1 – AZONNAL MEGVALÓSÍTANDÓ
> Ezek a meglévő kód alapján a legkisebb erőfeszítéssel
> a legnagyobb értéket adják.

### P1.1 – Weather Station Fix (KRITIKUS)
**Probléma:** Hibás settlement station adatok = garantált veszteség
**Javítás:**
```
NYC    → KLGA (LaGuardia)      NEM KNYC
Dallas → KDAL (Love Field)     NEM KDFW
London → EGLC (London City)    NEM EGLL
Tokyo  → RJTT (Haneda)         NEM RJAA
```
**Prompt:** `edgecalc-weather-patch.md`
**Időigény:** 1-2 óra
**Hatás:** Minden weather trade pontossága javul

---

### P1.2 – Korai Exit Logika (BTC 5m piacok)
**Probléma:** Hold-to-resolution = avg loss $52, korai exit = avg loss $19
**Javítás az execution rétegben:**
```typescript
TP: 0.75 (nem $1.00!)
SL: 0.35
Ha <60mp resolution: hold to end
Entry ablak: 60-180mp a market nyitás után
Előtte: retail zaj → skip
Utána: nem tudsz exitálni → skip
```
**Hol:** `execution/order-lifecycle.ts` módosítás
**Időigény:** 2-3 óra
**Hatás:** ~$3,100/hét extra PnL ugyanazon szignálokon

---

### P1.3 – Order Book Imbalance Szignál
**Probléma:** Egyetlen szignál (Binance divergencia) = 57% win rate
**Javítás:** Második szignál hozzáadása
```typescript
bid_depth / ask_depth > 1.8 → UP megerősítés
bid_depth / ask_depth < 0.55 → DOWN megerősítés
Csak 30-90mp ablakban market nyitás után
MINDKÉT szignál kell → entry (skip rate: 85%)
```
**Hol:** `execution/signal-aggregator.ts` bővítés
**Időigény:** 3-4 óra
**Hatás:** Win rate 57% → 71% (két szignál konvergencia)

---

### P1.4 – Auto-Claim (Polymarket)
**Probléma:** Nyertes pozíciók nem automatikusan jóváírva
**Javítás:** Redeem logika az execution rétegbe
```typescript
// Polymarket winning pozíciók manuális redeem nélkül
// nem kerülnek a wallet egyenlegbe!
// execution.ts-be: onResolved() → auto-redeem
```
**Hol:** `execution/order-lifecycle.ts`
**Időigény:** 2-3 óra
**Hatás:** Elveszett nyeremények visszaszerzése

---

### P1.5 – Kelly Formula Pontosítás
**Probléma:** Jelenlegi Kelly nem binary piacra optimalizált
**Helyes képlet (binary piacokra):**
```typescript
b = (1 - price) / price      // net payout odds
f_raw = (edge * b - (1 - edge)) / b
kelly_size = bankroll * f_raw * 0.25  // quarter Kelly
hard_cap = bankroll * 0.08            // max 8%
size = min(kelly_size, hard_cap)
```
**Hol:** `strategy/kelly-sizer.ts` csere
**Időigény:** 1-2 óra
**Hatás:** Pontosabb pozíció méretezés

---

## PRIORITÁS 2 – RÖVID TÁVON (1-2 HÉT)
> Ezek új funkcionalitást adnak a meglévő alapra.

### P2.1 – Resolution Risk Scorer
**Mit csinál:** Claude API elemzi a settlement rules-t
**Képlet:**
```
E[X]adjusted = P(YES) - price - resolution_risk - execution_drag
```
**Score komponensek:**
```
source_clarity:      25%
wording_ambiguity:   25%
deadline_precision:  20%
historical_disputes: 15%
source_availability: 15%
```
**SKIP trigger:** score > 0.60 → ne kereskedj
**Prompt:** `edgecalc-resolution-risk-prompt.md`
**Időigény:** 3-4 nap
**Hatás:** Technikai veszteségek kiszűrése

---

### P2.2 – Binance/PM Divergencia Szignál (Hetzner)
**Mit csinál:** Real-time Binance vs PM price gap mérés
**WebSocket feedek:**
```
Binance: wss://stream.binance.com:9443/ws/btcusdt@kline_1s
PM CLOB: wss://ws-subscriptions-clob.polymarket.com/ws/market
```
**Logika:**
```
Ha Binance >$50 mozgás 30mp alatt
ÉS PM ár nem frissült még
→ divergencia ablak nyílt (2-3 másodperc)
→ entry trigger a Netlify szignálhoz
```
**Prompt:** `edgecalc-divergence-patch.md`
**Időigény:** 3-4 nap
**Hatás:** Entry timing pontossága javul

---

### P2.3 – Weather Ensemble Forecast Upgrade
**Mit csinál:** 31 tagú GFS ensemble Open-Meteo-ból
**Logika:**
```
31 modell futás → hány jósol >= threshold?
24/31 → P(YES) = 77.4%
Confidence = egyhangúság mértéke
```
**API:** `Open-Meteo ?ensemble=true` (ingyenes)
**Opt-in:** `USE_ENSEMBLE=true` env var
**Prompt:** `edgecalc-weather-patch.md`
**Időigény:** 2-3 nap
**Hatás:** Weather forecast pontosság +15-20%

---

### P2.4 – LP Bot Klasszifikáció (Apex Wallets bővítés)
**Mit csinál:** LP bot viselkedési fingerprint azonosítás
**3 subgroup:**
```
Subgroup A: Reward Farmers → FADE target
  maker_ratio > 0.40
  trades_per_day > 80
  two_sided_ratio > 0.85
  reward_market_concentration > 0.80

Subgroup B: Naive Mid-Quoters → FADE target
  Mint A, de árfrissítés orderbook alapú

Subgroup C: Smart MMs → COPY target
  Pullback 200-400ms nagy order előtt
  Aszimmetrikus spread
  Net-pozitív direktcionális napokon
```
**Adatforrás:** `warproxxx/poly_data` trades.csv
**Időigény:** 3-4 nap
**Hatás:** Új edge forrás a LP refresh window stratégiából

---

## PRIORITÁS 3 – KÖZÉP TÁVON (2-4 HÉT)
> Ezek nagyobb fejlesztési sprinteket igényelnek.

### P3.1 – Hyperliquid Execution Engine (Hetzner)
**Mit csinál:** Direktcionális perp trading HL-en
**Stack:**
```
@nktkas/hyperliquid SDK
viem + Arbitrum bridge
GTC limit orders + TP/SL
WebSocket fill callbacks
Session loss auto-stop
PAPER_MODE=true default (testnet!)
```
**Tőke allokáció:**
```
Bankroll 20%-a direktcionális trading
Max leverage: 3x
Max pozíció: 15% bankroll
```
**Prompt:** `edgecalc-hyperliquid-prompt.md`
**Időigény:** 5-7 nap
**Előfeltétel:** Arbitrum bridge USDC

---

### P3.2 – Funding Rate Arbitrage (Delta-Neutral)
**Mit csinál:** HL SHORT + Binance LONG egyszerre
**Logika:**
```
Ha HL BTC funding > 0.01%/óra
ÉS HL funding - Binance funding > 0.01%/óra
→ SHORT HL + LONG Binance spot
→ Nettó: 0 irány kockázat + funding bevétel
```
**Várható hozam:** 25-40%/év
**Tőke allokáció:** Bankroll 40%-a
**Prompt:** `edgecalc-funding-arb-patch.md`
**Időigény:** 4-5 nap
**Előfeltétel:** Binance API (spot trading jog)

---

### P3.3 – LP Refresh Window Execution
**Mit csinál:** LP bot stale quote-ok ellen kereskedik
**Trigger:**
```
LP wallet (Subgroup A/B) fill event
+ Binance/Coinbase direktcionális trigger
+ Refresh lag ablak: 8-15 másodperc
→ hit the stale quote opposite side
```
**Risk management:**
```
SL: -12c entry-től
Daily loss cap: -$400
No overnight pozíciók
Kill switch: Redis flag Telegramból
```
**Időigény:** 5-7 nap
**Előfeltétel:** P2.4 LP klasszifikáció kész

---

### P3.4 – Edge Tracker Tab (Tab 12)
**Mit csinál:** Trade history vizualizáció + edge realizáció
**6 chart:**
```
1. Kumulatív PnL vs random baseline
2. Kalibráció scatter (predicted vs actual)
3. Per-szignál IC bar chart
4. Edge decay idősor
5. Win rate hőtérkép (napszak × kategória)
6. PnL eloszlás histogram
```
**KPI-k:** Win rate, Sharpe, Kelly efficiency,
           Max drawdown, Avg edge, Calibration
**Prompt:** `edgecalc-edge-tracker-prompt.md`
**Időigény:** 4-5 nap
**Adatforrás:** warproxxx/poly_data backtesting

---

## KORÁBBI CHATEKBŐL HIÁNYZÓ ELEMEK

### C1 – Hetzner VPS Migráció (részben tervezett)
**Státusz:** Egy korábbi chatben (`tradin bot - migration`) részletes
migrációs terv készült 4 fázisban:
```
Fázis 0: VPS setup (Ubuntu 24.04, Postgres, Redis, Caddy, PM2)
Fázis 1: Frontend + Tools API (read-only)
Fázis 2: Signal layer átköltöztetés
Fázis 3: Execution layer
```
**Domain terv:** `edgecalc.jmeszaros.dev` + `api.edgecalc.jmeszaros.dev`
**Stack:** Bun + PM2 + Caddy + Let's Encrypt
**Prioritás:** Ez a P3.1 Hyperliquid sprint előfeltétele

---

### C2 – 151 Trading Strategies Szignálok
**Forrás:** Kakushadze & Serur könyv (ingyenes SSRN PDF)
**Mit ad hozzá:** 3 új szignál a Signal Combiner-be
```
Jelenlegi: N=5 szignál → IR = 0.070 × √5 = 0.157
Bővítve:   N=8 szignál → IR = 0.070 × √8 = 0.198
```
**Releváns fejezetek:** Statistical arbitrage, momentum, mean reversion
**Hogyan:** Claude Code-nak add a PDF-et + a meglévő signal-combiner.mts-t
**Prioritás:** P2 szint – kis munka, mérhető IR javulás

---

### C3 – Poly_data LP Fingerprint (Python lokálisan)
**Státusz:** A warproxxx/poly_data trades.csv már letölthető
**Tennivaló:** Lefuttatni a cikkből az LP szűrő Python scriptet:
```python
filter: n_trades >= 2000, maker_ratio >= 0.40,
        trades_per_day >= 80, active_days >= 30
# Eredmény: ~343 LP kandidát → 47 confirmed → 9 top LP bot
```
**Ez nem kódfejlesztés** – lokális Python futtatás,
az eredmény (LP wallet lista) kerül a rendszerbe
**Prioritás:** P2.4 LP klasszifikáció előfeltétele

---

### C4 – Pair-Cost Arbitrage (andndyba stratégia)
**Mit csinál:**
```
Buy YES + NO token együtt olcsón
→ Redeem $1.00 garantáltan
→ Kockázatmentes ha combined price < $1.00
```
**Példa:** YES @ $0.05 + NO @ $0.05 = $0.10 → redeem $1.00 = 900% profit
**Referencia wallet:** andndyba (Polymarket leaderboard)
**Prioritás:** P3 szint – új execution mód kell hozzá

---

## PRIORITÁS 4 – HOSSZÚ TÁVON (1-2 HÓNAP)
> Ezek opcionálisak vagy előfeltételhez kötöttek.

### P4.1 – Dynamic Error Balancing (Weather)
**Mit csinál:** Modell súlyok automatikus frissítése
trade lezárása után
**Logika:**
```
Utóbbi 20 trade: GFS vs ECMWF hiba
→ jobb modell súlya automatikusan nő
Minimum 10 trade kell az aktiváláshoz
```
**Prompt:** `edgecalc-weather-patch.md` (benne van)
**Előfeltétel:** 10+ lezárt weather trade

---

### P4.2 – Sports/Politics/Macro Kategóriák
**Sports:** Statisztikai modell vs fan bias
**Politics:** LLM news sentiment scorer
**Macro:** NOAA weather + Fed calendar
**Prompt:** `edgecalc-autotrader-prompt.md` (kategória router)
**Előfeltétel:** Crypto + Weather modulok stabilak

---

### P4.3 – TradingAgents Debate Pattern
**Mit csinál:** Bull Agent vs Bear Agent vs
Risk Manager veto a decision engine-ben
**Referencia:** github.com/TauricResearch/TradingAgents
**Előfeltétel:** Alaprendszer stabilizálódott

---

## TŐKE ALLOKÁCIÓ (javasolt)

```
HLP Vault (passzív)         40% bankroll  → ~20%/év, semmi tennivaló
Funding Rate Arb            40% bankroll  → ~25-40%/év, delta-neutral
Direktcionális Trading      20% bankroll  → ~30-50%/év, magasabb kockázat

Összesített várható hozam: 20-35%/év
Napi felügyelet: 5-10 perc
```

---

## INFRASTRUKTÚRA ÖSSZEFOGLALÓ

```
Netlify (ingyenes)
  → Signal generálás (5 endpoint)
  → Frontend UI + EdgeCalc dashboard
  → Cron trigger (3 percenként)
  → Resolution risk scorer

Hetzner CX22 (€4/hó)
  → Execution engine (bun + PM2)
  → WebSocket feedek (Binance + PM CLOB)
  → Session state
  → Telegram bot

Polymarket
  → BTC 5m/15m piacok
  → Weather temperature piacok

Hyperliquid (testnet először!)
  → Perp trading
  → Funding rate arb (+ Binance spot hedge)
  → HLP Vault (manuális USDC deposit)

Telegram
  → Trade alertek
  → /stop /pause /status parancsok
  → Napi összefoglaló 07:00
```

---

## MEGVALÓSÍTÁSI SORREND (javasolt)

```
HÉT 1:
  ✓ P1.1 Weather station fix
  ✓ P1.2 Korai exit logika
  ✓ P1.3 Order book imbalance szignál
  ✓ P1.4 Auto-claim
  ✓ P1.5 Kelly formula fix

HÉT 2:
  ✓ P2.1 Resolution risk scorer
  ✓ P2.2 Binance/PM divergencia (Hetzner)
  ✓ P2.3 Weather ensemble upgrade

HÉT 3-4:
  ✓ P2.4 LP bot klasszifikáció
  ✓ P3.1 Hyperliquid execution (testnet)
  ✓ P3.4 Edge Tracker tab

HÓ 2:
  ✓ P3.2 Funding rate arb
  ✓ P3.3 LP refresh window execution

HÓ 3+:
  ✓ P4.x hosszú távú fejlesztések
```

---

## KÉSZ PROMPTOK (Claude Code-nak átadható)

```
edgecalc-autotrader-prompt.md      → Crypto execution alap
edgecalc-weather-trader-prompt.md  → Weather modul alap
edgecalc-weather-patch.md          → Station fix + ensemble
edgecalc-hyperliquid-prompt.md     → HL execution engine
edgecalc-funding-arb-patch.md      → FR arb modul
edgecalc-edge-tracker-prompt.md    → Tab 12 vizualizáció
edgecalc-resolution-risk-prompt.md → Settlement kockázat
edgecalc-divergence-patch.md       → Binance/PM divergencia
```

---

## KRITIKUS SZABÁLYOK (soha ne sértsd meg)

1. PAPER_MODE=true default – live előtt min. 20 paper trade
2. MAX_LEVERAGE=3 Hyperliquid-en – soha ne menj feljebb
3. SESSION_LOSS_LIMIT kötelező – default $50
4. TP/SL minden nyitott pozíción – stop nélkül ne nyiss
5. Auto-claim Polymarketen – különben elvesznek a nyeremények
6. Testnet először HL-en – mainnet csak sikeres paper után
7. Webhook secret kötelező – Netlify → Hetzner auth
8. PRIVATE_KEY soha nem kerül logba vagy chatbe
