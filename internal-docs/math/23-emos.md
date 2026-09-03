# 23 — EMOS/NGR ensemble kalibráció (weather underdispersion-fix)

> **Forrás:** [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) §4.E (B49 #6). **Implementálva:** 2026-09-03 (63. session). **Sprint-tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49). **Elsődleges forrás:** Gneiting et al. 2005 (EMOS / NGR).
> **Státusz:** kész — a residual-log MINDIG fut (adatgyűjtés), az EMOS-apply **default-OFF** (measure-first). `tsc` exit 0 + 33/33 teszt + build zöld.

---

## 1. A probléma

A weather bot iránya jó (`forecast_edge` IC ~+0.39), mégis **veszít** — a tankönyvi ensemble-**underdispersion** ujjlenyomata: a nyers ensemble-szórás (σ) túl kicsi → a bucket-matcher tail-valószínűségei **túlbizakodók** → a ¼-Kelly a legmagabiztosabb (és leggyakrabban téves) tétre méretez. A fix a σ **kalibrálása** a realizált hibához.

---

## 2. A modell (pure)

[`packages/core/src/emos.mts`](../../packages/core/src/emos.mts) — tiszta, I/O-mentes.

- **`gaussianCrps(μ,σ,y)`** — zárt CRPS egy Gauss-előrejelzésre (Gneiting 2005): `σ·[z(2Φ(z)−1)+2φ(z)−1/√π]`, z=(y−μ)/σ. A kalibráció célfüggvénye (a σ-t bünteti, ha alul- vagy túl-diszperz).
- **`emosApply({a,b,c,d}, ensMean, ensStd, varFloor)`** → kalibrált `μ = a+b·ensMean`, `σ = √max(varFloor, c + d·ensStd²)`. A `c` a **variancia-floor** → felfújja a σ-t → kiüti a tail-túlbizakodottságot.
- **`fitEmos(samples, {minSamples,varFloor})`** → {a,b,c,d, rawCrps, calibratedCrps, fitted}. **Two-step OLS:** (1) átlag-map `obs ~ a+b·ensMean` (bias/regresszió-korrekció); (2) szórás `r² ~ c+d·ensVar` (a σ²-t a realizált négyzetes reziduálhoz illeszti → underdispersion-fix). `< minSamples` (20) → identity fallback (nyers passthrough). Determinisztikus (nincs optimizer/RNG). A rawCrps→calibratedCrps mutatja a nyereséget (measure-first). Full CRPS-minimum estimation = follow-up.
- **`observationRank(members, obs)`** → rank-histogram építőelem (∪-alak = underdispersion).

6-csoportos [teszt](../../packages/core/src/emos.test.mts): CRPS zárt-alak pin (N(0,1)@0 ≈ 0,2337), emosApply μ/σ + floor, fit (b≈1, σ-infláció ~2 az underdispersed 0,5-ről, calibratedCrps<rawCrps), identity fallback, observationRank.

---

## 3. Az adat-pipeline + bekötés

**A residual-adat point-in-time — nem rekonstruálható később**, ezért a logolás MOST indul (mint a prediction-ledger), függetlenül attól, mikor élesítjük az apply-t.

| Lépés | Fájl | Mit |
|---|---|---|
| Store | [`weather/emos-store.mts`](../../services/worker/src/pillars/weather/emos-store.mts) | per-állomás rolling residual (`{date, ensMean, ensStd, obs}`) + params-cache (Blobs `weather-emos`). `logForecast` (upsert dátum szerint), `reconcileEmosObs` (**METAR-alapú** obs-fill a lejárt dátumokra + refit), `loadStationEmosParams`. |
| Log (scan) | [`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts) | minden scannelt piacra `logForecast(station.icao, date, predictedMaxC, rawSigma)` — **minden állomás+dátum** (nem csak a traded → torzításmentes). |
| Obs-fill | ugyanott | `reconcileEmosObs(station.icao, station.tz)` — a lejárt residualokra METAR daily-max lekérés + fillObs + refit (budgetelt, best-effort). **Nem trade-függő** → unbiased residual-halmaz. |
| Apply | ugyanott, a `matchBucket` előtt | ha `config.useEmos` ON **és** az állomásnak van fittelt map-je → `emosApply(params, predictedMaxC, rawSigma)` → a kalibrált (μ,σ) megy a bucket-matcherbe. OFF → nyers passthrough (0 trade-változás). |
| Config | [`decision-engine.mts`](../../services/worker/src/pillars/weather/decision-engine.mts) | `useEmos` mező + env `WEATHER_USE_EMOS` + `weatherUseEmos` Blobs-override. SCHEMA knob `weatherUseEmos` (0/1 default 0, category weather). |

---

## 4. Miért default-OFF (apply) de mindig-on (log)

- **A logolás mindig fut** — adatgyűjtés; nem érinti a trading-döntést (best-effort, non-throwing). Ez a „start the clock", mert a fit ~20 feloldott residual/állomás után lesz értelmes (hetek).
- **Az apply default-OFF** (measure-first): a bucket-matcher σ-jának megváltoztatása viselkedés-változtató. Élesítés: a knob ON után az állomás-fit `rawCrps→calibratedCrps` (+ a #4 walk-forward / proper-scoring) mutatja, hogy a kalibráció valóban javít-e; pozitív igazolás után marad ON. Kötődik: [B15](../roadmap/sprints.md) (σ-kalibráció), B35 (weather sizing), B40 (invert re-audit — a rank-histogram teszi objektívvá).

---

## 5. Maradó (follow-up — sprints.md B49)

- **Full CRPS-minimum estimation** a two-step OLS helyett (Gneiting 2005 szerint a spread-re jobb).
- **Rank-histogram az Edge Trackerre** (az `observationRank` már megvan) — vizuális underdispersion-diagnózis.
- **Per-évszak fit** (jelenleg per-állomás, szezon-aggregált).
- **Open-Meteo multi-model blend** (ECMWF IFS+AIFS ENS) az adat-oldalon — külön adat-upgrade (math/16 §3.B).
