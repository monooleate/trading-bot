# 31 — Offline EMOS seed (weather, historikus kalibráció)

> **Forrás:** [`roadmap/model-discovery-training.md`](../roadmap/model-discovery-training.md) §3.C + §6 (B50 #5, weather-ág). **Implementálva:** 2026-09-03 (73. session). **Sprint-tracker:** [`sprints.md` B50](../roadmap/sprints.md#b50).
> **Státusz:** kész, **manuális egyszeri backfill** (`scripts/seed-emos.ts`), mérés-only. `tsc` exit 0 + teszt + build zöld. Épít a B49 #6 EMOS-infrára ([`math/23-emos.md`](./23-emos.md)).

---

## 1. A kérdés

A weather EMOS-kalibrátor (B49 #6) **csak ≥20 forward-residual után fittel** → a `weatherUseEmos` a deploy után hetekig nem csinál semmit. De a két legfontosabb korrekció **historikus adatból MOST becsülhető:** a szisztematikus állomás-bias (egy város forecastja melegebbet/hidegebbet ad) **és a valós forecast-hiba-szórás** (az underdispersion-fix). Cél: a kalibrátor legyen fittelt az első naptól.

---

## 2. Adat + módszer

**Mindkét forrás keyless, ~2 hívás/állomás:**
- **Forecast (`x`):** Open-Meteo **Historical Forecast API** (`historical-forecast-api.open-meteo.com`) — **több determinisztikus modell** (`ecmwf_ifs025`, `gfs_seamless`, `icon_seamless`, `gem_seamless`) egy hívásban → a modellek közti átlag = `ensMean`, a modellek közti (populációs) szórás = `ensStd`. Ez egy **legitim ensemble-spread proxy historikus adatból** (a **valódi** production-ensemble-spread visszamenőleg NEM archivált). Élő-verifikált: London/3 hó → 4 modell × 91 nap, a kulcsok pontosan `temperature_2m_max_<model>`.
- **Realized (`y`):** Open-Meteo **Archive API** (ERA5) — napi max az állomás cellájában.

A pár → `(ensMean, ensStd, obs)` triple → **a meglévő `fitEmos`** (B49 #6) fittel `μ = a+b·ensMean`, `σ² = c+d·ensVar`-t. A `c` term a valós forecast-hiba varianciáját abszorbeálja → **kiüti a tail-túlbizonyosságot** (az underdispersion-fix), a (a,b) korrigálja a szisztematikus bias-t.

**Miért SEED, nem az igazság** (őszinte korlát): a modellek-közti spread ≠ a production-ensemble spread-je, az ERA5 cella ≠ a pontos METAR-állomás. Ezért a seed **le van súlyozva:** régi dátumokra kerül, és a gördülő per-állomás ablakból **kiöregszik**, ahogy a forward-logolt (production-matched, METAR-obs) residual-ok felhalmozódnak és lecserélik.

---

## 3. Implementáció

- **Pure parserek** [`packages/core/src/emos-seed.mts`](../../packages/core/src/emos-seed.mts): `parseDailySeries` (Open-Meteo `daily` → date→érték Map, explicit null-guard a `Number(null)===0` ellen), `buildSeedSamples` (modell-sorozatok + realized → `(ensMean, ensStd, obs)` triple-ök; ≥`minModels` modell/nap; populációs inter-modell szórás), `seedDateWindow`. 4-csoportos [teszt](../../packages/core/src/emos-seed.test.mts).
- **Store-inject** [`weather/emos-store.mts`](../../services/worker/src/pillars/weather/emos-store.mts) új `injectSeedResiduals(station, samples)`: **csak a még nem tárolt dátumokat** adja hozzá (`seed: true` tag; SOSEM ír felül forward-residualt), cap + `refit`. A store I/O egy helyen marad (nincs duplikáció).
- **Orchestrator** [`weather/emos-seed.mts`](../../services/worker/src/pillars/weather/emos-seed.mts): `seedStationEmos` (fetch multi-modell FC + ERA5 → buildSeedSamples → inject; best-effort, `error`-t ad throw helyett) + `seedAllStations` (a `SETTLEMENT_STATIONS`-ön, ICAO-dedup, szekvenciális).
- **Trigger** [`scripts/seed-emos.ts`](../../scripts/seed-emos.ts) (Bun): `setBlobsDb(pool())` + `seedAllStations(months)`. **A boxon futtatandó** (`docker compose exec workers bun scripts/seed-emos.ts [months]`, default 6). Idempotens (a tárolt dátumokat kihagyja), újrafuttatható.

---

## 4. Kapcsolat + follow-up

- **Épít:** [`math/23-emos.md`](./23-emos.md) (B49 #6 EMOS-fitter + store) — ez annak a **historikus adat-táplálója**. Kötődik B15 (σ-kalib) / B35 (weather sizing) / B40 (invert-döntés).
- **Operatív:** a seed hatása csak `weatherUseEmos=1` mellett él (a kalibrált μ,σ-t akkor használja a bucket-matcher). A seed önmagában 0 trading-hatás (csak a store-t tölti).
- **Follow-up (B50 #5 többi doménje):** **sports Shin** kalibráció a football-data.co.uk / the-odds-api Pinnacle-close-jain (a `devig.mts` `devigShin` már kész, B49 #7); **crypto HAR-RV** fit a Binance-klinákon (`har-rv` már kész, forecasting #5). Weather-follow-up: METAR-obs a seedhez (a forward-pipeline obs-forrásával konzisztens, az ERA5 helyett) + rank-histogram diagnosztika.
