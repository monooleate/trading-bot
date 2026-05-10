
# 2026-05-11 (g) — Weather audit round 4: ensemble σ → matcher + bucket half-width cap + DEB POL learning + NaN-safe Pearson

## A user kérése (folytatás 4)

A reset után 3 trade nyílt azonnal. A user: "újraindítottam és hármat is
nyitott azonnal. helyesen?". Igen — mindhárom helyesen a 7 új gate alatt.
De a Hong Kong + Austin trades-eken észrevettem egy strukturális σ-bias-t,
amit most fixelek.

## 4 új audit-finding (mind javítva)

**1. (HIGH) σ → matcher hardcoded, ignorálja az ensemble σ-t.** Austin
2026-05-12 példán: a 31-tagú GFS ensemble empirikus σ=1.28°C (ECMWF 29.0°C,
GFS det. 28.3°C, ensemble mean 30.4°C, member spread max=32.6 min=27.0). De
a bucket-matcher hardcoded σ=1.0-zel (cloud<60%) számolt → bot reported
P("84°F or higher")=98.2%. Helyes σ=1.28 alapján P=95% — overconfident bias.
**Fix**: a matcher mostantól a `forecast.ensembleDetail?.dailyMaxStdDev`-et
használja, 0.5°C floor-ral. Cloud-heuristic fallback marad ha nincs
ensemble.

**2. (MEDIUM) Bucket-matcher CDF interval over-spans sparse markets.** Egy
hipotetikus market 10°C/12°C/20°C/30°+ buckete-kkel a v2 matcher a
"12°C" buckethez `[11, 16]` intervallumot rendelne (mid-to-prev=11,
mid-to-next=16) — 5°C-os szélességgel! **Fix**: `NON_TAIL_HALF_WIDTH_CAP =
0.55°C` minden non-tail bucket-en. Az 1°C-os Shanghai gridre ÉS a 2°F-os
Austin gridre no-op (a 0.5/0.555 half-step már a cap alatt van), de sparse
gridon pinch-eli a width-et.

**3. (MEDIUM) DEB sample-ek csak METAR-fallback-on rögzítődnek.** A
POL-primary path 99%-on settle-elt, METAR-fallback ~6h után fut — DEB
gyakorlatilag SOHA nem tanult a paper history-ból. **Fix**: POL-settle
után opcionális METAR fetch a DEB feedback miatt, best-effort try/catch.
A POL-settlement maga sosem blokkolódik.

**4. (LOW) `pearsonCorrelation` NaN propagáció.** Egy NaN érték a scores
array-ben az egész IC-t NaN-ná teszi. **Fix**: jointly-finite filter az
elején — ha bárhol NaN/Infinity, az index dropped (mindkét oldalt). NaN-safe
`forecast_edge` is — weather entry-snapshot null-t ír ha match.probability
vagy marketPrice nem véges.

## A live trade validáció (a (e) fix utáni reset után)

| # | Trade | Math | Verdict |
|---|-------|------|---------|
| 1 | Shanghai 25°C YES — SKIPPED | disagreement 3.7°C > 2.0°C | ✓ helyes blokk (előző PDF-bug trade megakadt) |
| 2 | Seoul 20°C NO — SKIPPED | disagreement 2.2°C > 2.0°C | ✓ |
| 3 | HK 30°C+ YES @ 0.105 | μ=28.9, σ=1.5, P(T≥29.5)=0.345; market 0.095 | ✓ tail-trade lehetséges a v2 CDF math miatt; defensible |
| 4 | London 13°C NO @ 0.535 | μ=11.7, modal 12°C; market túlárazta 13°C-ot 47.5%-on | ✓ |
| 5 | Austin 84°F+ YES @ 0.715 | μ=30.6 (ensemble mean), P=98.2% | ⚠ slight overconfidence — σ fix után P=95% |

Cross-check: az Open-Meteo most:
- GFS deterministic: 28.3°C / 82.94°F
- ECMWF: 29.0°C / 84.2°F
- **GFS 31-tagú ensemble mean: 30.41°C / 86.7°F, σ=1.28°C**

A bot az ensemble-t használta (`useEnsemble: true`), helyesen. Ha a bot
ezután re-scan-elne, az Austin trade még mindig passza-na minden gate-et
(net edge 25% > 12%), de a probabilitás 95% lenne (nem 98.2%).

## Files touched

| Fájl | Változás |
|------|----------|
| `netlify/functions/auto-trader/weather/index.mts` | σ source = ensemble.dailyMaxStdDev (0.5°C floor); NaN-safe forecast_edge |
| `netlify/functions/auto-trader/weather/bucket-matcher.mts` | `NON_TAIL_HALF_WIDTH_CAP = 0.55°C` minden non-tail bucket-en |
| `netlify/functions/auto-trader/weather/reconciler.mts` | Opportunistic METAR fetch a DEB feedback-hez POL-settle után |
| `netlify/functions/edge-tracker/statistics.mts` | `pearsonCorrelation` NaN-safe jointly-finite filter |

## Verifikáció

- `tsc --noEmit` exit 0
- `bucket-matcher.test` 4/4 passed
- `station-config.test` 8/8 passed
- `npm run build` 10 pages built
- Custom cap-test: Shanghai 1°C grid no-op (interval [24.5, 25.5]), Austin 2°F near-no-op ([27.51, 28.475]), sparse-grid pinched correctly

## Hatás deploy után

- Ensemble σ a matcherbe → Austin-style trade-ek tail-probabilitása kalibráltabb (~5pp különbség)
- Sparse market-eken bucket-mass nem futószalagosan túlbecslés
- DEB minden POL-settled trade-ből tanul (eddig csak METAR-fallback-en, ~1%)
- IC-számítás NaN-safe → nincs csendes 0-ra esés ha bármely sample sérült

---

# 2026-05-11 (f) — Crypto bot deep-audit: 8 signal-layer + arithmetic fixes (vol_divergence degenerate, apex cash-flow, cond_prob direction, momentum regime, bankroll drift)

## A user kérése

A 2026-05-11 (d) crypto audit (6 gate-layer fix) után a user: "crypto botra
mélyelemzést! mindent, frontend, backend, jelek validsága amik alapján
trade történik!". Az audit a 8 trading signal matematikai validitására,
a session-state aritmetikájára és a UI rétegre fókuszált.

## 8 új audit-finding (mind javítva)

| # | Réteg | Probléma | Severity |
|---|-------|----------|----------|
| **A** | Signal: `vol_divergence` | A `iv = 2 × \|yp-0.5\| / √T × 100` Black-Scholes-szerű képlet rövid horizonton (T → 0) hatalmas IV-t számol — 15min BTC piacon yp=0.3 mellett iv ≈ 7,490%, ami RV (60%) ellenében minden esetben clamp 0.1-re esik. **A signal a BTC 5m/15m piacokon konstans 0.1**, NEM signal — szisztematikus NO-bias a combinerben. | 🔴 HIGH |
| **B** | Session arithmetic | `closePosition` a `bankrollCurrent`-et `shares × exitPrice` (gross proceeds) képlettel növelte, miközben a `sessionPnL` a `trade.pnl` (fee-vel csökkentett) értékkel. `bankrollStart + sessionPnL ≠ bankrollCurrent` invariáns sértve — bankroll trade-enként ~3.6% × notional optimist drift. | 🟠 MEDIUM |
| **C** | Signal: `apex_consensus` | A "wallet PnL" képlet csak a `/trades` feed cash flow-ját összegzi (`SELL → +cash, BUY → -cash`). A settlement-bevételt NEM látja → "top 10 wallets" valójában "top sellers". Egy 100% BUY wallet ami nyer is negatív "PnL"-t mutat. | 🟠 MEDIUM |
| **D** | Signal: `cond_prob` | `violationDir` csak a `complement-check` előjelét vette, a `monoton-violation` magnitúdóját VAKON adta hozzá. Két különböző irányú violation kioltása nem működött — egy "YES overpriced via complement" + "YES underpriced via earlier related" rosszul kombinálódott. | 🟠 MEDIUM |
| **E** | Signal: `momentum` | A Polymarket YES midpoint Rcum-ját trend-folytatásként interpretálta (`prob = 0.5 + rcum × 2.0`). DE a prediction market microstructure-ben gyors (>5%) mozgások tipikusan likviditás-driven, NEM informált → mean-reverting. A momentum-signal ezeken rossz irányba húz. | 🟡 LOW |
| **F** | Statistics chart | `computeCumulativePnl` EV baseline `predictedProb`-ot direkt használja win-probability-ként, de NO trade-en a tényleges win-prob `1 - predictedProb`. Az EV vonal rossz irányba mutatott minden NO trade-en. | 🟡 LOW |
| **G** | Frontend | `${activeSignals}/5 signals` chip a régi 5-signal max-ot mutatja; subtitle 5 signalt sorol fel (a 8 helyett); `RunResult.config` interface hiányolja az új `minPositionSizeUSDC` és `combinerConfidenceMin` mezőket. | 🟡 Cosmetic |
| **H** | (G-vel együtt) | UI félrevezetés. | 🟡 Cosmetic |

## A 8 fix

### Fix A — `vol_divergence` horizon gate

`signal-combiner.mts:getVolSignal`. Új `VOL_MIN_HORIZON_HOURS = 1`
konstans. Ha a piac endDate-je <1h-n belül van → `prob: null` +
`detail.skipped` reason. A combiner null-okat kihagy a súlyozott
átlagból, `activeSignals` csökken egyel a rövid BTC piacokon.

Empirikus impact: a 3 jelenleg nyitott pozíció `vol_divergence: 0.1`
értéke onnan jött, hogy minden BTC 5m/15m piacon a clamp lefutott.
A fix után a `vol_divergence: null` és az `activeSignals` 8 → 7 (még
mindig ≥ 2 gate-en pass-ol).

### Fix B — `closePosition` bankroll-konzisztencia

`session-manager.mts:closePosition`. Most a `pos.costBasis`-t lookup-olja
a `buyOrderId` szerint, és `bankrollCurrent += trade.pnl + costBasis`.

Bizonyítás:
- addOpenPosition: `bankrollCurrent -= costBasis`
- closePosition: `bankrollCurrent += pnl_net + costBasis`
- net effect: `+ pnl_net` → invariáns `bankrollStart + sessionPnL === bankrollCurrent` ✓

### Fix C — `apex_consensus` activity score

`signal-combiner.mts:getApexSignal`. A "PnL" képlet helyett:
- per-wallet `notional = Σ size × price` (total $ traded)
- per-wallet `markets = distinct conditionIds traded`
- score = `notional × √markets` (diminishing returns a market-diverzitásra)

A "top 10" mostantól a leg-aktívabb traderek a 8h trade-window-on belül,
amik tipikusan informált flow-t hordoznak. A részletes per-wallet PnL
analysis (settlement-bevétel együtt) a `/apex-wallets` endpoint
(Tab 8) dolga.

### Fix D — `cond_prob` direction-aware

`signal-combiner.mts:getCondProbSignal`. Új `complementSigned` és
`monotonSigned` változók:
- `complementSigned = -dev` (YES+NO > 1 → -1; YES+NO < 1 → +1)
- `monotonSigned`: per-related-market signed contribution, externally
  accumulated
- `netSigned = complementSigned + monotonSigned` — két egymás-ellenes
  violation **kiolthatja egymást**, az iránya a SUM-ből ered

Magnitude a `|netSigned|`-en alapszik, 0.3-en cap-elve. A detail
mezőben mind a 3 érték kiírva.

### Fix E — `momentum` regime-aware

`signal-combiner.mts:getMomentumSignal`. Új `REGIME_THRESHOLD = 0.05`:
- `|rcum| < 5%` → trend (Jegadeesh-Titman): `prob = 0.5 + rcum × 2.0`
- `|rcum| ≥ 5%` → mean-revert (likviditás-driven gyors mozgás):
  `prob = 0.5 − rcum × 1.0` (kisebb multiplier — regime detection nem
  tökéletes)

`detail.regime` mező mostantól pontosan jelzi a UI-on.

### Fix F — EV baseline direction-aware

`statistics.mts:computeCumulativePnl`. `winProb = direction === "NO" ? 1
- predictedProb : predictedProb`. A `evCum` chart mostantól helyes
irányba mutat NO trade-eken is. Csak az Edge Tracker UI vonalat érinti
— az IC számítás már korábban direction-aware volt.

### Fix G+H — Frontend cosmetics

`CryptoTrader.tsx`:
- L253: subtitle mostantól mind a 8 signalt sorolja fel (FR/VPIN/VOL/APEX/CP/MOM/CTR/PRS).
- L432: chip "X/8 signals" a régi "X/5" helyett, tooltip új 8-signal listával.
- L140-153: `RunResult.config` interface bővítve `minPositionSizeUSDC?` és `combinerConfidenceMin?` opcionális mezőkkel.

## Files touched

| Fájl | Változás |
|------|----------|
| `netlify/functions/signal-combiner.mts` | 4 signal fix (A vol, C apex, D condprob, E momentum) — együtt ~120 LOC delta |
| `netlify/functions/auto-trader/crypto/session-manager.mts` | `closePosition` bankroll képlet (B) |
| `netlify/functions/edge-tracker/statistics.mts` | `computeCumulativePnl` EV winProb (F) |
| `src/components/trader/CryptoTrader.tsx` | subtitle + chip max + config interface (G+H) |

## Verifikáció

| Lépés | Eredmény |
|-------|----------|
| `npx tsc --noEmit` (project files, sports-bot kivételével) | exit 0 |
| `npm run build` | 10 pages built |
| Logical sanity check a 8 fix-re egyenként | OK |

## Hatás deploy után

**Signal layer**:
- A `vol_divergence` mostantól csak a daily / weekly BTC piacokon járul
  hozzá a combinerhez. A 5m/15m piacokon `activeSignals` 8 → 7. Az IC
  kalibráció pontosabb lesz, mert a konstans 0.1-es noise eltűnt.
- `apex_consensus` top-N most a leg-aktívabb traders, NEM a top-sellers.
- `cond_prob` direction-aware — ellentétes violation-ök kioltják egymást.
- `momentum` regime-aware — gyors mozgásokon contrarian.

**Session arithmetic**:
- A `bankrollCurrent` mostantól PRECÍZEN követi a `bankrollStart + sessionPnL`-t. A jövőbeli closed trade-ek nem drift-elnek.
- A 3 meglévő open pozíción a fix close-kor lép életbe — a régi
  `bankrollCurrent` érték enyhén túlbecsült marad, de a sessionPnL helyes.

**UI**:
- "X/8 signals" pontosan tükrözi a backendet.
- "Why?" panel hibátlan.

`tsc --noEmit` exit 0 (project files), Astro build 10 page generated.

---


## A user kérése (folytatás 2)

A (d) commit utáni 3. audit-kör. A user kérése: "ha most újra megkérlek hogy
ellenőrizz mindent megint hibát találsz?". Igen — 4 további hibát találtam:

## 4 új audit-finding

**1. (HIGH) NaN predictedTempC leak a bucket-matcheren.** Edge case sweep
mutatta: `matchBucket(NaN, buckets, σ)` minden bucket-re NaN valószínűséget
ad, és null helyett egy "hamis" BucketMatch-et ad vissza NaN edge-zel. A
downstream gate-ek minden NaN-összehasonlítást false-ra értékelnek, így a
"shouldTrade = false" miatt ártalmatlannak tűnik — de a bot rossz reason-t
mutatna a UI-on. **Fix**: korai `if (!Number.isFinite(predictedTempC)) return null;`
guard, plus a bucket szűrőből kizárva minden NaN/Infinity tempC.

**2. (MEDIUM) NaN ár szivárog a `parseFloat` után.** A Gamma `outcomePrices`
mező `parseFloat` után NaN lehet malformed value-knál; a nullish-coalescing
(`prices[0] ?? 0.5`) NEM fogja el a NaN-t (csak null/undefined-ot). **Fix**:
explicit `Number.isFinite` guard 0.5 fallback-kal.

**3. (HIGH) Reconciler tail-bucket boundary inkonzisztens a matcher-rel.**
A v2 CDF-matcher a "21°C or below" buckethez `(-∞, 21.5]` intervallumot
rendel (midpoint a 22°C felé). A reconciler ellenőrzés viszont `settlementC
<= 21` — szigorúan a küszöb. METAR=70°F → settlementC=21.11°C → tail-low
check NEM teljesül (21.11 > 21), de a 22°C bucket sem teljesül
(|21.11-22|=0.89 > 0.5). **Settlement gap**: METAR=70°F-en se "21°C or
below", se "22°C" nem nyer (a fallback nearest-center logika kompenzálná, de
a reconciler nem használ nearest-centert). **Fix**: tail-low `settlementC <=
tempC + 0.5`, tail-high `settlementC >= tempC - 0.5` — szimmetrikus az
internal-bucket ±0.5 toleranciával, konzisztens a matcher interval-jával.

**4. (HIGH) Weather **soha** nem tudja teljesíteni a live-readiness IC gate-et.**
A `signal-ic` gate `applicable: isPredictionDriven` (a weather bot a
prediction-driven kategóriában van) — de a weather entry-decision snapshot
`signalBreakdown: null`-t mentett, és a reconciler `signalBreakdown: null`-t
ír be a closedTrade-be. A `computeSignalIC` minden trade-et kiszűr ami null
signalBreakdown-nal jön → 0 trade IC-számításhoz → maxAbsIC = 0 → gate
SOHA nem teljesül. **Az effekt: 30+ closed trade után a weather live-mode
fix struktúrális blokkban van.** Mivel a trade-count gate (0 < 30) jelenleg
maszkolja, élesedéskor látszott volna először. **Fix**: új `forecast_edge`
mező a `SignalBreakdown` interface-ben — a weather entry-snapshot
populálja `forecast_edge = predictedProb − marketPrice`-szel (a model edge),
a reconciler propagálja a closedTrade-be. A `computeSignalIC` mostantól
mérni tudja `Pearson(forecast_edge, win/loss)`-t weather-en, ami a forecast
skill valódi proxyja. Crypto/HL/funding-arb mindenhol `forecast_edge: null`.

## Files touched

| Fájl | Változás |
|------|----------|
| `netlify/functions/auto-trader/weather/bucket-matcher.mts` | NaN guards (előtér + tempC szűrés) |
| `netlify/functions/auto-trader/weather/market-finder.mts` | NaN ár guard a parseFloat után |
| `netlify/functions/auto-trader/weather/reconciler.mts` | Tail-boundary szimmetrizálva (`tempC ± 0.5`) |
| `netlify/functions/auto-trader/weather/index.mts` | `signalBreakdown.forecast_edge` populálva entry-kor |
| `netlify/functions/auto-trader/shared/types.mts` | `SignalBreakdown.forecast_edge` mező |
| `netlify/functions/edge-tracker/statistics.mts` | `forecast_edge` a `SIGNAL_NAMES`-ben |
| `netlify/functions/auto-trader/crypto/signal-aggregator.mts` | `forecast_edge: null` minden crypto signal-építésnél |
| `netlify/functions/auto-trader/hyperliquid/signal-source.mts` | `forecast_edge: null` HL signal-snapshot-on |
| `netlify/functions/edge-tracker/mock-trades.mts` | `forecast_edge: null` mock trade-eken |

## Verifikáció

- `tsc --noEmit` exit 0 (9 file érintett a type-bővítés miatt)
- `bucket-matcher.test` 4/4 passed (most már a NaN edge case is jól kezelt)
- `station-config.test` 8/8 passed
- `npm run build` 10 page (előbb 9 volt — nem a fix-ekhez kapcsolódó új page-ek)

## Egyéb auditált, NEM-bug területek

- METAR `parseMetarTGroup` (precise tenths-°C) működése validálva — order-of-ops
  helyes (max precise → °F round → settlement compare)
- `autoForecastDays` matek validálva
- `computeEnsemble` DEB súly normalizálása ellenőrizve
- Decision-engine NaN propagáció — match=null védi (a NaN guard miatt)
- `marketConsensusModalTempC` soft-fail tail-only lineup-on, all-null tempC-n,
  mixed null/szám lineup-on (mind ellenőrizve egy edge-case sweep-pel)

## Még nem javított

- **Bucket-matcher °F-rounding bias**: az integer °C buckete-k (pl. "25°C")
  Polymarket settlement window-ja keskenyebb (csak 1 °F integer = ~0.55°C)
  mint a matcher CDF intervalluma (1.0°C). 2°F buckete-k pedig szélesebbek
  (1.11°C). Az alternáló bias kicsi (~10%), TODO: explicit °F-integer
  modellezés.
- **σ kalibráció**: hardcoded 1.0/1.5 a `cloudCoverPct > 60` ágon. A
  31-tagú GFS-ensemble (most default ON) ad σ-t a `confidence` mezőhöz, de
  a bucket-matcher továbbra is a hardcoded értéket használja. TODO:
  ensemble σ-t átadni a matchernek is.
- **HL coin "BTC/ETH/SOL/XRP/AVAX" lista** — funding-arb és HL bot is használja,
  de a `classifyLogLine` szerinti `HL_COINS` set explicit. Új coin
  hozzáadásakor szinkronizálni kell.

---

# 2026-05-11 (d) — Weather bot audit-driven fixes: tail-bucket CDF + market-disagreement gate + ensemble default + cloud avg + log filter

## A user kérése (folytatás)

A 2026-05-11 (b) Reconcile timeout fix után a weather bot teljes audit-ja
következett. A user a `https://mj-trading.netlify.app/trade/weather/`
oldalon 2 nyitott paper pozíciót (Shanghai 25°C YES, Austin 82-83°F YES)
kérdéses-re tartott, és a teljes trade pipeline strukturális
felülvizsgálatát kérte. Az audit 4 strukturális hibát talált, mind
javítva.

## A 4 audit-finding

**1. (HIGH) `bucket-matcher.mts` PDF-alapú normalizációja torzított.**
A `parseTempFromLabel("84°F or higher")` `tempC=28.89`-t adott
(threshold), és a matcher Gauss-**PDF**-et használt a normalizációhoz,
nem a Gauss-**CDF**-integrált. Két hatás:
  - **Tail-bucketek pontmázsaként kezelve** — Polymarket viszont
    integrálban settlel: `P(T ≥ 28.89°C)` *és nem* `PDF(28.89)`. Az
    Austin 2026-05-12 piacon a `"84°F or higher"` bucket 70%-os market
    árán a bot 70.3% modell-probot adott (PDF-arány), miközben a helyes
    CDF-érték `μ=28.9, σ=1.0` mellett 50% lett volna. A belső buckete-k
    (`"82-83°F"`) ezért 38.8%-osra inflálódtak.
  - **Bucket-szélességek figyelmen kívül hagyva** — 1°C-os integer °C
    buckete-k és 2°F-os (~1.11°C) buckete-k ugyanazt a súlyt kapták.

**2. (HIGH) `useEnsemble = false` default.** A 31-tagú GFS-ensemble API
(`fetchEnsemble()`) már implementálva volt, de csak opt-in. Hardcoded
`σ = 1.0 (clear) / 1.5 (cloudy)` empirikusan nem kalibrált — 18-24h
daily-max forecast skill MAE ≈ 1.5°C, σ ≈ 2°C → a hardcoded 1.0 túl
optimista, OVERESTIMATEs precision.

**3. (MEDIUM) Cloud-cover csak GFS-ből.**
`forecast-engine.mts:252` `cloudCover = gfsResult?.cloudCover ??
ecmwfResult?.cloudCover ?? 50` — csak az első modell. Shanghai 2026-05-11
esetén GFS=68%, ECMWF=53% → σ=1.5 kapcsolt be GFS alapján; átlaggal
(60.5%) ugyanígy, de instabil pattern a két modell-disparity-nél.

**4. (LOW) `/status` `recentLogs` cross-kategória.** A weather-status
válaszban CRYPTO logok jelentek meg (`bitcoin-above-82k...`). A logger
globális, kategória-tag nem szűrt. Cosmetic, de zavaró.

## Az 5 fix

### (a) Bucket-matcher CDF v2

`bucket-matcher.mts` teljes átírás. Új algoritmus:
- `parseTempFromLabel` mostantól `{ tempC, tail: "low" | "high" | null }`-t ad vissza.
- `TemperatureBucket.tail` mező hozzáadva.
- `matchBucket` minden bucket-et **intervalként** kezel:
  - Belső bucket: `[lo, hi] = [(prev+self)/2, (self+next)/2]`
  - Alsó tail: `[lo, hi] = [-∞, (self+next)/2]`
  - Felső tail: `[lo, hi] = [(prev+self)/2, +∞]`
  - Szélső, de nem tail: a szomszéd felé félút, ellenkező oldalon `T_i ± fél-step`
- Per-bucket prob = Gauss-CDF az interval-on (`Φ(hi) - Φ(lo)`).
- `erf` Abramowitz & Stegun 7.1.26 approximation (1.5×10⁻⁷ abs error).
- Normalizáció only when tail-incomplete (sum < 1).
- Új helper: `marketConsensusModalTempC(buckets)` — a legmagasabban árazott bucket centerét adja vissza.

**Konkrét hatás a 2026-05-10-i Austin pozícióra:**
- Régi: `P(82-83°F)` = 0.388 (PDF), gross edge 0.223, net 0.213
- Új: `P(82-83°F)` = 0.258 (CDF), gross edge 0.088, net 0.078
- **A new edge most 7.8% < 12% threshold → a trade NEM nyílna meg.** Az
  Austin pozíció tehát PDF-bug artefakt volt.

Konkrét hatás a Shanghai 25°C pozícióra: minimális
(20.3% → 20.2%, edge 0.181 → 0.179) — itt a bucket belső,
közel-modális, ezért a PDF/CDF különbség elenyésző.

Új unit-test fájl: `netlify/functions/auto-trader/weather/bucket-matcher.test.mts`.
4 kategóriás teszt (Shanghai live, Austin live, single-bucket edge case,
market-modal helper). `npx tsx` → all passed.

### (b) `useEnsemble` default true

`decision-engine.mts:getWeatherConfig()` és `trader-settings.mts SCHEMA`
default `useEnsemble: 1`. Operátor `USE_ENSEMBLE=false` env vagy a
Settings tabon kapcsolhatja ki. Az ensemble API hibájára továbbra is
graceful fallback a determinisztikus GFS+ECMWF combo-ra (a meglévő
`ensembleResult.memberCount >= 5` gate marad).

### (c) Cloud-cover átlag GFS+ECMWF

`forecast-engine.mts` `cloudCover` mostantól `(gfs + ecmwf) / 2` ha
mindkettő elérhető, egyébként az elérhetőre esik vissza.

### (d) Market-disagreement gate (7. gate)

Új gate a `decision-engine.mts`-ben:
```
disagreeC = |predictedTempC - marketModalTempC|
gate.passed = disagreeC <= config.marketDisagreeMaxC
```
Default `marketDisagreeMaxC = 2.0°C`. `WEATHER_GATE_LABELS` 6→7 elem.
A `padWeatherGates` automatikusan kibővítve.

Az `index.mts`-ben a runner most a `marketConsensusModalTempC(market.outcomes)`-t számolja és átadja a decision-engine-nek. Soft-fail: ha
a modal nem parse-olható, a gate passed=true marad ("no market modal").

A 2026-05-09 Hong Kong May-9 historikus eset (predicted 24.4°C vs market
26°C @ 85%, disagreeC = 1.6°C) — a sanity cap (40%) már korábban blokkolta;
a market-disagreement gate (2.0°C) defense-in-depth.

### (e) Per-category log filter

`logger.mts` új `getLogBufferForCategory(category)` helper. Klasszifikáció
egy-passzal:
1. `category` field közvetlen match
2. `venue` field whitelist (`hyperliquid`, `funding-arb`, `weather`)
3. `type` field `weather`-prefix match
4. `coin` field HL-coin whitelist (`BTC/ETH/SOL/XRP/AVAX`)
5. `market` slug heuristika (`highest-temperature-*` → weather; `bitcoin-*`/`btc-*` → crypto)

Untagged sorok (nincs egyik mező sem) MINDEN kategória válaszában
megjelennek — session-wide warning-okat nem veszünk el.

A `auto-trader/index.mts:getStatus` mostantól ezt a szűrt változatot
adja vissza minden kategóriának.

## Files touched

| Fájl | Változás |
|------|----------|
| `netlify/functions/auto-trader/weather/bucket-matcher.mts` | Teljes átírás v2 CDF-alapú algoritmussal |
| `netlify/functions/auto-trader/weather/bucket-matcher.test.mts` | ÚJ — 4 kategóriás unit-test fájl |
| `netlify/functions/auto-trader/weather/market-finder.mts` | `parseTempFromLabel` `{tempC, tail}`-t ad vissza, `TemperatureBucket.tail` hozzáadva |
| `netlify/functions/auto-trader/weather/decision-engine.mts` | 7. gate (market-disagreement), `WEATHER_GATE_LABELS` bővítve, useEnsemble default true |
| `netlify/functions/auto-trader/weather/forecast-engine.mts` | cloud-cover átlag GFS+ECMWF |
| `netlify/functions/auto-trader/weather/index.mts` | `marketConsensusModalTempC` import + átadása a decision-engine-nek |
| `netlify/functions/auto-trader/shared/logger.mts` | `getLogBufferForCategory` + `classifyLogLine` helpers |
| `netlify/functions/auto-trader/index.mts` | `getStatus` mostantól per-category log buffert hív |
| `netlify/functions/trader-settings.mts` | `weatherUseEnsemble` default 1, új `weatherMarketDisagreeMaxC` field |
| `internal-docs/math/16-weather-bot.md` | §5 átírva v2-re, §7 gate-listája 6→7 sor |

## Verifikációs eredmény (live Shanghai + Austin data, 2026-05-10 22:30Z)

| Trade | Old gate result | New gate result | Verdict |
|-------|-----------------|-----------------|---------|
| Shanghai 25°C YES @ 0.022, μ=26.1, σ=1.5 | edge 18.1%, all 6 pass | edge 16.9%, all 7 pass | Új scan-en újra nyílna ugyanaz (model agreement 0.9°C < 2.0°C cap) |
| Austin 82-83°F YES @ 0.175, μ=28.9, σ=1.0 | edge 21.3%, all 6 pass | edge 7.8% < 12% → **edge gate FAIL** | Új scan-en nem nyílna — a régi pozíció PDF-bug artefakt |
| Hong Kong May 9 historical, μ=24.4 vs market 26°C @ 85% | sanity cap blokkolt | sanity cap + 1.6°C disagree blokkol | Defense-in-depth |

## Mit jelent ez a 2 jelenleg nyitott pozícióra

**Semmit.** A `if (updatedSession.openPositions.some(p => p.market === market.slug))` check garantálja, hogy a meglévő pozíciók nem re-evaluálódnak. A 2 trade természetes módon settlel (Shanghai 2026-05-11 12:00Z, Austin 2026-05-12 12:00Z) METAR-on. Az új gate-logika csak FUTURE scan-ekre érvényes.

A 2 trade tehát továbbra is "in flight" kalibrációs mintaként szolgál — az új CDF math nem retroaktív.

## Build + test eredmény

- `npx tsc --noEmit` → exit 0
- `npx tsx netlify/functions/auto-trader/weather/bucket-matcher.test.mts` → all checks passed
- `npx tsx netlify/functions/auto-trader/weather/station-config.test.mts` → 8/8 passed
- `npm run build` (Astro) → 9 page generated, no errors

## Még nem javított (low priority)

- **Top-5 `markets.slice(0, 5)` limit** — a scan loop csak a top-5 volume eventet dolgozza fel. Tudatos latency-cap, marad.
- **DEB σ-tanulás** — a per-bucket σ továbbra is hardcoded (1.0/1.5 cloudCover-alapú). Hosszú távon a closed-trade residual-eloszlásból kellene mérni (TODO, math/16-weather-bot.md §5 note).

---

# 2026-05-11 (c) — `internal-docs/` átszervezés (current-state / math / roadmap / archive)

## A user kérése

"Az internal-docs mappa tartalmát ésszerűsítsük, rendezzük logikus
mappaszerkezetbe! Elemezd az összes doksit és ha már nincs rá szükség
akkor vagy archive vagy törlés. Duplikációk nem kellenek. current-state
; math ; future-state és roadmap-to-reach future state."

## Új struktúra

A korábbi `app/`, `migration/`, `app/done/`, `math/weather/` keverék
egyszerre 5 szemantikai mappára bontva:

| Mappa | Mit tartalmaz | Mikor olvasod |
|-------|---------------|---------------|
| `current-state/` | Élő rendszer snapshot (architecture, env-vars, deploy, settings, trading-status, auto-claim) | Új session elején — "mi van most" |
| `math/` | Signal math + bot impl reference (02-ev-kelly … 16-weather-bot) | Algoritmus-szintű kérdéseknél |
| `roadmap/` | Hetzner migráció, master-plan, új stratégiák, infrastructure | "Mit építsünk legközelebb" |
| `changelog/` | Session-by-session history | "Mit változtattam tegnap" |
| `archive/` | Elkészült promptok + historikus tanulságok | Ritkán; régi döntések indoka |

## Mozgatások (git mv-vel a tracked fájlokon)

**`current-state/` (6 fájl):**
- `app/architecture.md` → `current-state/architecture.md`
- `app/trading-status.md` → `current-state/trading-status.md`
- `app/settings-help.md` → `current-state/settings-reference.md`
- `app/auto-claim.md` → `current-state/auto-claim.md`
- `env-vars.md` (root-ból) → `current-state/env-vars.md`
- `app/DEPLOY.md` → `current-state/deploy.md`

**`math/` (1 új flat-be hozva):**
- `math/weather/README.md` → `math/16-weather-bot.md`

**`roadmap/` (6 fájl + új README):**
- `edgecalc-master-plan.md` (root) → `roadmap/master-plan.md`
- `migration/hetzner-migration-plan.md` → `roadmap/hetzner-migration.md`
- `migration/infrastructure.md` → `roadmap/hetzner-infrastructure.md`
- `migration/migration-plan.md` → `roadmap/migration-strangler-fig.md`
- `migration/new-strategies-roadmap_1.md` → `roadmap/new-strategies.md`
- `migration/risk-coordinator.md` → `roadmap/risk-coordinator-considerations.md`
- **Új:** `roadmap/README.md` — olvasási sorrend a 6 doki-hoz

**`archive/` (5 prompt + 3 misc):**
- `app/done/edgecalc-{autotrader,hyperliquid,funding-arb,resolution-risk,weather-patch}-{prompt,patch}.md` → `archive/prompts/{autotrader,hyperliquid,funding-arb,resolution-risk,weather-patch}-{prompt,patch}.md`
- `app/paper-pnl-analysis.md` → `archive/paper-pnl-v2-bug.md` (a v2 sim bug forensics, már fixelve sim v3-mal)
- `migration/reference/VPS-SETUP_detailed_done_26-04-03.md` → `archive/grabit-vps-setup.md`
- `content-roadmap-matekmegoldasok.md` (root, untracked) → `archive/matekmegoldasok-content-roadmap.md` (másik projekt cikk-roadmap-je)

## Törlések (4 dupli/elavult)

- `app/done/hyperliquid.md` (átfedi `math/14-hl-directional.md`)
- `app/done/weather-patch.md` (átfedi CHANGELOG-2026-04-21)
- `app/done/roadmap.md` (Sprint 1 status, elavult)
- `migration/README_2.md` (csak meta-olvasási sorrend, beépítve `roadmap/README.md`-be)

## Cross-reference frissítések

**`internal-docs/README.md`** — teljes újraírás. Index 5 mappára, minden
fájl egysoros leírással.

**`CLAUDE.md`** — irányadó hivatkozások javítva (a session-history
bejegyzéseket nem nyúltam):
- "Mappaszerkezet" block (L56) — bemutatja az 5 új almappát
- "KÖTELEZŐ SESSION-ZÁRÓ SZABÁLY" 2. és 4. pont — `current-state/` /
  `math/` / `roadmap/` szétbontás
- "Új tab hozzáadása" 6. pont — `math/NN-new-panel.md` path
- 14-15. session env-vars hivatkozás → `current-state/env-vars.md`
- 26. session "B (külön MD)" → `roadmap/hetzner-migration.md`

**Belső roadmap cross-ref-ek** (7 sibling-link javítva):
- `roadmap/hetzner-migration.md` → `migration-strangler-fig.md` /
  `hetzner-infrastructure.md` / `risk-coordinator-considerations.md` /
  `new-strategies.md` / `../archive/grabit-vps-setup.md`
- `roadmap/master-plan.md` → új env-vars path + relative `../current-state/` /
  `../math/` / `../changelog/` linkek
- `roadmap/hetzner-infrastructure.md`, `roadmap/migration-strangler-fig.md`,
  `roadmap/new-strategies.md`, `roadmap/risk-coordinator-considerations.md`
  → új sibling-fájlnevekre

**`math/13-crypto-bot.md`** — `app/architecture.md` →
`current-state/architecture.md`, `app/paper-pnl-analysis.md` →
`archive/paper-pnl-v2-bug.md`.

**`changelog/`** fájlokat **nem** módosítottam — történelem-marker.

## Üres mappák törlése

`app/done/`, `app/`, `migration/reference/`, `migration/`, `math/weather/`
mind eltávolítva (üresek lettek a mozgatások után).

## Verifikáció

- `git status`: 13 modified file, 2 új untracked (`roadmap/README.md`,
  `archive/matekmegoldasok-content-roadmap.md`).
- Grep verifikáció: nincs maradék `internal-docs/(app|migration)/`
  hivatkozás a non-changelog fájlokban.
- TypeScript / build NEM futott (csak markdown, kód érintetlen).

## Hova nyúlj legközelebb

- Új doksi írásakor a megfelelő szemantikus mappába tedd (current-state
  / math / roadmap / archive). A flat root már nem támogatott.
- Az `archive/`-ban lévő doksikat NE editáld in-place — történelmi
  forrás. Ha új tanulság van, az `current-state/` vagy `math/` alá kerül.
- Egy új CLAUDE.md "Mappaszerkezet" block tükrözi az 5 mappát — új
  almappa hozzáadásakor frissíteni kell.

---

# 2026-05-11 (a) — Crypto Reconcile + per-position Gamma diagnostic

## A user észrevett bug

A /trade/crypto/ oldalon 1 pending paper position past endDate maradt
"awaiting Polymarket resolution"-nel, és nem volt világos, miért nem
záródik automatikusan.

## A valódi viselkedés

Polymarket BTC up/down piacai **UMA-n keresztül** rendeződnek:

1. Market endDate-je megtörténik.
2. UMA proposer beadja a kimenetet (~minutes–1h).
3. 2 órás dispute window.
4. UMA finalizálja → Gamma `closed=true` + `outcomePrices` ∈ {0,1}
   + `umaResolutionStatus="resolved"`.

Tehát **5min–4h közötti várakozás teljesen normális**. A paper-resolver
minden 3 percben próbálkozik, és automatikusan zár amint a 3 feltétel
együtt teljesül. Az előző commit-ban az UMA finality gate-et hozzáadtuk:
closed=true egyedül nem elég — a resolver explicit várja a `resolved`-et,
nem fogad el `proposed` / `disputed` / `challenged` / `settled_pending`
állapotot (fake-win védelem).

## Fix — diagnosztika gomb

A felhasználó **nem látta**, hogy melyik konkrét gate blokkol. Most:

### `crypto/paper-resolver.mts`

Új `diagnosePendingPositions(positions[])` async helper. Per-position
Gamma probe, NEM mutálja a session-t. Visszaad egy `PendingDiagnostic[]`
listát:

```typescript
interface PendingDiagnostic {
  market: string;
  conditionId: string | null;
  ageMin: number;
  gamma: {
    found: boolean;
    closed: boolean | null;
    outcomePrices: number[] | null;
    umaResolutionStatus: string | null;
  } | null;
  verdict: string;       // emberbarát szöveg
  shouldClose: boolean;  // resolver-nek zárnia kéne, de még nem futott
}
```

Verdict szövegek minden esetre:
- "Missing conditionId" → legacy pozíció, reset kell
- "Gamma returned no market" → conditionId stale/wrong vagy closed=true még nem flippelt
- "UMA <state>" → dispute/voting window — várj
- "Closed=true és UMA final de op nem binary" → ritka 50/50 dispute
- "Resolved on Gamma" → resolver következő tickkor zár

### `auto-trader/index.mts`

Új `handleCryptoReconcile(config)` — `case "reconcile"` mostantól crypto-ra
is működik (eddig weather-only volt). Két lépés:

1. `resolvePendingPaperPositions(session)` — bárkit, akit lehet, zár.
2. A maradék pending-eket `diagnosePendingPositions`-szel ellenőrzi.

Visszaad: `{ resolved: [...], stillPending: [...], session }`.

### `CryptoTrader.tsx`

- Új "⟳ Reconcile pending" gomb a controls-ban — csak akkor látszik, ha
  `pendingCount > 0`. Pattern szimmetrikus a Weather Reconcile gombbal.
- Új `ReconcileResult` típus + új `display.action === "reconciled"` ág a
  render-ben. Külön kártya "Reconcile result" header-rel, a zárt
  pozíciók zöld sorral + PnL-lel, a maradék pending-ek a Gamma chip-
  ekkel: `age 8min`, `closed: true`, `op: [0.50, 0.50]`, `uma: proposed`,
  + emberbarát verdict.
- A meglévő pending card footnote frissítve: pontos UMA timeline (5min–4h)
  + utalás a Reconcile gombra.

## Hatás deploy után

A felhasználó most:
1. Látja a pending card-on, hogy `expired Xm ago · UMA settlement window`
   (a `getCryptoPendingPositions`-ben már korábban hozzáadott waitReason).
2. Klikkel a `⟳ Reconcile pending` gombra → friss Gamma query per
   conditionId → új kártya mutatja a konkrét állapotot:
   - `closed: false` → market még nyitva (extreme edge case, restart?)
   - `closed: true, uma: proposed` → 2h dispute window
   - `closed: true, uma: resolved, op: [1, 0]` → következő cron tick zárja
   - `no conditionId` → legacy, reset kell

## A user pending pozíciója nagy valószínűséggel

Egy normális UMA dispute window-ban van (closed=true, uma=proposed).
A reconcile gomb klikkelése megmutatja a pontos állapotot. Ha 4+ óra
múlva sem záródik, az dispute eset (manual review).

`tsc --noEmit` exit 0 (project files), Astro build 9 page generated.

# 2026-05-11 (b) — Reconcile "Unknown error" fix (Netlify 10s timeout)

## A user észrevett bug

A /trade/crypto/ oldalon a "⟳ Reconcile pending" gombra "Unknown error"
jelent meg. A backend nem dobott látható error message-et, és a frontend
fallback szöveget mutatott.

## Root cause

`handleCryptoReconcile` két lépésben futott:

1. `resolvePendingPaperPositions(session)` — minden past-endDate pozícióra
   1 Gamma fetch (~5-8s timeout-tal).
2. `diagnosePendingPositions(stillPending)` — UJABB 1 Gamma fetch ugyanazon
   pozíciónként.

N pending pozíció = **2N Gamma fetch szekvenciálisan**, kb. N × 10-16s
wall-clock. Egyetlen pending pozíción a függvény ~10s körüli volt, és a
**Netlify default function timeout 10s** alatt megszakadt. A frontend
`res.json()` üres body-ra hibát dobott vagy `data` undefined volt, így
a useTraderAction fallback `data.error || "Unknown error"`-ra esett.

## Fix — single-pass refactor

### `crypto/paper-resolver.mts`

`resolvePendingPositions` mostantól **egyetlen Gamma fetch-et csinál per
pozíció**, és visszaadja a teljes diagnosztikai listát is:

```typescript
return {
  session: updated,
  resolutions: ResolutionRecord[],
  pendingDiagnostics: PendingDiagnostic[],  // ÚJ
};
```

A `PendingDiagnostic` típus a Gamma probe eredményét hordozza: closed,
outcomePrices, umaResolutionStatus, ageMin, plain-language verdict.
A `parseResolution` és `buildDiagnostic` segéd-fv-ek dolgozzák fel a
nyers Gamma raw-t.

Régi `diagnosePendingPositions` standalone függvény **törölve** — fölösleges
volt.

### `auto-trader/index.mts`

`handleCryptoReconcile` egyszerűsített:

```typescript
const r = await resolvePendingPaperPositions(session);
if (r.resolutions.length > 0) await saveSession(r.session);
return jsonResponse({
  ok: true, action: "reconciled",
  resolved: r.resolutions,
  stillPending: r.pendingDiagnostics,  // már megvan, nem kell újabb fetch
  session: sessionSummary(r.session),
});
```

Wall-clock most ~N × 5s (a 8s Gamma timeout-on belül). Egy pending pozíción
~2s, 5 pending-en ~10s — biztonságos a 10s budget alatt.

## Védő fix: outer catch fallback

`auto-trader/index.mts` top-level catch most graceful-en kezeli az üres
`err.message`-t:

```typescript
const errMsg = (err && (err.message || err.toString?.() || String(err))) || "internal error";
```

Eddig ha valamit `throw undefined`-dal vagy primitív-vel dobott, az error
message üres volt → frontend "Unknown error" fallback. Most legalább
"internal error" jelenik meg, és az `alertError` is `.catch(() => {})`
wrap-pelve, hogy a Telegram alert hibája ne maszkolja a tényleges hibát.

## Hatás deploy után

- A "⟳ Reconcile pending" gomb most ~2-3s alatt válaszol (1 pending).
- Az új "Reconcile result" kártya megjelenik a Gamma chip-ekkel:
  `closed: true`, `op: [0.50, 0.50]`, `uma: proposed`, + emberbarát
  verdict.
- Ha mégis hiba történne (Gamma API kiesés, stb.), az error pontos
  message-szel jelenik meg, nem generic "Unknown error".

`tsc --noEmit` exit 0 (project files), Astro build 9 page generated.

---

# 2026-05-11 (d) — Crypto bot decision-engine audit: 6 fix (9 → 12 gate, $1 floor kivétel, combiner recommendation gate, paper fee parity)

## A user kérése

"A crypto botot auditáld helyes trade működésre! Minden trade funkciót
elemezz, hogy megfelelően működik-e, ellenőrizd a production oldalon,
hogy a nyitott két pozíció indokolt volt-e és rendben működik a bot."

## Audit eredmény

A live `mj-trading.netlify.app/trade/crypto/` 3 nyitott paper pozíciót
(2 aktív + 1 settlement-re vár) cross-reference-eltem a Gamma API +
signal-combiner válaszával:

| Pozíció | dir | size | entry | predProb | mktPrice | grossEdge | kellyRaw |
|---|---|---|---|---|---|---|---|
| bitcoin-above-82k-on-may-11 | YES | $1 | 0.27 | 0.505 | 0.255 | 25.0% | 0.03% |
| bitcoin-up-or-down-on-may-11-2026 | YES | $1 | 0.32 | 0.5058 | 0.305 | 20.1% | 0.03% |

A signal-combiner ugyanazon slug-ra most **`recommendation.action = "WAIT"`**,
`trade_recommended = false`, `kelly.quarter = 0`. A 3 pozíció **nem volt
indokolt** — a 9-gates rendszer kihagyott 3 védőréteget:

1. Combiner saját `recommendation` ignorálva — a trader sose nézte.
2. Combiner `|p − 0.5| < 5%` (zaj-detekció) ignorálva — gate hiányzott.
3. Resolution-risk `trade_recommended = false` veto ignorálva.

És a `Math.max(1, bankroll * kellyCapped)` $1 hard floor 13× over-sized
minden trade-et (0.03% Kelly × $250 = $0.075 javasolt → $1 ténylegesen).

## 6 fix implementálva

| # | Fájl | Patch | Cél |
|---|------|-------|-----|
| **1** | `decision-engine.mts` | `Math.max(1, ...)` floor kiszedés. Új gate #11 "Kelly méret ≥ minimum" explicit pass/fail kontrollal. `MIN_POSITION_SIZE_USDC` env + Settings knob (default $0.50). | Méret-floor bypass kiszedés |
| **2** | `signal-aggregator.mts` | `AggregatedSignal` 3 új mező: `combinerRecommendation`, `tradeRecommendedByRisk`, `adjustedProbability`. | Combiner ajánlás átemelése |
| **3** | `decision-engine.mts` | Új gate #4 "Combiner recommendation" — pass csak ha `recAction.startsWith("BUY")`. | Combiner saját WAIT/WATCH/SKIP átemelése |
| **4** | `decision-engine.mts` | Új gate #3 "Combiner confidence (\|p − 0.5\|)" — küszöb default 5%, env-tunable `COMBINER_CONFIDENCE_MIN`. | Zaj/jel megkülönböztetés |
| **5** | `decision-engine.mts` | Új gate #5 "Resolution-risk gate" — pass csak ha `tradeRecommendedByRisk !== false`. `null` = helper nem futott → defensive pass. | Resolution-risk veto |
| **6** | `paper-resolver.mts` | `applySettlementFee(pnlGross, proceeds, costBasis, feePct)` helper. Fee = `max(proceeds, costBasis) × 0.036`. `PAPER_RESOLVED` log entry `pnlGross + pnlNet + feePct` mind kiír. | Paper PnL = live PnL parity |

### Plusz infrastruktúra

- `types.mts:TraderConfig` 2 új mező: `minPositionSizeUSDC`, `combinerConfidenceMin`.
- `types.mts:AggregatedSignal` 3 új optional mező (lásd fix #2).
- `config.mts:getTraderConfig` + `getEffectiveTraderConfig` az új mezőkkel.
- `trader-settings.mts:SCHEMA` 2 új field: `minPositionSizeUSDC`, `combinerConfidenceMin` — runtime override-olható.
- `auto-trader/index.mts:traderConfigSummary` exposes az új mezőket a UI-nak.
- `CRYPTO_GATE_LABELS` 9 → 12 elem. A régi "Kelly conviction (combiner > 0)" gate kikerült (a "Kelly méret ≥ minimum" funkcionálisan ekvivalens).

### Mit NEM csináltam

- **simVersion NEM bump-olva**. A 3 nyitott paper pozíció settle-el a saját
  endDate-én (2026-05-11 16:00Z). Fee modell változás ezeken a pozíciókon
  is alkalmazódik close-kor ($1 × 3.6% = $0.036 levonás per trade,
  negligible).
- **A meglévő open-ek nem törlődtek.** A fixek pure forward-looking módon
  hatnak — a jövőbeli scan-tick-eken a 3 új gate fogja elkapni a
  combiner-noise alapú trade-eket.

## Új gate-sorrend a "Why?" panelen (12 gate)

1. Session loss limit
2. Aktív signal források (≥2)
3. **Combiner confidence (|p − 0.5|)** ✦ ÚJ
4. **Combiner recommendation === BUY** ✦ ÚJ
5. **Resolution-risk gate** ✦ ÚJ
6. Market cooldown
7. Open interest ≥ küszöb
8. Entry window (BTC short markets)
9. OB imbalance konvergencia
10. Net edge ≥ küszöb
11. **Kelly méret ≥ minimum** ✦ ÚJ (replaces "Kelly conviction")
12. Kelly méret ≤ cap

## Live mode emlékeztető (új knob hatása)

- Polymarket CLOB minimum order size **$5 USDC**.
- Default `minPositionSizeUSDC = 0.50` csak paper módra optimális.
- Live módra váltás előtt a Settings tabon **$5.00-ra (vagy magasabbra)
  emelni kell** a knob-ot, különben a CLOB visszadob minden $5 alatti
  orderet.
- A `live-readiness` gate továbbra is védi a tényleges live-átállást
  (30 trade, IC ≥ 5%, Sharpe ≥ 0.5, drawdown < 25%).

## Hatás deploy után

Következő cron tick (3 perc múlva):
- A scanner most a 3 új gate-en megáll, ha a combiner WAIT/WATCH/SKIP-et ad.
- A meglévő 3 open pozíció endDate-en (16:00Z) settle-el, $0.036 fee
  levonással per trade.
- Nem nyílnak új $1 paper trade-ek noise-level signal mellett.
- A `Calibration Health` badge most érdemi IC-t fog mérni, mert a fee
  parity miatt a paper PnL realisztikusabb.

`tsc --noEmit` exit 0 (project files), Astro build 9 page generated.
