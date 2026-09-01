# CHANGELOG — 2026-09-01

> **Két párhuzamos session ezen a napon, független workstream (nincs kód-átfedés):**
> **(a) 5-bot elemzés + paper „never-stop" valve + B34/B35** — lásd a lenti „(Párhuzamos session)" szekciót. Deploy-státusz: **B29 (`d1f4e93`) az `origin/main`-en**; a never-stop valve kódfájljai (`paper-never-stop.mts` stb.) a `git status` szerint jelenleg **untracked/uncommitted** a munkafában.
> **(b) Forecasting-modell discovery + proper-scoring eval harness (#1)** — ez a session (53.), közvetlenül lentebb.

## (b) Forecasting-modell discovery + proper-scoring eval harness (#1) implementálva

### Kontextus

A user kérése: *„csinálj egy discovery-t a legjobb modell megtalálására … mint az opticut projektben a 2D nesting discovery-re"*, majd pontosítva: **trading / ár-előrejelzés**, cél a **meglévő botok fejlesztése**. Ezt követően: *„kezdd el a #1-et, a proper-scoring eval harness-t"*.

### 1. Research discovery (3 párhuzamos kutatási pillér)

Új doksi: [`roadmap/model-discovery-forecasting.md`](../roadmap/model-discovery-forecasting.md) + pointer a [`roadmap/README.md`](../roadmap/README.md) „Kapcsolódó" szekcióban.

3 párhuzamos web-kutató-ágens (primer források: arXiv, GitHub, hivatalos docs):
- **A. Foundation modellek:** Chronos-Bolt / TimesFM 2.5 (Apache-2.0) — ár-szinten alig verik a random walk-ot, és a **tail-eken túlbizonyosak** (arXiv 2510.16060). Csak kalibrált distribution/vol-estimatorként. Moirai **CC-BY-NC → blokkolt**, TimeGPT closed.
- **B. Volatilitás + digitális opció + kalibráció:** HAR-RV (Yang–Zhang) veri a napi GARCH-ot rövid horizonton; Deribit SSVI+Breeden–Litzenberger a piac-implikált `P(BTC>K)`-hez; **risk-neutral vs valós-világ measure-gap** a fő miskalibráció-ok; first-passage (~2×) a „by date" piacokra; **Venn-Abers/isotonic kalibrációs réteg** a pragmatikus fix. Tooling: MAPIE/crepes/venn-abers (BSD-3).
- **C. Aggregáció + meta-learner + scoring:** **log-odds pool** > lineáris pool; disagreement-gated extremizing; **online AdaHedge + ADWIN/BOCPD** regime-reset; logisztikus ridge stacking csak ≥150–200 kimenet után; LLM-forecasting csak sports/politics-ra; **proper scoring + walk-forward-only** az értékeléshez.

A discovery per-bot ajánlást + pontozott mátrixot + prioritált roadmapot (A-lépcső TS-now / B-lépcső Hetzner) ad. Több meglévő backlog-tétel (B34/B35/B36/B37/B40) elméleti + OSS-hátterét adja.

### 2. #1 — Proper-scoring eval harness (IMPLEMENTED)

**Cél:** a forecast valószínűséget magát pontozni (nem a zajos PnL-t), hogy a jövőbeli combiner/kalibráció-változások **strictly-proper metrikán** összehasonlíthatók legyenek. Ez validálja az összes többi discovery-tételt.

**Backend** — új `computeProperScores(trades, binCount=10)` a [`edge-tracker/statistics.mts`](../../netlify/functions/edge-tracker/statistics.mts)-ben:
- A pontozott forecast a modell **P(a trade nyer)**-je: `p_win = isYesLike ? predictedProb : 1−predictedProb` (YES/LONG vs NO/SHORT), a kimenet `y = pnl>0`. **Minden kategórián** működik (crypto/weather/HL/sports), a HL-perpen is (ahol az EV-chart összeomlik, de a win-prob forecast érvényes).
- **Scalar scores:** Brier (`mean (p−y)²`), log-score (cross-entropy, `[1e-6,1-1e-6]` clip → confident-wrong nem robban ∞-re).
- **Murphy-dekompozíció** K egyenlő-szélességű binnel: `Brier ≈ Reliability − Resolution + Uncertainty`; a bin-reprezentáns-identitás maradéka **`decompositionResidual`-ként explicit** kiírva (nincs elhallgatott within-bin tag).
- **Skill-score-ok** a base-rate (climatology) referenciához: `BrierSkill = 1 − Brier/Uncertainty`, `LogSkill = 1 − LogScore/BaseEntropy` (>0 ⇒ veri az „always-predict-ō"-t).
- **Reliability-diagram binek** a full [0,1] forecast-tengelyen (mean predicted vs realised freq + count).

**Endpoint** — [`edge-tracker.mts`](../../netlify/functions/edge-tracker.mts): `computeProperScores(trades)` bekötve, új `properScores` mező a JSON response-ban.

**Frontend** — [`EdgeTrackerPanel.tsx`](../../src/components/EdgeTrackerPanel.tsx): új `ProperScoresCard` (a SummaryCards után): 6 KPI-kártya (Brier↓, Log-score↓, Brier-skill↑, Reliability↓, Resolution↑, Log-skill↑) + full-[0,1] reliability-diagram SVG (a meglévő `CalibrationChart` mintáját tükrözi, 45°-referenciavonal, pont-méret count szerint, szín |dev| szerint) + message-sor. A [0,1]-diagram komplementálja a meglévő [0.5,1.0] `CalibrationChart`-ot.

**Teszt** — új [`shared/proper-scores.test.mts`](../../netlify/functions/auto-trader/shared/proper-scores.test.mts) (10+ pin, közvetlenül a valódi `computeProperScores`-t importálja): Brier/log-score scalar pin, Murphy singleton-bin residual≈0 + identitás-rekonstrukció, direction-inverzió (NO/SHORT a fogadott oldalt pontozza), log-score clipping (confident-wrong véges), high-skill/anti-skill BSS-előjel + message, n<20 noise-flag, empty + no-predictedProb → n=0.

**Verifikáció:** `npx tsx proper-scores.test.mts` → all passed; `tsc --noEmit` + `npm run build` zöld. Adat-út próba a mock-generátoron (n=120): Brier 0.2619, log-score 0.7234, reliability 0.0488, 8 kitöltött bin, Murphy-identitás önkonzisztens (recon 0.2618 ≈ brier 0.2619). A böngésző-vizuális ellenőrzés `netlify dev`-et igényelne (endpoint) — helyette a számítási út + build + unit-tesztek igazolva; a kártya a bizonyítottan működő `CalibrationChart` mintát tükrözi.

**NEM deployolva** (a repo konvenció szerint a deploy operátor-lépés). Élesedés után az Edge Tracker minden kategórián mutatja a proper-scoring KPI-ket + reliability-diagramot.

### 3. Prediction ledger — adat-alap (model-discovery §2, hibrid-döntés)

**Döntés:** a user a **hibrid** ütemezést választotta (adatgyűjtés + olcsó TS-javítások most; nehéz ML + backtest Hetzner után). Indok: a **point-in-time predikció (CLOB-mikrostruktúra jelek) nem pótolható visszamenőleg**, ezért a ledger-óra azonnal indul; a Blobs→Postgres átöltés triviális.

**Új modul** [`shared/prediction-ledger.mts`](../../netlify/functions/auto-trader/shared/prediction-ledger.mts): a botok `closedTrades`-e csak a *megfogadott* trade-eket tartja (selection bias) + kicsi. A ledger **minden scannelt piac** predikcióját logolja (taken + skipped), majd a resolution után feltölti a **YES-kimenetet** (0/1, irány-agnosztikus). Upsert per-piac (latest prediction wins, `firstTs`/`scans`/`outcome`/`taken` megőrizve), cap N=3000/kategória, Blobs store `prediction-ledger` (Hetznernél → Postgres, B12). Kimenet-feltöltés: (a) taken piacokra a `closedTrades`-ből (ingyen), (b) **skipped** piacokra Gamma-reconcile (`&closed=true`, budgetelt 12/tick) — **ez a torzításmentes hozzáadott érték**. Best-effort/non-throwing (sosem tör el egy trade-ticket).

**Bekötve mind a 3 forecasting-bot** (bot-agnosztikus modul: `market ?? coin`, `pnl ?? pnlUSDC`, taken = non-skip/fail/error):
- **crypto** ([`auto-trader/index.mts`](../../netlify/functions/auto-trader/index.mts)) — `appendPredictions` + `reconcileLedger` (Gamma).
- **weather** ([`weather/index.mts`](../../netlify/functions/auto-trader/weather/index.mts)) — per-bucket conditionId a rowContext-en (`predictedProb`/`conditionId`/`endDate` hozzáadva), `markets=[]` hogy a bucket-conditionId nyerjen, + Gamma-reconcile.
- **HL** ([`hyperliquid/index.mts`](../../netlify/functions/auto-trader/hyperliquid/index.mts)) — append only, **nincs** Gamma-reconcile (perp, nem Polymarket → a skipped-coin kimenet jövőbeli price-based reconcile-t igényel; a taken coinok a closedTrades-ből töltődnek).

**B) Ledger stats panel** — `edge-tracker.mts` új `ledgerStats` mező (`computeLedgerStats` per kategória, „all"-ra aggregálva) + `LedgerStatsCard` az `EdgeTrackerPanel`-en (Logged / Resolved / Taken / **Skipped+resolved** = a torzításmentes add-on). Új [`shared/prediction-ledger.test.mts`](../../netlify/functions/auto-trader/shared/prediction-ledger.test.mts) (7 csoport, bot-shape toleranciákkal) + `tsc`+build zöld. **A ledger-óra a deploy-jal indul.**

### 4. Hetzner Docker deployment terv (user-kérés: „teljes setup")

Új doksi [`roadmap/hetzner-docker-setup.md`](../roadmap/hetzner-docker-setup.md) — a **konténerizált deployment SSOT-je**: 13 konténer (caddy/api/5× worker/market-feeds/**model** [Python ML]/postgres/redis/migrate/backup), teljes `docker-compose.yml` + monitoring overlay, Dockerfile-ok (Bun worker/api/feeds, Python model, backup), **szerver** (`/opt/edgecalc`) + **repo** (monorepo `apps/`+`services/`+`packages/`) könyvtárfa, Caddyfile, a `prediction_ledger` Postgres-séma + a Blobs→Postgres import, a Netlify-function→konténer mapping, fázisos strangler-cutover, sizing (CCX23 Chronos-Bolt tier / CCX33 nagy foundation modell). **Döntés-megfordítás:** az infra-doksi §14 „Docker = overengineering" → **Docker-first** (indok: a B-lépcső Python ML model-service-t igényel + reprodukálhatóság). Az [`hetzner-infrastructure.md`](../roadmap/hetzner-infrastructure.md) top-pointer + §14 frissítve; a README SSOT-mátrix bővítve. Ami az infra-doksiból marad: §1 szerver, §2 OS-hardening, §4 Postgres-séma, §11 DR, §12 budget.

### 5. #2 Post-hoc kalibrációs réteg — MÉRÉSI lépés (nem live)

A discovery §7 #2 első, **biztonságos** lépése: a kalibráció **mérésként** épült be, **nem** nyúl a live döntéshez (a kutatás fő figyelmeztetése: overfitting <200 kimeneten leaked kalibrációval → ez a load-bearing kockázat). Új modul [`edge-tracker/calibration.mts`](../../netlify/functions/edge-tracker/calibration.mts): **Platt-skálázás** (sigmoid a `logit(p)`-n, Platt target-smoothinggal — tudatosan Platt, nem isotonic, mert az izotonikus <1000 mintán túltanul) + **szigorúan walk-forward** kiértékelés (`computeCalibrationEval`: minden trade-re a múlton fitel, a következőt pontozza — zéró leakage). Kiírja a **raw vs kalibrált Brier + log-score**-t → megmondja, kalibráció **segítene-e**, a #1 harness metrikáin, live viselkedés-változás nélkül. Közös win-prob extrakció kiszervezve (`extractWinProbPairs` a `statistics.mts`-ben, a #1 és #2 egy forrásból). Bekötve az `edge-tracker.mts`-be (`calibrationEval`) + `CalibrationEvalCard` (raw/kalibrált KPI-k + kalibrációs görbe SVG). Új [`shared/calibration.test.mts`](../../netlify/functions/auto-trader/shared/calibration.test.mts) (6 csoport: identity/guard, overconfident-recovery, insufficient, walk-forward-gain, direction-inverzió) + `tsc`/build zöld. Mock-próba: raw Brier 0.272 → kalibrált 0.2226 (−4.9pp). **Live bekötés (coach-mode toggle) csak elég adat + validáció után** — a ledger gyűjtése után.

### 6. #3 Log-odds pool (directional piacok) — default-OFF toggle

A discovery §7 #3: a `signal-combiner.mts` `combine()` új **általános log-odds pool** módot kapott directional (up-or-down / general) piacokra. A lineáris (számtani átlag) pool **bizonyíthatóan alul-magabiztos** (0.5 felé húz független jeleknél) — ez a projekt dokumentált „lapos ~0.46 finalProb" patológiája; a B21 K-anchor ennek *threshold-only* foltja volt. A log-odds pool `sigmoid(Σ wₖ·logit(pₖ))` a log-loss-optimális család, **decizívebb de bounded** (súlyozott **átlag**, nem összeg → nem túl-számolja a redundáns jeleket; a valódi bizonyíték-akkumuláció a külön, óvatosabb extremizing = #8). Új `combinerLogOddsStrength` Settings-knob (**default 0 = OFF, zéró regresszió**, range [0,1]); a `combine()` új 6. paraméter + `loadLogOddsStrength()` loader. **Threshold piacon nincs hatása** (ott a K-anchor pool-ol → nincs double-transform). A bevált B21/42A minta: speculative implementáció default-off, az operátor a #1 proper-scoring gain után kapcsolja. Új `shared/log-odds-pool.test.mts` (6 csoport: s=0 no-op regressziós pin, decizívebb-de-bounded, szimmetria, részleges blend, threshold-skip, súlyozott) + `tsc`/build zöld. Math-doksi [`10-signal-combiner.md`](../math/10-signal-combiner.md) bővítve.

### SSOT / task-tracking

- sprints.md: új **B41** backlog-tétel (model-discovery; #1 proper-scoring ✅ IMPLEMENTED, prediction ledger ✅ crypto-n IMPLEMENTED [weather/HL TODO], #2–#9 A-lépcső jelöltek jóváhagyásra, B-lépcső Hetzner-precondition). A B40 kereszthivatkozik a #1-re.
- Ütemezés: **hibrid** — most a ledger (adatgyűjtés indul) + #2 kalibrációs réteg; nehéz ML + backtest framework (B11) + ledger→Postgres (B12) Hetzner után.
- A discovery §7 jelölt-tételei (kalibrációs réteg, log-odds pool, online AdaHedge, HAR-RV, first-passage, Deribit BL, extremizing, sports de-vig) **operátor-jóváhagyásra várnak** a promócióhoz — SSOT-védelem miatt nem lettek egyoldalúan felvéve.

---

## (Párhuzamos session) 5-bot performance-elemzés + paper „never-stop" valve + B34/B35

> Megjegyzés: ez a szekció egy párhuzamos session munkája ugyanezen a napon; a fenti proper-scoring munka egy másik sessionből származik. A két workstream független (nincs kód-átfedés).

### Kontextus
A user kérte az összes bot teljesítmény-elemzését, majd: B29-deploy + crypto-restart, egy „demo-ban soha ne álljon le" kapcsolót minden botra (bekapcsolva), és a többi javaslat (B34/B35) implementálását.

### 1. Teljesítmény-elemzés (read-only, `/multi-status`+`/edge-tracker`)
Portfólió $1450→**$1287,80** (−11,2%), nettó realizált **−$111**, 671 closed. Barbell: crypto **+$445** fedezi a másik 4 −$556-ját; a crypto „+445" NEM valódi edge (Sharpe 0,16 CI [−0,04;0,36] átlépi a 0-t, evGap −$1534). Crypto+HL `stoppedReason='Session loss limit reached'` (AUTO), sports `'Manual stop'`. Weather iránya jó (`forecast_edge` realized IC **+0,317**), payoff **0,44** → sizing baj.

### 2. B29 — MÁR deployolva
`d1f4e93` (B29–B32) már az `origin/main`-en (main==origin/main). A crypto csak Blobs-`stopped` maradt → a never-stop self-heal-eli auth nélkül.

### 3. Paper „never-stop" safety valve (ÚJ, fő munka)
Új [`auto-trader/shared/paper-never-stop.mts`](../../netlify/functions/auto-trader/shared/paper-never-stop.mts): `isAutoStopReason()` (whitelist: session-loss-limit / calibration-noise / consecutive-loss → clearable; „Manual stop" → megőrzött), `loadPaperNeverStop()`. Új `paperNeverStop` Settings-knob (common, default **1=ON** → nem kell authed write). Csak `paperMode && paperNeverStop`-nál (LIVE inaktív): (1) **self-heal** minden tick elején az AUTO-stopolt sessiont (resume + odométer-null, history megmarad; HL stale pause is); (2) **loss/consecutive-limit → +Infinity**, így sem az auto-stop set-site, sem a **decision-engine loss/consec-gate-je** ([crypto decision-engine.mts:213](../../netlify/functions/auto-trader/crypto/decision-engine.mts), [HL :102/:108](../../netlify/functions/auto-trader/hyperliquid/decision-engine.mts)) nem halt → a bot TRADE-el. **Scope: csak auto-stop** — manual megőrzött. Érintett: crypto [`auto-trader/index.mts`](../../netlify/functions/auto-trader/index.mts), HL [`hyperliquid/index.mts`](../../netlify/functions/auto-trader/hyperliquid/index.mts), sports [`sports/index.mts`](../../netlify/functions/auto-trader/sports/index.mts). Weather+F-Arb: nincs auto-stop → eleve fedve. **Hatás:** crypto (sessionLoss $1162>$1000) + HL ($75,5>$50) a deploy utáni cron-tick-en magától újraindul; sports manual stop marad. Új [`shared/paper-never-stop.test.mts`](../../netlify/functions/auto-trader/shared/paper-never-stop.test.mts) (5 blokk).

### 4. B34 — `useRealizedIC` default 0→1
A sign-awareness már benne van (negatív realized IC → negatív súly → invertált hozzájárulás, B30-clamp biztosítja). HL `&category=hyperliquid`, crypto `&category=crypto`. ⚠️ Ha mentett `=0` override van, a default-change nem írja felül → operátornak Settings-ben 1-re kell váltania (auth).

### 5. B35 — `weatherKellyScale` knob (default 0,5)
Uniform Kelly de-risk: `kellyFraction = rawKelly × confidence × 0.25 × config.kellyScale` ([weather/decision-engine.mts](../../netlify/functions/auto-trader/weather/decision-engine.mts)). Kockázat-csökkentő (a vérzést korlátozza), NEM payoff-fix.

### Verifikáció + deploy
`tsc` ✅ · 13/13 teszt ✅ (új `paper-never-stop.test`) · `build` ✅. Push `main` → Netlify CD. sprints.md: B34/B35 RÉSZBEN KÉSZ. Operátor: ha van `useRealizedIC=0` override, Settings-ben váltsd 1-re.
