---
paths:
  - "services/worker/src/pillars/weather/**"
  - "packages/core/src/emos*.mts"
  - "packages/core/src/pooled-emos*.mts"
  - "packages/core/src/multi-model-*.mts"
  - "packages/core/src/weather-dispersion*.mts"
  - "scripts/seed-emos.ts"
  - "scripts/eval-multimodel*.ts"
  - "scripts/eval-weather-vs-market.ts"
  - "apps/web/src/components/trader/WeatherTrader.tsx"
---

# Weather bot

- `weatherHalt`=1 (B79): nem nyit, de előrejelez, logol, a multi-model felvétel fut. Visszakapcsolás CSAK ha a `scripts/eval-weather-vs-market.ts` valamelyik tisztességes horizonton pozitív Brier-skillt mutat a PIACI ár ellen (B76: T+1 −28%, T+0 −33% / −300%, a ½–½ keverék is rosszabb).
- σ-lánc: `weatherUseMultiModel`=1 → a keverék + SAJÁT EMOS (`pooled-emos.mts`) hajtja a μ/σ-t, szorzója `weatherMultiSigmaInflation` (1,0). A `weatherSigmaInflation` CSAK a GEFS-útra és a keverék-hibás GEFS-fallbackra hat. A GEFS-EMOS-tár tovább kapja a GEFS-adatot (tiszta visszakapcsolás).
- Forrás-flipnél a bucket-matcher σ-ja (`ensembleDetail`) és a recorder-throttle is kövesse az új forrást (B69: mindkettő elcsúszott volna).
- `weatherSigmaInflation` és `weatherEmosSeedWeight` párban mért: egyiket se hangold a másik újramérése nélkül; a σ-szorzó path-függő (nyers vs EMOS-úton más).
- σ-tágítás kár-csökkentés, nem edge: monoton, a predikció–kimenet korreláció előjelét nem fordítja.
- Multi-model: a modell-taget a VÁLASZ-kulcsból olvasd (`splitEnsembleKeys`; az Open-Meteo belső domain-nevet ad: `gfs_seamless` → `ncep_gefs_seamless`, aliasra illesztve némán 0 tag). A keverék modellenként egyenlő súlyú (σ² = mean σ²_k + var μ_k), nem tagonként.
- Az Open-Meteo a domainen kívüli regionális modellt egy közös kérésben némán elhagyja (egyedül kérve 400) → nem kell per-állomás modell-lista. Kizárva: `bom_access_global_ensemble` (csupa null), `ukmo_uk_ensemble_2km` (3 tag). Az Open-Meteo free tier non-commercial.
- Rezolúciós állomás = amit a piac szabálya megnevez (`station-config.mts`); Hongkong a HKO-megfigyelést használja (`station-obs.mts`). Eltérés → `SETTLEMENT_STATION_MISMATCH` log (városonként naponta egy); a javítás az operátor döntése.
- EMOS: log + reconcile MINDIG fut (METAR-alapú obs, trade-független → torzítatlan); apply csak `weatherUseEmos`=1 és ≥20 residual mellett. Seed: `injectSeedResiduals` sosem ír felül forward-residualt; futtatás a boxon operátor-lépés (`docker exec edgecalc-workers bun scripts/seed-emos.ts [months]`).
- `weatherInvertDirection` OFF marad: a naiv flip mérve sem működik. Invert módban is a Kelly a `baseDirection` (modell-preferált) oldalán méretez — különben 0 méret és 0 PnL minden trade-en (B22).
- `weatherSelectionShrink` csak a trade-gyakoriságot mozgatja; a méret-knob a `weatherKellyScale`. `weatherMinPrice` longshot-floor: a tail-bucket paperben tökéletesen tölt, élőben nem (felfelé torzított paper-PnL).
- A WN2/AIFS natívan 6 órás és nincs offline backfill (WN2 ~2026-09-04-től) → összehasonlító adatot log-forward gyűjts (`weatherMultiModelRecord` default 1).
