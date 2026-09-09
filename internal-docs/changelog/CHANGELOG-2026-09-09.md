# CHANGELOG — 2026-09-09 (84. + 85. session)

## 84. session — a 10 bekapcsolt knob Edge-Tracker-kiértékelése (read-only) → P1 mérési hiba

A user: „csináld meg az 1-est" (a 09-04-én bekapcsolt 10 knob kiértékelése). **Kód nem változott**; a ledgerek a boxról lehúzva és a repo SAJÁT függvényeivel pontozva (`computeWalkForward`, `computeConfigAttribution`, `banditArmsFromRecords`).

### Eredmény: a kiértékelés NEM elvégezhető — két független okból

**1. Nincs pre-flip kar.** A config-fingerprint jól elválasztja a 09-03 22:09-es flippet, de a kar-eloszlás használhatatlan:

| config | mikor | n (rezolvált) |
|---|---|---|
| `101cde4d` | flip **előtt** | **3** |
| `3683673b` | flip **után** | **214** |
| `unlabeled` | a #4 stamp előtt | 19 |

A Thompson-bandit „`101cde4d` 58% prob-best"-je a **priorból** jön (`nEff = 0.4`) — nem bizonyíték. Ok: a ledger rescan-enként felülírta a config-stampet, így a flip előtti, de utána is scannelt piacok átcímkéződtek.

**2. A metrika maga sérült** → lásd a 85. session (B53).

### Amit a szennyezéstől függetlenül tudunk

A **crypto modell nem-informatív**: átlagos `|p − 0.5|` = **0.119**, a piacé **0.296**; a modell Brier-je 0.213, a triviális „mindig 0.5"-é 0.25. A combiner a 0.5 körül lebeg, míg a piac határozottan és helyesen áraz. Ez a Sprint 41-42A-ban dokumentált „lapos finalProb" patológia, **nem** knob-hangolási kérdés. → **B54**.

Felvéve: **B53** (P1 mérési fix) + **B54** (a knob-kiértékelés, blokkolva).

---

## 85. session — B53 (ledger first-sighting latch) + B52 4. lépcső (8-rendszeres ensemble)

A user: „csináld a B53-at és B52-t is." A B52 2-3. lépcsője adat-függő (vár), tehát a **4. lépcső** készült el.

**Verifikáció:** `npx tsc --noEmit` exit 0 · `node scripts/run-tests.mjs` → **48/48** · `npm run build` zöld.

### B53 — a mérési réteg rossz mezőt olvasott

**A hiba.** A [`prediction-ledger`](../../packages/core/src/prediction-ledger.mts) slug-onként upsertel: minden rescan frissítette a `predictedProb`-ot, a `marketPrice`-t és a `configHash`-t (a mező doc-ja is kimondta: *„at the **latest** scan"*), miközben a `firstTs` megmaradt. Egy rezolvált sor tehát az **utolsó** scan állapotát hordozta — a lejárathoz közelit, amikorra a piaci ár már mechanikusan a kimenetre konvergált.

Mérve az élő ledgeren (2026-09-08):

| | weather | crypto | sports |
|---|---|---|---|
| rezolvált sor | 43 | 73 | 118 |
| ebből `ár > 0.98` | **17** | 0 | 0 |
| ebből `abs(ár − kimenet) < 0.02` | **18** | 4 | 1 |
| Brier-skill a piac ellen | **−233.6%** | −98.7% | −0.6% |

A szennyezettség sorrendje pontosan megmagyarázza a „rosszaság" sorrendjét, és a `> 0.98`-as sorok **94%-a** YES-re rezolvált — a „baseline" a válasz ismeretében árazott. Ez nem az a **belépéskori** összehasonlítás, amit a Walk-forward kártya állít: a bot belépéskor kereskedik, nem az utolsó scan-en.

**A fix.** Új, **írás-egyszer** hármas a `PredictionRecord`-on: `firstPredictedProb`, `firstMarketPrice`, `firstConfigHash`. Az `upsertRecords` az első látáskor rögzíti, és a latch a frissítés **ELŐTT** fut — így egy pre-B53 rekordnál a frissítés előtti (régebbi) értéket kapja, onnantól immutábilis. A „latest" mezők maradnak, a UI azt mutatja.

A **config** is a hármas része, szándékosan: a pontozott predikciót ahhoz a confighoz kell kötni, amelyik **készítette**. Enélkül egy knob-flip átcímkézi az összes még nyitott piacot és kiéhezteti a régebbi kart — pontosan ez blokkolta a 84. session kiértékelését (3 vs 214).

**Négy fogyasztó** vált a first-hármasra, mind `?? latest` fallbackkel: `ledgerPointsFromRecords` (walk-forward) · `computeConfigAttribution` · `banditArmsFromRecords` · a promóciós kapu hard „beats market OOS" gate-je (a walk-forwardon át).

**18 új regressziós assert** ([`prediction-ledger.test.mts`](../../packages/core/src/prediction-ledger.test.mts)) — köztük a végponti bizonyíték: az utolsó árral (0.99, YES-kimenet) a piac tökéletesnek látszik, a first-árral (0.25) viszont a modell (0.30) a jobb előrejelzés, és az attribúció a forecastot **készítő** confighoz írja.

**Élőben verifikálva:** a jelenlegi (mind pre-B53) ledgeren a walk-forward számok **bit-azonosak** a fix előttivel → a fallback ép, a fix tisztán forward-tölt. A már felülírt belépéskori árak **nem visszaállíthatók** (B50 #2 doktrína) → a tiszta mérés a deploytól indul. **Nem trading-hiba** — a bot mindig a valós árral kereskedett.

Doksi: [`math/21` §6](../math/21-walk-forward.md) + egysoros hivatkozás a [`math/30`](../math/30-config-attribution.md) és [`math/33`](../math/33-thompson-bandit.md) doksikban.

### B52 4. lépcső — 4 → 8 ensemble-rendszer

**A nyitott kérdés az volt, kell-e per-állomás modell-lista.** Nem kell: a domainjén kívüli regionális modellt az API **némán elhagyja** a multi-model válaszból — verifikálva: Tokió `gfs_seamless,icon_eu` → **HTTP 200, 31 tag**, se hiba, se null-oszlop. Csak **önmagában** kérve ad 400-at, amit ez a kód sosem tesz.

Új a listán: `gem_global` (CMC GEPS, 21) + `ukmo_global_ensemble_20km` (MOGREPS-G, 18) mindenhol, `icon_eu` (40 @ **13 km**) + `icon_d2` (20 @ **2 km**) Európában.

| állomások | rendszer | tag |
|---|---|---|
| EGLC London, EDDM München | **8** | **296** |
| LEMD Madrid (`icon_d2` kiesik) | 7 | 276 |
| US / Ázsia / Dél-Amerika / Afrika | 6 | 236 |

**Ugyanaz a költség:** egy kérés, ~42 KB, **~0,2 s** (mérve, 3 futás).

**Kihagyva:** `bom_access_global_ensemble` (18 tagot hirdet, de minden tesztelt állomáson **csupa null** hőmérséklet-oszlop) és `ukmo_uk_ensemble_2km` (3 tag — modellenként egyenlő súlyú keverékben túl kevés használható modellen-belüli σ-hoz, és egyetlen állomást fed). A US-regionális `gfs_hrrr`/`ncep_nbm_conus` **determinisztikus** (nincs ensemble-tagság) → a keverékbe nem illik; a determinisztikus DEB-ág bővítése külön tétel.

**Élő-verifikálva.** London 8 rendszer / 296 tag — és a két ICON (`icon_eu` μ 20.34, `icon_d2` μ 20.64) ~**1 °C-kal melegebb** a globálisoknál (18.76–19.90): pont az a lokális jel, amit a 25 km-es rács elsimít. Tokió 6/236. A legacy trading-út mindkét állomáson **bit-azonos** a recorder bekapcsolt fetch-ével.

Doksi: [`math/37` §2](../math/37-multi-model-ensemble.md) · [`math/16` §3.B (d)](../math/16-weather-bot.md) · [`env-vars.md` §13](../current-state/env-vars.md).

### Következő

Deploy → a B53 tiszta mérése és a 8-rendszeres log innen indul → 2-3 hét után `bun scripts/eval-multimodel.ts` (B52 flip) és a **B54** knob-kiértékelés, immár valódi A/B-karokkal.
