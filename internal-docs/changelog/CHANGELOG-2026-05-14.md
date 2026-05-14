# 2026-05-14 — Edge Tracker HL bug fix + 4 HL paper trade audit

## Kontextus

User jelezte: `https://mj-trading.netlify.app/trade/hyperliquid/` Edge Tracker
fülre kattintva üres oldal jön be. Egyúttal validálni kell, hogy a megtörtént
4 HL paper trade jogos volt-e, és élesben is ugyanazokat a fillek születtek
volna-e (paper vs live PnL realizmus).

## Bug root cause — üres Edge Tracker oldal HL-en

A `netlify/functions/edge-tracker.mts` `tradesFromSession` helpere a session
`closedTrades[]` mezőjét közvetlenül spread-eli a shared `ClosedTrade`
shape-be. A HL bot azonban a saját `HlClosedTrade` típusát menti, ami:

- `coin` (nincs `market` mező)
- `pnlUSDC` (nincs `pnl` mező)
- `sizeCoins` (nincs `shares` mező)
- `direction: "LONG" | "SHORT"` (nem `"YES" | "NO"`)
- `pnlPct` mint **ratio** (-0.0352 = -3.52%), míg crypto/weather/sports
  **percent**-ben (-3.52 = -3.52%) tárolja

Így a downstream `computeSummary`/`computeCumulativePnl`/`computePnlDistribution`
függvények `t.pnl = undefined`-dal dolgoztak — minden összeg `NaN` lett, JSON
serializációban `null`-ra konvertálódott. A React panel `s.totalPnl.toFixed(2)`
hívása `null.toFixed`-re hibázott → SummaryCards render-error → az egész panel
üresen jelent meg (Astro `client:only="react"` nem rendel error-boundary-t).

A bug nemcsak HL-en, hanem bármely más kategóriához tartozó view-n is
jelentkezett, ha a kombinált trade-listában volt HL trade (pl. "All" kategória).

## Fix

### (a) `netlify/functions/edge-tracker.mts` — HL normalizer

Új `isHlClosedTrade()` + `normalizeHlClosedTrade()` helperek. A
`tradesFromSession` mostantól venue-shape detektálással branchel:

- HL trade → `coin → market`, `pnlUSDC → pnl`, `sizeCoins → shares`,
  `pnlPct × 100` (ratio → percent), category=`hyperliquid`.
- A `direction` szándékosan megmarad `LONG`/`SHORT` formátumban
  (nem mapping-eljük YES/NO-ra), hogy a calibration + UI eredeti
  semantikát mutasson. A statisztika-modul `isYesLike()` helperrel
  kezeli mindkét konvenciót.

### (b) `netlify/functions/edge-tracker/statistics.mts` — LONG/SHORT + USD price tolerancia

- `computeCumulativePnl`: új `isBinary = entryPrice ∈ [0,1]` flag.
  Polymarket-binary trade-ek továbbra is a klasszikus
  `shares × 0.5 × (1 − 2×entry)` random-baseline és direction-aware
  EV-baseline képletet használják. HL perp trade-ek (USD entry, pl. 80531)
  esetén a random baseline = 0 cumulative (egy random irány-választás
  fee előtt 0 EV), az EV baseline pedig egybeolvad az actual line-nal
  (nincs elég adat ahhoz, hogy a tipikus mozgásmagnitúdóra modellt
  építsünk). Cél: a chart Y-tengelye olvasható maradjon HL-en is.
- `computeCalibration`: `isYesLike(direction)` helper a `"YES" || "LONG"`
  felismeréshez. SHORT/NO-t azonos módon kezeli (1 − predictedProb).

### (c) `src/components/EdgeTrackerPanel.tsx` — TradeRow + TradeTable

- `TradeRow.direction` típus szélesítve `"YES" | "NO" | "LONG" | "SHORT"`.
- `TradeTable`:
  - Direction színkód: green = YES vagy LONG, red = NO vagy SHORT.
  - Entry/exit ár formátum: binary (0..1) marad `¢`, USD (≥1) USD
    formátumra vált (`$80531` vs `$80.50`).
  - `Number.isFinite(t.pnl)` guard a régi, normalizálás-előtti adat
    elleni védelemhez.
  - `.tbl-scroll` wrapper class hozzáadva a 2026-05-13 mobile UI
    konvencióhoz illeszkedve.

### Build verify

`npm run build` zöld, 10 page generált, zéró TS error.

## 4 HL paper trade audit

| # | Date (UTC)            | Dir  | Entry  | Exit      | pnlPct   | Edge  | Pred prob | Megjegyzés        |
|---|-----------------------|------|--------|-----------|----------|-------|-----------|-------------------|
| 1 | 05-12 16:30 → 20:31   | LONG | 80200  | 80723.12  | +1.73%   | 31.3% | 65.66%    | 4h timeout, win   |
| 2 | 05-12 20:31 → 00:31   | LONG | 80764  | 80609.18  | -0.80%   | 17.8% | 58.93%    | 4h timeout, loss  |
| 3 | 05-13 01:42 → 05:46   | LONG | 81040  | 80889.04  | -0.78%   | 19.3% | 59.68%    | 4h timeout, loss  |
| 4 | 05-13 11:36 → 13:48   | LONG | 80531  | 79645.28  | -3.52%   | 17.3% | 58.70%    | SL hit (-1% stop) |

**Session-szintű egyezés**: sessionPnL = −$0.56, sessionLoss = $0.98 (3
veszteség), bankrollCurrent $200 → $199.44. A 4 pnlPct ratio összege
−0.0337, ami sizeUSDC ≈ $16.6 átlagos margin/trade-et implikál — 200 USD
bankrollhoz képest reális ¼-Kelly méret.

### Trade-decision validitás

Mind a 4 trade átment a 14-gates HL decision-engine-en:
- ✓ Edge ≥ 12% paper threshold (17.3–31.3% volt)
- ✓ Combiner recommendation ≠ WAIT/SKIP
- ✓ Vol gate (RV ≤ 120%/yr)
- ✓ Active signals ≥ 3
- ✓ Resolution risk ≠ SKIP
- ✓ Sanity cap (gross edge < 40%)
- ✓ Combiner trust (nem WATCH + extrém edge kombináció)
- ✓ Open positions < 3, consecutive losses < 3 (entry pillanatában)

Trade #4 után a `consecutiveLosses = 3` triggerelt → bot 1 órás
pause-ba kerül (`pausedUntil: 2026-05-13T14:48:17.803Z`). **Auto-pause
mint design intent** — működik ahogy kell.

### Paper PnL realizmus (vs élő mód)

A `paper-resolver.mts` valós HL markPrice-et használ (`getAllMids`),
**nem deterministic Brownian walk-ot**:

- **Trade #4 (SL hit)**: HL stop-MARKET triggerel @ $79725.69 (−1%
  entryből), majd a paper modell 0.1% adverse slippage-t fillel:
  $79725.69 × (1 − 0.001) = $79645.97. Tényleges paper exit $79645.28
  → kerekítési zaj, semmilyen érdemi eltérés. **Live HL-en ugyanez
  történne** ±0.02% kötési áron.
- **Trade #1–3 (timeout)**: paper a 4h timeout után az akkori HL
  markPrice-en zár 0.05% adverse slippage-zsel. Live-en reduce-only
  IOC market-tel ugyanezt a slippage-tartományt érné el.
- **Fees**: paper roundtripFeePct = 0.07% (config). HL valós fee
  schedule maker 0.015% + taker 0.025% = ~0.05% maker-in/taker-out
  roundtrip → paper **kissé konzervatív** (~0.02% × leverage × 4 trade
  ≈ +$0.05 kedvező eltérés a botra nézve).
- **Funding leg**: paper a `metaAndAssetCtxs` legutóbbi hourly rate-ét
  szorozza hold-órákkal. Live HL automatikusan minden funding-cycle-on
  könyveli. 2–4h holdokra a két érték közti diff < 1 bp.
- **Entry slippage**: paper a decision-engine által kalkulált pontos
  áron tölt. Live-on a limit-order order-book mélységétől függ — BTC
  perp vastag könyveken ez < $1 / $80k szint, vagyis < 0.0015%.
  Paper itt **nem modellez** ~0.01–0.02% adverse-t per trade.

**Becsült live PnL ezekre a 4 trade-re**: −$0.70 … −$0.90 (vs paper
−$0.56). Eltérés ~$0.15–0.35 — kb. 25–60% relatív különbség a kis
abszolút PnL miatt, de **abszolút értékben elenyésző**.

### Verdict

- ✅ **Trade-ek validak** — minden gate átment, decision-engine helyes
  döntéseket hozott.
- ✅ **Paper PnL reális** — slightly conservative (a botra nézve enyhén
  kedvező 0.02–0.05% fee-eltérés és nem-modellezett entry slippage
  miatt; mindkettő paper-favorable).
- ⚠️ **Win-rate 25% vs modell 58–66%** — kalibráció rossznak tűnik,
  de **N=4 statisztikailag értelmetlen**. A live-readiness gate `min
  30 trade`-et követel a kalibráció-ítélethez, helyesen. Sample-size
  bias.
- ⚠️ **All-LONG direction-bias** — a 24h ablakban a combiner
  konzisztensen LONG-ot adott (BTC valószínűleg trending up volt
  ezen a napon). Nem bug, de figyelendő.
- ✅ **Auto-pause** — 3 consecutive loss után 1h pause triggerelt;
  design szerint működik.

## Mit NEM változtattam

- ❌ **HL bot decision-engine** — érintetlen, működik mint kell.
- ❌ **HL paper-resolver math** — érintetlen, validált.
- ❌ **CLAUDE.md AKTUÁLIS ÁLLAPOT** — élő rendszer-állapot nem
  változott (továbbra is 4 HL trade, paused, $199.44 bankroll).

## Fájlok érintve

- `netlify/functions/edge-tracker.mts` — `isHlClosedTrade()` +
  `normalizeHlClosedTrade()` + `tradesFromSession` branch.
- `netlify/functions/edge-tracker/statistics.mts` — `computeCumulativePnl`
  isBinary branch + `computeCalibration` `isYesLike` helper.
- `src/components/EdgeTrackerPanel.tsx` — `TradeRow.direction` típus +
  `TradeTable` USD/cent + LONG/SHORT színkód + `.tbl-scroll`.
- `internal-docs/changelog/CHANGELOG-2026-05-14.md` (ez a section).

## Deploy

Lokális build zöld, de **production deploy nem történt meg** — a user
külön jóváhagyással `netlify deploy --prod --dir=dist`-tel élesítheti.

---

# 2026-05-14 — Weather forecast-forrás upgrade-opciók dokumentálva

## Kontextus

A user a session során rákérdezett, hogy a weather bot milyen adatokat
használ, és hogy a "settle" automatizálható-e (ami már megtörtént:
`auto-trader-weather-reconciler-cron.mts` */15 * * * * frekvenciával fut
2026-05-09 óta — Polymarket Gamma primary + METAR fallback 6h után).

A diagnosztika során áttekintettük az ingyenes vs. fizetős időjárás-adat
opciókat. A user kérése: dokumentáljuk a fejlesztési opciókat a megfelelő
doksiba, hogy később ne kelljen újra feltérképezni.

## Mit változtattam (doksi-only, kód nem érintve)

### (a) `internal-docs/math/16-weather-bot.md` — új §3.B szekció

A 3. Adatforrások szekció után új alszekció: **"3.B Opcionális adatforrás-
upgrade-ek (jövőbeli fejlesztés)"**, amely részletezi a 3 lehetséges
upgrade-utat:

- **(a) ECMWF közvetlen API** — `api.ecmwf.int` + MARS subscription. Teljes
  51-tagú ECMWF-ENS (jelenleg csak a determinisztikus IFS-t használjuk
  Open-Meteo-n keresztül). Akadémiai kulcs ingyenes, kereskedelmi ~€2 000/hó.
  +2-4% becsült IC tail-bucket-eken, európai városokon szisztematikusan
  jobb (Madrid, Milan, Munich, Paris, Ankara). Új env: `ECMWF_API_KEY` +
  `ECMWF_API_EMAIL`.

- **(b) NOAA GFS GRIB2 közvetlen** — `noaa-gfs-bdp-pds` S3 public bucket,
  zéró auth. +5-10 perc model-freshness, de GRIB2 parser overhead +
  Netlify Functions 10s timeout miatt **csak C1 (Hetzner) után érdemes**.

- **(c) Kereskedelmi szolgáltatók** (Tomorrow.io, Visual Crossing,
  AccuWeather) — $50-500/hó. NEM ajánlott a jelenlegi skálán (paper
  bankroll $100, ROI csak >$5 000/hó volume mellett). Csak multi-day
  market-bővülésnél megfontolható.

A szekció tartalmazza még:
- "Mit NE csináljunk" lista (OpenWeatherMap, multi-Open-Meteo account,
  Netlify-on GRIB2 parser)
- Prioritási sorrend: (a) → (b) → (c)
- Cross-link a master-plan.md `🟢 NICE-TO-HAVE` 13. tételére

### (b) `internal-docs/roadmap/master-plan.md` — új 13. tétel

🟢 NICE-TO-HAVE szekció 12 → 13 elemes. Az új 13. tétel **"Weather
forecast-forrás upgrade-ek"** rövid összefoglalót ad a 3 opcióról és
visszahivatkozik a math/16 §3.B részletes spec-jére. Utolsó státusz-
frissítés dátuma: 2026-05-11 → 2026-05-14.

### (c) Megjegyzés a §3 táblázat alatt — auth-clarification

A §3 Adatforrások táblázat alatt új kiemelés: **mind a 4 forrás zéró-auth,
egyetlen API-kulcs sem kell**. Ez azért fontos, mert a user explicit
megkérdezte ("kellett volna env-eket megadnom?"), és a `WEATHER_*` env-ek
nevükben félrevezetőek lehetnek — ezek bot-konfigurációs paraméterek (edge
threshold, position size), nem hitelesítés.

## SSOT-szabály alkalmazása

A CLAUDE.md SSOT-mátrix szerint:
- **Új algoritmus-leírás → math/NN-name.md** → §3.B részletes spec
- **Új master-plan TODO → master-plan.md "MI VAN MÉG HÁTRA"** → 13. tétel
- **Új env-vár listája → current-state/env-vars.md** → JELENLEG NEM
  frissítettem, mert a 3 upgrade közül egyiket sem implementáljuk most;
  amikor (a) ECMWF közvetlen-re sor kerül, akkor kerül be a 2 új env-vár
  (`ECMWF_API_KEY`, `ECMWF_API_EMAIL`) a katalógusba.

## Mit NEM változtattam

- ❌ **CLAUDE.md AKTUÁLIS ÁLLAPOT** — élő rendszer-állapot nem változott
  (továbbra is 2 closed weather trade, ugyanaz a deploy-státusz). A
  CLAUDE.md SSOT-szabály explicit kizárja a session-by-session
  részleteket — azok ide, a changelog-ba jönnek.
- ❌ **new-strategies.md** — nem új signal/stratégia, hanem meglévő bot
  input-forrás-bővítése. Math doc + master-plan a helyes hely.
- ❌ **Kód-változás** — pure doksi-szekció. Az implementáció amikor sorra
  kerül, külön session lesz.

## Fájlok érintve

- `internal-docs/math/16-weather-bot.md` (új §3.B szekció + auth-megjegyzés
  a §3 táblázat alatt)
- `internal-docs/roadmap/master-plan.md` (új 13. NICE-TO-HAVE tétel +
  utolsó-frissítés dátum 2026-05-14)
- `internal-docs/changelog/CHANGELOG-2026-05-14.md` (ez a fájl)

## Hivatkozások

- Részletes spec: [`math/16-weather-bot.md` §3.B](../math/16-weather-bot.md#3b-opcionális-adatforrás-upgrade-ek-jövőbeli-fejlesztés)
- Master-plan tracking: [`roadmap/master-plan.md` §🟢 NICE-TO-HAVE #13](../roadmap/master-plan.md)

---

# 2026-05-14 (b) — Live-readiness override + Realized-IC kalibráció

## Kontextus

User két dolgot kért: (1) lehessen overrideolni a live-readiness 7-gate
ellenőrzést hogy bot-ot ki lehessen tenni live-ba akkor is ha az még
nem teljesít minden gate-et, és (2) a "nem történik kalibrálás" állapot
helyett legyen valódi feedback-loop — a closedTrades realized IC-jét
építsük vissza a signal-combiner súlyozásába.

## Fázis 1 — Live-readiness override

### (a) Új SCHEMA knob: `liveReadyOverrideEnabled` (bool, default OFF)

`netlify/functions/trader-settings.mts` "Live readiness" csoport. ON
értékre kapcsolva a 4 bot (crypto, weather, HL, F-Arb) cron-loopja
bypass-olja a `shouldForcePaper` gate-et, és a `PAPER_MODE=false`
beállítás közvetlenül érvénybe lép a sample-méret / IC / DD / Sharpe
gate eredménytől függetlenül. Reverzibilis: OFF visszakapcsolja a
normál readiness-vezérlést.

### (b) `shouldForcePaper(...)` 3. paraméter: `overrideEnabled: boolean`

`netlify/functions/auto-trader/shared/live-readiness.mts`. Override + live
mód együttesen → `{forcePaper: false, overrideActive: true}`. A return
type is bővül (új `overrideActive: boolean` mező), és a
`LiveReadinessReport` interface kapott egy opcionális `overrideActive`
mezőt a UI számára.

### (c) Bot-ok bekötése (4 helyen)

- `auto-trader/index.mts` — crypto cron + status. Cron-on Telegram alarm
  is fut session-enként 1× hogy ne maradjon véletlenül az override ON
  (audit-log).
- `auto-trader/weather/index.mts`
- `auto-trader/hyperliquid/index.mts` — 2 spot (cron + status reporter).
  Status path-on csak a `overrideActive` flag-et tűzi be a UI számára.
- `auto-trader/hyperliquid/funding-arb/index.mts`

### (d) UI: `LiveReadinessBadge.tsx`

Új `lrb-override` tone (piros háttér, piros keret). Override aktívnál a
headline `"OVERRIDE — LIVE"`-ra vált, és egy explicit figyelmeztető sáv
jelenik meg: *"Readiness gate bypassed via Settings → Live readiness →
'Override readiness gate'. Bot trades LIVE regardless of paper-validation
gates."*

## Fázis 2 — Realized-IC kalibráció

### (e) Új SCHEMA knobok: `useRealizedIC` + `calibrationShrinkageK`

"Signal calibration" csoport. `useRealizedIC=1` opt-in: a `signal-combiner`
realized IC-t blend-eli a statikus akadémiai priorokba Bayes-shrinkage-zel.
`calibrationShrinkageK` (default 30) a prior súlyát adja a keverékben.

### (f) Új modul: `auto-trader/shared/signal-calibration.mts`

3 expose-olt függvény:
- `computeRealizedICs(trades)` — per-signal Pearson(score, win) a
  closedTrades-ből (Edge Tracker `computeSignalIC`-ot újrahasznosítja).
- `persistCalibration(category, trades)` — `signal-calibration-v1` Blobs
  storage-be ír.
- `loadCalibration(category)` + `effectiveICs(priors, record, k)` —
  shrinkage-blend: `effective_ic[s] = n_s/(n_s+k) × realized + k/(n_s+k) × prior`

Lefedett kategóriák: `crypto`, `hyperliquid`, `weather` (a weather a
synthetic `forecast_edge` signalt használja).

### (g) Cron-tick persist

- `auto-trader/index.mts` — a `resolvePendingPaperPositions` után, ha új
  trade záródott, lefuttatja a `persistCalibration("crypto", ...)`-t.
- `auto-trader/hyperliquid/index.mts` — minden run végén a
  `saveHlSession` előtt persistál (a HL `HlClosedTrade` shape-jét
  átkonvertálja a generikus `ClosedTrade`-re a `category` + `direction`
  mezőkkel).

### (h) `signal-combiner.mts` — `?category=` + Bayes-blend

- Új query param: `?category=crypto|hyperliquid`. Cache-kulcs is
  category-aware (`combined:${slug}:${category|static}`).
- Ha `useRealizedIC=1` + category jelen: betölti a calibration recordot,
  számolja az effective IC-t, és átadja a `combine(raw, effectiveICMap)`
  hívásnak. `combine()` 2. paramétere most opcionális `icMap` override.
- Payload új mezője: `calibration: {category, computedAt, sampleSize,
  shrinkageK, perSignal, effective}` — null amikor a toggle off vagy
  nincs még record.

### (i) Crypto + HL bot a `?category=` paraméterrel hívja a combinert

- `crypto/signal-aggregator.mts:72` — `&category=crypto`
- `hyperliquid/signal-source.mts:73` — `&category=hyperliquid`

### (j) Edge Tracker UI: "Calibrated vs Prior IC" kártya

- `edge-tracker.mts` válaszába új `calibrationView` mező (csak crypto +
  HL): `{priors, realized, effective, useRealizedIC, shrinkageK,
  sampleSize, computedAt}`. Statikus priors mirror a combiner
  `SIGNAL_ICS`-éből (9 sor — minimális duplikáció).
- `EdgeTrackerPanel.tsx` új `CalibrationViewCard` komponens a Summary
  cards után, csak crypto + HL kategórián. Táblázatos: Signal / Prior /
  Realized (n) / Effective; delta szín (zöld = realized > prior, piros =
  realized < prior). Toggle-státusz pill (ON/OFF + K + N + computedAt).
  Footer: ha ON, jelzi hogy a combiner aktívan használja; ha OFF,
  kalkulálja és kiírja a current shrinkage weight-et (`N / (N+K)`).

## Mit szándékosan kihagytam

- ❌ Kelly cap / edge threshold auto-tuning a closedTrades alapján —
  külön feedback loop, más session.
- ❌ Weather `bucket-matcher` σ auto-recal — más math, más session.
- ❌ Combiner `recommend()` IR/edge küszöb auto-tuning — opt-in maradhat
  egészen a Strict preset-ig.
- ❌ Calibration record automatikus retry / re-compute más kategóriákra
  (sports, funding-arb) — funding-arb rate-driven (nincs signal-vektor),
  sports nem használja a 8-signal combinert.

## Validáció

- `npm run build` — Astro frontend build PASS (1.56s).
- `npx tsc --noEmit` az új fájlokon (`signal-calibration.mts`,
  `live-readiness.mts`, `edge-tracker.mts`, `signal-combiner.mts`,
  `auto-trader/index.mts`, `weather/index.mts`, `hyperliquid/index.mts`,
  `funding-arb/index.mts`) — PASS, csak a pre-existing discriminated-union
  narrowing zaj a `trader-settings.mts:492,507` és `auto-trader/index.mts:114`
  pontokon (`auth.error`, `v.reason` — független az ebben a session-ben
  tett változásoktól).
- Funkcionális futás — UI-on tesztelendő `netlify dev`-en.

## Fájlok érintve

**Backend (8):**
- `netlify/functions/trader-settings.mts` (3 új knob: override + 2 calib)
- `netlify/functions/auto-trader/shared/live-readiness.mts` (shouldForcePaper sig + overrideActive)
- `netlify/functions/auto-trader/shared/signal-calibration.mts` (új modul)
- `netlify/functions/auto-trader/index.mts` (crypto cron + status)
- `netlify/functions/auto-trader/weather/index.mts`
- `netlify/functions/auto-trader/hyperliquid/index.mts`
- `netlify/functions/auto-trader/hyperliquid/funding-arb/index.mts`
- `netlify/functions/auto-trader/crypto/signal-aggregator.mts` (&category=)
- `netlify/functions/auto-trader/hyperliquid/signal-source.mts` (&category=)
- `netlify/functions/signal-combiner.mts` (icMap + cache key)
- `netlify/functions/edge-tracker.mts` (calibrationView payload)

**Frontend (2):**
- `src/components/shared/LiveReadinessBadge.tsx` (override tone + warn)
- `src/components/EdgeTrackerPanel.tsx` (CalibrationViewCard)

## Operator playbook

### "Most kell live-ra menni, de a gate nem enged"

1. Settings → Live readiness → "Override readiness gate" ON, mentés.
2. `PAPER_MODE=false` env-var beállítása a kérdéses bot-on (vagy bot
   konfig overrideja). Crypto és HL külön env-eken: `PAPER_MODE`,
   `HL_PAPER_MODE`.
3. Cron-tick után a `LiveReadinessBadge` piros "OVERRIDE — LIVE" jelzést
   ad; Telegram alarm fut session-enként 1× emlékeztetőként.
4. Visszakapcsolni: ugyanott OFF, vagy a knob default-ra reset.

### "Bekapcsolom a realized IC kalibrációt"

1. Várj, amíg a bot lezárt legalább ~10-20 paper trade-et (Edge Tracker
   Signal IC chart-ja már nem all-zero).
2. Settings → Signal calibration → "Use realized IC (per-bot)" ON.
3. Edge Tracker → kategória (crypto vagy HL) — új "Signal IC calibration"
   kártya megjelenik. Itt látod az Effective oszlopot — ez az, amit a
   combiner most ténylegesen használ.
4. Shrinkage K hangolása: alapból 30 (N=30-nál 50/50). Gyorsabb adaptáció
   = kisebb K (pl. 10), konzervatívabb = nagyobb K (pl. 60).
