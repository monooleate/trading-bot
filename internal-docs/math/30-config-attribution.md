# 30 — Per-trade config-címkézés + A/B-attribúció

> **Forrás:** [`roadmap/model-discovery-training.md`](../roadmap/model-discovery-training.md) §2.C + §6 (B50 #4) — „a hiányzó A/B-plumbing; a #3 két follow-upjának előfeltétele." **Implementálva:** 2026-09-03 (72. session). **Sprint-tracker:** [`sprints.md` B50](../roadmap/sprints.md#b50).
> **Státusz:** kész, **mérés-only** (0 trading-hatás; a stamp forward-tölt a deploytól). `tsc` exit 0 + 39/39 teszt + build zöld.

---

## 1. A kérdés

A prediction-ledger a forecastot + a kimenetet rögzíti, de **NEM azt, hogy melyik knob-konfiguráció termelte.** Az egyetlen knob-nyom a `trader-trials` (`{ts, keys}` — változott kulcsok, érték és per-predikció-linkelés nélkül). Így **nem lehet slice-olni**, hogy „mi volt a config, amikor ez a forecast tüzelt" → nincs valódi A/B-attribúció, és ez blokkolja a #3 két follow-upját (valódi ONC + cross-trial σ_SR).

---

## 2. A megoldás (pure)

Minden ledger-rekordot **stampelünk az aktív override-ok stabil hash-ével** scan-időben; a rezolvált rekordokat config szerint csoportosítva a **forecast-minőség (Brier-skill vs piaci ár)** configonként összehasonlítható — őszinte, forward-native A/B a **forecaston** (pont amit a #1 promóciós-kapu proper-score célja néz).

[`packages/core/src/config-fingerprint.mts`](../../packages/core/src/config-fingerprint.mts) — tiszta, I/O-mentes:
- `hash32(s)` — FNV-1a 32-bit → 8-hex.
- `configFingerprint(overrides)` — a mentett override-ok (a nem-default numerikus knobok) `k=v` párjai **rendezve** → hash; nincs override → `"default"` (rendezés → sorrend-független; érték-változás → más hash; nem-numerikus érték kihagyva).
- `computeConfigAttribution(records)` — a rezolvált rekordokat `configHash` szerint csoportosítja, configonként Brier(model) + Brier(market) + **brierSkill = 1 − model/market** (>0 ⇒ a model verte az árat) + avgEdge/avgPredicted; a fingerprint nélküli (pre-#4) rekordok `"unlabeled"`; n szerint csökkenőn rendezve. **Kritikus:** explicit null-guard (`Number(null)===0` átcsúszna → minden feloldatlan rekord hamis outcome=0 lenne).

4-csoportos [teszt](../../packages/core/src/config-fingerprint.test.mts): hash32 (8-hex/determinista/megkülönböztet), fingerprint (default/sorrend-független/érték-változás/nem-numerikus), attribution (csoportosítás + skill-előjel + unresolved+bad-baseline skip + unlabeled + rendezés), üres input.

---

## 3. Bekötés (mérés-only, nincs migráció)

- **`prediction-ledger.mts`:** `PredictionRecord` + `IncomingPrediction` új `configHash?` mező; `buildIncoming(..., configHash)` stampel; `upsertRecords` új rekordra beállítja, meglévőre a **legutolsó scan configja nyer** (konzisztens a „latest prediction wins"-szel); `appendPredictions(..., cap, configHash)`. A ledger blob_kv-JSON → **nincs séma-migráció.**
- **`trader-settings.mts`:** új `currentConfigFingerprint()` = `configFingerprint(loadRuntimeOverrides())` (best-effort → `"default"`).
- **A 3 runner** (crypto/weather/HL) tickenként lekéri a fingerprintet és átadja az `appendPredictions`-nek (best-effort, a ledger-hívás sosem törik).
- **UI:** [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts) új `configAttribution` response-mező (a betöltött ledger-rekordokból) + új **`ConfigAttributionCard`** az [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx)-en (per-config Brier-skill tábla).

**A stamp a deploytól forward-tölt** (a régi rekordok `unlabeled`-ok). 0 trading-viselkedés-változás.

---

## 4. Kapcsolat + follow-up

- **Feloldja:** a #3 két follow-upját — a per-config forecast-sorozatból számolható a **valódi ONC** (a trial-ek tényleges teljesítmény-korrelációján, a knob-halmaz-proxy helyett) + a **cross-trial σ_SR** (a bootstrap-CI-proxy helyett). Táplálja a #1 promóciós-kaput (config-szintű proper-score).
- **Follow-up (B50):** PnL-oldali A/B — a `configHash` stampelése az `OpenPosition`-re belépéskor (a session-store residual JSONB-be → nincs migráció) → átvitel a `ClosedTrade`-re záráskor; per-config PnL/Sharpe. Az edge-tracker per-config proper-score-idősor → ONC-input.
