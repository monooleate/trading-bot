# 34 — Regularizáció-budget (holt-knob audit + plateau-not-peak)

> **Forrás:** [`roadmap/model-discovery-training.md`](../roadmap/model-discovery-training.md) §3.A / #7 (sprints.md B50). **Implementálva:** 2026-09-03 (76. session). **Sprint-tracker:** [`sprints.md` B50](../roadmap/sprints.md#b50).
> **Státusz:** kész — audit + fegyelem-eszköz. `tsc` exit 0 + teszt + build zöld. Nincs kód-törlés (a felszín bekötött); a deliverable a **budget-fegyelem** + a plateau/ensemble helper.

---

## 1. Az audit eredménye: nincs holt knob

A ~96 SCHEMA-knob mind bekötve fogyasztódik — a mechanikus audit (minden kulcs kereszthivatkozása a `config.mts` effective-mapperen, a `signal-combiner`-en és a pillér-logikán át) **0 teljesen holt knobot** talált. (A korábbi egyetlen holt knob — `icHalfLifeTrades` rossz objektumról olvasva — a 67. session-audit már javította.) **Tehát nincs törölnivaló.**

**De pont ez a probléma.** A False Strategy Theorem (Bailey–López de Prado) szerint elég szabadságfokkal garantáltan találunk lenyűgöző, de hamis konfigot; minden tunable dimenzió szorozza az effektív trial-számot (√ln N DSR-büntetés, #3) és emeli a MBTL-t. **96 dimenzió messze több, mint amit a minta (tíz–pár száz trade/bot) elbír.** A regularizáció itt nem törlés, hanem **fegyelem:** kevés knobot tunolni, a többit fix, elmélet-alapú konstansként hagyni.

---

## 2. A knob-budget (osztályozás)

| Osztály | Elv | Knobok (példák) |
|---|---|---|
| **A. Risk-guardrail — SOHA nem tuning-tárgy** | biztonsági korlát, human-owned; egy adaptív hurok SEM tágíthatja | `maxKellyFraction`, `*SessionLossLimit(Enabled)`, `riskDdKill*`/`riskVolTarget*`, `*MaxLeverage`, `*MaxEdgeCap`, `*MaxOpenPositions`, `paperNeverStop`, `liveReadyOverrideEnabled` |
| **B. Tunable — kevés, nagy-karú (plateau-sweep szabad)** | strukturális, a forecast-minőséget érdemben mozgatja; sweep + plateau + #4 A/B + #1 kapu | `combinerConfidenceMin`, `edgeThreshold`/`hlEdgeThreshold*`/`weatherEdgeThreshold`/`sportsEdgeThreshold`, `*KellyScale`, `calibrationShrinkageK`, `icHalfLifeTrades`, a domén-metódus-flagek (`weatherUseEmos`/`sportsUsePinnacle`/`useHarRv`/`useDeribitIV`/`combinerLogOddsStrength`/`combinerExtremizeStrength`) |
| **C. Fix theory-default — beállítva, békén hagyva** | elméletből/irodalomból jön; a MinTRL szerint a különbségük a mi N-ünkön nem mérhető → NE sweepeld | `bonferroni*`, `collinearityHighThreshold`, `obImbalance*`, `*MinActiveSignals`, `*Cooldown*`, `*MinPrice`/`btcMinPriceBand`, `*WatchExtremeEdgeThreshold`, `weatherMarketDisagreeMaxC`, `fr*` (a Sprint-47 kalibráció után), `btc*Ms` ablakok, `*ExitBeforeMin`, `weatherForecastDays`/`ApplyCityOffset` |

**Szabály:** csak a **B** osztály sweepelhető, és ott is **plateau, nem peak** + **ensemble a plateau fölött**. Az **A** és **C** default-on marad (az A-t az adaptív hurok #6 sem érintheti).

---

## 3. A fegyelem-eszköz (pure)

[`packages/core/src/plateau.mts`](../../packages/core/src/plateau.mts) — tiszta:
- `selectPlateau(candidates, {tol})` — a **legszélesebb** összefüggő near-best (a maxtól `tol`-on belüli) érték-futam **közepét** választja, nem a csúcsot; `isPeak=true`-t jelez, ha a legjobb egy izolált tüske (törékeny). A plateau definíció szerint érzéketlen a kis paraméter-változásra → robusztus OOS.
- `ensembleWeights(candidates, temperature)` — softmax a score-okon → a plateau fölötti **átlagolás** súlyai (szigorúan robusztusabb, mint egyet választani → csökkenti a szelekciós varianciát).

5-csoportos [teszt](../../packages/core/src/plateau.test.mts): plateau a tüske helyett, izolált-csúcs jelzés, legszélesebb-futam nyer, degenerált/rendezetlen, ensemble (score-monoton, Σ=1, egyenlő→egyenlő).

**Munkafolyamat:** egy B-knobot néhány értéken sweepelsz (paper), a #4 per-config Brier-skill (edge-tracker `configAttribution`) adja a score-okat → `selectPlateau` a robusztus értéket, `ensembleWeights` az alternatíva (ne is válassz egyet). A promócióhoz a #1 kapu + #3 effektív-DSR.

---

## 4. Kapcsolat

- **#3** (effektív-trial DSR): a budget csökkenti az effektív N-t → kevesebb defláció, valódibb szignifikancia.
- **#4** (config-attribúció): a plateau-sweep score-forrása.
- **#1** (promóciós kapu): a sweep-győztes promóciója.
- **#6** (Thompson): az A-guardrailek a bandit-választáson KÍVÜL.
- **Nincs kód-törlés** — a fegyelem doksi- + eszköz-szintű; a knob-osztályok a jövőbeli sweepeket vezérlik.
