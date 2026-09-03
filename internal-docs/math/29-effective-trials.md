# 29 — Effektív-trial DSR (klaszterezett trial-szám)

> **Forrás:** [`roadmap/model-discovery-training.md`](../roadmap/model-discovery-training.md) §3.A + §6 (B50 #3) — „a meglévő literál-trial-DSR őszintévé tétele (ONC-klaszterezés)." **Implementálva:** 2026-09-03 (71. session). **Sprint-tracker:** [`sprints.md` B50](../roadmap/sprints.md#b50).
> **Státusz:** kész, advisory (a DSR-t pontosítja; a gate-ek default-OFF-ja változatlan). `tsc` exit 0 + 38/38 teszt + build zöld.

---

## 1. A kérdés

A DSR a Sharpe-ot az `E[max SR N trial alatt]` benchmarkkal deflálja — ez a benchmark N-nel nő, tehát a **helyes N** számít. A rendszer minden knob-váltást trial-ként logol (`trader-trials`), de sok **közel-duplikátum**: a changelog ugyanazt a knobot nyomkodja újra és újra (weather-invert, `useRealizedIC`, egy `combinerConfidenceMin` 0.02→0.05 tweak). Ha mindegyik **független** trial-ként számít, a DSR **túl-deflál**: húsz tweak egy knobon nem húsz független túlillesztési esély, hanem ~egy.

---

## 2. A megoldás (pure)

López de Prado ONC-je a trial-ek **hozam-sorozatának korrelációja** szerint klaszterez, és a klaszter-számot használja N_eff-ként. Per-trial hozam-sorozatot még nem logolunk (az a #4 per-trade config-címkézés) → az őszinte, **elérhető proxy** a trial-log önmagából: klaszterezés a **megváltoztatott knob-halmazok átfedése** szerint.

[`packages/core/src/trial-cluster.mts`](../../packages/core/src/trial-cluster.mts) — tiszta, I/O-mentes:
- `jaccard(a,b)` = |A∩B| / |A∪B|.
- `effectiveTrialCount(trials, threshold=0.5)` — a trial-gráf **összefüggő komponensei**, ahol két trial akkor él-kapcsolt, ha `Jaccard(changed-keys) ≥ threshold`. Az azonos knob-halmazt érintő trial-ek egy klaszterbe esnek; a diszjunktak külön maradnak. **N_eff = a klaszterek száma ≤ literál N.**

**N_eff < N ⇒ KEVESEBB defláció ⇒ pontosabb (nem mesterségesen szigorú) benchmark** — a DSR azt korrigálja lefelé, amit a konfig-keresés **valóban** bejárt. A threshold (default 0.5) korlátozza a single-linkage láncolást: `{A}` egyesül `{A,B}`-vel (J=0.5), de `{A,B}` és `{B,C}` (J=1/3) nem.

6-csoportos [teszt](../../packages/core/src/trial-cluster.test.mts): jaccard-értékek, degenerált (üres/üres-kulcs/egy), 5 azonos-tweak→1, 3 diszjunkt→3, threshold + korlátolt láncolás, vegyes reális log (dupok + egyediek → effektív < literál).

---

## 3. Bekötés

- **`trader-settings.mts`:** új `effectiveTrials(threshold=0.5)` → `{ literal, effective }` (a trial-logot betölti + klaszterezi); a `countTrials()` a `loadTrialLog()`-ra DRY-olva.
- **DSR-fogyasztók N_eff-re váltva** (literál-fallback megőrizve): a worker crypto/status live-readiness call-site-jai ([`pillars/index.mts`](../../services/worker/src/pillars/index.mts) `trialsCount`/`statusTrials`) + az [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts) #1 promóciós-kapu DSR-je. A `deflatedSharpe(..., nTrials, ...)` mostantól a klaszterezett N-t kapja.

**Advisory:** a DSR eddig is advisory volt (a `liveReadyMinPsr`/`UseMinTrl` gate-ek default-OFF, a #1 kapuban a DSR advisory) → 0 trading-viselkedés-változás, csak a defláció pontosabb.

---

## 4. Kapcsolat + follow-up

- **Kiegészíti:** [`math/20-robust-sharpe.md`](./20-robust-sharpe.md) (DSR) + [`math/27-promotion-gate.md`](./27-promotion-gate.md) (a #1 kapu DSR-advisory-ja most N_eff-en).
- **Follow-up (B50):** valódi **ONC a per-trial hozam-korreláción** + **cross-trial σ_SR** (a jelenlegi bootstrap-CI-proxy helyett) — mindkettő a **#4 per-trade config-címkézést** igényli (akkor lesz per-trial hozam-sorozat). Embargo a change-pointra + korrelált-predikció de-dup a forward-statisztikákban szintén #4-függő.
