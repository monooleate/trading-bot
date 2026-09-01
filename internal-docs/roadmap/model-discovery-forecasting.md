# Model Discovery — Forecasting / probability layer (5 auto-trader bot)

> **Típus:** research discovery (mint az opticut 2D-nesting discovery). **Nem** sprint-terv, **nem** stratégia-katalógus — ez egy forrásolt survey + pontozott ajánlás arról, **milyen open-source modell / elmélet / gyakorlati megvalósítás fejlesztené a meglévő botok predikciós rétegét.**
> **Dátum:** 2026-09-01 · **Scope:** a 4 predikció-vezérelt bot forecasting-magja (crypto, weather, HL directional, sports). Az F-arb kimarad (delta-neutrális carry, nem forecasting-probléma → a hibája kód-bug, `sprints.md` B31).
> **Módszer:** 3 párhuzamos kutatási pillér (foundation modellek; volatilitás + digitális-opció + kalibráció; aggregáció + meta-learner + scoring), primer forrásokkal (arXiv, GitHub, hivatalos docs).
> **Task-promóció:** a §7 prioritált tételei **jelöltek** — a `new-strategies.md` #N / `sprints.md` B-tételekbe csak operátor-jóváhagyás után kerülnek (SSOT-védelem).

---

## 1. A központi probléma

Mind a 4 bot ugyanazt csinálja matematikailag: **megbecsül egy bináris esemény valódi valószínűségét** (`P(BTC>K @ T)`, `P(napi max ∈ bucket)`, `P(perp up)`, `P(csapat nyer)`), és ha ez elég távol van a piaci ártól → trade. A profit tehát **kizárólag a valószínűség-becslés minőségén és kalibrációján** múlik — nem a signal-ötleteken.

A discovery kérdése: **melyik open-source modell / elmélet javítja leginkább ezt a becslést, adott a jelenlegi TypeScript / Netlify Functions infra?**

---

## 2. A jelenlegi stack és a 6 strukturális gyengeség (grounding)

| Réteg | Jelenlegi megoldás | Strukturális gyengeség (dokumentált) |
|---|---|---|
| **Threshold-prob** `P(BTC>K)` | Black–Scholes digital `N(d₂)`, 20-perces winsorizált realized-vol + `[10%,200%]` σ-sáv-guard (`getVolSignal`, B21) | **(G1)** Durva vol-becslés (1 kiugró percre σ 46%→495% ugrott). **(G2)** `N(d₂)` **risk-neutral** mérték → nem a valós-világ resolution-valószínűsége. **(G3)** "by date" (touch) piacokra is `N(d₂)`, holott first-passage kell (~2×). |
| **Jel-aggregáció** | Grinold–Kahn IC-súlyozott **lineáris** átlag (prob-térben), + K-anchored log-odds mód csak threshold-piacon; realized-IC Bayes-shrinkage K=30 | **(G4)** Lineáris pool prob-térben → provably **under-confident** (regresszál a base-rate-hez); a log-odds mód csak threshold-piacon él. IC-priorok kézzel állítva. |
| **Kalibráció** | **Nincs dedikált réteg** (Brier csak B13 sub-task) | **(G5)** Dokumentált **kalibráció-inverzió**: weather (modell 63%→realizált 18%), crypto cond_prob telítés, HL ~13pp túlbizonyosság (B36). A predikció → valós gyakoriság leképezés soha nincs korrigálva. |
| **Adaptáció** | Time-decay IC half-life knob (default 0=uniform) + Coach-mode manuális | **(G6)** Statikus IC-súlyok regime-shiftre törékenyek; a changelog ismételten dokumentál **IC-előjel-flippeket** (orderflow, vol_divergence). Nincs online újrasúlyozás / regime-detektálás. |
| **Értékelés** | PnL + realized-IC | Az értékelés PnL-en megy (n<200-on zajos), nem proper scoring-on; nincs walk-forward-only kalibrációs backtest → leakage-kockázat. |

---

## 3. Értékelési kritériumok (scoring)

Minden jelöltet 5 tengelyen pontozok, majd egy **Priority-score**-ot adok:

| Tengely | Skála | Súly |
|---|---|---|
| **Edge-impact** | mennyire javítja a becslést/kalibrációt (1–5) | ×3 |
| **Effort** | implementációs költség, fordított (5=triviális … 1=heteket) | ×2 |
| **Infra-illeszkedés** | `TS-now` (pure math, `.mts`-be portolható) / `Hetzner` (Python/R service kell) | kapu |
| **Licenc** | permisszív (BSD/MIT/Apache) / blokkoló (NC) / study-only | kapu |
| **Confidence** | mennyire biztos a nyereség a mi piac-típusainkra (1–5) | ×1 |

`Priority = 3·Edge + 2·Effort + Confidence`, azzal a **kemény kapuval**, hogy a `TS-now` + permisszív tételek előrébb sorolódnak (mert azonnal, új infra nélkül szállíthatók).

---

## 4. Kutatási találatok

### A. Threshold-valószínűség és volatilitás

| Jelölt | Mit ad | OSS / licenc | Infra | Verdict |
|---|---|---|---|---|
| **HAR-RV realized-vol motor** (Yang–Zhang RV-ből, opc. jump-komponens) | Rövid-horizontú crypto vol **szisztematikusan jobb**, mint a napi GARCH vagy a jelenlegi 20-perces minutely | OLS ~30 LOC; YZ ~10 LOC; `arch`/R `highfrequency` referencia | **TS-now** | **Legjobb ár/érték a vol-motorra.** Kiváltja a G1 törékeny becslést. |
| **Realized-GARCH** (`rugarch realGARCH`) | A legerősebb dokumentált crypto single-model vol | R (GPL-3) | Hetzner | Csak ha már van Python/R service; TS-ben nem triviális. |
| **Deribit SSVI + Breeden–Litzenberger** | A **piac-implikált** `P_Q(BTC>K)` közvetlenül az opciós láncból → független benchmark a `N(d₂)` mellé; a kettő spreadje **maga a risk-premium/measure-gap** | metódus: `djienne/POLYMARKET_UP_DOWN_DERIBIT_STRATEGY` (⚠ **licenc nélkül** → csak tanulmányozni); `py_vollib` MIT | TS-now (BL = 1 véges differencia) | Erős **új signal** + a G2 diagnózisa. |
| **Measure change (RN→physical)** | A `N(d₂)`/BL risk-neutral; a Polymarket a **valós** kimenetre fizet. Pricing-kernel / drift-korrekció, vagy **empirikusan tanult** korrekció | elmélet: Almeida et al. 2024 (arXiv 2410.15195) | — | A G2 gyökér-fix. **Pragmatikus út: a §C kalibrációs réteg abszorbeálja** a kernel explicit becslése nélkül. |
| **First-passage / one-touch** (reflection principle + Broadie–Glasserman–Kou diszkrét-monitoring korrekció) | "Touch by date" piac ≈ **2× terminal digital**; `N(d₂)` alulbecsül | QuantLib-Python (BSD) referencia; a reflection-formula 2 sor | **TS-now** | **Kötelező market-type routing.** Sose `N(d₂)` touch-piacra (G3). |
| **Foundation modellek** (Chronos-Bolt, TimesFM 2.5 — **Apache-2.0**) | Zero-shot probabilisztikus (kvantilis) forecast; **de** ár-szinten alig verik a random walk-ot, és a **tail-eken túlbizonyosak** (arXiv 2510.16060) | Chronos-Bolt/TimesFM Apache-2.0; Moirai **CC-BY-NC → blokkolt**; TimeGPT closed | Hetzner (Python) | **Csak mint distribution/vol-estimator, KÖTELEZŐ utó-kalibrációval.** Threshold-árra nyersen rákötve edge-et *gyárt* a tail-eken. |

### B. Jel-aggregáció és meta-modell

| Jelölt | Mit ad | OSS / licenc | Infra | Verdict |
|---|---|---|---|---|
| **Logaritmikus (log-odds) pool** minden piacra | A lineáris prob-pool provably **under-confident**; a log-odds átlag a log-loss-optimális család. Már megvan a K-anchored mód threshold-piacra → **általánosítás minden piac-típusra** | pure math ~30 LOC | **TS-now** | **A legmagasabb elmélet/effort arány.** Kiváltja a G4-et. |
| **Disagreement-gated extremizing** (`a≈1.1–1.3`) | A pooling alul-magabiztosságát korrigálja (Satopää/GJP). **De** a mi 8 jelünk részben redundáns → fix `a=1.7` túl-extremizálna; a jelek szórására skálázni | fix konstans, ~5 LOC | **TS-now** | Olcsó nyereség, de **disagreement-kapuval** kötelező (Satopää arXiv 1705.02391). |
| **Online multiplicative-weights / AdaHedge** a jelek fölött + **ADWIN/BOCPD** regime-reset | A statikus IC-súlyokat lecseréli online, self-tuning súlyokra, amik lecsengő IC-jű jelet automatikusan lehúznak; a regime-detektor resetel az IC-ablakon | `River` (BSD-3); `bayesian_changepoint_detection` (MIT) — metódus TS-be portolható | **TS-now** (AdaHedge paraméter-mentes, ~50 LOC) | **Valószínűleg a legnagyobb live-érték** a dokumentált IC-flippek miatt (G6). |
| **Ridge / non-negatív logisztikus stacking** | Tanult súlyok + intercept (base-rate korrekció); a fix IC-súlyok szigorú általánosítása | scikit-learn (BSD-3) | Hetzner | **Csak ≥150–200 tiszta kimenet/bot után.** Addig a Bayes-shrinkage a helyes regularizáló. |
| **GBM stacking** (LightGBM/XGBoost) | — | MIT/Apache | Hetzner | **Elhalasztva ~1000+ kimenetig** — n<200-on túlilleszt + rosszul kalibrált. |
| **LLM-forecasting** (retrieval-augmented) | Near-superforecaster **news-driven** kérdéseken (Halawi 2024); **semmit nem ad** kvantitatív crypto/weather piacra | Halawi/ForecastBench referencia | Hetzner | **Csak sports/politics extra signalként**, sosem a crypto/weather combinerbe, sosem végső aggregátorként. |

### C. Kalibráció és értékelés (a hiányzó réteg — G5)

| Jelölt | Mit ad | OSS / licenc | Infra | Verdict |
|---|---|---|---|---|
| **Platt / sigmoid kalibráció** (walk-forward) | Olcsó parametrikus recalibráció kevés adatra | sklearn (BSD-3) — de a képlet ~15 LOC | **TS-now** | **Az első kalibrációs réteg.** Abszorbeálja a measure-gapet (G2) + modell-bias-t empirikusan. |
| **Isotonic regresszió** | Rugalmasabb, non-parametrikus | sklearn (BSD-3) | TS-now | Default recalibrátor **~100+ kimenet** után (n<<1000-en Platt marad). |
| **Venn–Abers** | Finite-sample valid, **valószínűség-intervallumot** ad (nem pont) | `venn-abers` (MIT) | TS-now (2 isotonic) | **Best-in-class kevés adatra** — ideális event-piacokra. |
| **Conformal / CQR** | Distribution-free coverage garancia a kvantilisek körül | MAPIE / crepes (**BSD-3**) | Hetzner (Python) | Ha coverage-garantált intervallum kell; skalárra overkill. |
| **Proper scoring + Murphy-dekompozíció** (Brier=Reliability−Resolution+Uncertainty, log-score, CRPS weatherre) | A combinert **scoring-on** hasonlítja, nem PnL-en (n<200-on a PnL zajos); a log-score a Kelly-növekedés helyes célfüggvénye | `properscoring` (Apache), sklearn (BSD) | **TS-now** | **Az értékelési harness.** + reliability-diagram az Edge Trackerbe. |
| **Walk-forward-only backtest** | A kalibrátort/súlyokat **szigorúan out-of-sample** illeszti; a globális/random-CV illesztés jövő-leakage | módszertan (López de Prado PBO) | TS-now | **Nem alku tárgya** — leakage kis edge-en illuzórikus PnL-t mutat. |

---

## 5. Pontozott ajánlás-mátrix (a Top jelöltek)

| # | Jelölt | Edge | Effort | Infra | Licenc | Conf | **Priority** |
|---|---|---|---|---|---|---|---|
| 1 | **Kalibrációs réteg** (Platt→isotonic/Venn-Abers, walk-forward, piac-típusonként) | 5 | 4 | TS-now | ✅ | 5 | **28** |
| 2 | **Log-odds pool** minden piacra | 4 | 5 | TS-now | ✅ | 4 | **26** |
| 3 | **Online AdaHedge + regime-reset** (ADWIN/BOCPD) | 5 | 3 | TS-now | ✅ | 4 | **25** |
| 4 | **Proper-scoring eval harness** (log-score + Brier-Murphy + reliability-diagram) | 4 | 4 | TS-now | ✅ | 5 | **25** |
| 5 | **HAR-RV vol-motor** (Yang–Zhang) | 4 | 3 | TS-now | ✅ | 4 | **22** |
| 6 | **First-passage routing** touch-piacokra | 3 | 5 | TS-now | ✅ | 4 | **23** |
| 7 | **Deribit SSVI+BL** market-implied benchmark-signal | 4 | 2 | TS-now* | ⚠ study | 3 | **19** |
| 8 | **Disagreement-gated extremizing** | 2 | 5 | TS-now | ✅ | 3 | **19** |
| 9 | **Foundation model** (Chronos-Bolt) mint kalibrált vol/distribution-estimator | 4 | 2 | Hetzner | ✅ | 3 | **19** |
| 10 | **Logisztikus ridge stacking** (≥150–200 kimenet után) | 3 | 3 | Hetzner | ✅ | 3 | **18** |

\* a Deribit-fetch TS-ben megy, az SSVI-fit + BL is portolható; a referencia-repo csak metódusra.

---

## 6. Per-bot ajánlás

- **Crypto (threshold):** a magprobléma a **measure-gap + törékeny vol** (G1–G3). Sorrend: (1) kalibrációs réteg a `finalProb`-ra piac-típusonként, (2) HAR-RV vol-motor a `getVolSignal`-be, (3) Deribit SSVI+BL mint 9. signal + measure-gap diagnózis, (4) first-passage routing a "by date" piacokra, (5) log-odds pool általánosítás. → A profit "4 longshoton ül" patológia jórészt kalibrációs: a tail-árazás túlbizonyos.
- **Weather:** már **eloszlás-forecast** (Gauss bucket) — a baj a **sizing az ensemble-egyetértésre** + kalibráció-inverzió. Fix: (1) **isotonic kalibráció a bucket-valószínűségekre**, (2) **CRPS-alapú értékelés** + reliability-diagram (ez tenné láthatóvá a B40 invert-dilemmát objektíven), (3) a Kelly a **kalibrált edge-re** méretezzen, ne az ensemble-confidence-re. Foundation modell **nem kell** (a GFS-ensemble már jó). ECMWF 51-tagú ensemble = külön adat-upgrade (math/16 §3.B), nem modell-kérdés.
- **HL directional:** a **~13pp túlbizonyosság (B36)** tiszta **kalibrációs probléma** → Platt-kalibráció a `finalProb→win-prob` leképezésre. A "jelek kioltják egymást" (B34: vol_divergence −0.32 vs orderflow +0.20 pozitív súllyal) → **online AdaHedge sign-aware súlyozás** + regime-reset. Ez a bot profitálna a legtöbbet a §5/#3-ból.
- **Sports:** a "fair value" **fabrikált** (a Polymarket-ár 0.5 felé húzása) → nincs edge-forrás (B37). Ez **modell-fix**: **Pinnacle de-vig** (Shin / multiplicative / power-method) → valódi fair value, majd log-odds pool + kalibráció. Később **LLM retrieval extra signalként** a narratíva-vezérelt meccsekre (az egyetlen bot, ahol az LLM elméletileg hozzáad).

---

## 7. Prioritált roadmap (jelölt — jóváhagyásra)

**A. lépcső — TS-now, új infra nélkül (`.mts`-be portolható, permisszív/pure-math):**
1. Proper-scoring eval harness (log-score + Brier-Murphy + reliability-diagram) az Edge Trackerbe — **ez validálja a többit** → először ezt.
2. Kalibrációs réteg (Platt→isotonic/Venn-Abers), walk-forward, piac-típusonként.
3. Log-odds pool általánosítás minden piac-típusra.
4. Online AdaHedge + ADWIN/BOCPD regime-reset a jel-súlyokra.
5. HAR-RV (Yang–Zhang) vol-motor a `getVolSignal`-be.
6. First-passage routing a "by date"/touch piacokra.
7. Deribit SSVI+BL market-implied benchmark-signal (metódus a djienne-repóból, kód nélkül).
8. Disagreement-gated extremizing (a log-odds pool után).
9. Sports Pinnacle de-vig (modell-fix, B37 kiváltása).

**B. lépcső — Hetzner-fázis (Python/R service kell):**
10. Foundation model (Chronos-Bolt / TimesFM 2.5) mint **kalibrált** distribution/vol-estimator — kötelező utó-kalibrációval + random-walk+GARCH baseline-hoz mérve.
11. Realized-GARCH (`rugarch`) a vol-motorra.
12. Logisztikus ridge stacking (≥150–200 kimenet/bot után), majd GBM (~1000+ után).
13. LLM retrieval-signal sports/politics-ra.

---

## 8. Licenc- és infra-összefoglaló

- **Azonnal használható (permisszív):** scikit-learn / River / MAPIE / crepes / venn-abers **BSD-3**; LightGBM / reliability-diagrams **MIT**; XGBoost / properscoring **Apache-2.0**; Chronos-Bolt / TimesFM 2.5 **Apache-2.0**.
- **Blokkolt live-ra:** Moirai (**CC-BY-NC**), TimeGPT (closed API).
- **Study-only:** `djienne/POLYMARKET_UP_DOWN_DERIBIT_STRATEGY` (licenc nélkül — metódus igen, kód-másolás nem).
- **Infra-realitás:** az A-lépcső (1–9) mind **pure-math / fetch**, `.mts`-be portolható, **nincs új infra**. A B-lépcső (10–13) Python/R modell-service-t igényel → **Hetzner-migráció** precondition (`hetzner-migration.md`).

---

## 9. Kritikus figyelmeztetések (a discovery load-bearing tanulságai)

1. **Risk-neutral ≠ valós-világ valószínűség.** A `N(d₂)` és a Breeden–Litzenberger is `P_Q`-t ad; a Polymarket `P_real`-re fizet. A gap a variance/skew risk-premium, BTC-n **empirikusan nem-triviális és nem-monoton**. Fix: piac-típusonként stratifikált **empirikus kalibráció** (a kernel explicit becslése nélkül).
2. **A foundation modellek túlbizonyosak a tail-eken** (arXiv 2510.16060) — a threshold-piac pont a tail-ből él → nyers rákötés **fake edge-et gyárt**. Csak kalibrálva + baseline-hoz mérve.
3. **Overfitting <200 kimeneten leaked kalibrációval** a fő kockázat. Minden extra szabadságfok (szabad extremize-param, tanult súlyok, GBM, per-market Platt) egy pici, nem-stacionárius, regime-shiftelő label-halmaz ellen szoroz. Kötelező: **walk-forward-only illesztés, erős shrinkage a priorokhoz, paraméter-mentes online (AdaHedge), fix extremize-konstans, log-score szelekció** + explicit PBO-check live előtt.
4. **A jó irány ≠ jó sizing.** A weather IC +0.393 (jó irány), mégis veszít — a sizing a legmagabiztosabban téves tétre rak a legtöbbet. A kalibráció + CRPS-eval ezt teszi láthatóvá és korrigálja.

---

## 10. Kulcsforrások

- **Foundation:** [TimesFM 2.5](https://github.com/google-research/timesfm/) · [Chronos-Bolt](https://github.com/amazon-science/chronos-forecasting) · [Chronos-2 (arXiv 2510.15821)](https://arxiv.org/pdf/2510.15821) · [TSFM kalibráció (arXiv 2510.16060)](https://arxiv.org/pdf/2510.16060) · [Moirai CC-BY-NC](https://huggingface.co/Salesforce/moirai-2.0-R-small)
- **Vol / RND / measure:** [`arch`](https://arch.readthedocs.io) · [`rugarch realGARCH`](https://alexiosg.r-universe.dev/rugarch) · [djienne/POLYMARKET…DERIBIT (study-only)](https://github.com/djienne/POLYMARKET_UP_DOWN_DERIBIT_STRATEGY) · [Bitcoin risk premia (arXiv 2410.15195)](https://arxiv.org/pdf/2410.15195) · [Pricing kernels BTC (MDPI Risks 11(5):85)](https://www.mdpi.com/2227-9091/11/5/85) · [BGK continuity correction](https://www.columbia.edu/~sk75/mfBGK.pdf)
- **Aggregáció / online:** [Satopää extremizing (arXiv 1705.02391)](https://arxiv.org/pdf/1705.02391) · [Stacking vs BMA (Yao 2018)](https://projecteuclid.org/journals/bayesian-analysis/volume-13/issue-3/Using-Stacking-to-Average-Bayesian-Predictive-Distributions-with-Discussion/10.1214/17-BA1091.pdf) · [AdaHedge (arXiv 1301.0534)](https://arxiv.org/pdf/1301.0534) · [River](https://github.com/online-ml/river) · [BOCPD (Adams & MacKay)](https://arxiv.org/abs/0710.3742)
- **Kalibráció / scoring:** [MAPIE (BSD-3)](https://github.com/scikit-learn-contrib/MAPIE) · [crepes (BSD-3)](https://github.com/henrikbostrom/crepes) · [venn-abers](https://github.com/ip200/venn-abers) · [Triptych reliability (arXiv 2301.10803)](https://arxiv.org/pdf/2301.10803) · [PBO backtest overfitting](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253)
- **LLM-forecasting:** [Halawi 2024 (NeurIPS)](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a5acfd0876c940d81619c1dc60e7748-Paper-Conference.pdf) · [ForecastBench (arXiv 2409.19839)](https://arxiv.org/pdf/2409.19839)
