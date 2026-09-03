# 27 — Promotion gate (proper-score promóciós kapu)

> **Forrás:** [`roadmap/model-discovery-training.md`](../roadmap/model-discovery-training.md) §3.A + §6 (B50 #1) — „a MEGLÉVŐ mérés élesítése döntéssé; a legolcsóbb, legerősebb kar." **Implementálva:** 2026-09-03 (69. session). **Sprint-tracker:** [`sprints.md` B50](../roadmap/sprints.md#b50).
> **Státusz:** kész, **mérés-only** (0 trading-hatás). `tsc` exit 0 + 36/36 teszt + build zöld.

---

## 1. A kérdés

A rendszer már mindent kiszámol — proper-scoring (`computeProperScores`), walk-forward Brier-skill vs piaci ár (`computeWalkForward`), PSR/MinTRL/DSR (`sharpe-robust`), Platt/AdaHedge challenger-delta — de **mindez advisory kijelzés**. A knob-váltásokat és a default-OFF-flippeket **továbbra is szemre-becsült PnL-en promótáljuk**, ami tucatnyi fat-tail trade-en zaj (a „profit 4 longshoton ül" patológia). A kérdés: **mi az az objektív, előre-regisztrált kapu, ami eldönti, hogy egy konfiguráció promótálható-e?**

**A discovery válasza (a célfüggvény-váltás):** a döntés **elsődlegesen proper-score-on** (kalibráció + a piaci ár verése OOS), **nem** PnL/Sharpe-on. Egy proper-score minden predikcióból informál (a skippeltekből is) → nagy effektív N, kis variancia, és pont ezt fogyasztja a Kelly-sizing; a PnL-különbség tucatnyi trade-en gyakran **nem is mérhető** (MinTRL). Ezért a proper-score-kapuk **hard**-ok, a Sharpe-oldal (PSR/DSR/MinTRL) **advisory** megerősítés.

---

## 2. A logika (pure)

[`packages/core/src/promotion-gate.mts`](../../packages/core/src/promotion-gate.mts) — tiszta, I/O-mentes. `evaluatePromotionGate(input)` → `{ decision, checks[], hardPassed, hardTotal, headline, detail }`.

**Előre-regisztrált küszöbök** (`PROMOTION_THRESHOLDS` — **maga a kapu**, kódban verziózva, nem az operátor fejében; a módosításuk maga is kutatói döntés + DSR-trial):

| Kapu | Küszöb | Típus |
|---|---|---|
| Sample adequacy | `scoredN ≥ 30` | hard (alatta → INSUFFICIENT_DATA) |
| Brier skill vs base-rate | `> 0` | hard |
| Beats market (OOS) | `wfBrierSkill > 0` | hard, **csak ha `wfNResolved ≥ 10`** |
| Walk-forward consistency | `≥ 0.6` | hard, ledger-mély esetén |
| Not one correlated cluster | `maxDayShare ≤ 0.5` | hard, ledger-mély esetén |
| Challenger javít (opc.) | `brierImprovement > 0` | hard (ha applicable) |
| PSR | `≥ 0.95` | **advisory** |
| DSR (trial-deflated) | `≥ 0.95` | **advisory** |
| MinTRL | `tradeN ≥ minTrl` | **advisory** |

**Döntés:** `scoredN < 30` → **INSUFFICIENT_DATA**; minden hard-kapu átmegy → **PROMOTE**; egyébként → **HOLD** (a bukó hard-kapukat megnevezve). A PSR/DSR/MinTRL **sosem blokkol** — ha a hard-kapuk átmennek, de a Sharpe-oldal gyenge, a verdikt PROMOTE, de a `detail` óva int a konzervatív mérettől.

**Vékony ledger / nincs piaci-ár baseline** (F-arb/sports, vagy fiatal ledger, `wfNResolved < 10`): a walk-forward kapuk **advisory-vá fokozódnak le** (nem hard-buknak), így a proper-score-kapuk döntenek egyedül — a ledger-mentes botok nem kapnak hamis HOLD-ot.

**Challenger-mód (opcionális):** ha `input.challenger = {label, applicable, brierImprovement}` (pl. Platt `calibrationEval` vagy AdaHedge `onlineWeightsEval` walk-forward delta) → a verdikt átkeretez „promótáljuk-e ezt a default-OFF-flippet?" — hard-kapu, hogy a challenger **out-of-sample csökkenti-e a Brier-t**. (A v1 UI a baseline-verdiktet mutatja; a challenger-plumbing tesztelt, follow-up UI-selektorra kész.)

---

## 3. Bekötés (mérés-only)

- **API:** [`services/api/src/routes/edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts) — a `summary`/`properScores`/`walkForward`-ból (amit amúgy is kiszámol) építi az inputot; a DSR-t `deflatedSharpe(...)`-fal számolja (σ_SR proxy = bootstrap-CI félszélesség, `nTrials = countTrials()`), `promotionGate` response-mező. **0 store-olvasás felül**, a mode-aware (paper/live/both) trade-kiválasztással konzisztens.
- **UI:** [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx) `PromotionGateCard` — a `SummaryCards` alatt, a proper-score-kártyák **fölött** (a verdikt összefoglalja az alatta lévő részleteket): decision-badge (PROMOTE zöld / HOLD narancs / INSUFFICIENT szürke) + `hardPassed/hardTotal` + kapu-lista (hard elöl, advisory halványítva + „ADVISORY" címke, hover-hint) + tone-bordűrös `detail`.

**Nulla trading-hatás:** semmi nem flippel automatikusan; a decision-engine-ek érintetlenek. A kapu az operátornak mondja meg, mikor **szabad** flippelni — a döntés az övé.

11-csoportos [teszt](../../packages/core/src/promotion-gate.test.mts): PROMOTE (mind pass), INSUFFICIENT (sample-gate dominál), HOLD (brier / beats-market / consistency / cluster külön-külön), vékony-ledger → advisory-fokozás, advisory sosem blokkol, challenger jó/rossz/nem-applicable, tally-konzisztencia, a küszöbök pinelése.

---

## 4. Kapcsolat + follow-up

- **Kiegészíti:** [`math/20-robust-sharpe.md`](./20-robust-sharpe.md) (PSR/MinTRL/DSR) + [`math/21-walk-forward.md`](./21-walk-forward.md) (Brier-skill vs piac) + a proper-scoring harness — ez a kapu **döntéssé** fűzi őket.
- **Follow-up (B50):** (1) **per-trade config-címkézés** (#4) → valódi A/B a régi vs új config közt (jelenleg csak baseline-readiness + trial-szám-DSR); (2) UI challenger-selektor a default-OFF knobokhoz (Platt/AdaHedge/`useRealizedIC`); (3) effektív-trial DSR (ONC-klaszterezés, #3) a literál `countTrials()` helyett; (4) a kapu automatizált champion-challenger shadow-promócióba kötése (#6, guardrail-lel).
