# CHANGELOG — 2026-10-22

## Élő állapot-ellenőrzés + B38 #3 lejárati-ablak cap (default OFF)

### Élő ellenőrzés (read-only, 07:05 UTC)

- Box egészséges (load 0,1, 1,3/7,6 GB RAM, lemez 25%); az `edgecalc-*` konténerek ~280 MB-ot használnak.
- `multi-status`: $700 → **$613,45** (crypto $112,60 · weather $86,57 · HL $199,32 · F-Arb $195,48 · sports $19,47, stopped). A knob-override-ok (20) egyeznek a CLAUDE.md referencia-listájával.
- Csak a crypto threshold-ág köt: 10-06…10-21 között 14 kötés, 9 nyerő, **+$9**.
- F-Arb: a BTC/ETH carry 0,0013%/h a 0,005%/h küszöb alatt → nem nyit.
- `scripts/eval-maker-shadow.ts`: 900 megbízás / 86 piac, egyik szint sem `PROMISING` → B77b nem indul.
- `scripts/eval-weather-vs-market.ts`: 337 minta, a pooled modell Brier-skillje a piac ellen **−85%** [−100; −73], minden horizonton negatív → a `weatherHalt` marad.

### B38 #3 — lejárati-ablak cap

- Új: `windowExposureUsd` + `checkResolutionWindowCap` ([`packages/core/src/portfolio-exposure.mts`](../../packages/core/src/portfolio-exposure.mts)), `getEffectiveWindowCap` ([`shared/config.mts`](../../services/worker/src/pillars/shared/config.mts)), crypto runner 4b' gate ([`pillars/index.mts`](../../services/worker/src/pillars/index.mts)), 3 knob a [`trader-settings.mts`](../../services/api/src/routes/trader-settings.mts) SCHEMA-ban (`crypto` / Risk & sizing), env-ek az [`env-vars.md`](../current-state/env-vars.md)-ben.
- Default OFF → a gate nem fut, a viselkedés változatlan. Élő knob nem változott.
- Tesztek: `portfolio-exposure.test.mts` §6–8. Kapu: `tsc` exit 0 · **58/58** teszt · build zöld.
- Visszamérés: a 14 élő kötésből 6-ot blokkolt volna, mind nyerő volt (+$42) → nem élesítendő most. Részletek: [`math/19`](../math/19-portfolio-exposure-cap.md) §4b, feladat-állapot: → Backlog B38.
