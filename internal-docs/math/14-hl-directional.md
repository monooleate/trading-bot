# Hyperliquid Directional Perp Bot – Implementation Reference

> **Scope:** ez a doksi a `category: "hyperliquid", layer: "directional"`
> bot **élő futási logikáját** írja le, ahogy a
> `netlify/functions/auto-trader/hyperliquid/` fán jelenleg implementálva van
> (HL_PAPER_SIM_VERSION 2, 2026-05-10 állapot). A signal-szintű matematika a
> `math/06-orderflow.md`–`math/11-arb-matrix.md` fájlokban él (ugyanazt a
> `signal-combiner` endpointot használja, mint a crypto bot); ez a doksi azt
> szedi össze, **mit használ valójában a HL perp bot, milyen sorrendben,
> milyen paraméterekkel.**

---

## 1. Bot célja és stratégia

| Szempont | Érték |
|----------|-------|
| **Venue** | Hyperliquid mainnet (`api.hyperliquid.xyz`) – live, `api.hyperliquid-testnet.xyz` – paper |
| **Underlying** | BTC / ETH / SOL perpetual futures (3 coin per cron tick) |
| **Cron** | `*/3 * * * *` (`auto-trader-multi-cron` schedule, layer=directional fan-out) |
| **Side** | LONG / SHORT (a Polymarket binary "Up/Down" piac probabilitása alapján) |
| **Stratégia** | Cross-venue prediction → perp directional bias. A signal-combiner Polymarket-mart kombinált prob (`finalProb ∈ [0,1]`) megmondja a HL perp irányát: `≥ 0.5 → LONG`, `< 0.5 → SHORT`. Az `|finalProb − 0.5| × 2` directional-edge nyugtatja a sizing-et |
| **Exit** | TP/SL crossing a HL markPrice-ra, vagy timeout (default 4h) |
| **Default bankroll** | $200 USDC (paper init); UI override-olható reset-tel |

A bot **nem** prediction-market trader (azt a crypto bot csinálja Polymarket
CLOB-on), hanem **a Polymarket-mart predikciót cross-venue trade-eli HL-en**:
ha a binary market 60% YES (BTC up), HL LONG BTC. A perp leg nem kerüli meg
a binary spread-et (azt a crypto bot kihasználja), hanem a directional view-t
kétszerezi meg ott, ahol a leverage és tighter spreads van.

---

## 2. Futási pipeline

```
┌──────────────────────────────────────────────────────────────┐
│  CRON: */3 min — auto-trader-multi-cron fan-out              │
│  (POST /auto-trader { category: "hyperliquid",               │
│                       layer: "directional" }, ?source=cron)  │
└────────────────────────────┬─────────────────────────────────┘
                             │
            runHyperliquidTrader(configOverride?, source)
                             │
       ┌─────────────────────┼─────────────────────────┐
       │                     │                         │
       ▼                     ▼                         ▼
loadHlSession()      resolveOpenHlPaper       computeLiveReadiness()
+ simVersion         Positions()              + shouldForcePaper()
  archive gate       (HL markPrice + funding) + Telegram alarm
       │                     │                         │
       └─────────────────────┴─────────────────────────┘
                             │
                  for coin of ["BTC", "ETH", "SOL"]:
                    isOnCooldown(coin)?
                             │
                             ▼
                    getHlSignalForCoin(coin)
                             │     ← polymarket-proxy + signal-combiner
                             ▼
                    volatilityGate(coin, 120%)
                             │     ← Binance fapi/api klines + RV
                             ▼
                    makeHlDecision(signal, session, config)
                             │     ← 8 ordered gate (lásd §4)
                             ▼
                    getCurrentPrice(coin) ← HL allMids
                             │
                             ▼
                    kellyToPerpSize(...) ← ¼-Kelly + 3x lev cap
                             │
                             ▼
                    placeHlEntry(coin, dir, ...)
                             │     ← paper: pure sim
                             ▼     ← live: @nktkas/hyperliquid SDK
                    addOpenPosition(session, hlPosition)
                             │
                             ▼
                  saveHlSession() → markHlRunFinish()
```

---

## 3. Signal source (`hyperliquid/signal-source.mts`)

### Forrás

A bot a crypto bot signal pipeline-ját ÚJRAHASZNÁLJA — nem külön logikát.

```
1. polymarket-proxy?limit=80 → top markets list
2. COIN_KEYWORDS[coin] match (pl. "bitcoin-up-or-down" → BTC slug)
3. signal-combiner?slug={slug} → kombinált prob, kelly, 8 jelzés
```

### `HlSignalResult`

| Mező | Forrás | Jelentés |
|------|--------|----------|
| `direction` | `finalProb >= 0.5 ? "LONG" : "SHORT"` | Perp irány |
| `finalProb` | `combiner.combined_probability` | YES prob a Polymarket binary piacon |
| `edge` | `\|finalProb − 0.5\| × 2` | Directional edge ∈ `[0, 1]` |
| `kellyFraction` | `combiner.kelly.full` | Full-Kelly (a sizer ¼-eli) |
| `activeSignals` | `combiner.active_signals` | 0-8 (3 minimum a gate-ben) |
| `signalBreakdown` | `combiner.raw_signals.*` | 8-mezős mix (FR, VPIN, VOL, APEX, CP, MOM, CTR, PRS) |
| `marketSlug` | `m.slug` | Pl. `bitcoin-up-or-down-on-may-9-2026` |
| `marketPrice` | `combiner.market.yes_price` | Polymarket YES mid (rationale-hoz) |
| `resolutionCategory` | `combiner.resolution_risk.category` | LOW/MED/HIGH/SKIP |

> ⚠ **Fontos invariáns:** a HL bot ugyanazt a `signal-combiner` endpointot
> hívja, amit a crypto bot. Bármilyen IC-kalibráció, signal IC mérés a
> crypto edge-trackerben **automatikusan a HL bot signal-jeit is megméri**,
> mert ugyanazokra a market slug-okra futnak.

---

## 4. Decision gates (`hyperliquid/decision-engine.mts:makeHlDecision`)

A 15 gate sorrendben (a runner inline-ban evaluálja az összeset, non-short-circuit
— `auto-trader/hyperliquid/index.mts:226-585`). A `entryDecision`
snapshot a `EntryDecisionSnapshot.gates[]` array-jébe a teljes listát
építi:

| # | Gate | Forrás | Default | Bukás → reason |
|---|------|--------|---------|----------------|
| 1 | Coin cooldown | `cooldownMap[coin] !> now` | 300s | `<COIN> on cooldown` |
| 2 | Signal forrás elérhető | `getHlSignalForCoin(coin) !== null` | – | `no signal` |
| 3 | Volatility (RV) ≤ küszöb | `volatilityGate(coin, volGateRvPct)` | 120% RV/yr | `<COIN> RV X% > 120%` |
| 4 | Session loss < limit | `session.sessionLoss < config.sessionLossLimit` | $50 | `Session loss limit reached ($50)` |
| 5 | Open positions < max | `session.openPositions.length < maxOpenPositions` | 3 | `Max open positions (3) reached` |
| 6 | Consecutive losses < limit | `session.consecutiveLosses < consecutiveLossLimit` | 3 | `3 consecutive losses — pause required` |
| 7 | Coin nincs már nyitva | `!session.openPositions.some(p => p.coin === coin)` | – | `Already have open <COIN> position` |
| 8 | **Directional-consistency (no LONG+SHORT same coin)** ✦ | `!session.openPositions.some(p => p.coin === coin && p.direction !== signal.direction)` | – | `Directional conflict: <DIR>-<COIN> már nyitva` |
| 9 | Aktív signal források ≥ 3 | `signal.activeSignals >= minActiveSignals` | ≥ 3 (Loose 2, Strict 5) | `Only N/8 signals active (min 3)` |
| 10 | Resolution risk ≠ SKIP | `signal.resolutionCategory !== "SKIP"` | – | `Underlying market resolution risk = SKIP` |
| 11 | Net edge ≥ küszöb | `(signal.edge − feePct) >= edgeThreshold[paperMode?paper:live]` | 0.12 paper / 0.18 live | `Net edge X% < Y% threshold` |
| 12 | Sanity cap (gross edge ≤ cap) | `signal.edge <= maxEdgeCap` | 40% | `Gross edge X% > sanity cap 40%` |
| 13 | Combiner trust (WATCH + extrém edge) | `!(rec === "WATCH" && edge > watchExtremeEdgeThreshold)` | WATCH + 20%+ blokk | `Combiner trust: WATCH + X% edge` |
| 14 | HL price elérhető | `getCurrentPrice(coin, paperMode) !== null` | – | `no HL price` |
| 15 | Méret > 0 | `kellyToPerpSize(...).sizeCoins > 0` | – | `size rounds to zero` |

✦ Új gate a 2026-05-14e cross-position consistency sweep-ből — lásd a §10-es technikai debt H6 tételét. A meglévő #7 "Coin nincs már nyitva" gate stricter (max 1 / coin); a #8 expliciten néven nevezi a LONG+SHORT-pár tilalmát, defense-in-depth + UI clarity.

> **Megjegyzés:** a doc régebbi verziójában csak 8 gate szerepelt, mert a
> `makeHlDecision()` short-circuit verziójára hivatkozott. A 2026-05-10
> óta a runner inline non-short-circuit gate-pipeline-t használ
> (HL_GATE_LABELS[15]), és minden scan row egyenlő hosszú gate-listát
> küld a UI-nak. A `makeHlDecision()` ma a Net edge gate utáni
> backup-verdict-et adja, ugyanazon a feltételeken.

### Vol gate (külön szakasz, MINDIG fut – paper + live parity)

A `volatilityGate(coin, 120)` Binance USDT-M klines-ből 12-candle 1h
log-return szórást számol, annualizálja `√(24×365)`-tel. Ha RV > 120%
annualised → skip.

> **2026-05-10 fix (H2):** korábban a vol gate `if (!config.paperMode)`
> szigorral csak live módban futott — paper trade-elhetett 200% RV
> napokon át. Most paper + live ugyanazt a gate-et látja, így a paper PnL
> nem drift-el el a live realisztikus viselkedésétől.

---

## 5. Sizing (`hyperliquid/kelly-sizer.mts`)

### Kelly → perp size

```ts
quarterKelly  = max(0, signal.kellyFraction) × 0.25
cappedFrac    = min(quarterKelly, maxPctBankroll)   // default 0.15
sizeUSDC      = bankrollCurrent × cappedFrac
leverage      = clamp(maxLeverage, 1, 3)            // hard cap 3x
sizeCoins     = (sizeUSDC × leverage) / currentPrice
sizeCoinsStr  = formatSize(coin, sizeCoins)         // per-coin tick (0.001-0.001 BTC)
```

> ⚠ **Lev hard cap:** a `kellyToPerpSize` `Math.min(p.leverage,
> HL_LEVERAGE_HARD_CAP=3)`-mal clamp-eli a `maxLeverage` env-et. Ha
> `HL_MAX_LEVERAGE>3`-öt állítasz, a sizer egyszer sessiononként
> `log("ERROR", { configWarning: "..." })` warning-ot ír, és továbbra is
> 3x-szel megy. Konzervatív default — magasabb csak akkor érdemes ha a
> session SR > 1 paperben.

### TP / SL — clamp-elt edge-multiplier (2026-05-10 v2)

A `computeTpSl(...)` 2:1 RR-t targetál:

```ts
tpPct = min(edge × 2, tpPctMax)   // default tpPctMax = 0.02 (2%)
slPct = min(edge × 1, slPctMax)   // default slPctMax = 0.01 (1%)
tpPrice = isLong ? entry × (1 + tpPct) : entry × (1 − tpPct)
slPrice = isLong ? entry × (1 − slPct) : entry × (1 + slPct)
```

> 🔴 **2026-05-10 fix (H1):** a v1 sim **clamp nélkül** futtatta a
> formulát. `signal.edge = |prob−0.5|×2` egy BINARY-piac directional bias,
> NEM perp price-move target. Edge=0.20 mellett TP=+40%, SL=−20%-ot adott —
> BTC ezt 4h horizonton soha nem érte el → minden trade `timeout` reason-nel
> zárult. A clamp megtartja a kis edge-en lévő edge-multiplier scaling-et
> (edge=0.005 → TP=+1%), de a nagy edge-eknél a clamp-en saturálódik
> (edge=0.20 → TP=+2%, hit reach-be kerül).

| Coin | Tipikus edge | TP=+2% target hit ratio (4h hold) | SL=−1% hit ratio |
|------|--------------|------------------------------------|-------------------|
| BTC | 0.10–0.20 | ~30-40% | ~25-35% |
| ETH | 0.10–0.20 | ~35-45% | ~30-40% |
| SOL | 0.10–0.20 | ~40-50% | ~35-45% |

(Becslés ~60-90% annualised RV mellett. Pontos eloszlás 50+ paper trade
után IC-vel mérhető — lásd `Calibration Health` a UI-on.)

---

## 6. Order placement (`hyperliquid/order-manager.mts`)

### Paper mode

Pure sim. Nincs külső hívás. A `HlPosition` rögzíti az entry/TP/SL árakat,
sizeCoins-t, leverage-t, signal metadatát + `entryDecision` snapshotot.

### Live mode

`tryLoadLiveAdapter()` lazy-load a `@nktkas/hyperliquid` SDK-t. Ha nincs
`HL_PRIVATE_KEY` (0x + 64 hex) vagy a csomag nincs telepítve → `error:
"Live adapter unavailable: ..."` és skip.

3 order-leg (entry → TP → SL):

| Leg | side | type | tif | reduceOnly | grouping |
|-----|------|------|-----|------------|----------|
| Entry | LONG/SHORT | limit @ entryPrice | Gtc | false | `na` |
| TP | reverse | limit @ tpPrice | Gtc | true | `positionTpsl` (mert `triggerPx`-szel mennek) |
| SL | reverse | trigger limit @ slPrice (`isMarket: true`) | Gtc | true | `positionTpsl` |

> ⚠ Ha az SL leg fillt nem ad → entry + TP cancel, position nem nyílik.
> Ha az TP leg fail-el → position nyílva marad (a comment szerint
> "documented behavior") — manuális intervention kell. Ez az §9.A
> followup item.

### Asset index (`hl-client.mts:lookupAssetIndex`)

A `meta.universe[i].name` array a HL forrás. 6h cache cold start után,
fallback `STATIC_ASSET_INDEX_FALLBACK` csak BTC=0, ETH=1.

> ⚠ **SOL ≠ 2.** SOL=5, DOGE=12, XRP=25 a jelenlegi `meta` állapotban.
> A static fallback szigorúan tovább nem terjeszthető.

---

## 7. Paper resolver (`hyperliquid/paper-resolver.mts`)

Minden cron tick elején fut a `runHyperliquidTraderInner` `resolveOpenHl
PaperPositions(session, cfg)` lépésével.

### Per-position logika

```
mids = getAllMids()                     ← HL allMids
fundingMap = getHlFundingMap()          ← HL metaAndAssetCtxs.funding[i]

for pos of session.openPositions:
  px = mids[pos.coin]
  exitPrice, reason = null
  if isLong:
    if px >= pos.tpPrice:        exitPrice = pos.tpPrice; reason = "tp"
    else if px <= pos.slPrice:   exitPrice = pos.slPrice; reason = "sl"
  else: // SHORT
    if px <= pos.tpPrice:        exitPrice = pos.tpPrice; reason = "tp"
    else if px >= pos.slPrice:   exitPrice = pos.slPrice; reason = "sl"

  if exitPrice == null AND ageMs >= maxPaperHoldMs:  // 4h default
    exitPrice = px; reason = "timeout"
```

### PnL képlet (v2 paper sim, 2026-05-10)

```
priceMovePct  = isLong ? (exit−entry)/entry : (entry−exit)/entry
grossPnl      = sizeUSDC × leverage × priceMovePct
fees          = sizeUSDC × leverage × roundtripFeePct       // 0.07% default
entryNotional = sizeUSDC × leverage
exitNotional  = |sizeCoins| × exitPrice
avgNotional   = (entryNotional + exitNotional) / 2
fundingPaid   = avgNotional × hourlyFundingRate × holdHours
fundingPnl    = isLong ? −fundingPaid : +fundingPaid        // SHORT receives when rate > 0
pnlUSDC       = grossPnl − fees + fundingPnl
```

> 🔴 **2026-05-10 fix (H3):** v1 paper PnL nem könyvelte a HL hourly
> funding-ot. Live módban a HL automatikusan fizet/kap minden órán →
> bull tape-en a longok funding-ot fizetnek (eats into PnL), bear tape-en
> a shortok kapnak. v1 paper így overstate-elte a long PnL-t persistent
> positive funding tape-en, és understate-elte a short rebate-eket.
> v2 most az `metaAndAssetCtxs.funding[i]` legfrissebb hourly rate-jét
> kéri le minden tick-en, és az entry+exit notional midpoint-tal számol.

### IC szempontból

A paper-resolver SZIGORÚAN nem `signal.finalProb`-függő — a TP/SL crossing
és a funding rate is a HL valós piacáról jön. Ezért a paper-trade closed
PnL-en mért IC valós signál-prediktivitást mér: ha a kombinált prob
korrelál a HL price move-jával, IC > 0.

---

## 8. Session storage (`hyperliquid/session-manager.mts`)

```
Netlify Blobs store: "hyperliquid-session-v1"
  ├── session_paper       ← élő paper session
  ├── session_live        ← élő live session (kihagyva v2 addig amíg §9.A)
  └── archive_paper_vN_TS ← simVersion bump-kor archivált snapshot-ok
```

### `loadHlSession(paperMode)` – auto-archive logika

1. Get raw → JSON parse → `parsed.simVersion ?? 1`
2. Ha `paperMode && persistedVer < HL_PAPER_SIM_VERSION (=2)`:
   - Save: `archive_paper_v1_${Date.now()}` ← régi blob
   - Save: `session_paper` ← fresh session
   - Return: fresh
3. Egyébként backfill `simVersion` és return.

> Live session SOHA nem auto-resetel (real money, irreversible).
> Paper auto-archive csak konzisztens v2-paradigma alatt mért IC-t ad.

---

## 9. Paper / live PnL parity matrix

| Feature | v1 paper | v2 paper (2026-05-10) | Live |
|---------|----------|------------------------|------|
| TP/SL crossing on HL markPrice | ✅ | ✅ | ✅ (HL native trigger orders) |
| Volatility gate (120% RV cap) | ❌ skip in paper | ✅ | ✅ |
| Hourly funding accrual | ❌ ignored | ✅ midpoint notional | ✅ HL native |
| TP/SL distance clamps (2%/1%) | ❌ unclamped | ✅ | ✅ (entry order side) |
| Entry slippage | 0 (markPrice fill) | 0 | ~0.5% IOC limit |
| Asset-index validation | ✅ meta.universe | ✅ meta.universe | ✅ meta.universe |
| Live exit/reconcile reconciliation | n/a | n/a | ❌ §9.A blokker |

A két oszlop közti maradék divergencia: **entry slippage + execution
basis**. Paper assume markPrice fill (0 slippage); live IOC limit
0.5% slippage band. Konzervatív paper bias ~5-10 bp / trade — paper PnL
slight upper bound a live PnL-en.

---

## 10. Ismert limitációk és technikai debt

| ID | Severity | Probléma | Fixelve? |
|----|----------|----------|----------|
| H1 | 🔴 → ✅ | TP/SL clamp nélkül 40%/20%-os perp target | ✅ v2 (2026-05-10) |
| H2 | 🟠 → ✅ | Vol gate paper-ben skipped | ✅ v2 (2026-05-10) |
| H3 | 🟠 → ✅ | Paper nem könyveli a hourly funding-ot | ✅ v2 (2026-05-10) |
| H4 | 🟡 → ✅ | In-memory cooldown map (cold-start veszteséges) | ✅ Blobs-backed `hyperliquid-runtime` store, 30s reload TTL |
| H5 | 🟡 → ✅ | `maxLeverage` silent clamp 3x-re | ✅ Explicit warning log + `HL_LEVERAGE_HARD_CAP` const dokumentálva |
| §9.A | 🔴 → ✅ | Live exit / reconcile / settlement nincs | ✅ Új `live-resolver.mts` — `clearinghouseState` + `userFillsByTime` per cron tick |
| F2/F3 | 🟠 → ✅ | Paper slippage nincs modellezve | ✅ SL=0.1%, timeout=0.05% adverse paper slippage |
| §9.B | 🟡 → ✅ | TP leg failure paper-ben silent (live-ban entry+SL marad) | ✅ `placeHlEntry` most TP fail-on cancel-eli az entry-t (és nem placeolja az SL-t), tükrözve az SL fail meglévő rollback-jét |
| H6 | 🟡 → ✅ | Directional-consistency csak implicit (a "Coin nincs már nyitva" gate stricter) | ✅ Új explicit gate `Directional-consistency (no LONG+SHORT same coin)` (HL_GATE_LABELS[7], 2026-05-14e). LONG+SHORT párral nyitás → unleveraged + 2× fee → strict negatív EV. Layered the existing same-coin gate fölött defense-in-depth okból: ha valaha relaxáljuk a "max 1 / coin" megszorítást LONG+LONG averaging miatt, a direction-pair-blokk megmarad. |
| H7 | 🟢 → ✅ | Consecutive-loss pause idő env-only + alert action-mentes | ✅ Új `hlConsecutiveLossPauseHours` Settings knob (default 1h, range 0.0833–24h, preset-fűzve 0.5/1/2h). A pause-alert mostantól inline `Cancel pause` gombot rendereli (TraderAlert.action interface bővítés). 2026-05-14f changelog. |

### §9.A — RESOLVED (2026-05-10 follow-up)

Új modul: `live-resolver.mts`. A `runHyperliquidTraderInner` minden tick-en:
- paper módban: `resolveOpenHlPaperPositions(session, cfg)` (markPrice + funding)
- live módban: `resolveOpenHlLivePositions(session)` (HL adapter-driven)

A live resolver:
1. `getClearinghouseState({user: walletAddress})` — open positions HL-en.
2. Set diff a `session.openPositions` ellen → eltűnt coin = closed.
3. `getUserFillsByTime(walletAddress, oldestOpenedAt)` — closing fillek.
4. Match by `oid`: ha `tpOrderId === f.oid` → `closeReason: "tp"`. Ha
   `slOrderId === f.oid` → `"sl"`. Egyébként `"manual"` (UI-ról zárás).
5. Size-weighted average exit price + `closedPnl` sum → `HlClosedTrade`.

Edge cases:
- Fill record nem látható még (HL data API eventually consistent few-sec):
  → log `PAPER_RESOLVE_SKIP/live_position_closed_but_no_fill_yet`, retry
  next tick. NEM bookol phantom close-t.
- Adapter unavailable: silent skip (entry path egyébként is felszínre hozza).
- `clearinghouseState` network blip: silent skip, retry next tick.

### §9.B részletei

`order-manager.placeHlEntry`-ben az SL leg fail-re entry+TP cancel; de
a TP leg fail csak warning-ot loggol. Élesben elvesztheted az automatikus
exit-et felfelé, ha a TP placement-et a HL elutasítja (pl. tick alignment
bug). Ennek a kezelése a §9.A-val együtt fixelendő.

---

## 11. Validációs protokoll

A bot **paper-only** módban fut (`HL_PAPER_MODE=true` default). A v2 sim
2026-05-10 deploy-jától számítva:

- **First 24h:** session friss, 0 trade. Ne következtess.
- **24-48h:** 5-15 trade várható (cron */3 × 3 coin × ~15% gate-pass rate).
  Calibration Health badge insufficient marad.
- **30+ trade után:** Calibration Health badge színe (zöld ≥0.05 / narancs
  ≥0.02 / piros <0.02) megmutatja a signal IC erejét. Live-ra **csak
  zöld** mellett szabad váltani — és csak a §9.A megoldása után.

Diagnosztika:

```bash
# Live HL funding rate snapshot
curl -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"metaAndAssetCtxs"}' | jq '.[1] | map({funding, markPx})'

# Paper session state
curl https://mj-trading.netlify.app/.netlify/functions/auto-trader-api?action=status\&category=hyperliquid

# Archive lookup (auth-protected Blobs)
# A Reset gomb a UI-n triggereli a manuális archive-ot.
```

---

## 12. File → szerep map

| File | Szerep |
|------|--------|
| `index.mts` | Main loop, gate orchestration, run-state markers |
| `signal-source.mts` | Polymarket slug match + signal-combiner call |
| `hl-client.mts` | REST wrapper, asset-index resolver, live adapter loader |
| `decision-engine.mts` | 8-gate decision + cooldown map |
| `volatility-gate.mts` | 12h Binance klines RV |
| `kelly-sizer.mts` | ¼-Kelly + leverage clamp + TP/SL formula |
| `order-manager.mts` | Paper sim / live SDK entry placement |
| `paper-resolver.mts` | Markprice + funding-rate paper close + slippage model |
| `live-resolver.mts` | Live HL fill reconciliation (`clearinghouseState` + `userFillsByTime`) |
| `session-manager.mts` | Blobs persistence + simVersion archive |
| `run-state.mts` | UI status pill state (Scanning/Idle/cron/last) |
| `config.mts` | env defaults, `HL_PAPER_SIM_VERSION` const |
| `types.mts` | Type definitions |
