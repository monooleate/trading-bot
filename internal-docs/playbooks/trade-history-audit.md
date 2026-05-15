# Trade history audit — Claude Code playbook

> **Mire való ez a dokumentum:** Amikor a user kéri a trade history ellenőrzését (pl. *"ellenőrizd hogy a history valid-e"*, *"a PnL reális?"*, *"mit nyitott jót?"*, *"audit"*, *"validate"*), ezt a runbook-ot kell követni. Cél: matematikai precizitás, ismert bug-patternek felismerése, konkrét javaslatok az operatórnak.
>
> **Hatókör:** EdgeCalc paper + live trading bot-jai (crypto, weather, HL Perp, F-Arb, sports). A playbook **általános auditra** vonatkozik — single trade vagy edge-case vizsgálathoz az adott bot `math/NN-*.md` doksija a részletes hivatkozás.
>
> **Utolsó frissítés:** 2026-05-15 (Sprint 41 vol_divergence K-extrakció fix + Sprint 42A K-blind downweight implementálás után). **Karban tartandó** minden új audit-eredmény-fixelés után — ha egy bug felmerül és lejavítva van, az ujjlenyomata bekerül a "[§5 — Ismert bug-patternek]" szekcióba.

---

## §1 — Trigger-szófordulatok (mikor használd)

A user kérése jellemzően az alábbi minták egyikét tartalmazza:

| Magyar trigger | Angol trigger | Cél |
|---|---|---|
| "ellenőrizd a history-t" | "validate the trade history" | Teljes audit |
| "a PnL valós?" | "is the PnL real?" | Paper-fee + Gamma cross-check |
| "jókat nyitott a bot?" | "did the bot open the right trades?" | Cross-position-konzisztencia + per-trade EV-ellenőrzés |
| "audit" / "auditálás" | "audit" | Teljes audit |
| "mit fogadott most a bot?" | "what did the bot bet?" | Open positions snapshot + sanity check |
| "miért bukott el ez a trade?" | "why did this trade lose?" | Single-trade post-mortem |
| "ellentétesre fogadott!?" | "the bot bet contradictory?" | Cross-position-overlap-gate trigger |
| URL: `mj-trading.netlify.app/trade/<cat>/` | (same) | Bot-specific deep-dive |

**Fontos**: a user explicit kérése nélkül **soha ne futtasd** ezt a playbook-ot proaktívan. A trade history audit időigényes (3-5 endpoint hívás + Gamma cross-check), és csak akkor releváns ha a user explicit erre kér.

---

## §2 — Kötelező első lépések (adatbeszerzés)

A teljes audithoz **5 adatforrás** szükséges. Ezeket **párhuzamosan** hozhatod le egy multi-tool-call üzenetben, kivéve ha a 2. egy specifikus bot-ra szűkíti a többit.

### §2.1 — Bot status snapshot (élő session-state)

```
GET https://mj-trading.netlify.app/.netlify/functions/auto-trader-api?action=status&category=<cat>
```

Ahol `<cat>` ∈ `crypto`, `weather`, `hyperliquid`, `funding-arb`, `sports`.

**Releváns mezők a JSON-ban:**
- `session.bankrollStart` — induló tőke
- `session.bankrollCurrent` — élő bankroll
- `session.sessionPnL` — kumulatív zárt-pozíció PnL
- `session.sessionLoss` — abszolút veszteség (csak loserek)
- `session.tradeCount` — closed trade count (összes, `closedTrades` mező itt csak szám, nem array!)
- `session.openPositions` — open count (szám, nem array)
- `session.startedAt` — session induló timestamp
- `session.simVersion` — paper sim verzió (`3` = legújabb crypto, `2` = HL legacy)
- `session.stopped` + `session.stoppedReason` — manual stop state
- `recentLogs` — utolsó 20 log entry (SIGNAL / DECISION_TRADE / DECISION_SKIP / ORDER_*)
- `liveReadiness.gates` — 6 gate státusz (trade-count / win-rate / IC / drawdown / session / sim-version)
- `runStatus`, `cronEnabled`, `pending`, `openDetails` — kiegészítő infók

**PowerShell minta**:
```powershell
$r = Invoke-WebRequest -Uri "https://mj-trading.netlify.app/.netlify/functions/auto-trader-api?action=status&category=crypto" -UseBasicParsing
$r.Content | Out-File -FilePath "_state.json" -Encoding utf8
$j = Get-Content "_state.json" -Raw | ConvertFrom-Json
```

### §2.2 — Edge Tracker (closed trades array + summary statisztikák)

```
GET https://mj-trading.netlify.app/.netlify/functions/edge-tracker?category=<cat>
```

**Ez a kanonikus closed-trade lista** — minden audit ezzel kezdődik. Az `auto-trader-api?action=status` `session.closedTrades` csak `number` (count), a teljes array itt van.

**Releváns mezők:**
- `summary` — 20+ statisztikai mező (winRate, totalPnl, sharpeRatio + 95% CI, sortinoRatio, profitFactor, expectancy, payoffRatio, longestWinStreak/longestLossStreak, currentStreak, evGap, maxDrawdown + duration, kellyOptimal/Used/Efficiency, calibrationDeviation, isWellCalibrated)
- `trades[]` — minden closed trade `{closedAt, openedAt, category, market, direction, entryPrice, exitPrice, shares, pnl, pnlPct, edgeAtEntry, predictedProb}`
- `cumulativePnl[]` — running PnL pontok `drawdown` + `peak` mezővel
- `calibration`, `signalIC`, `calibrationHealth`, `collinearity`, `edgeDecay`, `heatmap`, `distribution` — Edge Tracker chart-okhoz
- `calibrationView` — Prior / Realized / Effective IC oszlopok per signal (ha `useRealizedIC` ON)

**PowerShell minta**:
```powershell
$r = Invoke-WebRequest -Uri "https://mj-trading.netlify.app/.netlify/functions/edge-tracker?category=crypto" -UseBasicParsing
$j = $r.Content | ConvertFrom-Json
"---closedTrades---"
$j.trades | ConvertTo-Json -Depth 6
"---summary---"
$j.summary | ConvertTo-Json -Compress
```

### §2.3 — Polymarket Gamma resolution lookup (KÖTELEZŐ a closed trade-ekhez)

Minden closed trade `market` (slug) mezőjét vissza kell ellenőrizni a Polymarket Gamma API-n. **A `&closed=true` query string kötelező** — anélkül a Gamma a lezárult market-eket NEM adja vissza (2026-05-10 simV3 paper-resolver bug oka):

```
GET https://gamma-api.polymarket.com/markets?slug=<slug>&closed=true
```

**Releváns mezők a response[0]-ban:**
- `closed` — `true` → final resolution
- `outcomePrices` — `["1","0"]` (YES nyert) VAGY `["0","1"]` (NO nyert)
- `endDate` — UTC timestamp
- `umaResolutionStatus` — `"resolved"` / `"proposed"` / `"disputed"` / null

**PowerShell minta (batch ellenőrzés)**:
```powershell
$slugs = @("bitcoin-above-80k-on-may-14", "bitcoin-above-78k-on-may-14", ...)
foreach ($s in $slugs) {
  $u = "https://gamma-api.polymarket.com/markets?slug=$s&closed=true"
  $r = Invoke-RestMethod -Uri $u -UseBasicParsing
  Write-Output "$s | closed=$($r[0].closed) | outcomePrices=$($r[0].outcomePrices) | endDate=$($r[0].endDate)"
}
```

**Anti-pattern**: ne tételezd fel hogy a bot exit price-a egyenlő a real Gamma resolution-nel. **Mindig** verify-old külön. A 2026-05-10 előtti simV3 bug Brownian-bridge szimulációval generált fake exit-eket, ami nem egyezett a real Polymarket resolution-nel. Ez a 35. session-audit (2026-05-12) óta fixed, de a paranoid double-check továbbra is best practice.

### §2.4 — Live BTC spot price (sanity check open pozíciókhoz)

A bot által nyitott `bitcoin-above-Nk` pozíciók **realisztikussága** csak a jelenlegi BTC árhoz képest értelmezhető. Pre-fix gyors lekérés:

```
GET https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT
```

VAGY (project-specifikus, 15s Blobs cache):

```
GET https://mj-trading.netlify.app/.netlify/functions/binance-price?symbols=BTC
```

A project endpoint 502-zik gyakran (Bybit primary fallback issue), ezért **közvetlen Binance** a megbízható.

### §2.5 — Trader Settings (effektív paraméterek)

```
GET https://mj-trading.netlify.app/.netlify/functions/trader-settings
```

Visszaadja az `effective`, `overrides`, és `presets` map-eket. A `combinerConfidenceMin`, `edgeThreshold`, `maxKellyFraction`, `combinerKBlindDownweight` paramétereket innen kell lekérni — **ne tételezd fel** hogy a CLAUDE.md-ben szereplő default érvényes (a user változtathatott rajta a session közben preset-váltással).

Például a Loose preset `combinerConfidenceMin = 0.02`-vel megy, Normal 0.05-tel, Strict 0.10-zel. Ha az `effective` Normal-t mutat, de a trade-ek a Loose küszöbnek megfelelő finalProb-bal nyíltak meg, az **timing race condition gyanús** (a trade-ek Loose alatt nyíltak, majd a user átváltott Normal-ra).

---

## §3 — Az 5-lépéses audit metódus

### Step 1 — Closed trades exit price ↔ Gamma resolution match

Mind a `trades[]` array-ban szereplő `(market, direction, exitPrice)` tripletre verify-old:

| Bot exit-price | Gamma `outcomePrices` | Bot direction | Egyezés |
|---|---|---|---|
| `1.00` | `["1","0"]` (YES nyert) | YES | ✓ |
| `1.00` | `["0","1"]` (NO nyert) | NO | ✓ |
| `0.00` | `["1","0"]` (YES nyert) | NO | ✓ |
| `0.00` | `["0","1"]` (NO nyert) | YES | ✓ |
| **bármi más kombináció** | — | — | ❌ |

Ha bármely trade-en eltérés van → **HARD ERROR**: jelentsd a user-nek, hivatkozz a `paper-resolver.mts:resolvePendingPositions` szekcióra a debug-ba.

**Closing-timing sanity check**: minden `closedAt` legyen `≥ market.endDate` (Gamma) — ha bármelyik korábbi, az a 2026-05-10 előtti pre-resolution paper-close bug ujjlenyomata, és a simV3-on már nem lehetséges.

### Step 2 — PnL math reproduction (3.6% paper fee model)

A paper-resolver fee modellje **bit-pontos** ezzel a képlettel:

```
proceeds  = exitPrice × shares
costBasis = entryPrice × shares
pnlGross  = proceeds − costBasis
fee       = max(proceeds, costBasis) × feePct
pnl       = pnlGross − fee
```

Ahol `feePct = 0.036` (3.6% roundtrip — entry slippage + bid-ask + redemption gas).

**Forrás**: [paper-resolver.mts:44 `applySettlementFee()`](../../netlify/functions/auto-trader/crypto/paper-resolver.mts) — crypto bot.
**Forrás (HL)**: [hyperliquid/paper-resolver.mts](../../netlify/functions/auto-trader/hyperliquid/paper-resolver.mts) — más fee modell (perp 2× fee + funding accrual).
**Forrás (weather)**: [weather/reconciler.mts](../../netlify/functions/auto-trader/weather/reconciler.mts) — ugyanaz a 3.6% mint a crypto, mert mindkettő Polymarket binary.

**Loserek ujjlenyomata**: `pnlPct ≈ −103.6%` (nem −100%) — ez azt jelenti, hogy a stake teljes elvesztése + 3.6% fee a notional-on. **Ez a 3.6% fee modell ujjlenyomata** — ha látsz `pnlPct = −100%` pontosan, az ANOMÁLIA (régi simV2 vagy bug).

**Példa reprodukció**:
```
Trade: bitcoin-above-80k-on-may-14, YES @ 0.34, exit 1.00, shares 37.3235
gross = (1.00 − 0.34) × 37.3235        = 24.6336
fee   = max(37.3235, 12.6900) × 0.036  =  1.3436
pnl   = 24.6336 − 1.3436               = 23.2900
→ reported $23.29 ✓
```

Mind a closed trade-en futtasd. Ha **bármelyikre ≥ 0.01 USD eltérés** a reprodukált és a `trades[].pnl` között → flag-eld.

### Step 3 — Bankroll-rekonciliáció

```
bankrollCurrent = bankrollStart + sum(closedTrades.pnl) − sum(openPositions.size)
```

Ahol `openPositions.size = entryPrice × shares` (a foglalt stake).

**Példa**:
```
bankrollStart      = 250.00
closedPnL (Σ)      =  +21.96  (3W/4L sum)
openStakes (Σ)     =  −34.96  (2 open pozíció)
bankrollCurrent    = 237.00  ✓
```

Ha eltérés > $0.05 → vagy session-state bug, vagy a `closedTrades` array nem teljes (Edge Tracker max 100 trade-et tárol, hosszabb history-n trim-elhetnek).

### Step 4 — Cross-position konzisztencia (mind az 5 gate)

A bot 2026-05-14e óta tartalmaz cross-position konzisztencia-gate-eket. Audit során **statikusan re-verify-old** őket a jelenlegi open positions-listán:

| Bot | Gate | Vizsgálat |
|---|---|---|
| **Crypto** | Monotonicitás (#15) | Minden `bitcoin-above-Nk` open pozíció pred-YES-prob-jára: `K1 < K2 ⇒ pred(K1) ≥ pred(K2)`. Sértés → gate bug vagy gate-bypass. |
| **Crypto** | Outcome-overlap (#16) | Nincs `NO@K_lo + YES@K_hi` (K_hi > K_lo) pár ugyanazon closingKey-en. Ha van → mai 2026-05-15 incidens reprodukálódott. |
| **Weather** | Σ P(YES) ≤ 1.0 | Per `(city, date)` negRisk csoport: a YES-pozíciók predicted-prob-jainak összege ≤ 1.0. |
| **HL Perp** | Directional-consistency | Egyetlen LONG vagy SHORT coin-ra, nem mindkettő. |
| **F-Arb** | Coin-capacity | Egy coin = max 1 nyitott F-Arb pozíció. |
| **Sports** | Outcome-sum | Per `eventSlug`: Σ predicted-YES-prob ≤ 1.0. |

Ha bármely gate sérül → flag, hivatkozz a [`auto-trader/shared/cross-position-gates.mts`](../../netlify/functions/auto-trader/shared/cross-position-gates.mts) helperre + a sprint-ek changelog-jaira.

**Részletes pattern-detection**: lásd §5.

### Step 5 — Statisztikai sanity check (summary mezők)

| Mező | Acceptable | Anomália | Tegyél |
|---|---|---|---|
| `winRate` | 50%-ban random walkkal kompatibilis sávban | < 30% (n ≥ 20) | suggest preset szigorítás vagy signal-IC kalibráció |
| `sharpeCiLo / Hi` (95% bootstrap) | szűk CI ≥ n=30 mellett | CI band > 2× Sharpe érték | "n too small" warning, ne hozz következtetést |
| `profitFactor` | ≥ 1.2 | < 1.0 | unviable strategy, suggest stop |
| `calibrationDeviation` | < 7% | > 10% | enable realized-IC blend (useRealizedIC = 1) |
| `maxDrawdownPct` | < 25% | ≥ 25% | live-readiness gate fail; suggest preset szigorítás vagy session-loss-limit emelés |
| `evGap` (Σactual − ΣEV) | |evGap| < 20% × sessionPnL | > 30% | model-error gyanú, suggest IC-kalibráció |
| `payoffRatio` | > 1.0 | < 1.0 (n ≥ 20) | wins too small vs losses, suggest TP/SL clamp |

---

## §4 — Combiner predikció-pattern detection

Külön szekció, mert a 2026-05-15 vol_div K-extrakció + Sprint 42A K-blind downweight után a combiner-output legközelebbi limitációja a finalProb K-érzékenységének hiánya.

### §4.1 — "Flat finalProb" pattern

**Ujjlenyomat**:
- Mind a 3+ open pozíció `predictedProb` mezője `[0.45, 0.49]` sávban
- Mind a 3+ pozíció `edgeAtEntry` ≥ 0.20 (mert market YES árak diszperzek: 0.13, 0.25, 0.65, stb.)
- A trade-ek `direction` rugalmasan ingadozik (NO + YES + NO ugyanazon piacosztályon)

**Mit jelent**: a 8-signal combiner output a default-0.5 értékhez konvergál (nincs konvergens jel), és a decision-engine ezt a "noise"-t kiterjedt edge-jelnek látja a piaci árakhoz képest. A bot aggresszív contrarian-trade-ekbe megy.

**Forrás**: ez a pattern 2026-05-15 előtt **mindig** triggerelt a `bitcoin-above-Nk` piacokon a vol_divergence K-extrakció bug-ja miatt. Post-Sprint-41 (vol_div K-fix) ez **javítva**, de a 4 K-blind signal (momentum, contrarian, funding_rate, pairs_spread) még mindig 0.5-höz vonja a kombinált értéket, amit a Sprint 42A K-blind downweight knob old meg (default-off, 0.5-re kapcsolható).

**Javaslat ha látod**:
1. Verify-old hogy a `signal_details.vol_divergence.detail.strikeSource` MIT mutat — ha `"slug-threshold"` → Sprint 41 fix aktív. Ha `"spot-fallback"` → még a régi kód fut.
2. Ha `strikeSource = "slug-threshold"` és mégis flat → suggest Settings → `combinerKBlindDownweight = 0.5` (Sprint 42A bekapcsolása).
3. Ha `Loose preset + combinerConfidenceMin = 0.02` aktív → suggest Normal preset váltást (0.05 küszöb megfogja a noise-t).

### §4.2 — Bimodal-prior bug (pre-Sprint-41 ujjlenyomat)

**Ujjlenyomat**:
- Adjacent K-jú threshold piacokon a bot `predictedProb` mezője **<1 pp eltéréssel** csökken (pl. 0.4609 → 0.4604 → 0.4557)
- Az implied "P(K_lo < BTC ≤ K_hi)" sáv valószínűsége < 1%, ami matematikailag lehetetlen ha a piac > 10%-ra árazza ugyanezt

**Mit jelent**: a model BTC eloszlása quasi-bimodális ("vagy mélyen alatt, vagy magasan fölött") a fenti vol_div K-extrakció bug miatt.

**Post-Sprint-41 várt viselkedés (BTC=$80,620, T=6h, σ=0.6 mellett)**:
- `above-78k`: predictedYES ≈ 0.98
- `above-80k`: predictedYES ≈ 0.69
- `above-82k`: predictedYES ≈ 0.14

Ha ezeket látod → Sprint 41 fix correctly applied.

### §4.3 — Loose preset bypass

**Ujjlenyomat**:
- `effective.combinerConfidenceMin = 0.05` (Normal)
- A closed trade-ek `predictedProb` mezője `|p − 0.5| < 0.05` (matek szerint NEM ment volna át a Gate-3-on)
- A trade-ek nyitása NEM mostani timestamp-re datálódik

**Mit jelent**: a user a trade-nyitás idején Loose preset-en volt (`combinerConfidenceMin = 0.02`), majd átkapcsolt Normal-ra (vagy a `presets` mező visszaállította default-ra). A history-ban szereplő trade-ek Loose alatti zaj-trade-ek.

**Javaslat**: ha a user új audit-ot kér ennek tudatában → emlékeztesd a preset-history-ra. Az ilyen trade-ek `signal-IC`-be torzítva mennek bele — érdemes a `useRealizedIC` blend `calibrationShrinkageK = 30` priori-súlyával ellensúlyozni.

### §4.4 — `Combiner trust (WATCH + extrém edge)` gate-trigger

**Ujjlenyomat**:
- `recommendation.action = "WATCH"` (a combiner saját kelly_q broken → WATCH default)
- ÉS `grossEdge > watchExtremeEdgeThreshold` (Normal 20%, Loose 30%, Strict 15%)
- DECISION_SKIP log-ban szerepel

**Mit jelent**: a combiner saját kelly_q rendszerstruktúrálisan broken (mindig ~0 fair-implied pricing-on), de a gate-5 nem blokkolja kivéve extrém edge-en. Ez a "hallucinated alpha" védelem (2026-05-12 audit fix).

### §4.5 — Resolution-risk SKIP

**Ujjlenyomat**:
- `signal-combiner` `recommendation.action = "SKIP"` ÉS `trade_recommended = false`
- A bot rationale-ja: `"Resolution risk: ..."` (LLM-based reasoning)

**Mit jelent**: a market kérdés-szövege olyan ambiguitást tartalmaz (pl. "Will Trump...", "Will Fed..."), amit a `analyseResolutionRisk()` LLM-helper kockázatosnak ítélt. A decision-engine #6 gate veto-ja.

---

## §5 — Ismert bug-patternek ujjlenyomatai (history-detector)

Ez a "fingerprint database" — ha bármelyik mintát látod a closed trade-ekben, az alábbi bug aktívan jelen volt:

### §5.1 — `pnlPct = exact -100.0%` (pre-2026-05-11)

**Bug**: paper-fee model még nem volt 3.6% roundtrip, hanem 0% fee + stake-loss-only.

**Fix**: 2026-05-11 audit fix #6 — `applySettlementFee()`.

**Mit tegyél**: ha látod, ez a trade pre-2026-05-11 nyílt → ignore-old a 0.05+ pnl-anomáliát.

### §5.2 — Brownian-bridge fake exit (pre-2026-05-10)

**Bug**: simV2 a Polymarket UMA-resolution helyett véletlenszerű price-path-ot szimulált a closedTime → fake exit-eket generált.

**Fix**: 2026-05-10 simV3 + Gamma `&closed=true` query.

**Detection**: a trade `closedAt` korábbi mint a Gamma `endDate`, **és** az `exitPrice` nem `0` vagy `1` (hanem köztes érték, pl. `0.42`).

**Mit tegyél**: ha látod → flag, a trade history pre-simV3 era-ból van; ne hozz IC-kalibrációs következtetést.

### §5.3 — vol_divergence K=S fallback (pre-Sprint-41, 2026-05-15)

**Bug**: a `getVolSignal` `above-Nk` piacokra K=S fallback-be esett → fair YES ≈ 0.5 minden K-ra.

**Fix**: Sprint 41 — `parseThresholdK(slug)` helper + Priority-1 ágválasztás.

**Detection**: a `signal_details.vol_divergence.detail.strikeSource = "spot-fallback"` az above-Nk slug-okra.

**Mit tegyél**: post-fix verify hogy `strikeSource = "slug-threshold"`. Ha még spot-fallback → deploy lag, várj 1 cron tick-et.

### §5.4 — NO@K_lo + YES@K_hi pár (pre-Sprint-41, 2026-05-15)

**Bug**: a Sprint 39e Monotonicitás-gate csak a predikciók koherenciáját ellenőrizte, a bet-oldalak kontradikcióját NEM. 2026-05-15-én a bot nyitott egy `NO @ above-80k-may-15` + `YES @ above-82k-may-15` párt, a (80K, 82K] sáv mindkettőt buktatta.

**Fix**: Sprint 41 — Outcome-overlap (#16) gate.

**Detection**: az open positions között létezik (`bitcoin-above-K_lo-on-X`, NO) és (`bitcoin-above-K_hi-on-X`, YES) pár (K_hi > K_lo, same X).

**Mit tegyél**: ha látod a CURRENT open-listán post-fix → potenciális gate-regression, escalate.

### §5.5 — Monotonicity-sértés (pre-Sprint-39e, 2026-05-14)

**Bug**: 78K-NO + 80K-YES nyitva, pred(78K) = 52% < pred(80K) = 53% → P(>78K) ≥ P(>80K) sértve.

**Fix**: Sprint 39e — `findMonotonicityViolation()` shared helper.

**Detection**: open positions között létezik (above-K_lo, pred_lo) és (above-K_hi, pred_hi) pár ahol K_hi > K_lo de pred_hi > pred_lo (azonos closingKey).

### §5.6 — Combiner-noise gate-bypass (Loose preset)

Lásd §4.3 részletesen.

### §5.7 — HL paper-vol drift (pre-2026-05-10)

**Bug**: HL paper-vol gate más küszöböt használt mint live → paper trade-ek eltérő DECISION-eket adtak.

**Fix**: 2026-05-10 — paper-vol gate parity.

**Detection**: nehéz utólag detektálni; a `recentLogs`-ban a `volGate` mező egyezzen paper/live között.

---

## §6 — Modifikációs javaslatok (mit mondj az operátornak)

Az audit végén minden esetben adj **konkrét, akcionable javaslatokat**. Soha ne legyen pusztán deszkriptív riport.

### §6.1 — Settings-knob változtatás javaslatok

| Trigger | Javaslat | Knob |
|---|---|---|
| Flat finalProb a Sprint 41 fix után | Sprint 42A bekapcsolás | `combinerKBlindDownweight = 0.5` (default 1.0) |
| Loose preset + noise-trade-ek | Normal preset | `combinerConfidenceMin = 0.05` |
| Calibration deviation > 7% | Realized-IC blend ON | `useRealizedIC = 1` |
| Regime-shift gyanú | Time-decay IC | `icHalfLifeTrades = 50` (default 0) |
| Session loss limit miatt stop | Limit emelés + Resume | `sessionLossLimit = 100` (vagy a tényleges loss-szal arányosan) |
| HL consecutive-loss pause túl hosszú | Pause idő csökkentés | `hlConsecutiveLossPauseHours = 0.5` |
| Live-readiness override (kockázatos) | Csak audit után | `liveReadyOverrideEnabled = 1` |

### §6.2 — Backlog / Sprint promotion javaslatok

Ha az audit során azonosítasz egy **strukturális** problémát, ami nem egy Settings-knob változtatással javítható, akkor:

1. **Új feladat** → `internal-docs/roadmap/sprints.md` Backlog (B-szám) vagy Next candidate (42-N)
2. **Ne** módosítsd a többi doksit (math/, changelog/) feladat-leírással — a sprints.md a SSOT (2026-05-15 szabály, CLAUDE.md)
3. A javaslatba foglald bele:
   - **Severity**: 🔴/🟠/🟡/🟢
   - **Becslés**: nap/óra
   - **Precondition**: mire kell várni
   - **Várt hatás**: numerikus, ha tudható

### §6.3 — Manual operatív akciók

| Trigger | Javaslat |
|---|---|
| Bankroll kifogyott (sessionLossLimit hit) | Settings → limit emelés → `?action=resume` (NEM reset!) |
| Tényleges bankroll-kiürülés | Sprint 42B Topup action — vagy operátor manual Blobs-edit (ronda de gyors) |
| Manual stop kell | `POST /auto-trader-api { action: "stop", category: "crypto" }` |
| Open pozíció close manual | Polymarket UI-n keresztül (a bot csak Gamma-resolution-on zár automatikusan) |

### §6.4 — Sample-size warnings

Ha n < 10 trade → **semmilyen IC vagy Sharpe következtetés nem statisztikailag érvényes**. Mondd ki explicit. A user-nek érdemes 30+ trade-ig várni mielőtt strategy-tuning-ot tesz.

---

## §7 — Output formátum

A user-nek **strukturált** report-ot adj, NEM csak prose-t. Sablon:

```markdown
### 1. Stale állapot (ha van)
[CLAUDE.md még a tegnapi snapshotot tartalmazza vs. élő...]

### 2. Trade-validitás (Polymarket Gamma cross-check)
| # | Slug | Dir | Bot exit | Gamma | Match |
|---|------|-----|---------|-------|-------|
| 1 | ... | ... | ... | `["1","0"]` ✓ | ... |
...

### 3. PnL matematika reprodukció
[bit-pontos reprodukció bemutatása, formula + 1-2 példa]

### 4. Bankroll-rekonciliáció
```
bankrollStart   = $250
+ closedPnL     = +$X
− openStakes    = −$Y
= bankrollCurrent  $Z  ✓
```

### 5. Megfigyelések (nem hibák, de figyelembe veendők)
[EV-gap, Sharpe CI, win-rate gate státusz, calibrációs deviation]

### 6. Cross-position konzisztencia (5 gate)
[per-bot eredmény + Sprint 39e + Sprint 41 fingerprint]

### 7. Pattern-detection (combiner-output)
[§4-ből alkalmazható minták felismerése]

### Verdict
[A history valid/suspect/buggy → 1-2 mondatos összegzés]

### Konkrét javaslatok
1. [Settings-knob change, ha indokolt]
2. [Sprint promotion, ha strukturális]
3. [Operatív akció, ha azonnali]
```

Markdown link-formátum: minden file-hivatkozás `[name](path:line)` formátumban, hogy a user kattintható linket kapjon.

---

## §8 — Anti-patterns (mit NE csinálj)

1. **Ne futtass destructive akciókat (reset, stop, manual close) audit közben anélkül hogy explicit kérnék.** Az audit read-only művelet. Ha javaslod a `reset`-et, mindig magyarázd el a következményt (closedTrades + IC kalibráció wipe).

2. **Ne csinálj kód-változtatást history-audit közben.** Ha bug-ot találsz, először javasolj (Sprint-promotion), és csak explicit "implementáld" után írj kódot.

3. **Ne mentsd a memóriába az audit-eredményt.** Az audit egy session-specifikus snapshot — a következő session-ben már elavult. A részletes audit-history a `changelog/CHANGELOG-YYYY-MM-DD.md`-be megy, **csak ha** új bug/feature kerül lejavításra. Pusztán "verifikáció történt" audit-ot **soha** ne tegyél changelog-ba.

4. **Ne következtess túl kicsi mintán.** n < 10 → nincs statisztikai következtetés. n < 30 → nincs IC vagy Sharpe következtetés. Mondd ki ezt explicit a user-nek.

5. **Ne állítsd hogy "a PnL biztos valid" anélkül hogy Gamma-resolution-t megnéztél volna.** A `trades[].exitPrice` a bot belső állapota — a `outcomePrices` a kanonikus forrás.

6. **Ne tételezd fel hogy a CLAUDE.md AKTUÁLIS ÁLLAPOT szekciója friss.** Mindig pull-old a live state-et először. CLAUDE.md a session-zárás után frissül; a session során eltelt idő alatt a bot dolgozhatott.

7. **Ne komplexítsd a fee-modellt.** Crypto + weather paper-PnL **mindig** `applySettlementFee(pnlGross, proceeds, costBasis, 0.036)`. Ne keress más fee-modellt anélkül hogy a kód explicit változott volna.

8. **Ne futtass `npm run build` audit-ban.** Ha nem kóddolsz, nincs build-target. A `?action=status` + `/edge-tracker` + Gamma elég.

9. **Ne adj absztrakt javaslatot** ("optimalizáld a stratégiát"). Minden javaslat **konkrét Settings-knob** vagy **Sprint promotion** legyen, számokkal.

10. **Ne keverj össze open vs closed pozíciókat.** Az `auto-trader-api?action=status` `openDetails` az open lista, az `edge-tracker?category=X` `trades[]` a closed lista. Soha ne audit-old őket együtt egy táblában.

---

## §9 — Példa session: 2026-05-15 7-trade history audit

A 2026-05-15-i 41. session demonstrálja a playbook teljes alkalmazását. Lépésről-lépésre:

### Trigger
User: *"ellenőrizd hogy a history trade-k validak voltak-e és a pnl valós-e: https://mj-trading.netlify.app/trade/crypto/"*

### Step 1 — Adatbeszerzés (párhuzamosan)

```powershell
# §2.1
$status = Invoke-WebRequest "...?action=status&category=crypto"
# §2.2
$edge   = Invoke-WebRequest "...edge-tracker?category=crypto"
# §2.3 — minden closed slug-ra
foreach ($s in $slugs) { Invoke-RestMethod "...gamma-api...slug=$s&closed=true" }
# §2.4
$btc = Invoke-WebRequest "...binance.com...BTCUSDT"
# §2.5
$set = Invoke-WebRequest "...trader-settings"
```

### Step 2 — Cross-check (§3 Step 1-2)

7 closed trade Gamma resolution-je verify-olva → mind a 7 egyezett. PnL math 3 tizedesjegyig reprodukálva mind a 7-en.

### Step 3 — Bankroll-rekonciliáció (§3 Step 3)

`$250 + $21.96 − $34.96 = $237.00` ✓

### Step 4 — Cross-position konzisztencia (§3 Step 4)

A 4 open pozíción a Monotonicitás-gate átment (`pred(>78K) > pred(>80K) > pred(>82K)`), de az Outcome-overlap-gate **sérült**: `NO@above-80k-may-15 + YES@above-82k-may-15` pár → Sprint 41 trigger.

### Step 5 — Combiner-pattern (§4)

Flat finalProb pattern detected: mind a 3 új open pozíció `predictedProb ∈ [0.46, 0.48]`, ami a §4.1 ujjlenyomata. A vol_divergence `strikeSource` ellenőrzéséből kiderült: `"spot-fallback"` az above-Nk piacokra → §5.3 bug aktív → Sprint 41 root-cause fix indokolt.

### Step 6 — Javaslatok (§6)

1. **Outcome-overlap gate hozzáadása** (Sprint 41 #16) — kód-változtatás, implementálva
2. **vol_divergence K-extrakció fix** (Sprint 41) — kód-változtatás, implementálva
3. **Sprint 42A K-blind downweight** (speculative-OK) — kód-változtatás, implementálva default-off
4. **Settings: Loose → Normal váltás** (operátor, opciós)
5. **Topup action** (Sprint 42B promotálva B9-ből)

### Step 7 — Changelog entry

`internal-docs/changelog/CHANGELOG-2026-05-15.md` — 4 munka-tétel:
- 7-trade audit (read-only verification)
- Outcome-overlap gate (#16)
- vol_divergence K-extrakció fix
- Sprint 42A K-blind downweight (speculative)

A részletes audit eredménye **csak akkor** kerül changelogba, ha bug-fix-szel együtt — ez teljesült.

---

## §10 — Karbantartás

Ezt a playbook-ot frissíteni kell minden új audit-eredmény után, **ha**:

1. **Új bug-pattern azonosított** → §5 új sub-szekció + fingerprint
2. **Új audit-endpoint hozzáadva** → §2 új sub-szekció
3. **Új gate / Settings-knob bevezetve** → §6.1 új sor a táblában
4. **Új combiner-jellegű anomália dokumentálva** → §4 új pattern

**Tilos** a playbook-ot frissíteni:
- Egy konkrét trade tartalmával (history-snapshot a changelog-ban él)
- Operátor-specifikus preferenciákkal (a Settings-knob default-ok elégek)
- Még nem implementált feature-ekkel (sprints.md candidate-en kell ülniük előbb)

A playbook **stabil dokumentum** — átlagosan 1-2 frissítés/hónap várható, ha az audit-rendszer érett.

---

## §11 — Hivatkozások

- [`internal-docs/math/13-crypto-bot.md`](../math/13-crypto-bot.md) — crypto bot 16-gate decision-engine + paper PnL formula
- [`internal-docs/math/14-hl-directional.md`](../math/14-hl-directional.md) — HL Perp bot
- [`internal-docs/math/15-funding-arb.md`](../math/15-funding-arb.md) — F-Arb
- [`internal-docs/math/16-weather-bot.md`](../math/16-weather-bot.md) — weather bot 8-gate + bucket-matcher
- [`internal-docs/math/10-signal-combiner.md`](../math/10-signal-combiner.md) — 8-signal combiner + Grinold-Kahn
- [`internal-docs/roadmap/sprints.md`](../roadmap/sprints.md) — SSOT a sprint-tárgyú feladatokhoz
- [`netlify/functions/signal-combiner.mts`](../../netlify/functions/signal-combiner.mts) — combiner implementáció
- [`netlify/functions/auto-trader/crypto/paper-resolver.mts`](../../netlify/functions/auto-trader/crypto/paper-resolver.mts) — paper-fee model
- [`netlify/functions/auto-trader/shared/cross-position-gates.mts`](../../netlify/functions/auto-trader/shared/cross-position-gates.mts) — cross-position-gate helpers
- Changelog precedensek:
  - [2026-05-15 outcome-overlap + vol_div fix + Sprint 42A](../changelog/CHANGELOG-2026-05-15.md)
  - [2026-05-14e cross-position consistency](../changelog/CHANGELOG-2026-05-14e.md)
  - [2026-05-11 8-fix crypto deep audit](../changelog/CHANGELOG-2026-05-11.md)
  - [2026-05-10 simV3 paper-resolver fix](../changelog/CHANGELOG-2026-05-10.md)
