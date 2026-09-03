# 21 — Walk-forward scoring a prediction-ledgeren (model vs market, OOS)

> **Forrás:** [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) §4.B (B49 #4) — a #3 (PSR/MinTRL/DSR) párja, a validációs réteg másik fele. **Implementálva:** 2026-09-03 (61. session). **Sprint-tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49).
> **Státusz:** kész, **mérés-only** (diagnosztika, 0 live viselkedés-változás). `tsc` exit 0 + 31/31 teszt + build zöld. **A B11 (walk-forward backtest) Hetzner-mentes, backtest-motor-mentes verziója.**

---

## 1. A kérdés, amire válaszol

A #3 a Sharpe-ot ítéli meg. A forecasting-bot élesebb kérdése viszont: **a model valószínűségei verik-e a PIACI ÁRAT, out-of-sample, konzisztensen az időben?** Ha nem, az „edge" illúzió — a piaci ár a jobb előrejelző (ugyanaz a fabrikált-fair-value csapda, ami a sportsot megölte, és amit a leakage-aware kutatás a likvid piacokra kimutatott: a puszta ár veri az LLM-et).

A **prediction-ledger** a helyes szubsztrátum: minden szkennelt piac P(YES) predikcióját logolja (taken + skipped → torzításmentes), a realizált YES-kimenettel és rezolúciós idővel.

---

## 2. A modell (pure)

[`packages/core/src/walk-forward.mts`](../../packages/core/src/walk-forward.mts) — tiszta, I/O-mentes.

- `ledgerPointsFromRecords(records)` → a **feloldott** rekordok (outcome 0/1, valós model+market prob, parse-olható rezolúciós idő). ⚠ `Number(null)===0` csapda kivédve (a null-outcome explicit skip).
- `computeWalkForward(points, {blockCount=5})`:
  1. rendezés **rezolúciós idő** szerint (nincs look-ahead),
  2. `blockCount` egymást követő **kronológiai blokk** (a blockCount az adathoz zsugorodik, hogy egy blokk se legyen üres),
  3. blokkonként + poololva: **Brier(model)** vs **Brier(market)** + **Brier skill = 1 − Brier_model/Brier_market** (>0 ⇒ a model veri az árat), log-loss model vs market, avgPred/avgOutcome.
- **Konzisztencia:** `blocksPositiveSkill / nBlocks` — hány blokkban veri a modell az árat (nem egy szerencsés ablak).
- **Korrelációs figyelmeztetés (surfaced, nem elhallgatva):** `effectiveDays` (különböző rezolúciós napok) + `maxDayShare` (a legnagyobb egynapos klaszter aránya). Az azonos napon feloldó crypto-strike-létra / weather-bucketek erősen korreláltak → egy mozgás sokszor számít; ezt a két szám láthatóvá teszi. (Teljes purge = follow-up; a kutatás szerint a purge főleg a kalibráció-**illesztésnél** kritikus, a tiszta blokk-scoringnál kevésbé.)

**Scoring-only → nincs train/test leakage:** egyetlen idő-rendezett átmenet, piaci baseline-nal. 7-csoportos [teszt](../../packages/core/src/walk-forward.test.mts): extract-szűrés, skill>0/=0/<0, blokk-hasítás+kronológia, klaszter-caveat, szűkös adat.

---

## 3. Bekötés

- **Edge-tracker route** [`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts): a ledger-rekordok (amiket a `ledgerStats` amúgy is betölt) → `ledgerPointsFromRecords` → `computeWalkForward` → `walkForward` mező a response-ban. `category=all`-nál a kategóriák poololva (a market-baseline összevethető). Mock-ban kihagyva.
- **UI** [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx): új **`WalkForwardCard`** — overall Brier skill (vs piac) + konzisztencia (hány blokk veri a piacot) + per-blokk skill-sávok + a korrelációs caveat (indep. days / max cluster). Szín: skill>0 zöld, <0 piros.

Nincs új knob, nincs env-vár, nincs live-döntés — tisztán mérés.

---

## 4. Hogyan olvasd

- **Brier skill > 0 + magas konzisztencia** (pl. 4/5 blokk) → a bot valószínűségei valóban jobbak a piaci árnál OOS → a stratégia-mag valid.
- **Brier skill ≤ 0** → a piaci ár a jobb előrejelző; a „profit" (ha van) nem a jobb predikcióból jön (fee/variance/szerencse) → óvatosan a méretezéssel.
- **maxDayShare magas** (>50%) → a mintát egy korrelált nap dominálja → a blokk-skillt fenntartással kezeld, gyűjts több, időben szórtabb rezolúciót.

---

## 5. Maradó (follow-up — sprints.md B49)

- **Purge/embargo** a korrelált klaszterekre (azonos strike-létra / város-nap) a puszta caveat helyett — de-correlated skill.
- **Anchored-fit walk-forward** a #2 Platt-kalibrációval összekötve (a kalibrátort múlt-blokkon illeszteni, a következőn scoreolni) — a `calibration.mts` már ad walk-forward Platt-evalt; ezt a ledger-szubsztrátumra kiterjeszteni.
- **Per-kategória bontás** az UI-n (jelenleg `all`-nál poololt).
