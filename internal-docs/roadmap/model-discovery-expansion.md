# Model Discovery — Rendszer-bővítés (execution / portfólió / új edge-források)

> **Típus:** research discovery — forrásolt survey + pontozott ajánlás, a [`model-discovery-forecasting.md`](./model-discovery-forecasting.md) **testvér-doksija**. Az a discovery a **predikciós/valószínűség-réteget** vizsgálta (kalibráció, vol, aggregáció → A-lépcső #1–#9 **implementálva**, B41). Ez a discovery a **maradék edge-t** keresi: **execution/fill-realizmus, portfólió-szintű kockázat, validációs szigor, új független signalok, és domén-specifikus átépítések.**
> **Dátum:** 2026-09-03 · **Scope:** mind az 5 élő bot + a shared infra + a nem-implementált pillérek (politics/macro) + egy potenciális **új üzletág (market making)**.
> **Módszer:** 1 read-only kód-katalógus-ágens (a teljes `services/worker/pillars` + `packages/core` + `services/api/routes` fa) + **8 párhuzamos webes kutató-ág** (primer források: arXiv, hivatalos exchange/API-docs, GitHub, peer-reviewed). Minden állítás a **kódra + a forrásra** verifikálva. Skeptikus alapállás: a hype-ot explicit megjelöltük.
> **Task-promóció:** a §6 tételei **jelöltek** — a `new-strategies.md` #N / `sprints.md` B-tételekbe csak operátor-jóváhagyás után kerülnek (SSOT-védelem). Tracker: **`sprints.md` B49**.

---

## 0. TL;DR — a discovery egyetlen mondatban

**A rendszer eddig signalokat halmozott, de a bizonyítékok szerint a maradék profit szinte teljesen három NEM-signal rétegben van: (1) execution/fill-realizmus [a paper-PnL hazudik a longshotokon], (2) a már megépített kalibrációs/validációs réteg élesítése + walk-forward, (3) portfólió-szintű crypto-béta koncentráció-kezelés.** Új signalból egyetlen tétel emelkedik ki (OI-Δ × ár). A domén-fixek (weather EMOS-kalibráció, sports Shin-de-vig) valósak de szűk plafonúak; az LLM-forecasting a likvid piacokon **csapda**; a prediction-market arbitrázsok (negRisk/Kalshi/settlement-sniping) **kis szereplőnek nem alfa**.

---

## 1. A központi újrakeretezés

A [`new-strategies.md`](./new-strategies.md) filozófiája helyes: *„az edge a független edge-források × kalibrált sizing × walk-forward validation szorzatából jön"*. A 8 kutatási ág **egybehangzó** üzenete viszont az, hogy a rendszer az **első** faktort (signalok száma) telítette, és a **másik két faktor** alul van építve:

| Réteg | Jelenlegi állapot (kódból) | A kutatás verdiktje |
|---|---|---|
| **Signalok** | 8-signal combiner + 5 default-off forecasting-add-on (log-odds, extremize, HAR-RV, first-passage, Deribit) | **Telített.** Egyetlen erős új, *korrelálatlan* signal maradt: **OI-Δ × ár** (§4.D). A többi új signal-ötlet redundáns vagy hype. |
| **Execution / fill** | Lapos 3,6% fee (PM), naiv perp-slippage; **dokumentáltan túl-jóváír a vékony longshot-könyveken** | **A #1 fix.** Két független ág (mikrostruktúra + backtest) egymástól függetlenül ugyanezt tette #1-re. **Amíg ez nem valós, minden downstream statisztika fikció.** (§4.A) |
| **Validáció** | Proper-scoring + Platt + AdaHedge **megvan, de MÉRÉS-only** (nincs live-re kötve); nincs walk-forward; a live-gate önkényes „N trade" | Élesíteni + **PSR/MinTRL/DSR** a valós track-recordon + **walk-forward scoring a prediction-ledgeren** (Hetzner-backtest-motor NÉLKÜL). (§4.B) |
| **Portfólió / kockázat** | **Nincs.** 6 külön bankroll, egyenként ¼-Kelly + 8% cap, egymásról mit sem tudva | **Strukturális lyuk:** crypto + HL-perp + F-arb **mind crypto-béta** → hat „független" 8%-os tét együtt egy nagy korrelált BTC-pozíció. A portfólió-réteg első dolga ezt elkapni. (§4.C) |

**Load-bearing tanulság:** a legnagyobb *várható-érték-javulás* nem egy új jelből, hanem a **hamis paper-PnL kiirtásából** és a **már megépített kalibráció élesítéséből** jön. Ezek részben *negatív* felfedezések (elvesznek illuzórikus edge-ek) — de pont ezért kritikusak: a rendszer jelenleg vak tétekre méretez.

---

## 2. Grounding — mi van MÁR megépítve (a duplikáció elkerülésére)

A kód-katalógus (monorepo: bots → `services/worker/src/pillars/*`, shared math → `packages/core/src/*`, tools+combiner → `services/api/src/routes/*`) pontos leltára:

- **Épített & ON:** 8-signal IC-súlyozott combiner; BS-digital K-aware vol; **B21 K-anchor** (threshold, ON); **realized-IC Bayes-blend** (`useRealizedIC` ON, crypto+HL); ¼-Kelly mindenhol (lokális újraszámolás; HL perp R/R-variáns B36 driftmentes baseline-nal + 3× lev-cap); cross-position monotonicity + outcome-overlap gate (mind); resolution-risk gate; weather adverse-selection shrink (0,5); longshot-floor (weather+sports, 0,05); paper-never-stop; **prediction ledger**; **proper-scoring + Platt + AdaHedge — DIAGNOSZTIKA**; coach-recommendations.
- **Épített de OFF (Settings-kapcsoló):** `combinerLogOddsStrength`, `combinerExtremizeStrength`, `useHarRv`, `useFirstPassage`, `useDeribitIV`, `sportsUsePinnacle` (odds-feed hiányzik), `weatherInvertDirection`, `icHalfLifeTrades`.
- **MÉRÉS-only (NINCS live sizingra kötve):** Platt-kalibráció, AdaHedge súlyok, proper-scoring. ← **nagy kar: élesíteni pozitív walk-forward gain után.**
- **NINCS megépítve:** politics + macro bot (üres stub `export {}`); portfólió-réteg (egyáltalán); Shin de-vig (csak multiplicative+power van); auto-redeem cron.

> Ezért ez a discovery **nem** javasol újra: log-odds/extremize/HAR-RV/first-passage/Deribit-RND (mind kész, csak méréstől-függő élesítés — az B41), sem az apex-v2/GARCH/HMM-tételeket (new-strategies #2/#8/#11 — meglévő katalógus).

---

## 3. Értékelési kritériumok (scoring)

`Priority = 3·Edge + 2·Effort + Confidence`, kemény kapukkal:

| Tengely | Skála |
|---|---|
| **Edge-impact** | mennyivel javítja a valós (nem paper) profitot / mennyi hamis edge-et irt ki (1–5) ×3 |
| **Effort** | fordított (5 = triviális … 1 = hetek) ×2 |
| **Infra** | `TS-now` (pure-math/fetch, `.mts`) / `Hetzner` (persistent WS / Python / live-exec) — **kapu** |
| **Licenc / adat** | permisszív + ingyenes / fizetős-de-olcsó / drága-vagy-blokkolt — **kapu** |
| **Confidence** | mennyire biztos a nyereség a mi piac-típusainkra (1–5) ×1 |

---

## 4. Kutatási találatok rétegenként

### A. Execution & fill-realizmus — **a #1 konvergens találat**

**Két független ág (Polymarket mikrostruktúra + backtest-szigor) egymástól függetlenül ezt tette az abszolút első helyre.** A jelenlegi paper-motor a tail-buckMSeteket (< 0,10) a kijelzett áron és teljes méretben tölti, de az élő könyv ezt nem nyeli el.

- **Empirikus alap:** a Polymarketen **fordított favorite-longshot bias** van (arXiv 2606.04217): az olcsó tokenek **túlárazottak** (0,00–0,10 bucket átlaghozam **−0,0023**, < 0,30 nyerési arány ~4%). A likviditás Gini 0,970 (a top 1% maker = a volumen 84%-a) → a kijelzett mélység 1-2 maker, aki adverse flow-ra visszahúz. Egy $12k order a long-tailen 5-10¢-et mozdít.
- **A fix (MED effort, a MÁR lekért adatból):** (1) **a valós L2-mélységet lépegetni** (VWAP-fill a touch helyett); (2) **participáció-cap** ~10-20% a látható méretre szintenként; (3) **részleges fill** könyvelése, a maradék eldobása (soha ne írd jóvá a nem-tölthetőt); (4) **√-law slippage-floor** (`I(Q)=Y·σ·√(Q/V)`) ha nincs snapshot; (5) **adverse-selection haircut** limit-fillekre (a gyors fill = rossz fill: market −0,72, sub-min limit −0,31); (6) **tick/min-size validitás-gate** (a < 0,04 áron a tick finomodik — a rácson kívüli fill érvénytelen).
- **Fontos aszimmetria:** a mélység-walk a **PM longshotokra** kritikus (a méret nagy a mélységhez képest); a √-law a **perpekre** (a méret kicsi, a költség kicsi-de-nem-nulla). Előbb a (1)+(2)+(3)+(6)-ot.
- **Skeptikus figyelmeztetés:** a tökéletes fill-modell sem teszi nyereségessé a < 0,10 longshotokat — azok strukturálisan veszítenek. **Az érték a HŰ PnL** → a rendszer abbahagyja a vak tétet egy vesztő bucketbe. Ez validálja a meglévő B24/B28 longshot-floort.
- **Skip:** DL LOB-szimulátorok, teljes queue-reactive sim, Almgren-Chriss ütemező (a méret túl kicsi — a √-law becslés elég; a nagy orderre HL/Bybit native TWAP).
- Források: arXiv 2606.04217, 2606.24019 (√-law), 2407.16527 (limit-fill drift), 2409.12721 (backtest-optimizmus); docs.polymarket.com/concepts/order-lifecycle.

### B. Validációs szigor — a mérés-only réteg élesítése + forward-native overfitting-védelem

A rendszer overfitting-kockázata **nem** a backtest-trial-ekben van (nincs backtest-motor), hanem a **knob-konfigurációk számában, amiket egyetlen növekvő forward-track-recordra próbáltunk** (a changelog tucatnyit mutat: weather-invert, useRealizedIC, downweight, Kelly-scale…). Ehhez **forward-native** eszközök kellenek:

- **PSR (Probabilistic Sharpe) + MinTRL** a valós track-recordon. A PSR fat-tail-tudatos → **helyesen bünteti** a „4 longshoton ülő" Sharpe-ot (a crypto +$690 patológia). A **MinTRL = a paper→live kapu** trade-ben kifejezve (fat-tailű longshot-botnál gyakran több száz trade — ez az őszinte válasz a „kész-e?"-re, az önkényes „50 trade" helyett). ~½ nap.
- **DSR (Deflated Sharpe) őszinte trial-számmal:** minden knob-váltást egy `trials` táblába logolni, `E[max SR_N]`-t számolni (`N_eff = 1+(1−ρ̄)(N−1)`). ~1 nap (plumbing). Ez a **helyes** korrekció arra, ahogy ténylegesen dolgozunk.
- **Walk-forward SCORING harness a prediction-ledgeren** (NEM param-optimizer → **nem kell Hetzner/backtest-motor**). Anchored, purged/embargoed **rezolúciós idő** szerint (egység = a predikció, nem az instrumentum → a ledgerem pont ez). A korrelált klasztereket purge-elni (azonos BTC strike-létra / azonos város temp-bucketek). Minden OOS-blokkot a **meglévő proper-scorral** pontozni. ~1-1,5 nap. **= a B11 principled, Hetzner-mentes verziója.**
- **Élesítés:** a Platt-kalibráció / AdaHedge / proper-scoring MÉRÉS-only → a `finalProb` live-kalibrálása a decision-engine-ben **csak elég adat + pozitív walk-forward gain után** (kötődik B34/B35/B36/B40).
- **Paper-vs-live reconciliation logger** (Perold Implementation Shortfall): live-flip után minden signalra a paper-fill vs valós-fill különbség tárolása → a mért slippage-gap. Csak live. ~1 nap.
- **Skip:** PBO/CSCV (historikus backtest-mátrix kell — helyette fagyasztott hold-out); SPRT (túlzás tucatnyi trade-en).
- Források: Bailey & López de Prado deflated-sharpe PDF; Perold implementation-shortfall; arXiv 2512.12924. ⚠ a PSR/MinTRL képletben ellenőrizni: `(γ₄−1)/4` vs `(γ₄−3)/4` (excess-vs-raw kurtózis-konvenció).

### C. Portfólió / kockázat meta-réteg — a legnagyobb strukturális lyuk

**A per-bot nézetből láthatatlan:** crypto (BTC-threshold) + HL-perp (BTC/ETH/SOL) + F-arb (BTC/ETH) **mind crypto-béta** → hat „független" 8%-os tét együtt akár egyetlen nagy korrelált BTC-pozíció. Az adatszinten (tíz–pár száz trade/bot) a látványos matek (vektor-Kelly becsült átlagokkal, ML meta-labeling, HMM) **túlilleszt** — az olcsó overlay-ek nyernek:

1. **Shared-bankroll aggregát bruttó/nettó exposure-cap** (kiemelten **crypto-béta cap** a crypto+HL+F-arb fölött). Nulla becslés, 0 trade. Órák–1 nap. **A legnagyobb lyukat egyedül ez zárja.** ⚠ NEM mond ellent a Sprint-45 F-arb-bankroll-szétválasztásnak: nem a bankrollok újraegyesítése kell, hanem egy **portfólió-NÉZET/cap-réteg** a per-bot bankrollok fölé.
2. **Vol-target + portfólió max-drawdown kill-switch** a ¼-Kelly tetején. Robusztus, közel-paramétermentes (full-Kelly ≈ 60% átlag maxDD; fél-Kelly felezi a DD-t ~8% vagyon-veszteségért). Azonnal, ~0,5-1 nap.
3. **Effective Number of Bets (min-torsion) + PCA effective-rank diverzifikáció-monitor.** Az ENB valószínűleg **~2-3, nem 6** a közös crypto-béta miatt — **a legakcióképesebb egyetlen diagnózis.** ~60-180 igazított napi periódus kell (előbb shrinkelt kovariancia). ~1-2 nap. Meucci.
4. **Means-free, shrinkage-kovariancia risk-parity** újraallokáció (Ledoit-Wolf, az becsülhetetlen átlagokat elhagyva). ~1-2 nap.
5. **Durva exogén vol-regime tőke-tárcsa** (BTC realized-vol percentilis → 2-3 bucket → per-bot szorzó). Bőséges piaci adatból, nem szűkös trade-ből. Azonnal, ~0,5 nap.
- **Előfeltétel az egész meta-rétegre:** a per-bot PnL igazítása egy közös napi hozam-sorozathoz egy shared ledgerben (Postgres, napi mark). **Előbb ezt** → kötődik B12.
- **Meta-labeling (López de Prado triple-barrier):** valós risk-adjusted lift, de **≥300-500 trade/bot** kell (ideálisan 1000+), purged CV-vel → **elhalasztva**. Interim: egy **regularizált lineáris meta-gate** 2-3 robusztus feature-rel (combiner-confidence, regime-flag, domináns-signal realized IC) védhető most.
- **Skip (túlilleszt):** vektor-Kelly C⁻¹·M becsült átlagokkal; ML meta-modell < 300 trade-en; fittelt multi-state HMM strategy-returnökön; portfólió CVaR-LP.
- Források: Chan Kelly-vs-Markowitz; Ledoit-Wolf shrinkage; Meucci ENB; Man Group Expected Shortfall; Hudson & Thames meta-labeling.

### D. Új független (korrelálatlan) signalok — crypto

Az összes pick **nulla-költségű adat** (Binance/HL/Deribit public). A meglévő stacket (momentum/contrarian/funding-level/orderflow/vol_div/apex/cond_prob/pairs) nem duplikálhatja:

1. **OI-Δ × ár quadráns — TOP PICK.** ár↑+OI↑=friss longok (trend); ár↑+OI↓=short-cover (gyenge); ár↓+OI↑=új shortok; OI↓+long-funding↑=squeeze-setup. **Korrelálatlan az orderflow-val** (pozíció-életciklus vs passzív könyv). Binance `/fapi/v1/openInterest` + `/futures/data/openInterestHist`. Low-Med. **Natívan multi-coin → ez a legtisztább út a BTC-hardcoding leváltására is (new-strategies #3).**
2. **Liquidation-cascade fade — CSAK ETH/SOL** (BTC walk-forward elbukott, PF~1,5, a mély könyv elnyeli). ETH ~67% WR PF~2,9. Fade (a kényszer-flow ELLEN, <5 perc exit). Binance `!forceOrder@arr` WS → **persistent worker kell (Hetzner, nem serverless cron).** = new-strategies #7, de ETH/SOL-scope. HL directionalra.
3. **Funding cross-section percentilis-rank.** A funding rangja saját-historiához + top-N keresztmetszethez → crowding/overheating mean-reversion. Más, mint a funding-level jel. Ingyenes transzformáció a MÁR lekért adaton. Low. = new-strategies #17.
4. **Opciós 25-Δ risk-reversal** (RR25 = IV(25Δcall)−IV(25Δput)) — irányított skew-tilt. **Részben redundáns a tervezett Deribit-RND-vel** → skalárként + term-slope-ként húzd ki, ne dupláz. Low (a tervezett Deribit-infrán ül).
5. **Taker CVD / divergencia** — átfed az orderflow-val; csak a *divergencia*-variáns értékes, HL-intraday. Legalacsonyabb prioritás.
- **Overhype/skip:** on-chain flows (gyenge irány-evidencia + $100-800/hó → kihagyni); basis/term-structure (redundáns a fundinggal + #3-mal); cross-DEX funding-dispersion (valós carry, de execution-nehéz = F-arb kapacitás-projekt, live-infra-blokkolt, nem irány-signal).
- Források: Binance derivatives docs; arXiv 2608.03616 (subkritikus kaszkádok → fade); arXiv 2410.15195 (BTC opciós predikció).

### E. Domén-specifikus átépítések

**Weather — a fix a KALIBRÁCIÓ, nem az adat.** A „jó irány (IC +0,39), rossz sizing" = tankönyvi ensemble-**underdispersion** (a σ túl kicsi → a tail-bucketek túlbizakodók → a Kelly a legmagabiztosabban téves tétre méretez).
- **EMOS/NGR post-processing** (Gneiting 2005): `μ=a+b·ensMean`, `σ²=c+d·ensVar`, az (a,b,c,d) **CRPS-minimalizálással** fittelve rolling per-város/évszak ablakon (a Gauss-CRPS-nek zárt alakja van). A `c` felfújja a floor-varianciát → kiüti a tail-túlbizakodottságot. Ugyanaz a Φ bucket-képlet, őszinte paraméterekkel. ~2-4 nap. **= a B15 (σ-kalib) + B35 (weather sizing) hiányzó rétege.**
- **Diagnózis előbb (olcsó, bizonyítja):** rank-histogram (∪-alak = underdispersed) + CRPS/CRPSS. **A rank-histogram teszi objektívvá a B40 invert-dilemmát.**
- **Adat-blend:** Open-Meteo Ensemble API (ingyenes, kulcs nélkül) — ECMWF IFS ENS + **AIFS ENS** + GFS ENS + ICON EPS egy hívásban. Edge-plafon **szerény** (a piac ugyanazt a szabad modellt árazza); a valós edge = intraday data-cutoff + állomás-bias.

**Sports — Shin de-vig a fabrikált fair value helyett (B37).** A jelenlegi „ár 0,5 felé húzása" a favorite-longshot bias-t **megtartja** (pont a bukás oka). A `devig.mts`-ben van multiplicative+power → **hozzáadni Shint** (~1-2 óra, zárt 2-way + bisekció z-re; a Štrumbelj-2014 szerint a legjobban kalibrált, a longshotokat lehúzza).
- **CLV vs Pinnacle-close = az igazi edge-metrika** (a de-viggelt Pinnacle-close a marginig hatékony → **nincs residual edge Pinnacle ellen**; az edge = a Pinnacle-igazság és a **laggos Polymarket-ár** rése).
- **Adat:** a Pinnacle publikus API megszűnt (2025-07) → **the-odds-api ($30/hó, `region=eu` = Pinnacle)** = a B37/#9 hiányzó odds-feed-je (a `sportsUsePinnacle` knob már kész). Edge valós de **szűk + likviditás-cap** (arXiv 2605.00864: ~$15/lehetőség, 3,6s ablak) → cél a **pozitív CLV paperen**, nem nagy PnL; méret a likviditáshoz, ne paper-Kelly-hez.

**Politics/Macro/LLM — a likvid piacokon CSAPDA.** Az LLM-forecasting **nem veri a likvid árat** (leakage-aware: a puszta piaci ár 0,096 > a legjobb LLM 0,109; a szuperforecasterek még #1). Ez ugyanaz a fabrikált-fair-value patológia, ami a sportsot megölte. **Ne** irányíts LLM-et likvid piacra.
- **Valós, nem-LLM érték:** (1) extremizing + log-odds aggregáció **kalibrációra kapuzva** — a `combinerExtremizeStrength` + log-odds knobok **MÁR megvannak** (session-53); a feladat kalibráció-mérés, nem új kód; (2) **neglected/illikvid piac-szkenner** (alacsony volume × széles spread × modell-eltérés, realisztikus fill-lel); (3) leakage-safe as-of-date backtest (prereq bármely news-signalhoz); (4) GDELT/RSS news csak illikvid piacok **shortlistjére**; (5) LLM-ensemble **capelt, shrinkelt SECONDARY** jelként, soha standalone/likvid.
- A politics+macro botok jelenleg üres stubok → az MVP-jük **NEM** LLM-forecasting, hanem a fenti (1)+(2).

### F. Új üzletág — Market Making / likviditás-reward-farming (Polymarket CLOB)

**A rendszer taker-only. A likviditás-reward-program egy genuin ÚJ bevételi ág — de subsidy-harvesting, nem MM-alfa.**
- Reward-score kvadratikus: `S(v,s)=((v−s)/v)²·b` → a jutalom a touch-nál koncentrálódik; két-oldali quote ~3× az egy-oldali (midpoint∈[0.10,0.90]). Pool: ~$1M/hó crypto TWAP (Aug-2026). `max_spread`/`min_size` **per-market** — élőben olvasni (`getSimplifiedMarkets` `rewards{}`).
- **Adverse selection a domináns veszteség-csatorna** (a resting quote akkor tölt, amikor a fair érték ellened mozdul; a bináris payoff **nem hedge-elhető** settlementig). A profik pont ezért kerülik a PM-et.
- **A meglévő orderflow/VPIN/Kyle-λ signalok közvetlenül újrahasznosíthatók toxicitás-kill-switchként** — ez a rendszer egyedi előnye ehhez.
- Effort: LOW-MED a quote-loop; **MED-HIGH** az inventory-skew + time-to-resolution szélesítés + kill-switch (ez dönti el a túlélést). **Live-infra kell (B10).** A subsidy explicit **átmeneti** → minden EV, ami rá épül, lejárati idejű.
- Számold ki kód előtt: várható reward $/nap/piac vs várható adverse-fill $/nap. Ha a részesedés < $1 min vagy < adverse-költség → nem éri meg farmolni.
- Akadémia (2025-26, PM-specifikus): Optimal MM in Prediction Markets arXiv 2607.17991 (HJB → skew+szélesíts, ahogy nő az inventory / közeleg a rezolúció).

### G. Settlement / redemption + arbitrázs-tooling

- **CTF `redeemPositions()` auto-redeem cron — a legtisztább „csak csináld" (LIVE only).** CTF `0x4D97DCd9…`, args (pUSD, parentCollectionId 0x00, conditionId, indexSets [1,2]); Polygon gas ~$0.002-0.01; **ágazz standard vs negRisk adapter közt**; idempotens; wait-for-finality kötelező. **= B6.**
- **negRisk convert + CTF merge** = kapacitás-hatékonysági / exit-primitívként tartsd meg (a meglévő Tab-11 Pair-Cost Arb scannerhez), **NEM alfa-stratégiaként.**
- **Resolution-risk kategória-filter:** a near-certain belépőket objektív/alacsony-dispute kategóriákra szűkíteni (crypto-ár/weather/sport-score) — a subjektív/politikai/nagy-pool piacokat kizárni (a Mar-2025 UMA governance-attack, no-refund). Ezt a crypto-combiner resolution-risk-gate-je részben már teszi.

### H. Explicit „NEM éri meg" (skeptikus mentések)

| Tétel | Miért nem | Forrás |
|---|---|---|
| **negRisk / Σ≠1 strukturális arb mint alfa** | 3,6s median korrekció, ~$15 likviditás-cap; a latency-botok elviszik. A „$0.60 median mispricing" **stale mid**, nem tölthető mélység. | arXiv 2605.00864 |
| **Cross-platform Kalshi arb mint auto-executor** | „Semantic non-fungibility" (azonosnak látszó piacok más kritériumra rezolválnak) → hamis arb, ami egy lábon veszít; ~1,75%/láb Kalshi-fee eszi a 3¢ rést; dupla pre-funding felezi a tőke-hatékonyságot. **Read-only scannerként OK.** | arXiv 2601.01706 |
| **Settlement-window sniping** ($0,97→$1,00) | A 1-4% a dispute-kockázat ára (biztosítás-eladás), nem ingyen alfa; front-run-olják. | docs.uma.xyz; theblock |
| **On-chain flows (netflow/whale)** | Gyenge irány-evidencia, single-entity-szennyezett; $100-800/hó. Az akadémiai haszna vol-spike, nem irány. | arXiv 2211.08281 |
| **LLM likvid politics/macro piacra** | A piaci ár veri az LLM-et; parity ≠ tradable edge fee+slippage után. | arXiv 2606.22719, ForecastBench |

---

## 5. Pontozott ajánlás-mátrix (Top jelöltek)

| # | Jelölt | Réteg | Edge | Effort | Infra | Adat | Conf | **Prio** |
|---|---|---|---|---|---|---|---|---|
| 1 | **Depth-aware fill-modell** (walk L2 + participáció-cap + partial + √-law) | Execution | 5 | 3 | TS-now | ✅ | 5 | **26** |
| 2 | **Shared-bankroll crypto-béta exposure-cap** | Portfólió | 5 | 5 | TS-now | ✅ | 5 | **30** |
| 3 | **PSR/MinTRL live-gate + honest-trial DSR** | Validáció | 4 | 4 | TS-now | ✅ | 4 | **24** |
| 4 | **Walk-forward scoring harness a ledgeren** | Validáció | 4 | 3 | TS-now | ✅ | 4 | **22** |
| 5 | **OI-Δ × ár signal** (+ multi-coin BTC-hardcode leváltás) | Signal | 4 | 4 | TS-now | ✅ | 4 | **24** |
| 6 | **Weather EMOS/NGR kalibráció** (+ rank-histogram/CRPS + Open-Meteo blend) | Domén | 4 | 3 | TS-now | ✅ | 4 | **22** |
| 7 | **Sports Shin de-vig + the-odds-api feed + CLV-KPI** | Domén | 4 | 4 | TS-now | 💲olcsó | 3 | **23** |
| 8 | **Vol-target + portfólió max-DD kill-switch** | Portfólió | 3 | 5 | TS-now | ✅ | 4 | **23** |
| 9 | **Effective Number of Bets + PCA diverzifikáció-monitor** | Portfólió | 3 | 4 | TS-now | ✅ | 4 | **21** |
| 10 | **CTF auto-redeem cron (B6)** | Tooling | 3 | 4 | TS-now* | ✅ | 5 | **22** |
| 11 | **Liquidation-cascade fade (ETH/SOL)** | Signal | 4 | 2 | Hetzner | ✅ | 3 | **19** |
| 12 | **Neglected-market scanner (politics/macro MVP)** | Domén | 3 | 3 | TS-now | ✅ | 3 | **18** |
| 13 | **Market-making / reward-farming** | Új üzletág | 4 | 2 | Hetzner+live | ✅ | 2 | **18** |
| 14 | **Meta-labeling (triple-barrier)** | Portfólió | 3 | 2 | Hetzner | ✅ | 2 | **15** |

\* az auto-redeem TS-now, de LIVE-only (paper-ben nincs mit redeem-elni).

---

## 6. Prioritált roadmap (jelölt — jóváhagyásra)

**A. lépcső — TS-now, infra nélkül, mérés-first / regresszió-mentes:**
1. **Depth-aware fill-modell** (#1) — **ez validál mindent, először ezt** (a hamis paper-PnL nélkül minden statisztika hazudik).
2. **Shared-bankroll crypto-béta exposure-cap** (#2) — nulla becslés, a legnagyobb strukturális lyuk.
3. **PSR/MinTRL live-gate + honest-trial DSR** (#3) + **walk-forward scoring a ledgeren** (#4).
4. **OI-Δ × ár signal** (#5) — az egyetlen erős új korrelálatlan jel + a BTC-hardcode leváltása.
5. **Weather EMOS/NGR kalibráció** (#6) + **Sports Shin de-vig + odds-feed + CLV** (#7).
6. **Vol-target + max-DD kill-switch** (#8) + **ENB diverzifikáció-monitor** (#9).
7. **Neglected-market scanner** (#12) mint a politics/macro MVP (NEM LLM-forecasting).

**B. lépcső — Hetzner / live-infra precondition:**
8. **CTF auto-redeem cron** (#10, live-flip előtt — B6).
9. **Liquidation-cascade fade ETH/SOL** (#11, persistent WS worker).
10. **Market-making / reward-farming** (#13, live-infra + adverse-selection kezelés).
11. **Meta-labeling** (#14, ≥300-500 trade/bot után).
12. **Paper-vs-live reconciliation logger** (a live-flip első napjától).

---

## 7. Kereszthivatkozások a meglévő trackerekhez

- **B41** (`model-discovery-forecasting.md`): ez a doksi annak execution/portfólió/domén **kiegészítése** — a #2-#9 forecasting-add-on élesítése ott él, itt nem duplikáljuk.
- **B6** ← §4.G auto-redeem. **B10** ← §4.F/G live-infra precondition. **B11/B12** ← §4.B walk-forward + shared ledger (a §4.B a B11 Hetzner-mentes verzióját adja).
- **B15/B35/B40** ← §4.E weather EMOS (a hiányzó σ-kalibrációs réteg + a rank-histogram az invert-döntéshez).
- **B37 + odds-data task** ← §4.E sports Shin de-vig + the-odds-api.
- **new-strategies #3** (per-coin slug map) ← §4.D OI-Δ multi-coin mellékterméke. **#7** (liq-cascade) ← §4.D (ETH/SOL-scope pontosítva). **#17** (funding cross-section) ← §4.D.
- **ÚJ (nincs meglévő tétel):** depth-aware fill (§4.A), portfólió crypto-béta cap + ENB + vol-target (§4.C), PSR/MinTRL/DSR (§4.B), market-making (§4.F).

---

## 8. Kritikus figyelmeztetések (load-bearing)

1. **A hamis paper-PnL a legveszélyesebb.** Minden validáció, kalibráció és sizing-döntés a paper-fillekre épül; amíg a longshot-túltöltés él, a rendszer illuzórikus edge-re méretez. **A #1 fix nem opció.**
2. **A hat bot nem hat független tét.** A crypto-béta koncentráció a per-bot 8%-os capekben láthatatlan; az ENB valószínűleg ~2-3. A portfólió-cap az egyetlen, ami egy BTC-krachnál megvéd.
3. **Az új signal ritkán a válasz.** 8 kutatási ágból egyetlen erős új jel jött (OI-Δ). A profit a NEM-signal rétegekben van.
4. **A domén-fixek valósak, de szűk plafonúak.** A weather EMOS + sports Shin de-vig megállítja a vérzést, de a szabad modellek / a sharp Pinnacle-close hatékonysága miatt a felső korlát szerény — a cél a **pozitív proper-score/CLV**, nem nagy PnL.
5. **Az LLM likvid piacra csapda** — ugyanaz a fabrikált-fair-value hiba, ami a sportsot megölte.
6. **Minden A-lépcső TS-now**; a B-lépcső Hetzner/live-infra precondition (`hetzner-migration.md`).

---

## 9. Kulcsforrások (a részletes URL-lista a session-changelogban)

- **Execution/fill:** arXiv 2606.04217 (PM favorite-longshot reversal + Gini), 2606.24019 (√-law), 2407.16527 (limit-fill drift), 2409.12721 (backtest-optimizmus); docs.polymarket.com.
- **Validáció:** Bailey & López de Prado deflated-sharpe; Perold implementation-shortfall; arXiv 2512.12924.
- **Portfólió:** Chan Kelly-vs-Markowitz; Ledoit-Wolf; Meucci ENB; Man Group ES; Hudson&Thames meta-labeling; López de Prado AFML.
- **Crypto signal:** Binance derivatives docs; arXiv 2608.03616 (kaszkádok), 2410.15195 (BTC opciós predikció).
- **Weather:** Gneiting 2005 (EMOS/NGR, MWR 133); Hamill 2001 (rank histogram); open-meteo.com/en/docs/ensemble-api; ECMWF open-data.
- **Sports:** Štrumbelj 2014 (IJF, Shin); football-data.co.uk/blog/pinnacle_efficiency; CRAN `implied`; arXiv 2605.00864; the-odds-api.com.
- **Politics/LLM:** Halawi arXiv 2402.18563; ForecastBench 2409.19839; leakage-aware 2606.22719; alignmentforum „Contra superhuman AI forecasting"; Baron/Tetlock/Satopää extremizing.
- **Market making:** arXiv 2607.17991 (Optimal MM PM), 2606.09454 (Axiomatic MM), 2510.15205 (Black-Scholes for PM); docs.polymarket.com/programs/liquidity-rewards.
- **Settlement/arb:** docs.uma.xyz; docs.polymarket.com/trading/ctf; arXiv 2601.01706 (Kalshi non-fungibility), 2605.00864 (NBA arb).
