# CHANGELOG — 2026-09-08 (81. + 82. + 83. session)

## B51 — Crypto multi-coin scan-bővítés (BTC-only → BTC/ETH/SOL)

### Kontextus / trigger

A user kérdése: „állítsuk lejebb a küszöböt hogy több trade legyen és több adat, vagy azok elvinnék a modell-állítást rossz irányba? a crypto alig kereskedik." + „nézd meg", majd „bővíthető-e több strike-ra/coin-ra, mikor érdemes ránézni a gyűjtött adatra és kalibrálni?", végül: „mérd fel a coin-bővítést, vedd sprintbe, végezd el, ellenőrizd vissza."

**Élő diagnózis (boxon, `ssh analytics`):** a crypto fut (paper, 3-perces tick, nincs auto-stopolva), de 2 óra alatt **0 nyitás / 120 skip**. A scan-ablakban 3 BTC-piac: 2× `above-78k` (a **resolution-risk gate** blokkolja — BTC $78,529 ≈ a strike-on → lejárathoz közel megjósolhatatlan) + 1× `up-or-down` (a **combiner-confidence gate** blokkolja — output 0.51–0.53, valódi zaj). **Következtetés:** a szűk kereskedés oka **piac-kínálat-szűke + coinflip-ablak**, NEM tight-küszöb → a küszöb-lazítás nem hatna a gate-blokkolt piacokra, és csak coinflip-zajt engedne be (hígítva a realized-IC-t). A helyes kar a **piac-szélesség**: több coin. A Gamma-verifikáció megerősítette: ETH-nek is sok napi piaca fut (`ethereum-above-1900…3000-on-…`, literál strike; `ethereum-up-or-down-on-…`), a scan mégis BTC-only volt, és a 8 combiner-jelből 7 hardcode-olta a `BTCUSDT`-t.

### Mit csináltam

Teljes multi-coin bekötés — `tsc` exit 0 + **45/45 teszt** (44→45) + web-build zöld, `main`.

**1. SSOT új pure modul** [`packages/core/src/coin.mts`](../../packages/core/src/coin.mts) + [teszt](../../packages/core/src/coin.test.mts) (7 csoport):
- `coinFromText(text)` → `CoinInfo { base, binance, coingecko, fsym, deribit }` (szó-határos alias-match; `deribit` csak BTC/ETH-nek).
- `parseCryptoAboveStrike(slug)` → `{ coin, K, closingKey }`: a **3 korábban duplikált** strike-regex (combiner `parseThresholdK` + gates `parseBtcAboveSlug` + a threshold-teszt lokális másolata) egyetlen forrásba. Kezeli a **BTC „k"** (78k→78000) ÉS az **ETH literál** (3000→3000) konvenciót; `K` USD-ben; `closingKey` **coin-scoped** (`"BTC:…"`) → cross-coin sosem hasonlítódik.

**2. Finder** [`btc-market-finder.mts`](../../services/worker/src/pillars/crypto/btc-market-finder.mts): `isBtcUpDown` → `detectCryptoUpDown` (coinFromText + `CRYPTO_COINS` allowlist, default `BTC,ETH,SOL`); `MarketInfo.coin` tag (új opcionális mező a [types.mts](../../packages/core/src/types.mts)-ben).

**3. Combiner** [`signal-combiner.mts`](../../services/api/src/routes/signal-combiner.mts) — a 7 BTC-hardcode coin-aware (`coinOf(market)`, default BTC):
- `fetchCloses` / `fetchDailyOHLC` / `fetchBtcPriceAt` (Binance/CoinGecko/CryptoCompare a coin symbol/id-jével);
- `getFundingSignal(coin)` (Bybit/Binance/premium-proxy a coin symbol/fsym-jével);
- Deribit `fetchDeribitRaw/Smile(currency)` + **per-currency cache**; a #7 Deribit-IV út csak `coin.deribit`-tel (BTC/ETH), másnak model-σ fallback;
- `getCondProbSignal` related-match **coin+K identitásra** (nem csak K — elkerüli a cross-coin USD-kollíziót);
- `parseThresholdK` / `parseCoinSymbol` a shared SSOT-ra delegálva.

**4. Aggregator** [`signal-aggregator.mts`](../../services/worker/src/pillars/crypto/signal-aggregator.mts): az order-book imbalance a piac saját coinjára (`coinFromText(slug).binance`, fallback BTC).

**5. Gates** [`cross-position-gates.mts`](../../services/worker/src/pillars/shared/cross-position-gates.mts): `parseBtcAboveSlug` delegál (K USD + coin-scoped key); a [decision-engine](../../services/worker/src/pillars/crypto/decision-engine.mts) monotonicity/overlap display `$X` formátumra (K már USD).

### Biztonság / regresszió

- **BTC-viselkedés bit-azonos:** minden fetch default BTC (`BTC_DEFAULT` / `?? "BTCUSDT"`), a BTC slug-ok ugyanúgy parse-olnak → 0 regresszió a meglévő BTC-trade-ekre. Az ETH/SOL a deploy után élesedik; `CRYPTO_COINS=BTC` visszaszűkíti.
- A 16 crypto gate coin-agnosztikus vagy coin-scoped (entry-window duration-alapú, longshot-band ár-alapú, monotonicity/overlap coin-scoped, paper-resolver valós Polymarket-rezolúción). A Kelly/loss-limit/beta-cap/DD-kill érintetlen.
- Két érintett teszt frissítve a coin-scoped/USD-kontraktusra (`cross-position-gates.test.mts`, `signal-combiner-threshold.test.mts` — ez utóbbi most a shared parsert importálja a lokális másolat helyett).

### Verifikáció

`tsc` exit 0 · `node scripts/run-tests.mjs` → 45/45 · `npm run build` zöld. Push `main` → GitHub Actions CI+deploy → box-log-verifikáció (ETH-piacok a scan-listán + ETH-signal-tick).

### Doksi

[math/36-multi-coin.md](../math/36-multi-coin.md) · [sprints.md B51](../roadmap/sprints.md) · [env-vars.md `CRYPTO_COINS`](../current-state/env-vars.md).

### Follow-up (Backlog)

Per-coin realized-IC (a calibration jelenleg kategória-szintű) ha az ETH-edge eltér a BTC-től; ETH Deribit-IV élő-teszt; SOL a piacai megjelenésekor automatikusan bejön.


---

# 82. session (2026-09-08) — Edge Tracker mobil-overflow fix + weather multi-model felmérés

A user két dolgot kért: **(1)** „mobilon két komponens az edge tracker oldalakat eltöri és széltében elmegy a nézet! javítsd", **(2)** „a weather botba be tudnánk integrálni weather api-kat vagy modelleket? elvileg a Gemini is pontosított a modelljén".

## 1. Edge Tracker mobil horizontális overflow — javítva

### Reprodukció (nem tipp — mérve)

Lokális Astro dev-szerver + 375×812 emulált viewport, az `/.netlify/functions/edge-tracker` válasz kimockolva (mind a 18 kártya renderelt). Mérés: minden elem `getBoundingClientRect().right` vs `documentElement.clientWidth`, kizárva azokat, amelyeknek van valódi `overflow-x:auto|scroll` őse (azok szándékosan görgetnek befelé, pl. a `.tbl-scroll`-os táblák).

```
clientWidth = 375   scrollWidth = 496   →  121 px túlcsordulás
```

**A két törő kártya (pontosan, ahogy a user mondta):**

| Kártya | Elem | Szélesség | Túllóg |
|---|---|---|---|
| `WinRateHeatmap` | `.et-heatmap` | 434 px | +104 px |
| `PnlDistribution` | `.et-hist` / `.et-hist-axis` | 434 px | +104 px |

**Gyökérok — egyetlen hiba, két látható tünet.** A `.et-heatmap` grid-je `grid-template-columns: 60px repeat(24, 1fr)`; egy `1fr` sáv automatikus **minimuma a min-content**, így a 24 óra-oszlop + a 60 px-es kategória-label min-content szélessége ≈ **434 px** — a telefonon rendelkezésre álló ~323 px-nél sokkal több. A heatmap az `.et-grid2`-ben ül (≤768 px-en 1 oszlop), és ott ugyanez az `1fr`-szabály a **teljes sávot** 468 px-re feszítette — vagyis a *szomszédjának*, a `PnlDistribution` kártyának a szélességét is. Innen a „két komponens". A `body { overflow-x: hidden }` (global.css) miatt ez nem görgetésként, hanem **levágott tartalomként** jelentkezik.

### Fix — [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx)

1. **`.et-grid2 > * { min-width: 0 }`** — grid-blowout guard: a sáv többé nem tud egy túl széles kártya min-contentjéhez igazodni és magával rántani a testvérét. Szerkezeti védelem, nem csak erre az egy kártyára.
2. **A heatmap saját vízszintes scrollere** (`.et-heat-scroll`, `overflow-x: auto`) + `@media (max-width: 768px) { .et-heatmap { min-width: 440px } }` — a cellák olvashatók maradnak (nem 8 px-re préselődnek), a user oldalra húz. Ugyanaz a minta, mint a projekt meglévő `.tbl-scroll` konvenciója a tábláknál.
3. **Sticky kategória-oszlop** — `.et-heat-corner, .et-heat-cat { position: sticky; left: 0 }` a kártya háttérszínével + `box-shadow: -2px 0 0, 2px 0 0` (ez festi át a 2 px-es grid-gap-et, amin egyébként átlátszanának az alágörgetett cellák). Enélkül a jobbra húzott órák névtelen számok lennének.

### Verifikáció

| Viewport | `clientWidth` | `scrollWidth` | Nem-kontrollált túlcsordulás |
|---|---|---|---|
| 320 px | 320 | **320** | 0 |
| 375 px | 375 | **375** | 0 |
| 1280 px (desktop) | 1276 | 1276 | 0 — a heatmap 485 px az 519 px-es sávban, **nem** görget (változatlan) |

`npx tsc --noEmit` exit 0 · `node scripts/run-tests.mjs` → **45/45** · `npm run build` zöld.

> **Csapda, ami elsőre elkapott:** a `styles` konstans egy **template literal**, így a hozzáadott CSS-kommentbe tett `` `1fr` `` backtick lezárta a stringet (`TS1005`). A `tsc` elkapta; a styles-blokkban azóta nincs backtick a záró jelen kívül.

**Mellékesen:** [`.claude/launch.json`](../../.claude/launch.json) új `web-dev` bejegyzés (`npm --prefix apps/web run dev`, port 4321) — frontend-only vizuális ellenőrzéshez, a meglévő `netlify-dev` mellett.

## 2. Weather bot — model/API bővítés felmérése (kód NEM változott)

**Kérdés:** be lehet-e húzni több forecast-modellt, és tényleg jobb lett-e a Google modellje?

**Rövid válasz: igen, és sokkal olcsóbban, mint a doksiban tervezett (a)/(b)/(c) opciók** — ugyanazon a keyless endpointon, amit a bot ma is hív. Részletek: [`math/16-weather-bot.md` §3.B (d)](../math/16-weather-bot.md) · feladat-tracking: [`sprints.md` **B52**](../roadmap/sprints.md).

**Élő-verifikált** (`ensemble-api.open-meteo.com/v1/ensemble`, 2026-09-08): `models=gfs_seamless,ecmwf_ifs025,ecmwf_aifs025,google_weathernext2_ensemble` → **197 tag egyetlen kérésben** (31 GEFS + 51 ECMWF IFS-ENS + 51 ECMWF AIFS-ENS + **64 Google DeepMind WeatherNext 2**). A bot ma **csak a 31-tagú GEFS-et** használja.

**A mért indok** (a bot saját állomásain, T+0/T+1 daily-max — pont a bot lead-time-ja):

| Állomás | nap | GEFS-only (ma) | Multi-model (197) | σ-arány |
|---|---|---|---|---|
| RJTT Tokyo | T+0 | μ 32.3 σ **0.49** | μ **29.3** σ **1.58** | **×3.2** |
| RJTT Tokyo | T+1 | μ 34.0 σ 1.00 | μ **30.3** σ 1.96 | ×2.0 |
| VHHH Hong Kong | T+1 | μ 31.9 σ 0.43 | μ 30.3 σ 1.07 | ×2.5 |
| KORD Chicago | T+0 | μ 29.8 σ 0.70 | μ 27.9 σ 1.64 | ×2.3 |
| EGLC London | T+0 | μ 18.8 σ 0.89 | μ 18.1 σ 0.63 | ×0.7 |

A GEFS-only σ Ázsiában/USA-ban **2–3×-osan alulbecsli** a valós bizonytalanságot, és a μ akár **3.0–3.7 °C**-kal elcsúszik (Tokyo). Európában *szűkebb* lesz a σ → nem uniform tágítás, hanem **helyesebb** σ. Ez közvetlenül a dokumentált weather-patológia (`forecast_edge` **IC +0.393** = jó irány, **payoffRatio 0.44** = rossz sizing) gyökere: a Kelly egy 2–3×-osan túl szűk σ-ra méretez.

**Amit MÉRNI kell flip előtt (nem azonnali bekapcsolás):**
- A WeatherNext 2 és az AIFS natívan **6-órás** → hourly-ra interpolálva a napi **max** csúcsa simulhat; az AI-modellek dokumentáltan hideg-biasosak hőhullám-csúcsokon ([arXiv 2504.21195](https://arxiv.org/abs/2504.21195)). A meglévő DEB + B49 #6 EMOS ezt korrigálni tudja — mérés után.
- **Nincs offline backfill:** a `historical-forecast-api` a WeatherNext 2-re csak ~**2026-09-04-től** ad értéket, az AIFS-ENS-nek nincs archívuma ⇒ **log-forward MOST** (B50 #2 doktrína). Az [`emos-store.mts`](../../services/worker/src/pillars/weather/emos-store.mts) `logForecast` már minden scannelt állomást naplóz METAR-reconcile-lal → elég a per-modell μ/σ-t is belerakni.
- **Open-Meteo free tier = non-commercial + 10 000 hívás/nap**, a hívás-súly a változószámmal nő (>10 változó → törtrészes többszörös) — 197 tag ≈ 197 „változó". Élesedés (B10) előtt újraszámolandó / fizetős tier.

**A „Gemini pontosított" állítás:** a Google DeepMind vonalon a **WeatherNext 2** (64 tag, 0.25°) van API-n; a **WeatherNext 3** (5 km, órás, „station head") a bejelentés szerint 2 m-hőmérséklet-CRPS-ben *akár* −30% a WN2-höz és −40% az ECMWF ENS-hez képest **rövid lead-time-on** — de az „akár" legjobb eset, és a WN3 az Open-Meteo-n **még nem elérhető**. A ma behúzható nyereség tehát a WN2 + AIFS-ENS + IFS-ENS **együttese** (inter-modell szórás), nem egyetlen modell.

**Kapcsolódó:** B15 (weather σ kalibráció), B35 (`weatherKellyScale`), B40 (invert re-audit), B49 #6 (EMOS), B50 #2 (log-forward).


---

# 83. session (2026-09-08) — B52 1. lépcső: weather multi-model log-forward

A user: „csináld meg a B52 első lépcsőjét." Vagyis: per-modell μ/σ log-forward (0 trading-hatás) + a flip-knob bekötve mai-viselkedés-defaulttal.

**Verifikáció:** `npx tsc --noEmit` exit 0 · `node scripts/run-tests.mjs` → **48/48** (3 új suite, 91 új assert) · `npm run build` zöld · `main`, **NEM deployolva**.

Teljes leírás: [`math/37-multi-model-ensemble.md`](../math/37-multi-model-ensemble.md) · tracking: [`sprints.md` B52](../roadmap/sprints.md).

## Mit csináltam

### 1. Pure core — [`packages/core/src/multi-model-ensemble.mts`](../../packages/core/src/multi-model-ensemble.mts)

- `parseModelList` — env-lista → normalizált id-tömb (trim/lowercase/dedupe, üresre fallback).
- `splitEnsembleKeys` — a válasz-oszlopokat modellenként csoportosítja. **Kulcs-döntés:** a modell-taget a **kulcsból** olvassa, nem a kért aliassal párosítja, mert az Open-Meteo a **belső domain-nevet** adja vissza (`gfs_seamless` → `ncep_gefs_seamless`, `ecmwf_ifs025` → `ecmwf_ifs025_ensemble`). Aliasra illesztve a parser némán 0 tagot találna.
- `modelStatsForDate` — **modellenként egyenlő súlyú** keverék a teljes variancia tétele szerint: σ²_pool = mean(σ²_k) + var(μ_k). Tagonkénti súlyozás a 64-tagú WeatherNext 2-nek kétszeres szavazatot adna a 31-tagú GEFS fölött — fizikai indok nélkül. A második tag (`interModelSpread`) az, amit egy modellcsalád szerkezetileg nem tud megmérni.
- [47 pinelt állítás](../../packages/core/src/multi-model-ensemble.test.mts): single- és multi-model kulcsalak, a mixture-matek (a teszt explicit pineli, hogy a pooled átlag 15 és nem 14 egyenlőtlen tagszámnál), a teljes variancia tétele, és a robusztusság (null-sorok, hiányzó dátum, ragged oszlopok).

### 2. Fetch — [`ensemble-forecast.mts`](../../services/worker/src/pillars/weather/ensemble-forecast.mts)

`fetchMultiModelEnsemble` — ugyanaz az endpoint, amit a bot eddig is hívott, csak vesszős modell-listával: **1 kérés / 197 tag / ~30 KB / ~0,2 s** (mérve). `daily=temperature_2m_max`-ot használ a hourly-ből derivált max helyett — numerikusan azonos mind a 4 modellen (az Open-Meteo ugyanazt az interpolált órás sort aggregálja), töredék payloadért. `EnsembleResult`-alakban tér vissza (minden meglévő fogyasztó változatlanul működik) + `perModel` bontás. Null-ra bukik, sosem dob — mint a `fetchEnsemble`.

### 3. Store — [`multi-model-store.mts`](../../services/worker/src/pillars/weather/multi-model-store.mts)

- (állomás, céldátum) párra **~3 órás** throttle (`dueForSnapshot` — ugyanaz a primitív, mint a B50 #2 OI/könyv-recordereknél), gördülő 400 snapshot/állomás. A rendszerek 6–12 óránként frissülnek → a 3 perces tick-cadence-ből semmit nem veszítünk, és lapos marad az Open-Meteo hívás-budget.
- Minden snapshot rögzíti a per-rendszer μ/σ-t **ÉS azt, amit a bot azon a tickben ténylegesen használt** (`baseMean`/`baseSd` = a GEFS-only ensemble) → **azonos pillanatban vett** fej-fej összehasonlítás, nem két külön időpont utólagos összeollózása.
- Az `obs` az **EMOS-store-ból** másolódik (új `loadResolvedObs` export) — a `reconcileEmosObs` már lekérte a METAR-t minden scannelt (állomás, dátum) párra, **nincs második METAR-kör**.
- [13 integrációs assert **valós Postgres (PGlite)** ellen](../../services/worker/src/pillars/weather/multi-model-store.test.mts) a blobs-compat facade-on át: throttle (per dátum, nem per állomás), round-trip, `leadHours` (12:00 UTC konvenció), obs-átvétel + idempotencia, gördülő cap (a **legrégebbi** esik ki), junk-elutasítás.

### 4. Read-out — [`scripts/eval-multimodel.ts`](../../scripts/eval-multimodel.ts) + [`multi-model-eval.mts`](../../packages/core/src/multi-model-eval.mts)

A log önmagában haszontalan; ez az a szerszám, amivel 2-3 hét múlva eldől a flip. Per állomás és összesítve: bias / MAE / RMSE / **CRPS** / σ̄ / **var-ratio** / ±1σ-coverage / CRPS-skill, explicit verdikttel.

- **CRPS** a döntő oszlop (a Gauss-előrejelzés proper score-ja), **var-ratio** = `mean(hiba²)/mean(σ²)` a diagnózis: >1 = **underdispersed** (túl szűk σ → a Kelly túlméretez) ← pont a dokumentált bug.
- A [31 assert](../../packages/core/src/multi-model-eval.test.mts) pineli a lényeget: **azonos pont-hiba mellett a becsületes σ jobb CRPS-t kap** — vagyis egy változat rosszabb MAE-vel is nyerhet. Ez szándékos: a weather bot problémája a méretezés, nem az irány.
- Futtatás a boxon: `docker compose exec workers bun scripts/eval-multimodel.ts [maxLeadHours]` (default 48h = a T+0/T+1 sáv). Read-only.

### 5. Knobok + wiring

| knob | default | hatás |
|---|---|---|
| `weatherMultiModelRecord` | **1 (ON)** | csak logol; semmi nem olvassa vissza a trade-útra |
| `weatherUseMultiModel` | **0 (OFF)** | ON: a keverék hajtja a μ-t ÉS a σ-t |

A recorder azért default-ON, mert az összehasonlítás **nem backfillelhető** (a B50 #2 doktrína): az Open-Meteo historical API a WeatherNext 2-t csak **~2026-09-04-től** adja, az AIFS-ENS-nek **nincs archívuma**. Ez illik a B49 #6 EMOS mintájához („apply default-OFF, log mindig-on"). Env: `WEATHER_MULTIMODEL_RECORD` / `WEATHER_ENSEMBLE_MODELS` / `WEATHER_MULTIMODEL_INTERVAL_MIN` / `WEATHER_USE_MULTIMODEL` → [env-vars.md §13](../current-state/env-vars.md).

A [`forecast-engine.mts`](../../services/worker/src/pillars/weather/forecast-engine.mts) ág-sorrendje szándékosan olyan, hogy OFF-nál a régi `if` marad az élő út; a fetch is csak akkor indul, ha valaki kérte (`wantMultiModel` a recorder throttle-ből VAGY `useMultiModel`) — **egy** fetch szolgálja ki mindkét fogyasztót.

## Zéró trading-hatás — verifikálva, nem feltételezve

Élő futtatás 4 állomáson (2026-09-08, 2026-09-09 célnap). A `predictedMaxC` / `confidence` / `modelUsed` a bekapcsolt recorder-fetch-csel **bit-azonos** a recorder nélküli hívással:

| állomás | legacy | recorder ON | azonos? | flip ON (mit tenne) |
|---|---|---|---|---|
| RJTT Tokyo | μ 33.9 σ 1.02 conf 0.745 | μ 33.9 σ 1.02 conf 0.745 | **✓** | μ **30.6** conf **0.448** |
| EGLC London | μ 20.0 σ 0.91 conf 0.773 | ugyanaz | **✓** | μ 18.9 conf **0.790** |
| KORD Chicago | μ 28.3 σ 1.55 conf 0.613 | ugyanaz | **✓** | μ 26.7 conf 0.555 |
| VHHH Hong Kong | μ 31.7 σ 0.44 conf 0.890 | ugyanaz | **✓** | μ 30.6 conf 0.725 |

**A Tokió-eset a teljes érv egy sorban:** GEFS μ 33.97 σ **1.02** · ECMWF IFS-ENS 30.80 · ECMWF AIFS-ENS **28.78** · WeatherNext 2 29.16 → keverék μ 30.68 **σ 2.21** (ebből 2.05 a modellek közötti tag). A GEFS **5.2 °C**-kal az AIFS fölött ül, miközben ±1.02 °C-ot állít magáról — a bot ma ezen a piacon kötné a legmagabiztosabb, legnagyobb tétet. Hong Kongon még élesebb: GEFS σ **0.44** egy 1.4 °C-os eltérés mellett.

Londonban viszont a keverék σ **szűkebb** (0.84 vs 0.91) és a confidence **nő** — a modellek egyetértenek, nincs mit tágítani. Tehát **nem uniform σ-tágítás, hanem helyesebb σ.**

## Amit tudni kell a flip előtt

- ⚠ **Kevesebb trade lesz.** A confidence `1 − σ/4`, tehát a szélesebb σ lejjebb viszi; a `weatherConfidenceMin` (0.65) több piacot blokkol — Tokió a fenti példában kiesne (0.448). **Ez a szándék**, nem regresszió.
- A WeatherNext 2 és az AIFS natívan **6-órás** (az API interpolál órásra) → a napi max csúcsa simulhat; az AI-modellek dokumentáltan hideg-biasosak hőhullám-csúcson ([arXiv 2504.21195](https://arxiv.org/abs/2504.21195)). A `perModel` log per-rendszer bias-t mér, a §4.4 korrekció + EMOS korrigálni tudja — **mérés után**.
- Az Open-Meteo free tier **non-commercial**, a hívás-súly a változószámmal nő; a throttle miatt ma elfér, de a live-flip (B10) előtt újraszámolandó.

## Következő

Deploy (push `main` → GitHub Actions → box) → ~2 nap múlva jönnek az első címkézett sorok → 2-3 hét után `bun scripts/eval-multimodel.ts` → a verdikt alapján `weatherUseMultiModel`.
