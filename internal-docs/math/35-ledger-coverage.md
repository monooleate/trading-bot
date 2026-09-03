# 35 — Prediction-ledger lefedettség (sports-ledger + a deferred infra)

> **Forrás:** [`roadmap/model-discovery-training.md`](../roadmap/model-discovery-training.md) §6 / #9 (sprints.md B50, → B12). **Implementálva:** 2026-09-03 (77. session). **Sprint-tracker:** [`sprints.md` B50](../roadmap/sprints.md#b50).
> **Státusz:** kész — a tisztán illeszkedő rész (sports-ledger) bekötve; a többi rész **tudatosan deferred / not-applicable** (indoklással). `tsc` exit 0 + teszt + build zöld.

---

## 1. A #9 három része — őszinte scope

A roadmap #9 három dolgot csomagolt össze; a kód-valóság szerint eltérően kezelendők:

| Rész | Verdikt | Indok |
|---|---|---|
| **Sports prediction-ledger** | ✅ **bekötve** | A sports bináris Polymarket-piac, ami **rezolvál** — pont mint a crypto/weather. Eddig **semmi** ledger nem volt rá → nincs proper-scoring/config-attribúció/walk-forward szubsztrátum. |
| **Ledger → normalizált Postgres-tábla** | 🟠 **deferred (B12)** | A ledger **MÁR Postgres-en van** (a blob_kv KV-shim → `blob_kv` tábla, JSON). A normalizált `prediction_ledger` tábla (a `ledger.ts` létezik, nincs bekötve) csak **SQL-queryability nicety** — funkcionálisan nem szükséges, a migráció koordinált worker+api + adat-shape kockázat. B12-re marad. |
| **HL / F-arb ledger-baseline** | ⚪ **not-applicable** | **F-arb:** delta-neutrális carry — **nincs P(YES) forecast**, amit scoreolni lehetne → prediction-ledger nem értelmezhető. **HL:** perp directional — **nincs bináris piaci ár / rezolúció**; a walk-forward „beat the market price" (bináris baseline) nem alkalmazható. A HL ledger eleve **taken-only** a természeténél fogva (a kimenet a realizált PnL, nem egy market-rezolúció). |

---

## 2. A sports-ledger bekötése

[`sports/index.mts`](../../services/worker/src/pillars/sports/index.mts): a scan-loop + `saveSportsSession` után `appendPredictions("sports", results, markets, session.closedTrades, undefined, cfgHash)` + `reconcileLedger("sports")`, a config-fingerprinttel stampelve (#4), best-effort (sosem töri a ticket). A [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts) `LEDGER_CATEGORIES`-e bővült `"sports"`-szal → az edge-tracker betölti (ledger-stats + walk-forward + config-attribúció + bandit a sportsra is).

**Állapot-megjegyzés:** a sports jelenleg **leállítva** (a fabrikált fair-value + B37 odds-feed-hiány miatt) → a runner a stopped-guardnál korán kilép, tehát a ledger **a sports újraindulásáig (B37 után) nem tölt.** De az infrastruktúra kész, és a taken-trade-ek predikcióit rögzíti, amint a bot fut. Post-B37 valós Shin-fair-value-kat logol.

**Audit-fix (2026-09-03, 78. session):** a bekötés eredeti verziója **két latens hibát** hordozott, amit az audit feltárt és javított — a sports-ledger a fix előtt gyakorlatilag inert volt:
- **`endDate` hiányzott minden result-row-ról** → a `reconcileLedger` pending-szűrője (`r.endDate && …`) **soha** nem talált jelöltet → a skipped-market Gamma-reconcile **strukturálisan sosem futott** (holt `reconcileLedger("sports")` hívás). **Fix:** `endDate: m.endDate` minden row-on (traded + skip).
- **A skip-rowok nem hordoztak `predictedProb`-ot** → `buildIncoming` **eldobta** őket → a skipped piacok be sem kerültek → a ledger nemcsak „taken-heavy", hanem **taken-only** volt. **Fix:** minden skip-row kap `predictedProb: yesProb`-ot (a direction-agnosztikus model P(YES) = a 0.5-pull heurisztika a direction-inverzió **előtt**), + `marketPrice: m.yesPrice`.
- **Bónusz-korrekció:** a *traded* row `predictedProb`-ja `predicted` (= **P(chosen side)**) volt, ami NO-trade-eknél **hibás** a ledger-kontraktushoz (`predictedProb = model P(YES)`, direction-agnosztikus) képest → a Gamma YES-rezolúció ellen rossz Brier-t számolt volna. **Fix:** a traded row is a `yesProb`-ot logolja (mint a crypto `marketContext.predictedProb: signal.finalProb`). Zero UI-hatás (a `SportsTrader` nem olvassa a result-row `predictedProb`-ot).

A sports-ledger mostantól **valóban unbiased** (taken + skipped), és a reconcile funkcionális. Regressziós pin: [`prediction-ledger.test.mts`](../../packages/core/src/prediction-ledger.test.mts) „sports-ledger" blokk. A fabrikált fair-value **minősége** külön ügy → **B37** (valós Pinnacle Shin de-vig).

---

## 3. Kapcsolat

- **#1/#4/#6** (proper-scoring / config-attribúció / Thompson): a sports mostantól ezek szubsztrátumát is kapja (a `LEDGER_CATEGORIES`-en át).
- **B12** (ledger → normalizált Postgres): a deferred migráció; a `packages/core/src/ledger.ts` a cél-implementáció, koordinált worker+api port + `export-blobs`/`import-blobs` tooling megvan.
- **B37** (sports odds-feed): a sports-ledger valódi feltöltésének feltétele (addig fabrikált/leállított).
