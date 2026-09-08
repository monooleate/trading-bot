# 37 — Weather multi-model ensemble (B52 #1)

> **Státusz:** log-forward recorder **ÉL** (default-ON, mérés-only) · a trading-flip
> (`weatherUseMultiModel`) **default-OFF**, a felvett head-to-head bizonyítékára vár.
> Feladat-tracking: [`sprints.md` B52](../roadmap/sprints.md) · adatforrás-kontextus:
> [`16-weather-bot.md` §3.B (d)](./16-weather-bot.md) · env: [`env-vars.md` §13](../current-state/env-vars.md).

---

## 1. A probléma: egyetlen modellcsalád nem tudja megmérni a saját tévedését

A weather bot σ-ja eddig **egy** ensemble-rendszerből jött: a 31-tagú NCEP GEFS
([`ensemble-forecast.mts`](../../services/worker/src/pillars/weather/ensemble-forecast.mts)
`fetchEnsemble`, `models=gfs_seamless`). Ez a σ megy a
[bucket-matcher](./16-weather-bot.md#5-bucket-matching--gauss-cdf-interval-allokáció-v2-2026-05-11) Gauss-CDF-jébe,
onnan a P(YES)-be, onnan a **Kelly-méretezésbe**.

Egy ensemble szórása a modell **saját** perturbációinak szórása: azt méri, mennyire
érzékeny a kezdeti feltételekre — **nem** azt, hogy a modell fizikája téved-e.
Strukturális hibát (rácsfelbontás, konvekciós parametrizáció, határréteg-séma) az
összes tag *együtt* hordoz, tehát a spread nem látja. Ez az ensemble-underdispersion,
és pontosan illik a dokumentált weather-patológiára:

| Mérés (2026-07-23 audit) | Érték | Olvasat |
|---|---|---|
| `forecast_edge` IC | **+0.393** | az **irány** jó |
| payoffRatio | **0.44** | „win small, lose big" — a **méretezés** rossz |

Túl szűk σ → túl magas P(YES) a megfogadott oldalon → túl nagy Kelly → pont a
legmagabiztosabban téves tétre kerül a legtöbb pénz.

### Élő bizonyíték (RJTT Tokyo, 2026-09-09 célnap, T+1)

A négy rendszer ugyanarra a napra, ugyanabban a percben:

| rendszer | tagok | μ (°C) | σ (°C) |
|---|---|---|---|
| NCEP GEFS *(amit a bot használ)* | 31 | **33.97** | **1.02** |
| ECMWF IFS-ENS | 51 | 30.80 | 0.57 |
| ECMWF AIFS-ENS | 51 | 28.78 | 0.84 |
| Google WeatherNext 2 | 64 | 29.16 | 0.82 |
| **keverék** | **197** | **30.68** | **2.21** *(inter-modell 2.05)* |

A GEFS **5.2 °C**-kal a AIFS fölött van, miközben **±1.02 °C** bizonytalanságot
állít magáról. Egyik rendszer szórása sem tud erről semmit — csak a modellek
*közötti* tag mutatja meg. Ugyanez Hong Kongon: GEFS σ **0.44** (!) egy 1.4 °C-os
eltérés mellett.

Londonban viszont a keverék σ-ja **szűkebb** (0.84 vs 0.91) és a confidence
**nő** (0.7725 → 0.79): a modellek egyetértenek, tehát nincs mit tágítani.
**Nem uniform σ-tágításról van szó, hanem helyesebb σ-ról.**

---

## 2. Az adat: 197 tag, egy kérés, nulla kulcs

Ugyanaz az endpoint, amit a bot eddig is hívott. Az Open-Meteo elfogadja a
modelleket vesszővel felsorolva **egyetlen** kérésben:

```
GET https://ensemble-api.open-meteo.com/v1/ensemble
      ?latitude=…&longitude=…&timezone=…&forecast_days=7
      &daily=temperature_2m_max
      &models=gfs_seamless,ecmwf_ifs025,ecmwf_aifs025,google_weathernext2_ensemble
```

Mérve (2026-09-08): **197 tag, ~30 KB, ~0,2 s.** Tehát **0 extra HTTP-hívás** a
piaconkénti költségvetésben.

**Kulcs-formátum.** Egy modellnél `temperature_2m_max`, `…_member01`; többnél a
kulcs **modell-szuffixet** kap: `temperature_2m_max_member01_ncep_gefs_seamless`.
A szuffix az Open-Meteo **belső domain-neve**, nem a kért alias
(`gfs_seamless` → `ncep_gefs_seamless`), ezért a parser a **kulcsból** olvassa ki
a modell-taget, nem a kért listával párosít
([`splitEnsembleKeys`](../../packages/core/src/multi-model-ensemble.mts)).

**Miért `daily=temperature_2m_max` és nem `hourly`?** Numerikusan azonos
(ellenőrizve mind a 4 modellen — az Open-Meteo ugyanazt az interpolált órás sort
aggregálja), töredék payloadért.

---

## 3. A pooling: modellenként egyenlő súly, nem tagonként

Tagonkénti egyenlő súly a WeatherNext 2-nek (64 tag) **kétszer** akkora szavazatot
adna, mint a GEFS-nek (31) — pusztán azért, mert a Google több tagot futtat. Ennek
nincs fizikai indoka. Ezért minden **modell** egy-egy, egyenlő súlyú keverék-komponens,
és a szórás a **teljes variancia tételét** követi:

$$
\mu_{\text{pool}} = \frac{1}{K}\sum_{k=1}^{K}\mu_k
\qquad
\sigma^2_{\text{pool}} = \underbrace{\frac{1}{K}\sum_{k=1}^{K}\sigma_k^2}_{\text{modellen belüli}}
\;+\;\underbrace{\frac{1}{K}\sum_{k=1}^{K}(\mu_k-\mu_{\text{pool}})^2}_{\text{modellek közötti}}
$$

A második tag — az `interModelSpread` — az, amit egy modellcsalád szerkezetileg
nem tud megmérni. A σ_k **minta**-szórás (n−1), hogy a GEFS-számok
összehasonlíthatók maradjanak a régi úttal.

Pure implementáció + 47 pinelt állítás:
[`packages/core/src/multi-model-ensemble.mts`](../../packages/core/src/multi-model-ensemble.mts) ·
[teszt](../../packages/core/src/multi-model-ensemble.test.mts).

---

## 4. Miért log-forward, és miért MOST

A B50 #2 doktrína: **ami nem visszatölthető, azt ma kell logolni.**
Az Open-Meteo `historical-forecast-api`-n (ellenőrizve 2026-09-08):

| modell | historikus lefedettség |
|---|---|
| `google_weathernext2_ensemble` | csak **~2026-09-04-től** (előtte `null`) |
| `ecmwf_aifs025` (ensemble) | **nincs archívum** |
| `gfs_seamless`, `ecmwf_ifs025` | van |

Vagyis a head-to-head **nem backtestelhető** — minden nem-logolt nap végleg
elveszett bizonyíték. Ezért a recorder **default-ON**, ami illik a B49 #6 EMOS
mintájához: *„apply default-OFF, log mindig-on"*.

### Mit rögzít egy snapshot

[`multi-model-store.mts`](../../services/worker/src/pillars/weather/multi-model-store.mts),
`weather-multimodel` KV-store, állomásonként gördülő 400 rekord:

| mező | tartalom |
|---|---|
| `ts`, `date`, `leadHours` | mikor, melyik célnapra, mekkora lead-del (12:00 UTC konvenció) |
| `perModel[]` | rendszerenként `n`, `mean`, `sd` |
| `pooledMean`, `pooledSd`, `interModelSpread` | a keverék |
| `baseMean`, `baseSd` | **amit a bot ténylegesen használt azon a tickben** (GEFS-only) |
| `obs` | a realizált napi max — az **EMOS-store-ból** másolva |

A `baseMean`/`baseSd` a lényeg: a snapshot egy **azonos pillanatban** rögzített
fej-fej összehasonlítás, nem két külön időpont utólagos összeollózása.

**Az `obs` nem külön METAR-hívás.** A [`reconcileEmosObs`](../../services/worker/src/pillars/weather/emos-store.mts)
már minden scannelt (állomás, dátum) párra lekéri a realizált napi maxot — a
recorder ezt a már meglévő eredményt másolja át (`loadResolvedObs` → `fillObsFromEmos`).

### Költség-kontroll

A rendszerek 6–12 óránként frissülnek, a worker 3 percenként tickel. A recorder
(állomás, céldátum) párra **~3 óránként** enged egy fetch-et
(`dueForSnapshot`, ugyanaz a primitív, mint a B50 #2 OI/könyv-recordereknél),
és tickenként legfeljebb egyszer ugyanarra a párra. Tipikus terhelés: pár tucat
extra kérés/nap a ~8 600-as napi keret mellett.

---

## 5. Zéró trading-hatás — hogyan van biztosítva

Két, egymástól független kapcsoló:

| knob | default | mit tesz |
|---|---|---|
| `weatherMultiModelRecord` | **1 (ON)** | csak logol. Semmi nem olvassa vissza a trade-útra. |
| `weatherUseMultiModel` | **0 (OFF)** | ON: a keverék hajtja a μ-t és a σ-t. |

A [`forecast-engine.mts`](../../services/worker/src/pillars/weather/forecast-engine.mts)
ág-sorrendje szándékosan olyan, hogy OFF-nál a régi `if` marad az élő út:

```ts
if (opts.useMultiModel === true && multiResult && multiResult.memberCount >= 5) { … }
else if (ensembleResult && ensembleResult.memberCount >= 5) { …a változatlan GEFS-ág… }
```

**Élőben verifikálva** (4 állomás, 2026-09-08): a recorder bekapcsolt fetch-csel a
`predictedMaxC`, `confidence` és `modelUsed` **bit-azonos** a recorder nélküli
hívással. Ha a flip ON lenne, Tokióban μ 33.9 → 30.6 és confidence 0.745 → 0.448.

> ⚠ **Várható mellékhatás a flipnél:** a confidence a §4.2 szerint `1 − σ/4`,
> tehát a szélesebb σ **lejjebb** viszi. A `weatherConfidenceMin` (0.65) így több
> piacot fog blokkolni — Tokió a fenti példában kiesne. **Ez a szándék:** a bot ma
> pont az ilyen piacokon köt magabiztos, nagy tétet.

---

## 6. Hogyan születik a flip-döntés

Nem a 2026-09-08-i pillanatfelvétel alapján. A read-out:

```bash
docker compose exec workers bun scripts/eval-multimodel.ts [maxLeadHours]
```

([`scripts/eval-multimodel.ts`](../../scripts/eval-multimodel.ts), default lead ≤ 48 h
= a bot T+0/T+1 sávja; read-only.)

A pontozás **nem** PnL és **nem** puszta pontpontosság (B50 #1 doktrína — a
proper-score a célfüggvény). Két oszlop dönt
([`multi-model-eval.mts`](../../packages/core/src/multi-model-eval.mts)):

- **CRPS** — a Gauss-előrejelzés proper score-ja. A `crpsSkill = 1 − CRPS_pool/CRPS_GEFS`
  pozitív értéke jelenti, hogy a keverék a jobb *eloszlás*.
- **var-ratio** = `mean(hiba²) / mean(σ²)` — a diagnózis:
  - ≈ 1 → a σ helyes méretű
  - **> 1 → underdispersed**: túl szűk σ, a Kelly túlméretez ← *a dokumentált bug*
  - < 1 → overdispersed: túl széles σ, a bot alul-fogad

Egy változat **rosszabb MAE-vel is nyerhet**, ha az ő σ-ja mond igazat: a weather
bot problémája a méretezés, nem az irány. A teszt ezt explicit pineli („azonos
pont-hiba, a becsületes σ jobb CRPS-t kap").

**Küszöb:** ≥30 címkézett snapshot, és csak pozitív CRPS-skill mellett szabad a
`weatherUseMultiModel`-t bekapcsolni.

---

## 7. Kapcsolódások

| Tétel | Viszony |
|---|---|
| **B49 #6 EMOS/NGR** ([math/23](./23-emos.md)) | Ugyanazt az underdispersion-t célozza, de **kalibrációval** (utólagos σ-infláció). Ez a forrásnál javítja. A kettő kiegészíti egymást: az EMOS ezután a keverék (μ,σ)-ját kalibrálja. |
| **B50 #2 recorderek** ([math/28](./28-market-recorder.md)) | Azonos doktrína és azonos `dueForSnapshot` primitív. |
| **B50 #1 promóciós kapu** ([math/27](./27-promotion-gate.md)) | Ugyanaz a célfüggvény-váltás: proper score, nem PnL. |
| **B15 / B35 / B40** | A weather σ-kalibráció, a `weatherKellyScale` de-risk és az invert-re-audit mind ugyanennek a méretezési hibának a tünet-kezelései. |
| **DEB** ([`deb.mts`](../../services/worker/src/pillars/weather/deb.mts)) | Per-város modell-súlyozás a *determinisztikus* ágon. A `perModel` log ugyanezt teszi majd lehetővé az ensemble-ágon. |

## 8. Ami nyitva marad

- **6-órás natív lépés.** A WeatherNext 2 és az AIFS natívan 6 óránként ad
  értéket, az API interpolál órásra → a napi **max** csúcsa simulhat (hideg-bias).
  Az AI-modellek dokumentáltan hideg-biasosak hőhullám-csúcsokon
  ([arXiv 2504.21195](https://arxiv.org/abs/2504.21195)) — a max-hőmérséklet-bucket
  pont ilyen. A `perModel` log per-rendszer bias-t mér, a §4.4 korrekció + EMOS
  korrigálni tudja. **Mérés után**, nem előtte.
- **Open-Meteo free tier: non-commercial**, és a hívás-súly a változószámmal nő
  (>10 változó → törtrészes többszörös); 197 tag ≈ 197 „változó". A recorder
  throttle miatt ez ma elfér, de a live-flip (B10) előtt újraszámolandó.
- **Regionális nagyfelbontás.** EU-ra `icon_eu` (40 tag, 13 km) / `icon_d2_eps`
  (20 tag, 2 km), US-ra `ncep_nbm_conus` / `gfs_hrrr` — a `WEATHER_ENSEMBLE_MODELS`
  már fogadná őket, de nem minden állomásra érvényesek → per-régió lista kell (B52 4. lépcső).
- **WeatherNext 3** (5 km, órás, „station head", a bejelentés szerint 2 m-hőmérséklet-CRPS-ben
  akár −40% az ECMWF ENS-hez képest rövid lead-en) **még nincs az Open-Meteo-n**.
  Ha megjelenik, egy env-listaelem.
