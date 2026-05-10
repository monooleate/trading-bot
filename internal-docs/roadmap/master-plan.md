# EdgeCalc Trading Rendszer – Megvalósítási Összefoglaló

> Ez a dokumentum az összes eddigi trading témájú megbeszélés
> alapján készült. Claude Code-nak átadható, prioritásokkal ellátott
> fejlesztési terv.
>
> **Utolsó státusz-frissítés:** 2026-05-11

---

## STÁTUSZ JELÖLŐK

| Jelölő | Jelentés |
|--------|----------|
| ✅ **DONE** | Implementálva, prodban fut. |
| ⚠️ **PARTIAL** | Részben kész — alap-funkció van, de hiányoznak komponensek. |
| ❌ **TODO** | Még nem készült el. |
| 📋 **PLAN-ONLY** | Csak terv-doksiban szerepel, infra-előfeltétele hiányzik. |
| 🔄 **REPLACED** | Megvalósult, de más megoldás formájában (lásd "Plan-on kívül"). |

---

## TÉNYLEGES ÁLLAPOT (2026-05-11)

**Implementálva (✅):** 11/19 fő pont
**Részben (⚠️):** 3/19
**Hátra (❌/📋):** 5/19

### Mi MŰKÖDIK élesben (paper mode)
- Crypto bot — BTC 5m/15m piacokon, 8 signal, ¼-Kelly, korai exit, OB imbalance
- Weather bot — 24 város, ensemble forecast, METAR reconciler, bucket-matcher
- HL Perp bot — directional perp trading paper-only (live SDK NPM install kell)
- Funding-Arb bot — delta-neutral HL short + Binance spot long paper-only
- Edge Tracker — 12. tab, IC + calibration health badges
- 9 elemző tool (Scanner / EV / Swarm / Order Flow / Vol Harvest / Apex / Cond Prob / Signals / Arb Matrix)
- Settings tab — Blobs runtime override 30+ env-paramater fölött
- Auth + JWT cookie + admin password

### Mi NEM működik élesben
- **Hetzner VPS nincs telepítve** — minden Netlify-on fut (signal + execution réteg ugyanazon a serverless platformon)
- **LP Refresh Window execution** — WebSocket feedek hiányoznak (Hetzner kéne)
- **Sports/Politics/Macro bot** — csak stub fájlok TODO-kkal
- **Live HL trading** — SDK telepítés és HL_PRIVATE_KEY env kell hozzá
- **Live Polymarket trading** — gate-ek átengedése után POLY_PRIVATE_KEY kell

---

## A TELJES RENDSZER ARCHITEKTÚRA (eredeti terv)

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

HETZNER CX22 (execution réteg, €4/hó)       ← 📋 PLAN-ONLY (nincs telepítve)
  Folyamatosan fut (PM2 + bun):
    WebSocket: Binance kline_1s + PM CLOB
    Divergencia detektor
    LP refresh window detektor
    Order lifecycle management
    Session state + PnL tracking
    Telegram alerts

POLYMARKET (execution célpont 1)             ← ✅ paper-mode kész
  BTC 5m/15m Up/Down piacok
  Weather temperature piacok

HYPERLIQUID (execution célpont 2)            ← ✅ paper-mode kész
  BTC/ETH/SOL perp trading
  Funding rate arbitrage (delta-neutral)
  HLP Vault (passzív, manuális)
```

**Valós state:** A teljes "execution réteg" Netlify Functions-on fut, nem Hetzner-en.
Cron `*/3 * * * *` szerint. WebSocket helyett HTTP poll van mindenhol.

---

## PRIORITÁS 1 – AZONNAL MEGVALÓSÍTANDÓ
> Ezek a meglévő kód alapján a legkisebb erőfeszítéssel
> a legnagyobb értéket adják.

### P1.1 – Weather Station Fix ✅ **DONE**
**Probléma:** Hibás settlement station adatok = garantált veszteség
**Javítás:**
```
NYC    → KLGA (LaGuardia)      NEM KNYC
Dallas → KDAL (Love Field)     NEM KDFW
London → EGLC (London City)    NEM EGLL
Tokyo  → RJTT (Haneda)         NEM RJAA
```
**Megvalósítás:** `netlify/functions/auto-trader/weather/station-config.mts` (24 város).
Session 1 (2026-05-09) + session 14 (2026-05-10) bővítések — Madrid, Paris,
Milan, Munich, Ankara, Lagos, Sao Paulo, Austin, Dallas, Tokyo hozzá.

---

### P1.2 – Korai Exit Logika (BTC 5m piacok) ✅ **DONE**
**Probléma:** Hold-to-resolution = avg loss $52, korai exit = avg loss $19
**Javítás az execution rétegben:**
```typescript
TP: 0.75 (nem $1.00!)
SL: 0.35
Ha <60mp resolution: hold to end
Entry ablak: 60-180mp a market nyitás után
```
**Megvalósítás:** `auto-trader/shared/config.mts` (BTC_TP_TARGET, BTC_SL_TARGET,
BTC_ENTRY_WINDOW_* env-ek) + `auto-trader/crypto/order-lifecycle.mts:checkExitConditions`.
Session 1 (2026-05-09) **+** session 15 (2026-05-10) wire-up live exit
orchestrator (`runLiveEarlyExits` az index.mts-ben — addig dead code volt).

---

### P1.3 – Order Book Imbalance Szignál ✅ **DONE**
**Probléma:** Egyetlen szignál = 57% win rate
**Javítás:** Második szignál hozzáadása
```typescript
bid_depth / ask_depth > 1.8 → UP megerősítés
bid_depth / ask_depth < 0.55 → DOWN megerősítés
```
**Megvalósítás:** `auto-trader/crypto/signal-aggregator.mts:fetchOrderBookImbalance`
+ `classifyImbalance` + `obImbalance` mező az `AggregatedSignal`-ben.
Decision-engine konvergencia gate-ként használja.

---

### P1.4 – Auto-Claim (Polymarket) ⚠️ **PARTIAL**
**Probléma:** Nyertes pozíciók nem automatikusan jóváírva
**Javítás:** Redeem logika
- ✅ `netlify/functions/polymarket-redeem.mts` (auth-protected, intent-only)
- ✅ `RedeemSection` a TradingPanel Polymarket sub-panelben (kézi gomb)
- ✅ Live close `requiresRedeem: true` flag logban + Telegram alert
- ❌ **Cron-alapú auto-redeem NEM kész** — még mindig manuális gombnyomás kell.

**Hátra:** új `*/15 * * * *` cron ami pollolja a `closedTrades` `requiresRedeem`
flag-jét és futtatja a redemption-t. Session 15 hova-nyúlj listán mint
"opcionális".

---

### P1.5 – Kelly Formula Pontosítás ✅ **DONE**
**Probléma:** Kelly nem binary piacra optimalizált
**Megvalósítás:** `src/lib/math.ts:kellyBinary(p, marketPrice, bankroll, { fraction: 0.25 })`
— ¼-Kelly + 8% hard cap (`MAX_KELLY_FRACTION` env, default 0.08). Dashboard 3 call-site
átállítva. HL bot saját `auto-trader/hyperliquid/kelly-sizer.mts` (külön
3x leverage cap-pel).

---

## PRIORITÁS 2 – RÖVID TÁVON (1-2 HÉT)
> Ezek új funkcionalitást adnak a meglévő alapra.

### P2.1 – Resolution Risk Scorer ✅ **DONE**
**Mit csinál:** Claude API + heurisztikus fallback elemzi a settlement rules-t
**Megvalósítás:** `netlify/functions/_resolution-risk.ts` (3 path:
ambig-keywords → Claude → static fallback). A signal-combiner-be integrálva
(`analyseResolutionRisk` + `applyResolutionAdjustment` minden trade-ajánlásra).
Score > 0.6 → trade blokkolva.

**Score komponensek:** source_clarity, wording_ambiguity, deadline_precision,
historical_disputes, source_availability.

---

### P2.2 – Binance/PM Divergencia Szignál (Hetzner) 📋 **PLAN-ONLY**
**Mit csinál:** Real-time Binance vs PM price gap mérés WebSocket-en
**Status:** A Netlify oldal HTTP poll-on csinál egy közelítést (`fetchOrderBookImbalance`
P1.3-ban), DE a valódi WebSocket-alapú real-time divergencia (2-3 másodperces
entry ablak) Hetzner kell hozzá.

**Hátra:**
- Hetzner CX22 setup (C1)
- `wss://stream.binance.com:9443/ws/btcusdt@kline_1s` consumer
- `wss://ws-subscriptions-clob.polymarket.com/ws/market` consumer
- HTTP webhook a Netlify cron → Hetzner trigger-hez

---

### P2.3 – Weather Ensemble Forecast Upgrade ✅ **DONE**
**Mit csinál:** GFS + ECMWF + NOAA többmodell ensemble
**Megvalósítás:** `auto-trader/weather/ensemble-forecast.mts`. `USE_ENSEMBLE=true`
env-flag-gel kapcsolható. Settings tab-ról is állítható (`weatherUseEnsemble`
toggle). DEB (Dynamic Error Balancing) — `auto-trader/weather/deb.mts` — a P4.1
korai megvalósítása.

---

### P2.4 – LP Bot Klasszifikáció (Apex Wallets bővítés) ✅ **DONE**
**Mit csinál:** Hubble Research módszertan, 3 subgroup azonosítás
**Megvalósítás:** `netlify/functions/apex-wallets.mts:buildLPProfile` +
`classifySubgroup`. Mezők: `maker_ratio`, `trades_per_day`, `two_sided_ratio`,
`top_market_concentration`, `active_days`. Subgroup A (Reward Farmer, FADE) /
B (Naive Mid-Quoter, FADE) / C (Smart MM, COPY).

UI: `LPSubgroupCard` az `ApexWalletsPanel.tsx` Profile tabján.

**Nyitva maradt:** a klasszifikáció EREDMÉNYÉT (subgroup label) még nem
táplálja vissza a signal-combiner apex_consensus súlyba. Subgroup C wallet-eket
nagyobb súllyal kéne figyelni, A/B-t fadelni.

---

## PRIORITÁS 3 – KÖZÉP TÁVON (2-4 HÉT)
> Ezek nagyobb fejlesztési sprinteket igényelnek.

### P3.1 – Hyperliquid Execution Engine ⚠️ **PARTIAL (paper-only)**
**Mit csinál:** Direktcionális perp trading HL-en (BTC/ETH/SOL)
**Megvalósítás állapot:**
- ✅ Paper mode teljes pipeline: scan → signal → decision → entry → resolve
- ✅ 13 kereskedési knob (config.mts) + Settings tab override-ok
- ✅ 6 audit-finding (sessions 16-17) closeolva: TP/SL clamp, vol gate parity,
  funding accrual, lot precision, cooldown persistence, slippage modeling
- ✅ `live-resolver.mts` — TP/SL fill reconciliation a session blob-bal
- ✅ `live-readiness` gate (≥30 paper trade, IC≥5%, Sharpe≥0.5, DD<25%, simVersion=2)
- ⚠️ **Élesítéshez hiányzik:**
  - `npm i @nktkas/hyperliquid viem` (még nincs telepítve)
  - `HL_PRIVATE_KEY` env var beállítása
  - `HL_PAPER_MODE=false` redeploy

**Tőke allokáció:** max leverage 3x, max pozíció 15% bankroll (HL_MAX_PCT_BANKROLL).
**Telepítés helyett a Netlify Functions-on fut**, nem Hetzner-en.

---

### P3.2 – Funding Rate Arbitrage (Delta-Neutral) ⚠️ **PARTIAL (paper-only)**
**Mit csinál:** HL SHORT + Binance LONG spot egyszerre
**Megvalósítás állapot:**
- ✅ Teljes pipeline: scanner → opportunity detection → 5-gate entry decision →
  atomic 2-leg open → mark-to-market funding accrual → close
- ✅ 9 kereskedési knob (FR_* env-ek) + Settings tab
- ✅ Session 16 audit (2 critical + 1 major fix): MtM funding accrual,
  asymmetric close slippage, Binance lot precision
- ⚠️ **Élesítéshez:**
  - `HL_PRIVATE_KEY` (HL leg)
  - `BINANCE_API_KEY` + `BINANCE_API_SECRET` (spot hedge leg)
  - `HL_PAPER_MODE=false`

**Várható hozam:** 25-40%/év (tényleges, miután live).
**Tőke allokáció:** 40% bankroll (FR_MAX_CAPITAL_PCT).
**A HL és F-Arb session ugyanazt a HL bankroll-t osztja meg.**

---

### P3.3 – LP Refresh Window Execution ❌ **TODO**
**Mit csinál:** LP bot stale quote-ok ellen kereskedik
**Status:** Csak az LP detektor (P2.4) van kész, az execution NEM.
**Hátra:**
- WebSocket fill event consumer LP wallet-ekre (Hetzner kell — Netlify Functions
  serverless cold start nem tud 8-15s reaktivitást)
- Binance/Coinbase directional trigger consumer
- "Hit the stale quote opposite side" execution
- Daily loss cap −$400, kill switch
- **Előfeltétel:** P2.4 ✅ + C1 (Hetzner) ❌

---

### P3.4 – Edge Tracker Tab (Tab 12) ✅ **DONE**
**Mit csinál:** Trade history vizualizáció + edge realizáció
**Megvalósítás:** `netlify/functions/edge-tracker.mts` + `edge-tracker/` modul
(statistics.mts, types.mts). UI: `src/components/EdgeTrackerPanel.tsx` +
per-category routing `/trade/{category}/edge-tracker`.

**Implementált:**
- ✅ Kumulatív PnL idősor
- ✅ Per-szignál IC bar chart
- ✅ Win rate breakdown
- ✅ Calibration Health Badge (good/weak/noise/insufficient)
- ✅ Per-trade view rationale-pop-overek
- ⚠️ **Részben (eredeti 6 chart-ból):**
  - Random baseline összehasonlítás — nincs explicit baseline overlay
  - Kalibráció scatter — más vizualizáció (Badge instead)
  - Edge decay idősor — nincs külön chart
  - Win rate hőtérkép (napszak × kategória) — nincs

---

## KORÁBBI CHATEKBŐL HIÁNYZÓ ELEMEK

### C1 – Hetzner VPS Migráció 📋 **PLAN-ONLY**
**Státusz:** A `internal-docs/roadmap/hetzner-migration.md`-ban 7-fázisos
action plan készen áll, **de Hetzner deploy nincs**.

**Hátra (a plan szerint):**
1. Ubuntu 24.04 VPS provision (CX22, €4/hó)
2. Bun + PM2 + Caddy + Let's Encrypt + Postgres + Redis stack
3. Domain: `edgecalc.jmeszaros.dev` + `api.edgecalc.jmeszaros.dev`
4. Frontend + Tools API mirror (read-only)
5. Signal layer átköltöztetés
6. Execution layer (WebSocket feedek)
7. Cutover

**Mit jelent ez az operatív működésre:**
- Jelenleg minden a Netlify Functions-on fut. HTTP poll cron */3 min-onként,
  WebSocket nélkül.
- A P3.3 LP Refresh Window és P2.2 valódi divergencia signal Hetzner-re vár.
- A bot jelenlegi reaktivitása: ~3 perces ciklus — elég a BTC 15m markets-hez,
  kevés a 5-15s LP refresh window-hoz.

---

### C2 – 151 Trading Strategies Szignálok ✅ **DONE**
**Forrás:** Kakushadze & Serur könyv
**Megvalósítás:** 3 új signal a signal-combiner.mts-ben:
- `getMomentumSignal` (Kakushadze 3.1, Rcum momentum) — Blobs snapshot anchor
- `getContrarianSignal` (Kakushadze 10.3, mean-reversion vs market index)
- `getPairsSpreadSignal` (Kakushadze 3.8, Z-score related markets)

A combinator most 8 signal-t kombinál (5 eredeti + 3 Kakushadze). IR-formula
és aktuális számítás: `IR = avgIC × √(effN)` ahol effN = N × 0.6 a korreláció-korrekció.

---

### C3 – Poly_data LP Fingerprint ⚠️ **PARTIAL**
**Mit jelent:** A Python script futtatása + LP wallet lista a rendszerbe.
**Megvalósítás:**
- ✅ Python script — `apex_wallet_profiler.py` futtatható (--consensus, --profile, --leaderboard)
- ✅ A web UI Apex Wallets panel azonos logikát fut Polymarket Data API-val
- ⚠️ A 47 confirmed + 9 top LP bot CSV lista **nincs feedelve** a
  signal-combiner-be — a wallet-szintű klasszifikáció per-profil fut a UI-n,
  de globális "LP bot whitelist" amit a bot mindennap olvasna, nincs

**Hátra:**
- Egy Blobs-tárolt `lp_wallets.json` lista bot-onként
- Cron ami havonta frissíti a `apex_wallet_profiler.py --leaderboard --filter-lp` output-tal

---

### C4 – Pair-Cost Arbitrage ✅ **DONE**
**Mit csinál:** Buy YES + NO együtt < $1.00 → redeem $1.00 = arb
**Megvalósítás:** `netlify/functions/pair-cost-arb.mts` + Tab 11 D (`Pair-Cost`)
az `ArbMatrixPanel.tsx`-ben. VWAP-validált $50 notional-on (nem mid-price
illúzió). User testnotional + minProfit% paraméterekkel állítható.

---

## PRIORITÁS 4 – HOSSZÚ TÁVON (1-2 HÓNAP)

### P4.1 – Dynamic Error Balancing (Weather) ✅ **DONE (korán)**
**Mit csinál:** Modell súlyok automatikus frissítése trade lezárása után
**Megvalósítás:** `auto-trader/weather/deb.mts`. A weather reconciler-be
integrálva — minden zárt trade után frissíti a GFS/ECMWF/NOAA súlyokat
az utolsó N trade hibája alapján.

---

### P4.2 – Sports/Politics/Macro Kategóriák ❌ **TODO (stub-ok)**
**Status:** A 3 modul fájl létezik mint stub:
- `auto-trader/sports/index.mts` — TODO Sprint 2 (NBA, NFL, Premier League)
- `auto-trader/politics/index.mts` — TODO Sprint 3 (LLM news sentiment)
- `auto-trader/macro/index.mts` — TODO Sprint 4 (NOAA, Fed, indicators)

Mind az alábbival kezdődik: `// TODO: ...` + `export {};`.

**Hátra:** category-onként teljes pipeline (market-finder + decision-engine +
session-manager). Mintaként a crypto / weather modul-pár szolgál.

---

### P4.3 – TradingAgents Debate Pattern ❌ **TODO**
**Mit csinál:** Bull Agent vs Bear Agent vs Risk Manager veto a decision
engine-ben (Claude multi-agent pattern).
**Status:** Nincs implementáció.
**Előfeltétel:** Alaprendszer stabilizálódása + ANTHROPIC_API_KEY budget bővítése.

---

## TŐKE ALLOKÁCIÓ (javasolt — eredeti terv)

```
HLP Vault (passzív)         40% bankroll  → ~20%/év, semmi tennivaló
Funding Rate Arb            40% bankroll  → ~25-40%/év, delta-neutral
Direktcionális Trading      20% bankroll  → ~30-50%/év, magasabb kockázat

Összesített várható hozam: 20-35%/év
Napi felügyelet: 5-10 perc
```

**Tényleges paper-bankroll szétosztás (2026-05-11):**
- Crypto bot: $150 paper
- Weather bot: $100 paper (reset után, fake $571 bankroll fix)
- HL Perp + Funding-Arb: $200 shared HL session paper
- HLP Vault: nincs (manuális, off-system)

---

## INFRASTRUKTÚRA ÖSSZEFOGLALÓ — TÉNYLEGES

```
Netlify (ingyenes)                          ✅ ACTIVE
  → Signal generálás (8 endpoint + combinator)
  → Frontend UI + 9 elemző tool + 4 trader dashboard
  → Cron trigger (*/3 min × 4 bot)
  → Resolution risk scorer
  → Execution réteg ITT FUT (nem Hetzner-en)

Hetzner CX22 (€4/hó)                        📋 NEM TELEPÍTVE
  → Tervezett, plan-only

Polymarket                                  ✅ paper-mode kész
  → BTC 5m/15m piacok (crypto bot)
  → Weather temperature piacok (weather bot)
  → ⚠️ Live trading: paper-validation + POLY_PRIVATE_KEY után

Hyperliquid                                 ⚠️ paper-only
  → Perp trading (HL bot)
  → Funding rate arb HL leg (FR-arb bot)
  → ⚠️ Live: npm install + HL_PRIVATE_KEY után

Binance                                     ⚠️ paper-only
  → Klines + funding rates (data, public)
  → FR-arb spot hedge leg (auth needed live)
  → ⚠️ Live: BINANCE_API_KEY/SECRET + execution

Telegram                                    ⚠️ env-függő
  → Trade alertek, calibration warnings, session stop
  → TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env kell
```

---

## MEGVALÓSÍTÁSI SORREND — TÉNYLEGES

A plan eredetileg 4 hetes ütemezést javasolt. **A valós megvalósítás
25+ session-ön át történt 2026-04 és 2026-05 között**, jellemzően:

```
2026-04-08 — Crypto bot + weather bot alap (sessions 1-5)
2026-04-21 — Hyperliquid bot indítása (sessions 6-9)
2026-04-30 — Funding-Arb bot (sessions 10-12)
2026-05-08 — Settings tab + Polymarket auto-claim + LP subgroups (sessions 13-15)
2026-05-09 — Kakushadze 3 új signal + Calibration alarm (sessions 16-19)
2026-05-09 — Auto-Trader UI unification (TraderShell) (sessions 20-21)
2026-05-10 — HL + Funding-Arb full audit + 15 bug fix (sessions 22-23)
2026-05-10 — Paper-resolver v3 (real Polymarket only, no sim) (sessions 24-25)
2026-05-10 — /tools/ dashboard UX + env-vars doc (sessions 26-27)
2026-05-11 — UMA finality fix + Funding-Arb UI parity (sessions 28-29)
```

---

## PLAN-ON KÍVÜL MEGVALÓSÍTVA (nem szerepelt az eredeti tervben)

Ezek vagy menet közbeni feature-igények voltak, vagy "hidden requirement"-ek
amiket az audit talált meg:

### Infra + UX
- ✅ **Auth rendszer** — JWT cookie + SHA-256 password hash + 8h session,
  Settings tab védése
- ✅ **Settings tab (Tab 13)** — 30+ runtime-overrideolható paraméter,
  redeploy nélkül állítható
- ✅ **HomePage mission control** — minden bot status egyetlen oldalon,
  aggregated PnL summary, click-to-trade navigation
- ✅ **CategoryDashboard** — 4 bot saját 3-tabos oldala (Auto-Trader /
  Edge Tracker / Settings)
- ✅ **Multi-bot session-isolated state** — minden bot saját Blobs key-en
- ✅ **TraderShell unified UI** — 1 wrapper + 5 reusable card (ScanResults,
  Pending, Open, Opportunities, Dropped)
- ✅ **Live readiness gate rendszer** — per-bot 5-7 gate (trade count, IC,
  Sharpe, DD, simVersion, session active)
- ✅ **Calibration Health badge** — 30+ trade IC-monitoring + Telegram alarm
  ha minden signal noise (IC<2%)
- ✅ **Type-to-confirm Reset dialog** + JSON trade export
- ✅ **Per-row entry-criteria gate chips** — minden scan-sor "X/Y gates ✓"
  hover popoverrel

### Bot-pipeline javítások
- ✅ **simVersion auto-archive** (v1→v2→v3 paper sessions)
- ✅ **Paper resolver v3** — sim-mentes, csak valós Polymarket resolution
- ✅ **UMA finality gate** — paper-resolver csak `umaResolutionStatus="resolved"`-on
  zár (defensive 2026-05-11)
- ✅ **Slug-mismatch sanity check** weather reconciler-ben
- ✅ **HL `runLiveEarlyExits` orchestrator** — TP/SL exit code wire-up
  (session 15 előtt dead code volt)
- ✅ **Crypto Pending Positions Card** — past endDate UMA-várakozó pozíciók
  diagnostic kártya
- ✅ **Crypto Reconcile button** — per-position Gamma probe (session 24)
- ✅ **Funding-Arb 4-cell stats parity** a többi bottal (session 29, 2026-05-11)

### Dokumentáció
- ✅ **internal-docs/current-state/env-vars.md** — 61 env-változó részletes referencia (2026-05-11)
- ✅ **internal-docs/math/13-crypto-bot.md** — runtime walkthrough
- ✅ **internal-docs/math/14-hl-directional.md** — HL implementation reference
- ✅ **internal-docs/math/15-funding-arb.md** — F-Arb implementation reference
- ✅ **internal-docs/changelog/CHANGELOG-YYYY-MM-DD.md** — minden non-trivial
  változás dokumentálva

---

## MI VAN MÉG HÁTRA — PRIORITÁS SZERINT

### 🔴 KRITIKUS (live-mode előfeltételek)

1. **P1.4 follow-up — Polymarket auto-redeem cron**
   Új `*/15 * * * *` cron + `closedTrades.requiresRedeem` poll +
   automatikus redemption hívás. Minor effort (~2h).

2. **HL live trading deps + env**
   `npm i @nktkas/hyperliquid viem` + `HL_PRIVATE_KEY` + `HL_PAPER_MODE=false`.
   Csak akkor amikor a paper validation gate-eken átment.

3. **Polymarket live trading deps + env**
   `POLY_PRIVATE_KEY` + `POLY_FUNDER_ADDRESS` + `PAPER_MODE=false`.
   Csak gate-átengedés után.

### 🟠 KÖZÉPTÁVÚ (új funkcionalitás)

4. **P2.4 follow-up — LP subgroup feedback a signal-combiner-be**
   Az apex_consensus súly subgroup-szintűen állítódjon: A/B → fade,
   C → boost. ~1 nap.

5. **C3 follow-up — globális LP wallet whitelist**
   `lp_wallets.json` Blobs + havi cron frissítés. ~2 nap.

6. **P3.4 follow-up — hiányzó Edge Tracker chartok**
   Random baseline overlay, Calibration scatter, Edge decay timeseries,
   Win-rate heatmap (napszak × kategória). ~3 nap.

### 🟡 NAGY SPRINT (új infra + új bot)

7. **C1 — Hetzner VPS migráció**
   A `hetzner-migration.md` 7-fázisa. ~1-2 hét.
   **Előfeltétele:** P2.2, P3.3, és long-term operábilis bot-mátrix.

8. **P2.2 — Real-time WebSocket divergencia (Hetzner-en)**
   Binance kline_1s + PM CLOB WebSocket consumer + 2-3s entry trigger.
   **Előfeltétel:** C1 (Hetzner).

9. **P3.3 — LP Refresh Window execution**
   Stale-quote opposite-side hit. **Előfeltétel:** C1 + P2.4 follow-up.

10. **P4.2 — Sports/Politics/Macro bot trio**
    Category-onként market-finder + decision-engine + session.
    Sports: NBA odds vs fan-bias. Politics: LLM news sentiment.
    Macro: NOAA + Fed calendar. ~4-6 hét össz.

### 🟢 NICE-TO-HAVE (opcionális)

11. **P4.3 — TradingAgents debate pattern**
    Bull/Bear/Risk Manager Claude agent triumvirate. Kísérleti.

12. **HLP Vault auto-deposit**
    Bankroll-arány-tartó cron ami a HL bankroll 40%-át passzív yield-re
    küldi HLP-be. Manuálisan ma is működik.

---

## KRITIKUS SZABÁLYOK (soha ne sértsd meg)

1. **PAPER_MODE=true default** — live előtt min. 30 paper trade + IC≥5% + Sharpe≥0.5
2. **MAX_LEVERAGE=3 Hyperliquid-en** — soha ne menj feljebb (`HL_MAX_LEVERAGE` env, warning log clamp-on)
3. **SESSION_LOSS_LIMIT kötelező** — crypto: $20, HL: $50 (env-overrideolható)
4. **TP/SL minden nyitott pozíción** — stop nélkül ne nyiss
5. **Auto-claim Polymarketen** — kézi vagy cron, különben elvesznek a nyeremények
6. **Testnet először HL-en** — mainnet csak sikeres paper-validation után (≥30 trade)
7. **Webhook secret kötelező** — Netlify → Hetzner auth (ha Hetzner aktiválódik)
8. **PRIVATE_KEY soha nem kerül logba vagy chatbe** — Netlify env masking is védi
9. **UMA finality gate** — paper/live resolver csak `umaResolutionStatus="resolved"`-on
   zár (2026-05-11 (i) bug fix után invariáns)
10. **simVersion gate** — paper PnL semantic change-nél kötelező auto-archive +
    runState invalidation (crypto v1→v2→v3 minta)

---

## REFERENCIÁK

- **Részletes env-doksi:** [`../current-state/env-vars.md`](../current-state/env-vars.md) (2026-05-11)
- **Architektúra-doksi:** [`../README.md`](../README.md)
- **Math/implementation references:** [`../math/`](../math/) (15-bot referencia + 6 algoritmus-doksi)
- **Changelog:** [`../changelog/`](../changelog/) (session-by-session, 2026-04-08 óta)
- **Hetzner migration plan:** [`hetzner-migration.md`](./hetzner-migration.md)
- **CLAUDE.md "AKTUÁLIS ÁLLAPOT"** — minden session aktuális statusz-bejegyzéssel
