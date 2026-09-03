# 32 — Offline kalibráció-validáció (sports de-vig + crypto HAR-RV)

> **Forrás:** [`roadmap/model-discovery-training.md`](../roadmap/model-discovery-training.md) §3.C + §6 (B50 #5, sports + crypto ág). **Implementálva:** 2026-09-03 (74. session). **Sprint-tracker:** [`sprints.md` B50](../roadmap/sprints.md#b50).
> **Státusz:** kész, **validáció-only** (nincs store-írás, nincs live-wiring — a report az operátornak). `tsc` exit 0 + teszt + build zöld. A weather-ág (store-seed) külön: [`math/31-emos-seed.md`](./31-emos-seed.md).

A weathertől eltérően a sports Shin (per-market oldja a z-t) és a crypto HAR (a `harRvSigma` fogadja a súlyokat) **állapotmentes** — nincs store-seed. A #5 sports/crypto ága ezért **validációs harness:** valós historikus adaton proper-score/MSE-vel igazolja a metódust, mielőtt élesítenénk. Mérés-first, anti-overfit.

---

## 1. Sports — de-vig validáció valós Pinnacle-close-okon

**Kérdés:** a B49 #7 Shin de-vig tényleg a legjobban kalibrált a MI adatunkon (a `sportsUsePinnacle` élesítése előtt)?

[`packages/core/src/devig-eval.mts`](../../packages/core/src/devig-eval.mts) — tiszta:
- `parseFootballData(csv)` — a football-data.co.uk CSV-t 3-way (H/D/A) rekordokká; a **Pinnacle CLOSING** oszlopokat használja (`PSCH/PSCD/PSCA`), fallback `PSH/PSD/PSA` → `B365C*` → `B365*`; `FTR` a kimenet.
- `scoreDevigMethods(records)` — configonként (multiplicative/power/shin) a fair-valószínűségeket a realizált one-hot ellen: **multiclass Brier + log-loss**, Brier-aszc rendezve (a legjobban kalibrált elöl). N-way (a `devigShin` tömböt vesz → 3-way soccer közvetlenül).

5-csoportos [teszt](../../packages/core/src/devig-eval.test.mts) (closing-preferencia, FTR-map, fallback, 3-way+2-way score, degenerált). Script [`scripts/eval-devig.ts`](../../scripts/eval-devig.ts) (Bun, no-DB): fetch football-data CSV-k (default top-5 liga × 3 szezon) → aggregált + per-liga tábla.

**Élő-verifikált (2023/24 Premier League, 380 meccs):** power 0.5249 ≈ shin 0.5252 < multiplicative 0.5258 — a power/shin épphogy veri a multiplicative-et. **Ez a várt eredmény:** a Pinnacle-close **majdnem hatékony a marginig** (a discovery jóslata) → a de-vig-választás nyeresége kicsi; **az edge a Pinnacle-igazság és a laggos Polymarket-ár rése, nem a de-vig.** A harness ezt objektíven megmutatja.

---

## 2. Crypto — HAR-RV együttható-fit valós Binance-klinákon

**Kérdés:** a `harRvSigma` **equal-weight** (1/3-1/3-1/3) HAR-blendje helyett a **fittelt Corsi-együtthatók** jobban jósolják-e a másnapi realized-vol-t? (A `har-rv.mts` header maga jelölte follow-upnak.)

[`packages/core/src/har-fit.mts`](../../packages/core/src/har-fit.mts) — tiszta:
- `olsFit(X, y)` — normál-egyenletek + Gauss-elimináció parciális pivottal (általános többváltozós OLS).
- `fitHarWeights(rv)` — Corsi HAR: `RV_t = c + βD·RV_{t-1} + βW·RV^(5) + βM·RV^(22)` OLS-fit + in-sample R².
- `evaluateHarForecast(rv)` — kronológiai train/test split → OOS másnapi-RV MSE **fitted vs equal-weight vs random-walk**.

5-csoportos [teszt](../../packages/core/src/har-fit.test.mts) (OLS ismert relációt visszaad + szinguláris→null; HAR-folyamaton R²>0.8 + β-visszanyerés; kevés adat→nem-fitted; sokkos HAR-on fitted veri az equal-t; degenerált). Script [`scripts/fit-har.ts`](../../scripts/fit-har.ts) (Bun, no-DB): Binance napi klina (BTC/ETH/SOL) → RS-realized-var → fit + eval tábla.

**Élő-verifikált (BTC, 1000 napi bar):** fit `βD=0.098, βW=0.185, βM=0.175, R²=0.044` (a heti/havi komponenst súlyozza a zajos napi felett — értelmes mean-reversion), OOS: fitted ≈ equal, de **veri a random-walkot**. **Ez az őszinte mérés-first eredmény:** a napi RV nehezen jósolható (alacsony R²), a fitted-vs-equal rés kicsi → a fittelt együtthatók live-wiring-je csak akkor éri meg, ha a rés **konzisztensen pozitív** több coinon (anti-overfit).

---

## 3. Kapcsolat + follow-up

- **Épít:** [`devig.mts`](../../packages/core/src/devig.mts) (B49 #7 Shin) + [`har-rv.mts`](../../packages/core/src/har-rv.mts) (forecasting #5 equal-weight HAR).
- **Follow-up:** **sports** — az edge-metrika a CLV vs Pinnacle-close (a lag), nem a de-vig → a live sports-firing a B37 odds-feed-en (the-odds-api) múlik, nem ezen a harness-en. **crypto** — ha a fit konzisztensen pozitív, a fittelt Corsi bekötése a `harRvSigma`-ba (opcionális `corsi?` paraméter, backward-kompatibilis) + egy per-coin együttható-store, amit a `getVolSignal` betölt (mérés után, gated). Egyik sem live-wired most (mérés-first).
