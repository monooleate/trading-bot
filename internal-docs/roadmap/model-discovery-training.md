# Model Discovery — Training / paraméter-optimalizáció (a bot „trainelése")

> **Típus:** research discovery — forrásolt survey + pontozott ajánlás, a [`model-discovery-forecasting.md`](./model-discovery-forecasting.md) (predikciós réteg) és a [`model-discovery-expansion.md`](./model-discovery-expansion.md) (execution/portfólió) **harmadik testvér-doksija**. Míg azok azt kérdezték *„milyen modell/edge kell"*, ez azt: **„a ~96 állítható knobot hogyan hangoljuk elvi módon, valós adaton, túlillesztés nélkül — mi a „training" jó gyakorlata ebben a rendszerben, honnan lesz adat, és hogyan fusson."**
> **Dátum:** 2026-09-03 · **Scope:** mind az 5 élő bot + a shared combiner + a mérési/validációs infra (prediction-ledger, proper-scoring, DSR/PSR, walk-forward, AdaHedge, Platt, realized-IC) + az adat-pipeline.
> **Módszer:** 1 read-only kód-katalógus-ágens (a teljes `trader-settings` SCHEMA + presetek + env-ek + a `packages/core` mérési modulok) + 3 párhuzamos webes kutató-ág (anti-overfit tuning best practice; valós historikus adatforrások 6 doménben 5 al-ágenssel; online/adaptív hangolás + RL őszinte értékelése), primer forrásokkal (arXiv, exchange/API-docs, peer-reviewed). Minden állítás a **kódra + a forrásra** verifikálva, skeptikus alapállással.
> **Task-promóció:** a §6 tételei **jelöltek** — a `sprints.md` B-tételekbe csak operátor-jóváhagyás után kerülnek (SSOT-védelem). Tracker: **`sprints.md` B50**.

---

## 0. TL;DR — a discovery egyetlen mondatban

**A „bot trainelése" ebben a forward-native, DSR-trial-trackelt, kis-mintás rendszerben NEM grid-search/Bayes-opt/RL a paper-PnL-en (azt a rendszer szándékosan bünteti, és mind a három kutató-ág egybehangzóan csapdának minősíti) — hanem három dolog: (1) a hangolási CÉLFÜGGVÉNY átállítása PnL/Sharpe-ról proper-score-ra / kalibrációra (nagy effektív N, a skippelt predikciókat is beleértve); (2) offline kalibráció valós historikus adaton ott, ahol nagy-N nem-pénzügyi cél létezik (weather EMOS az állomás-napokon, sports Shin de-vig a Pinnacle-close-okon, vol-modell a klinákon) — ez az EGYETLEN hely, ahol az optimalizálás biztonságos; (3) egy fegyelmezett online-adaptív réteg (a meglévő AdaHedge + Bayes-shrinkage + Platt fölé egy diszkontált Thompson-sampling preset-választó, champion-challenger promócióval).** A rendszer már a helyes háromlábú széken ül; a maradék nyereség kicsi és unalmas — nem új keresőalgoritmus.

**Két load-bearing infra-találat, ami az egészet gátolja, ha nem javul:** (a) **a ledger jelenleg NEM címkézi, melyik knob-konfiguráció termelte az adott trade-et** → nincs A/B-attribúció, csak trial-*szám* (a DSR őszinte korrekciója, de a slice-olást blokkolja); (b) **a legértékesebb tréning-adatok egy része nem visszatölthető** (Polymarket könyv-mélység, OI-history, Deribit-felület, Pinnacle live-close) → **log-forward MOST kell kezdődjön; minden nem-logolt nap véglegesen elveszett tréning-adat.**

---

## 1. A kérdés újrakeretezése — mi a „training" ebben a rendszerben?

A user intuíciója helyes (sok knob → keressük az optimumot), de a naiv ML-„training" fogalom itt félrevezet, és a repo eddigi filozófiája ezt már részben kodifikálta:

- **Nincs backtest-motor, és nem is akarunk** (a `math`/`roadmap` doksik többször kimondják). A rendszer **forward-native**: minden predikció konstrukció szerint out-of-sample, mert sosem re-fittelünk a jövőre. Ez **strukturálisan a helyes póz** — a szakirodalom (López de Prado, Bailey) fele arról szól, hogyan *szimuláljuk* ezt a fegyelmet purged CV-vel; nálunk ingyen van.
- **Minden knob-váltást már trial-ként logolunk** ([`trader-settings.mts`](../../services/api/src/routes/trader-settings.mts) `appendTrial`/`countTrials`) → **Deflated Sharpe** korrekció. Ez a legfontosabb meglévő fegyelem.
- Ezért a fő overfitting-kockázat **nem** a backtest-data-snooping, hanem **(i)** a kis élő minta (tíz–pár száz rezolvált trade/bot) zaj-illesztése, és **(ii)** a trial-szám-infláció, ahogy egyik knobot a másik után hangoljuk egyetlen, növekvő forward-track-recordra (a changelog tucatnyi ilyet mutat: weather-invert, useRealizedIC, downweight, Kelly-scale…).

**Tehát a „training" itt = 3 külön dolog, amit szét kell választani:**

| Réteg | Mit jelent | Hol biztonságos az „optimalizálás" |
|---|---|---|
| **(A) Offline kalibráció** | Modell-paraméterek (EMOS σ-infláció, Shin insider-frakció, HAR-RV együtthatók) illesztése **nagy-N valós historikus adatra** | **Igen** — ez a klasszikus „training", DE **csak nem-pénzügyi / piaci-ár célon** (állomás-nap, closing-line, klina). Soha nem a trade-PnL-en. |
| **(B) Forward-native knob-tuning** | A gate/sizing knobok (confidence-min, Kelly-scale, edge-threshold) hangolása az élő ledgeren | **Korlátozottan** — csak proper-score-célon, effektív-trial-DSR-kapuval, plateau-not-peak; a legtöbb knob a mérés szerint **nem megkülönböztethető** ezen a mintán → fixen hagyni. |
| **(C) Online adaptív réteg** | Súlyok/preset-választás automatikus, regret-minimalizáló hangolása menet közben | **Igen, óvatosan** — AdaHedge (megvan) + diszkontált Thompson-sampling; bounded controller, champion-challenger, a risk-guardrailek KÍVÜL. |

A dokumentum a három rész-kérdést (jó gyakorlat / adat / hogyan) e három réteg mentén válaszolja meg.

---

## 2. Grounding — a paraméter-felszín + a MÁR meglévő mérési/tanuló infra

### 2.A A tunable felszín (a kód-katalógusból)

**~96 SCHEMA-knob** egyetlen `SCHEMA` objektumban ([`trader-settings.mts`](../../services/api/src/routes/trader-settings.mts)), bot-onként: crypto 27, common (cross-bot) 25, weather 16, hyperliquid 12, sports 9, funding-arb 7. **Politics/macro: 0** (üres stub). + 18 preset (loose/normal/strict × 6 bot) = kurált pontok ugyanabban a térben. Env-override csak a crypto+common magra van; a `PAPER_MODE` (env) a master live/paper kapcsoló.

Funkció szerint: **(a) sizing/risk** (`maxKellyFraction` 0.08, `weatherKellyScale`, `hlMaxLeverage`, loss-limitek, `riskVolTarget`/`riskDdKill` #8, `betaCap` #2); **(b) signal/edge** (`combinerConfidenceMin`, `edgeThreshold`, IC-priorok, `combinerLogOddsStrength`/`ExtremizeStrength`, `useHarRv`/`useFirstPassage`/`useDeribitIV`, `oiDeltaEnabled` #5, `weatherUseEmos` #6, `sportsUsePinnacle` #9); **(c) gate/filter** (longshot-floorok, monotonicity, edge-cap); **(d) execution** (`fillModelEnabled` #1, `fillParticipationCap`); **(e) meta** (`paperNeverStop`=1, `useRealizedIC`=1, `calibrationShrinkageK`=30, `icHalfLifeTrades`=0, a 7-gate live-readiness + `liveReadyMinPsr`/`UseMinTrl` #3).

> **Overfitting-releváns tény:** a ~96 dimenzió messze több szabadságfok, mint amennyit a jelenlegi minta elbír. A False Strategy Theorem (Bailey–López de Prado) szerint elég knobbal *garantáltan* találunk lenyűgöző, de hamis konfigot. **A legnagyobb kar nem egy jobb kereső, hanem a tunable-knobok SZÁMÁNAK csökkentése** (§3.A).

### 2.B A mérési/validációs infra — MI VAN MÁR (a duplikáció elkerülésére)

Mind **pure** modul a `packages/core/src/`-ben, **read-side** hívva az edge-tracker route-ból. Állapot:

| Modul | Fájl | Fut? | Live-re kötve? |
|---|---|---|---|
| **Prediction ledger** (minden szkennelt piac, taken+skipped, outcome-fill) | `prediction-ledger.mts` | ✅ crypto+weather+HL | mérés-only |
| **Proper-scoring** (log-score + Brier-Murphy + reliability-diagram) | `statistics.mts` `computeProperScores` | ✅ minden kategória | mérés-only |
| **Robust-Sharpe** (PSR/MinTRL/DSR/skew/kurt) | `sharpe-robust.mts` + `live-readiness.mts` | ✅ (DSR `countTrials()`-szal) | **advisory** (a 2 gate default-OFF) |
| **Walk-forward scoring** (Brier-skill vs piaci ár, kronológiai blokkok) | `walk-forward.mts` | ✅ | mérés-only |
| **Online AdaHedge súlyozás** (paraméter-mentes) | `online-weights.mts` | ✅ (min 20 minta) | **mérés-only** — semmi nem folyik a live combinerbe |
| **Platt post-hoc kalibráció** (walk-forward raw vs kalibrált) | `calibration.mts` | ✅ | **mérés-only** |
| **Realized-IC** (per-signal Pearson, Bayes-shrinkage K=30, opc. half-life) | `signal-calibration.mts` | ✅ crypto+HL+weather | **`useRealizedIC` (default 1)** — az EGYETLEN, ami tényleg hat a live-ra |
| **DSR honest-trial** (minden knob-váltás → trial) | `trader-settings.mts` `appendTrial` | ✅ | a promócióhoz advisory |
| **ENB** (cross-bot corr → effective number of bets) | `enb.mts` | ✅ | mérés-only |

**Kulcs-verdikt:** a teljes tanuló/validáló infra **fel van építve és fut, de gyakorlatilag semmi nincs a live-viselkedésre kötve** (kivéve `useRealizedIC`). **A „training" nagy része tehát nem új kód, hanem a MEGLÉVŐ advisory réteg élesítése + a tuning-célfüggvény átállítása.** Ez a legolcsóbb és legerősebb kar.

### 2.C A két infra-lyuk, ami a training-et strukturálisan gátolja

1. **Per-knob-konfiguráció NINCS címkézve a ledgeren/closed-trade-eken.** Egy `PredictionRecord`/`ClosedTrade` a predikciót és a kimenetet tárolja, de **nem azt, hogy melyik SCHEMA-config tüzelte**. Az egyetlen knob-nyom a `trader-trials` (`{ts, keys}` — a *változott kulcsok*, érték és per-trade-linkelés nélkül). → **Nem lehet slice-olni, hogy „mi volt a `combinerConfidenceMin`, amikor ez a trade tüzelt"** → A/B-attribúció lehetetlen, csak trial-szám-alapú DSR megy. **Ez a hiányzó plumbing minden knob-hangoláshoz.**
2. **A ledger a `blob_kv` KV-shimen ül** (`ledger-<category>` JSON-blob), **nem** a normalizált `prediction_ledger` táblán — a Postgres-native [`ledger.ts`](../../packages/core/src/ledger.ts) létezik, de **nincs bekötve** (a header maga mondja: „Phase 3 switches the workers … once ported"). A box tiszta lappal indult (nincs Netlify-history importálva). + **F-arb/sports/politics/macro egyáltalán nem ír ledgert**, a HL-nek nincs piaci-ár baseline reconcile-ja (perp). → a tréning-szubsztrátum jelenleg crypto+weather-re teljes, másra részleges/hiányzó.

---

## 3. A három rész-kérdés

### 3.A — Jó gyakorlat: hogyan hangoljunk túlillesztés nélkül?

A három legfontosabb elv (mind forrásolt, mind a mi kényszereinkre szabva):

**1. Váltsd a célfüggvényt PnL/Sharpe-ról proper-score-ra / kalibrációra.** Ez a legjobb illeszkedés a szakirodalom és az architektúránk között, mert a botok **valószínűség-előrejelzők**. A proper scoring rule (log-loss, Brier, CRPS) csak akkor minimális, ha az előrejelzés = a valós eloszlás; **minden predikcióból informál (a skippeltekből is)** → az effektív N sokszorosa a realizált PnL-nek, a varianciája töredéke. A PnL/Sharpe tucatnyi trade-en pár longshot-kimenettől és útvonal-szerencsétől függ (a mi „a profit 4 longshoton ül" patológiánk). **A log-loss maximálisan érzékeny a túlbizonyosságra** — pont amit a Kelly-sizing megbüntet. **Konkrétan: egy knob-váltás CSAK akkor promótálható, ha a proper-score-t (log-loss / Brier-reliability) javítja értelmes N-en, a PnL másodlagos megerősítő kapu.** ([arXiv 2407.17697](https://arxiv.org/pdf/2407.17697))

**2. Regularizáció-first, nem jobb kereső.** A cure a *kevesebb szabadságfok*, nem a jobb optimalizálás:
- **Kevesebb knob.** Minden tunable dimenzió szorozza az effektív N-t és a DSR-küszöböt (√ln N). **Auditáld, mely knobok load-bearing vs holt/kozmetikus, és nyugdíjazd a többit;** a maradékot fixáld elmélet-alapú konstansként.
- **Plateau, nem peak.** Ha egy knobot állítasz, sweepeld paper-ben és a **széles, lapos régió közepét** válaszd (a szomszédok is jók), ne egy izolált csúcsot — a plateau definíció szerint robusztus OOS. ([ScienceDirect S095070512400265X](https://www.sciencedirect.com/science/article/abs/pii/S095070512400265X))
- **Ensemble a configok fölött, ne szelektálj egyet.** A configok egy sávjának átlagolása szigorúan robusztusabb, mint a legjobbra fogadni.
- **Shrink a default felé** (a meglévő IC Bayes-blend ezt teszi) — széles priorok, ne éles értékek.
- **A risk-guardrailek (Kelly-cap, 8% binary cap, loss-limit, DD-kill) SOHA nem tuning-tárgyak** — ezek biztonsági korlátok, nem teljesítmény-knobok.

**3. Tedd a DSR-t őszintévé (effektív trial-szám) + purge/embargo higiénia.** A jelenlegi DSR literál trial-*számot* használ; a korrekt N az **effektív** (klaszterezett): a knob-tweak-ek fele közel-duplikátum (0.02→0.05 nudge), ezeket klaszterezni kell (López de Prado ONC → klaszter-szám = N_eff) + a **cross-trial SR-varianciát** trackelni (a DSR-hez mindkettő kell). A CPCV-motort **ne** építsd (az a backtest-őszinteséget *szimulálja*, ami nálunk ingyen van), de a **szellemét** importáld: az átfedő/korrelált predikciókat (azonos BTC strike-létra, azonos város temp-bucketek) **de-duplikáld minden forward-statisztika előtt** (különben az effektív N, IC, t-stat, DSR mind túlbecsült), és **embargózd a change-pointot** (a knob-váltás utáni első trade-ek részben a régi config alatt indultak). ([Deflated Sharpe](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) · [Purged CV](https://en.wikipedia.org/wiki/Purged_cross-validation))

**Csapdák (NE építsd, mind a három ág megjelölte):**
- ❌ **Bayes-opt / TPE / Optuna a live-PnL-en vagy Sharpe-on.** *Adaptív* overfitting — hatékonyabban vadássza a validációs-halmaz zaját, mint a random search, és minden kiértékelés egy új DSR-trial. Csak offline, nagy-N, nem-pénzügyi al-problémán biztonságos (pl. EMOS-σ ezer állomás-napon). ([LIACS](https://ada.liacs.nl/papers/SchEtAl25.pdf))
- ❌ **Grid-search a trade-subset PnL-jén.** A MinTRL szerint ezek a különbségek a mi N-ünkön **nem mérhetők** — ez zaj-illesztés tudományos máz alatt.
- ❌ **Gyakori re-optimalizálás + a meta-paraméterek (lookback, retune-kadencia) hangolása.** Másodrendű overfitting; minden refit friss trial. **Pin-eld policy-vel.**
- ❌ **Knob hozzáadása egy megfigyelt élő anomália „megmagyarázására".** Minden új knob emeli a √ln N DSR-küszöböt; a False Strategy Theorem garantálja, hogy *találsz* egy lenyűgöző hamis konfigot.

### 3.B — Honnan az adat: a labeled dataset felépítése

**A központi aszimmetria:** a **kimenet/`y` oldal** (a label) szinte mindenütt visszatölthető és ingyenes; a **feature/`x` oldal** doménenként megoszlik — és a legértékesebb feature-ök egy része **nem visszatölthető → log-forward**. Részletes mátrix: §4. A fő megállapítások:

**Teljesen backfillelhető, ingyen (a labeled dataset gerince):**
- **Polymarket:** ár-idősor per token (`CLOB /prices-history`) + rezolvált kimenetek skálán (`Gamma /events?closed=true` keyset — a `closed=true` kvirk kötelező) + trade-history bulk (Data API + Envio/subgraph on-chain, 2020-tól; ⚠ CTF Exchange **V2 kontraktus-váltás 2026-04-28** → a backfill uniózza az old+new kontraktust). = tiszta ár-path→ismert-kimenet tréning-halmaz.
- **Crypto:** teljes OHLCV (spot 2017-, perp 2019-) + funding-history minden granularitáson, `data.binance.vision` bulk-dumpokból + REST. A tick trades/aggTrades dumpokból **offline rekonstruálható az orderflow-feature (Kyle-λ/VPIN/Hawkes)**, amit ma csak live számolunk — valós upgrade-lehetőség.
- **Weather:** Open-Meteo **Historical Forecast API** (igazi múltbeli modell-futások, IFS 2017-, GFS 2022-) × ERA5 (Open-Meteo Archive / Copernicus CDS) **vagy** METAR (Iowa State ASOS-archívum, állomás-egzakt) mint `y` → valós EMOS `(forecast, realized)` párok, jórészt ingyen.
- **HL:** candle + funding backfillelhető (candle 5000-es chunk-cap, funding 500-as).

**Részleges / drága:**
- **Crypto OI-history:** Binance API **~30 nap**, Bybit rövid retenció; a Binance `metrics` daily dump részben menti (futures) → **hosszú OI-sorhoz log-forward.** ⚠ **Ez a legerősebb log-forward érv: a #5 OI-Δ signal tréning-adata nem rekonstruálható visszamenőleg.**
- **Sports Pinnacle closing:** the-odds-api `regions=eu` (5-perces snapshotok 2020-tól, **de scraped-with-delay + fizetős historical, 10× credit**); ingyenes alternatíva football-data.co.uk (soccer, Pinnacle PS/PSC oszlop 2000-től) + Kaggle/SBR (US). A Polymarket↔event matching manuális (entity-resolution). → **elég egy offline de-vig kalibrációs halmazhoz**, a live-hoz külön feed-döntés.
- **Deribit IV-felület/RND:** DVOL + realized-vol ingyen és mély (2021-); a **teljes historikus opció-lánc (SSVI+Breeden-Litzenberger-hez) NEM a public REST-ből** → tardis.dev (2019-, fizetős, de az **ingyenes elseje-havi snapshot** elég a pipeline megépítéséhez/validálásához) vagy log-forward.

**Kötelező log-forward MOST (history nem szerzi meg — minden nap véglegesen elveszett adat):**
1. **Polymarket könyv-mélység** (`CLOB /book` snapshot cronon) — a #1 depth-aware fill-modell + Kyle-λ/VPIN élő szubsztrátuma.
2. **HL open interest** (`metaAndAssetCtxs` poll) **+ `l2Book` WS-recorder** — az API nem ad OI/mélység historyt.
3. **Hosszú crypto OI** (Binance/Bybit snapshot) — a #5 OI-Δ signal.
4. **Deribit opció-lánc snapshot** (`get_book_summary_by_currency`) — az RND-réteg.
5. **Pinnacle live-close snapshot** — a folyó the-odds-api historical-költség elkerülésére.

> **A ledger a Polymarket price/outcome tréning-halmaz kanonikus tárolója lesz** — a `prediction_ledger` Postgres-táblára portolva (jelenleg blob_kv), a #B12-höz kötve.

### 3.C — Hogyan történjen: a konkrét pipeline

**1. Offline kalibráció (a valódi „training", ahol biztonságos):** külön batch-job (a Hetzner-fázisban Python model-service, addig `.mts` script), ami a §3.B nagy-N historikus adatán illeszti a **modell**-paramétereket, **nem a trade-PnL-en**:
- weather EMOS/NGR (a,b,c,d) CRPS-minimalizálással rolling per-város/évszak ablakon (a Gauss-CRPS zárt) — az `weather/emos-store.mts` reconcile-pipeline már ezt csinálja live METAR-obs-szal; a historikus seed felgyorsítja (a live-log kifutásáig down-weightelve, hogy ne legyen train/serve skew);
- sports Shin insider-frakció-kalibráció a football-data.co.uk / the-odds-api Pinnacle-close-jain;
- crypto HAR-RV együtthatók + vol-modell OLS a Binance-klinákon; opcionálisan az orderflow-IC offline a tick-dumpokból.
- **Itt — és CSAK itt — használható plateau-search vagy szűk Bayes-opt**, mert a cél nagy-N és nem a trade-PnL.

**2. Forward-native knob-tuning (a live ledgeren, fegyelmezetten):**
- a promóciós kapu **pre-regisztrált és numerikus**: egy default-OFF knob csak akkor megy ON-ra, ha (a) van mechanisztikus hipotézis, miért edge; (b) javítja a proper-score-t értelmes N-en; (c) a DSR/PSR átlép az effektív-trial-számhoz igazított küszöbön; (d) egy valóban későbbi, OOS ledger-szakaszon megerősítve;
- a legtöbb gate/threshold knob **fixen marad** (a MinTRL szerint a különbségük nem mérhető) — a tuning csak a **kevés strukturális, nagy-karú** paraméterre (melyik fair-value-metódus, fill-modell ON/OFF, Kelly-scale-sáv);
- **per-trade config-címkézés** (§2.C.1) — a hiányzó plumbing, ami ezt egyáltalán lehetővé teszi.

**3. Online adaptív réteg (a meglévő fölé):**
- **Tartsd az AdaHedge-et** — ez a helyes, paraméter-mentes online-tanuló a súlyozásra, nincs jobb a polcon ehhez a mintához ([AdaHedge/FlipFlop](https://arxiv.org/abs/1301.0534)). Olcsó finomítás: *sleeping/specialist experts* (a dormant signal ne kapjon súlyt) + *fixed-share/tracking* (beépített regime-felejtés).
- **Diszkontált Thompson-sampling a diszkrét presetek fölött** (confidence-min, Kelly-scale-sáv, take/skip egy marginális trade), **proper-score-jutalommal** (nem nyers PnL), decayed Beta-számlálókkal a non-stacionaritásra. **Ez az egyetlen erős ÚJ adaptív technika** — olcsó, elvi, minta-hatékony, és a korrekt, kezelhető helyettese a „hadd hangolja magát a bot" impulzusnak (ami különben RL lenne). ([Thompson tutorial](https://arxiv.org/abs/1707.02038))
- **Egységes felejtési faktor** (~50–100 rezolvált trade fél-életidő) a Platt-kalibráció + realized-IC-shrinkage + bandit-poszterior fölött megosztva — **állítsd be, ne tanuld** (a `icHalfLifeTrades` knob a helyes mechanizmus).
- **Champion-challenger shadow-promóció:** a bandit *javasol*, a shadow-eval *dönt* — a challenger config paperben fut a live champion mellett ugyanazon a piac-streamen, proper-score-on hasonlítva, promóció csak a pre-regisztrált, multiple-testing-tudatos küszöbön. **Bounded controller:** clamp-elt lépés, hard floor/ceiling minden knobon, auto-revert safe-default-ra anomáliára; **az adaptív hurok SOHA nem tágíthatja a saját risk-limitjét.** ([Sculley 2015 hidden-technical-debt](https://papers.nips.cc/paper/2015/hash/86df7dcfd896fcaf2674f757a2463eba-Abstract.html))

**RL — a verdikt:** **NE építs end-to-end RL-t alfára vagy sizingra, most és sokáig.** Minden tengelyen bukik, ami nálunk van: 10⁴–10⁷ minta-igény vs. tíz–pár száz; seed/hiperparaméter-irreprodukálhatóság élő számlán ([Henderson 2018](https://arxiv.org/abs/1709.06560)); **reward-hacking** — egy tanult sizer a tökéletlen paper-fill-modellt fogja kihasználni (pont a #1 bug); non-stacionaritás + sim-to-real gap; és a szelekciós-bias-felfújt backtestet a saját DSR-ünk zajként jelölné. **Az egyetlen védhető RL-láb a szűk execution/liquidation-optimalizálás — de csak élő kereskedés + HF orderbook-szimulátor után, és ott is Almgren-Chriss vagy bandit az első lépés, nem PPO.** Minden „tanuljon a bot" impulzust a §3.C.3 Thompson-loop-ba kell terelni.

---

## 4. Az adat-mátrix (domain | forrás | mélység | költség | elég-e kalibrációhoz)

| Domén | Legjobb forrás | History-mélység | Költség | Elég? |
|---|---|---|---|---|
| **PM árak** | CLOB `/prices-history` (token-id) | piac teljes élete | Ingyen | ✅ ár-path/piac |
| **PM kimenetek** | Gamma `/events?closed=true` (keyset) | 2020- | Ingyen | ✅ tiszta label (`closed=true` kvirk!) |
| **PM trade-ek** | Data API `/trades` + Envio/subgraph | 2020- | Ingyen | ✅ bulk (V2-split 2026-04-28) |
| **PM könyv-mélység** | CLOB `/book` (csak live) | **nincs** | Ingyen | ❌ **log-forward** |
| **Crypto klina** | `data.binance.vision` + REST | 2017/2019- | Ingyen | ✅ |
| **Crypto funding** | Binance `/fapi/v1/fundingRate`, Bybit v5 | listázástól | Ingyen | ✅ |
| **Crypto OI** | Binance `openInterestHist` / `metrics` dump | **~30 nap** API | Ingyen | ⚠ **log-forward hosszú sorhoz** (#5) |
| **Crypto könyv-mélység** | `data.binance.vision` `bookDepth`/`bookTicker` (futures) | symbol-függő | Ingyen | ⚠ snapshot, nem folytonos L2 |
| **Sports (Pinnacle-close)** | the-odds-api `/v4/historical` (`regions=eu`) | 5-perc snapshot 2020- | **Fizetős** (free 500/hó) | ⚠ scraped-delay + 10× credit |
| **Sports (ingyen)** | football-data.co.uk (soccer), SBR/Kaggle (US) | soccer 2000- | Ingyen | ⚠ sport-korlátozott |
| **Deribit DVOL** | `get_volatility_index_data` | 2021- | Ingyen | ⚠ egy sor, nem felület |
| **Deribit IV-felület/RND** | live-snapshot; **tardis.dev** history | live ingyen / vendor 2019- | Ingyen live / **fizetős** | ❌ **log-forward vagy tardis** |
| **Weather EMOS-párok** | Open-Meteo Historical Forecast + ERA5/METAR | több év | Ingyen | ✅ |
| **HL candle/funding** | `info` `candleSnapshot`/`fundingHistory` | backfillelhető (cap) | Ingyen | ⚠ OI/mélység log-forward |

**Ahol log-forward MOST kell (nem visszatölthető):** PM könyv-mélység · HL OI + könyv-mélység · hosszú crypto OI · Deribit teljes IV-felület · Pinnacle live-close.

---

## 5. Pontozott ajánlás-mátrix (a training-infra tételei)

`Priority = 3·Edge + 2·Effort + Confidence`, kapuk: Infra (`TS-now`/`Hetzner`), Adat (ingyen/fizetős).

| # | Tétel | Réteg | Edge | Effort | Infra | Conf | **Prio** |
|---|---|---|---|---|---|---|---|
| 1 | **Proper-score/kalibráció mint promóciós CÉLFÜGGVÉNY** (PnL helyett) | tuning-fegyelem | 5 | 4 | TS-now | 5 | **28** |
| 2 | **Log-forward adat-recorderek** (PM book, HL OI+L2, crypto OI, Deribit chain, Pinnacle) — **minden nap végleg elvész** | adat | 5 | 3 | TS-now* | 5 | **26** |
| 3 | **Effektív-trial DSR** (ONC-klaszterezés + cross-trial SR-var + embargo + korrelált-predikció de-dup) | validáció | 4 | 4 | TS-now | 4 | **24** |
| 4 | **Per-trade config-címkézés a ledgeren** (a hiányzó A/B-plumbing) | infra | 4 | 3 | TS-now | 5 | **23** |
| 5 | **Offline kalibrációs harness historikus adaton** (weather EMOS / sports Shin / HAR-RV — nagy-N cél) | training | 4 | 3 | TS-now/Hetzner | 4 | **22** |
| 6 | **Diszkontált Thompson-sampling preset-választó** (proper-score-jutalom) + champion-challenger | online | 4 | 4 | TS-now | 3 | **23** |
| 7 | **Regularizáció-budget** (holt-knob audit + plateau-sweep + ensemble-over-configs) | tuning-fegyelem | 3 | 4 | TS-now | 4 | **21** |
| 8 | **Egységes felejtési faktor** (Platt+IC+bandit, ~50–100 trade, set-not-learn) | online | 3 | 5 | TS-now | 4 | **23** |
| 9 | **Ledger→Postgres + ledger F-arb/sportsra + HL piaci-ár baseline** (B12) | infra | 3 | 3 | TS-now | 4 | **20** |
| 10 | **Foundation-modell (Chronos-Bolt) mint KALIBRÁLT combiner-input** | training | 3 | 2 | Hetzner | 3 | **16** |
| 11 | **Kontextuális bandit (LinUCB)** presetekre regime-feature-rel | online | 3 | 2 | Hetzner | 2 | **15** |
| 12 | **Offline orderflow-IC a Binance tick-dumpokból** (Kyle-λ/VPIN) | training | 2 | 2 | Hetzner | 3 | **13** |

\* a recorderek TS-now, de a **folytonos** WS-recorder (HL `l2Book`) perzisztens worker → részben Hetzner.

---

## 6. Prioritált roadmap (jelölt — jóváhagyásra)

**A. lépcső — TS-now, mérés-first / regresszió-mentes:**
1. **Proper-score promóciós kapu** (#1) — a MEGLÉVŐ mérés élesítése döntéssé: egy knob-váltás/default-OFF-flip csak proper-score-javulás + effektív-DSR után promótál. **Ez a legolcsóbb, legerősebb kar — először ezt.**
2. **Log-forward recorderek** (#2) — PM `/book`, crypto OI, Deribit chain, Pinnacle snapshot cronok **azonnal** (a HL `l2Book` WS a Hetzner-fázisban). Minden halasztott nap véglegesen elveszett tréning-adat.
3. **Effektív-trial DSR** (#3) + **per-trade config-címkézés** (#4) — a validáció őszintévé tétele + az A/B-attribúció plumbingja.
4. **Offline kalibrációs harness** (#5) a historikus seed-en (weather EMOS a legkiforrottabb, az `emos-store` már fél-kész) — a `weatherUseEmos`/`sportsUsePinnacle`/`useHarRv` default-OFF knobok élesítésének adat-alapja.
5. **Diszkontált Thompson-sampling** (#6) + **egységes felejtési faktor** (#8) + **champion-challenger** shadow-promóció.
6. **Regularizáció-budget** (#7) — holt-knob audit + a maradék plateau-sweepje.
7. **Ledger→Postgres + F-arb/sports ledger + HL baseline** (#9, B12-hez kötve).

**B. lépcső — Hetzner / nagyobb adat:**
8. **Foundation-modell** (Chronos-Bolt) mint kalibrált combiner-input (legkisebb checkpoint, on-demand service; SOHA nyers kvantilis a Kelly-be).
9. **Kontextuális bandit** (LinUCB) presetekre — ≥ pár száz rezolúció/bot után.
10. **Isotonic/beta kalibráció** — ≥ 500 rezolúció után (addig Platt).
11. **Logisztikus/ridge stacking** (≥150–200), majd GBM (≥1000).
12. **Offline orderflow-feature kalibráció** a tick-dumpokból.
13. **RL CSAK execution/liquidationra** — élő kereskedés + HF-szimulátor után, Almgren-Chriss/bandit elsőként.

**NE építsd (mind a három ág megjelölte):** end-to-end RL alfára/sizingra · a felejtési faktor / learning-rate online tanulása · bármely risk-guardrail auto-tuningja · Bayes-opt a live-PnL-en · CPCV/backtest-motor · foundation-modell nyers kvantilise a Kelly-be.

---

## 7. Kritikus figyelmeztetések (load-bearing)

1. **A „training" itt NEM keresőalgoritmus.** A rendszer már forward-native + DSR-trial-trackelt — a state-of-the-art póz. A marginális nyereség (a) a célfüggvény PnL→proper-score váltásában, (b) az effektív-trial-DSR-ben, (c) a tunable-knobok *számának* csökkentésében van — **nem** fancier keresőben, aminek a többsége itt aktívan ártana.
2. **A per-trade config-címkézés hiánya minden A/B-t blokkol.** Amíg nem tudjuk, melyik knob-config termelte a trade-et, csak trial-*szám*-alapú DSR megy (az őszinte korrekció, de a slice-olást lehetetlenné teszi). Ez a #4, előfeltétel.
3. **A log-forward NEM opció, és NEM halasztható.** A legértékesebb tréning-adatok (PM mélység, OI, Deribit-felület, Pinnacle-close) nem visszatölthetők — minden nem-logolt nap véglegesen elveszett. A recordereket a többi munka *előtt* kell elindítani.
4. **Optimalizálni CSAK offline, nagy-N, nem-pénzügyi célon szabad** (EMOS az állomás-napon, Shin a closing-line-on, HAR-RV a klinán). A live trade-PnL-en bármilyen optimalizálás (grid, Bayes, RL) zaj-illesztés — a MinTRL szerint a különbségek a mi N-ünkön nem is mérhetők.
5. **A kalibráció nem gyárt resolutiont.** Egy tökéletesen kalibrált, de alacsony-resolution modell kalibrált ÉS veszteséges — a kalibráció a túlbizonyosság-vezérelt rossz sizinget javítja (a weather-patológia), nem edge-et teremt. Mérd a resolution/skill-score-t is, ne csak a reliability-t.
6. **Az RL alfára/sizingra csapda** — reward-hacking a tökéletlen fill-modellen, sample-inefficiencia 4–7 nagyságrenddel, seed-irreprodukálhatóság élő számlán. A minta-hatékony bandit + kalibráció-fegyelem a hiányzó darab, nem az RL.
7. **Minden A-lépcső TS-now**; a B-lépcső (foundation/stacking/kontextuális-bandit/RL-execution) Hetzner/live-infra precondition (`hetzner-migration.md`).

---

## 8. Kereszthivatkozások a meglévő trackerekhez

- **B11** (walk-forward backtest framework): ennek a discovery-nak a §3.A/#3 a **principled, Hetzner-mentes verziója** — a meglévő `walk-forward.mts` scoring-harness + effektív-trial-DSR kiváltja a nehéz param-optimizer-motort. B11 ezzel jórészt redundáns → átcímkézni „ledger-scoring + honest-DSR"-re.
- **B12** (ledger→Postgres): a #9 közvetlen kiterjesztése (F-arb/sports ledger + HL baseline + `prediction_ledger` tábla-port).
- **B49** (`model-discovery-expansion.md`): a #1 fill-modell, #2 beta-cap, #3 PSR/MinTRL/DSR, #5 OI-Δ, #6 EMOS, #7 Shin **default-OFF knobjai** — ez a discovery adja a **tréning/élesítési protokollt** hozzájuk (mikor, milyen adaton, milyen kapuval flippeljünk ON-ra). Nem duplikálja őket, hanem operacionalizálja.
- **B41** (`model-discovery-forecasting.md`): a mérés-only kalibráció/AdaHedge/proper-scoring élesítése — a #1/#6/#8 ennek a végrehajtási fegyelme.
- **B15/B35/B40** ← a #5 offline EMOS-harness a weather σ-kalibrációhoz. **B37 + odds-task** ← a #5 sports Shin offline-kalibrációja.
- **ÚJ (nincs meglévő tétel):** per-trade config-címkézés (#4), log-forward recorder-suite (#2), Thompson-sampling preset-választó (#6), egységes felejtési faktor (#8).

---

## 9. Kulcsforrások

- **Overfitting / trial-korrekció:** [Bailey–Borwein–López de Prado–Zhu — Pseudo-Mathematics (AMS Notices)](https://www.ams.org/notices/201405/rnoti-p458.pdf) · [Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) · [False Strategy Theorem (SSRN 3221798)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3221798) · [Probability of Backtest Overfitting (CSCV)](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
- **CV / walk-forward:** [Purged cross-validation](https://en.wikipedia.org/wiki/Purged_cross-validation) · [Purging/Embargo/CPCV (QuantInsti)](https://blog.quantinsti.com/cross-validation-embargo-purging-combinatorial/) · [Walk-Forward Optimization (QuantInsti)](https://blog.quantinsti.com/walk-forward-optimization-introduction/)
- **Célfüggvény / scoring / plateau:** [Superior Scoring Rules (arXiv 2407.17697)](https://arxiv.org/pdf/2407.17697) · [Parameter-plateau search (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S095070512400265X) · [Adaptív overfitting HPO (LIACS)](https://ada.liacs.nl/papers/SchEtAl25.pdf)
- **Online / adaptív:** [AdaHedge/FlipFlop (arXiv 1301.0534)](https://arxiv.org/abs/1301.0534) · [Hedge (Freund–Schapire)](https://doi.org/10.1006/jcss.1997.1504) · [Thompson Sampling tutorial (arXiv 1707.02038)](https://arxiv.org/abs/1707.02038) · [LinUCB (arXiv 1003.0146)](https://arxiv.org/abs/1003.0146) · [Non-stationary bandits (arXiv 0805.3415)](https://arxiv.org/abs/0805.3415) · [Hidden Technical Debt in ML (Sculley 2015)](https://papers.nips.cc/paper/2015/hash/86df7dcfd896fcaf2674f757a2463eba-Abstract.html)
- **RL — a csapda-oldal:** [Deep RL reproducibility (Henderson 2018, arXiv 1709.06560)](https://arxiv.org/abs/1709.06560) · [Concrete Problems in AI Safety / reward-hacking (arXiv 1606.06565)](https://arxiv.org/abs/1606.06565) · [RL execution (Nevmyvaka–Feng–Kearns 2006)](https://dl.acm.org/doi/10.1145/1143844.1143929)
- **Foundation TS:** [Chronos (arXiv 2403.07815)](https://arxiv.org/abs/2403.07815) · [TimesFM (arXiv 2310.10688)](https://arxiv.org/abs/2310.10688)
- **Adatforrások:** [PM CLOB prices-history](https://docs.polymarket.com/api-reference/markets/get-prices-history) · [PM Gamma closed=true](https://docs.polymarket.com/developers/gamma-markets-api/fetch-markets-guide) · [Envio PM on-chain](https://docs.envio.dev/blog/polymarket-onchain-data) · [data.binance.vision](https://github.com/binance/binance-public-data) · [Open-Meteo Historical Forecast](https://open-meteo.com/en/docs/historical-forecast-api) · [IEM METAR ASOS](https://mesonet.agron.iastate.edu/request/download.phtml) · [the-odds-api historical](https://the-odds-api.com/historical-odds-data/) · [Deribit DVOL](https://docs.deribit.com/api-reference/market-data/public-get_volatility_index_data) · [tardis.dev Deribit](https://docs.tardis.dev/historical-data-details/deribit) · [HL info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
