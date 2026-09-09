# 38 — Weather forecast dispersion correction (P0-1)

> **Státusz:** implementálva 2026-09-09 (90. session, rendszer-audit fix-fázis), **default OFF**.
> **Kód:** [`packages/core/src/weather-dispersion.mts`](../../packages/core/src/weather-dispersion.mts) · teszt: [`weather-dispersion.test.mts`](../../packages/core/src/weather-dispersion.test.mts)
> **Knob:** `weatherSigmaInflation` (default **1.0 = KI**, tartomány 1.0–4.0, ajánlott élesben **2.25**) · env `WEATHER_SIGMA_INFLATION`
> **Sprint:** [B58](../roadmap/sprints.md)

---

## 1. A lelet

A weather pillér egy Gauss-eloszlást `(μ, σ)` ad át a bucket-matchernek. A σ a 31-tagú GEFS ensemble szórása, **0,5 °C-os padlóval** ([`weather/index.mts:382`](../../services/worker/src/pillars/weather/index.mts)).

Az EMOS-residual-store **forward** felén mérve (élő METAR-megfigyelés vs. a bot által ténylegesen használt GEFS-átlag, **n = 35**):

| mutató | mért | kalibrált érték |
|---|---|---|
| `mean(err² / σ²)` | **10,04** | 1,0 |
| `median(err² / σ²)` | **1,44** | 0,455 (χ²₁ medián) |
| átlagos torzítás (obs − μ) | **+0,497 °C** | 0 |

Vagyis a σ **~1,8×** (medián, outlier-robusztus) … **~3,2×** (átlag) **túl kicsi**.

**Miért:** egy ensemble szórása a *saját perturbációinak* egyet-nem-értését méri — a **strukturális modellhibát nem látja**. A 0,5 °C-os padló ott ront tovább, ahol harap: a két legegyoldalúbb hibájú állomás (ZSPD +1,7…+2,8 °C, n=5; RKSS +2,3…+2,8 °C, n=3) **mindkettő padlózott**.

### Miért nem a kód-olvasás találta meg

A σ-kód önmagában konzisztens, sőt a padló *kommentje is megindokolja magát* („az ensemble véletlen összecsúszása nem jelent fél foknál jobb skillt"). A hiba csak akkor látszik, ha megkérdezed: **ez a σ akkora-e, amekkorára a fogyasztója fogad?** — és erre a választ a residual-adat adja meg. (Charta [§1](../playbooks/system-audit.md), szemantikai drift.)

---

## 2. Miért ez fáj

Nem rossz **irányt** okoz, hanem **téves magabiztosságot**. σ = 0,5 mellett egy μ-től 1,55 °C-ra lévő bucket ≈ **1,6 %**-ot kap, és a bot erre a kvázi-bizonyosságra méretez ¼-Kelly-t.

A valós belépőkön (uncontaminated: a `pillar_closed_trade` befagyasztja a belépési értékeket, **n = 28**):

| predikció-sáv | n | átlagos predikció | realizált YES | PnL |
|---|---|---|---|---|
| **[0 – 0,15)** | 7 | 0,104 | **71,4 %** | **−$20,68** |
| [0,15 – 0,30) | 7 | 0,241 | 57,1 % | −$1,99 |
| [0,30 – 0,45) | 4 | 0,372 | 0,0 % | +$10,42 |
| [0,45 – 0,60) | 6 | 0,507 | 16,7 % | −$5,19 |
| [0,60 – 0,80) | 4 | 0,647 | 50,0 % | +$5,62 |

A legnagyobb veszteség pontosan a **legmagabiztosabb alacsony** predikciókból jön.

---

## 3. A korrekció

```
σ' = σ · λ,   λ ∈ [1, 4],   λ = 1 ⇒ bit-azonos no-op
```

Szándékosan **EMOS UTÁN** alkalmazva ([`weather/index.mts`](../../services/worker/src/pillars/weather/index.mts), közvetlenül a `matchBucket` előtt).

**Korrekció az audit első megfogalmazásához.** A P0-2 tétel eredetileg úgy szólt, hogy az EMOS a rossz eloszláson illesztve „nem megbízható" — a mérés ezt **részben cáfolta**. Az élő, seed-illesztett EMOS a forward adaton **javít**:

| variáns (n=35 forward) | CRPS | log-score | var-ratio | átlag σ |
|---|---|---|---|---|
| nyers ensemble (EMOS ki) | 1,1641 | 5,6139 | **10,04** | 0,784 |
| **élő EMOS (seed-illesztett)** | 1,0767 | 3,5778 | **5,96** | 0,756 |
| élő EMOS + σ×2,25 | **0,9867** | **1,9967** | **1,18** | 1,70 |

Vagyis az a megfigyelés, hogy **27 állomásból 17 SZŰKÍTI** a σ-t (VHHH: 0,80 → 0,53) igaz ugyan, de **nem ez a domináns hatás** — az `a + b·ensMean` átlag-korrekció többet nyer, mint amennyit a szűkebb σ veszít.

**Amit az EMOS viszont NEM javít: a torzítást.** A forward bias +0,497 °C nyersen és **+0,55 °C** EMOS után — a `a, b` tagok a **seed** eloszlás −0,03 °C-os biasára illeszkedtek, és **nem transzferálnak** az élő METAR-vs-GEFS eloszlásra. Ez a P0-2 valódi, mért tartalma; a σ-tágítás ezen definíció szerint nem segít (lásd §4). Az utólagos szorzó előnye, hogy **az illesztéstől független** és kiszámítható marad, amíg a P0-2 rendeződik.

### λ megválasztása — plató, nem csúcs

Három független metrika a valós forward-residualokon (n = 35):

| λ | átlag CRPS | átlag log-score | var-ratio | PIT-KS | trading PnL (n=28) |
|---|---|---|---|---|---|
| **1,00** | 1,1641 | 5,6139 | **10,04** | 0,348 | **−$11,82** ← ma |
| 1,50 | 1,1203 | 3,2316 | 4,46 | 0,269 | −$11,82 |
| 1,75 | 1,1104 | 2,7940 | 3,28 | 0,247 | −$8,23 |
| **2,00** | **1,1064** | 2,5435 | 2,51 | 0,231 | **−$2,96** |
| 2,25 | 1,1073 | 2,3980 | 1,98 | 0,229 | −$2,96 |
| 2,50 | 1,1124 | 2,3150 | 1,61 | 0,229 | −$4,96 |
| 3,00 | 1,1337 | **2,2520** | 1,12 | 0,235 | −$5,78 |
| 3,50 | 1,1668 | 2,2583 | 0,82 | 0,246 | — |

A metrikák **nem értenek egyet** — és pont ez a lényeg. A CRPS °C-ban mér és a μ-hiba dominálja, ezért alig mozdul; a log-score és a var-ratio látja a diszperziót, ami a tényleges defektus.

A választás [`selectPlateau`](../../packages/core/src/plateau.mts)-val történt (**B50 #7** fegyelme: a legszélesebb near-best futam **közepe**, nem a csúcs):

- forward log-score → plató **λ = 2,5** (csúcs 3,0; szélesség 6)
- forward CRPS → plató **λ = 2,0** (szélesség 4)
- trading PnL → plató **λ = 2,0** (szélesség 2)

λ ≥ 3,5-nél a var-ratio **1,0 alá** megy (alul-magabiztosság), tehát „több" itt nem „jobb".

### ⚠ λ PATH-FÜGGŐ — az élő úton más a szám

A fenti tábla a **nyers** ensemble-re vonatkozik. Élesben viszont `weatherUseEmos = 1`, és a szorzó **EMOS után** hat, tehát a releváns sweep a kalibrált (μ, σ)-n fut. Ugyanaz a 35 megfigyelés, minden állomás **saját** élő illesztésével:

| λ | CRPS | log-score | var-ratio | PIT-KS |
|---|---|---|---|---|
| **1,00** | 1,0767 | 3,5778 | **5,96** | 0,446 ← ma (EMOS be) |
| 1,75 | 0,9981 | 2,1300 | 1,95 | 0,322 |
| **2,25** | **0,9867** | 1,9967 | **1,18** | 0,308 |
| 2,50 | 0,9896 | **1,9902** | 0,95 | 0,303 |
| 3,00 | 1,0087 | 2,0268 | 0,66 | 0,295 |

`selectPlateau` mindkét metrikán **2,25**-öt ad (log-score: plató 2,25 / csúcs 2,5 / szélesség 6; CRPS: plató 2,25 / szélesség 3).

**Ajánlott: λ = 2,25** (élő út, EMOS be). Nyers ensemble-on 2,0–2,5.

A nem-nyilvánvaló rész az **irány**: az élő út **kevesebb** inflációt kíván, mint a nyers — mert az EMOS a túl-magabiztosság egy részét már elnyelte (var-ratio 10,04 → **5,96**). A két érték **nem cserélhető fel**, és a teszt ezt explicit pineli.

---

## 4. ⚠ Amit ez NEM old meg

**Kár-csökkentés, nem edge.** A σ-szorzás **monoton transzformáció**, ezért matematikailag **nem tudja megváltoztatni** a `corr(predikció, kimenet)` előjelét — ami a 28 valós belépőn **−0,316**. A modell rossz irányba korrelál; a σ-tágítás csak **abbahagyatja a bottal, hogy erre fogadjon**.

A 28 belépőn szimulálva:

| λ | Brier | vs. „mindig 0,5" | megmaradó trade | PnL |
|---|---|---|---|---|
| 1,00 | 0,3513 | −40,5 % | 28/28 | −$11,82 |
| 2,00 | 0,2969 | −18,7 % | 26/28 | −$2,96 |
| 3,00 | 0,2783 | −11,3 % | 18/28 | −$5,78 |

A Brier **minden λ-nál 0,25 FÖLÖTT marad** — a weather bot ettől **nem lesz nyereséges**. Az előjel-probléma külön munka (a szegmentált kalibrációs görbe monoton fordított; a naiv „flippeljük meg" viszont **szintén nem működik**: Brier(1−p) = 0,2753, még mindig rosszabb a 0,25-nél — ugyanaz a csapda, mint a **B56b**-nél).

A **+0,497 °C-os meleg-torzítást** sem érinti: a teszt explicit pineli, hogy a bias-diagnosztika **invariáns** a σ-ra. Az a P0-2 hatásköre.

---

## 5. Regressziós védelem

A [`weather-dispersion.test.mts`](../../packages/core/src/weather-dispersion.test.mts) a **mérést** pineli, nem a kódot (charta [§7.2](../playbooks/system-audit.md)) — a fixture a **valós** forward-residual-halmaz (n = 35), a boxról másolva. **9 csoport:**

1. **λ = 1 bit-azonos no-op** (a default tényleg KI, nem „nagyjából ki"); NaN / 0 / negatív faktor → 1 (σ-t **soha nem zsugorítunk**)
2. felső clamp 4,0-nál
3. **a mérés maga**: var-ratio ≈ 10,04, medián-ratio jóval a kalibrált fölött, bias ≈ +0,50 °C
4. a var-ratio monoton csökken, és λ = 3,5-nél **túllő** 1,0 alá
5. **a bias invariáns a σ-ra** — kifejezetten az ellen, hogy valaki összemossa a kettőt
6. az ajánlás **plató**, nem argmax
7. n < 20 → `null` (nem magabiztos szám öt pontból)
8. **EMOS-kompozíció** — a második fixture ugyanaz a 35 megfigyelés, minden állomás **saját** élő illesztésével. Pineli, hogy az EMOS **javít** (var-ratio 5,96), hogy önmagában **nem elég** (>3), hogy a forward **biast nem viszi el** (>0,4 — ha egyszer mégis, a P0-2 megoldódott és a pint szigorítani kell), és hogy az élő út **kevesebb** inflációt kér, mint a nyers
9. degenerált input nem dob és nem mérgezi a statisztikát

---

## 6. Élesítés

1. Deploy (a knob default 1.0 → **0 viselkedés-változás**).
2. Settings → Weather → *Forecast σ inflation* → **2.25** (élő út, `weatherUseEmos=1`).
3. 20-30 rezolvált trade után: Edge Tracker proper-score + a `dispersionDiagnostics` újrafuttatása a friss forward-residualokon. A var-ratio **1,0 felé** kell mozduljon.
4. Ha a P0-2 (EMOS seed-dominancia) rendeződik, ezt a szorzót **újra kell mérni** — az EMOS diszperziós tagja akkor részben átveheti a szerepét, és a kettő egymásra halmozódna.
