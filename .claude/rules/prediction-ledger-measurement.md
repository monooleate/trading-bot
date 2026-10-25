---
paths:
  - "packages/core/src/prediction-ledger*.mts"
  - "packages/core/src/ledger.ts"
  - "packages/core/src/promotion-gate*.mts"
  - "packages/core/src/walk-forward*.mts"
  - "packages/core/src/config-fingerprint*.mts"
  - "packages/core/src/build-info*.mts"
  - "packages/core/src/sharpe-robust*.mts"
  - "packages/core/src/calibration*.mts"
  - "packages/core/src/statistics.mts"
  - "packages/core/src/online-weights*.mts"
  - "packages/core/src/enb*.mts"
  - "packages/core/src/thompson*.mts"
  - "packages/core/src/trial-cluster*.mts"
  - "services/api/src/routes/edge-tracker.mts"
  - "services/api/src/routes/edge-tracker/**"
  - "apps/web/src/components/EdgeTrackerPanel.tsx"
  - "scripts/eval-*.ts"
  - "scripts/eval-*.mts"
  - "packages/core/src/fx-backtest*.mts"
---

# Prediction ledger + mérési réteg (Edge Tracker, promóciós kapu)

- A ledger-sor `firstPredictedProb` / `firstMarketPrice` / `firstConfigHash` hármasa **írás-egyszer**: az `upsertRecords` a frissítés ELŐTT latch-el. A „latest" mezők csak a UI-nak valók — rescan után az ár mechanikusan a kimenetre konvergál (B53). Minden mérés-fogyasztó `first* ?? latest`-et olvas.
- „Tiszta" sor kizárólag a `firstObservationProvenance` szerint: `firstTs ≥ FIRST_TUPLE_EPOCH` (`2026-09-09T05:25:24Z`), nem `firstBackfilled`, weathernél van `bucketId`. A `firstTs` sosem íródik felül. Ha a tisztaság-szabály változik, a drift-check SQL-jét (`~/.claude/scheduled-tasks/edgecalc-drift-check`) is frissíteni kell.
- Weather ledger-sor kulcsa (esemény, bucket) — `bucketId` a `recordKey`-ben (B78); slug-kulcsú sor egy bucket valószínűségét egy másik bucket kimenetével párosítaná.
- `codeVersion` (BUILD_INFO sha első 12 karaktere) külön mező; NE hasheld a `configHash`-be — minden push új armot nyitna (B66).
- A ledger `blob_kv` JSON (store `prediction-ledger`) → új rekord-mező nem igényel SQL-migrációt.
- Sports ki van zárva a `category="all"` aggregátumból (`AGGREGATE_EXCLUDED` az `edge-tracker.mts`-ben); a saját fül és a gyűjtés változatlan. B37 (valódi odds-feed) után visszavonandó.
- Edge-et a PIACI ár ellen mérj (Brier-skill vs market, OOS, kronologikus blokkok) — a base rate verése nem edge (threshold-ág: +90,9% base rate ellen, de a piacot nem veri).
- Promóciós kapu: a proper-score kapuk (sample ≥30, Brier-skill >0, beats-market OOS, consistency ≥0,6, cluster ≤0,5) hard; a PSR/DSR/MinTRL advisory. Semmi nem flippel automatikusan; a Thompson-bandit csak javasol.
- DSR `nTrials` = effektív trial-szám (`effectiveTrials()`, Jaccard-klaszter), literál fallbackkel.
- Mérés-scriptet csak kontrollal hihetsz: a B73 (+92%) artefakt volt (a Gamma `tag_id=21` above-K készlet ár-idősor nélkül, 0,5-ös placeholderrel); in-sample alapvonal ellen a B69 keverék hamisan vesztesnek látszott. Artefaktból származó eredményt ne szállíts.
- Külső idősort a granularitásáig ellenőrizz: a Yahoo chart API `range=max&interval=1d` csendben HAVI gyertyát ad (B80) → `period1/period2`, és a script álljon le, ha a medián bar-köz nem a vártnak felel meg.
- Megkülönböztetendő: „mértük, nincs skill" vs „nem tudtuk mérni" — a HL realized-IC 8 × pontosan 0,0 törött cső volt (`pnlUSDC` vs `pnl` mezőhiba); degenerált jelzést adj, ne skillt.
- Ledger-írás minden scannelt piacra (taken + skipped), a skip-sor is `predictedProb`-ot visz — taken-only ledger torzít. A measure-only halt (B74/B79) is pusholja a skip-sort.
