# 33 — Diszkontált Thompson-sampling config-választó (+ egységes felejtési faktor)

> **Forrás:** [`roadmap/model-discovery-training.md`](../roadmap/model-discovery-training.md) §3.C + §6 (B50 #6 + #8). **Implementálva:** 2026-09-03 (75. session). **Sprint-tracker:** [`sprints.md` B50](../roadmap/sprints.md#b50).
> **Státusz:** kész, **mérés-only** (a „bandit javasol" fele; 0 trading-hatás). `tsc` exit 0 + teszt + build zöld. A #4 config-attribúcióra ([`math/30`](./30-config-attribution.md)) ül rá.

---

## 1. A kérdés

A discovery **egyetlen erős új adaptív technikája.** A rendszer diszkrét configok között választ (melyik preset / melyik knob segít) **bizonytalanság + késleltetett, zajos reward** mellett — ez **bandit-probléma**, nem felügyelt tanulás. A Thompson-sampling a helyes, minta-hatékony válasz: config-onként Beta-poszterior a „veri-e a forecast a piacot?" fölött, a régi evidencia **diszkontálva** (non-stacionaritás — a #8 felejtési faktor), és a configok a **poszterior „prob-best" (annak valószínűsége, hogy ez a legjobb)** szerint rangsorolva. A reward **proper-score-származék** (model-Brier < piac-Brier), sosem nyers PnL (kisebb variancia, nehezebb gamelni).

---

## 2. A modul (pure)

[`packages/core/src/thompson.mts`](../../packages/core/src/thompson.mts) — tiszta, determinisztikus:
- **#8 `forgettingWeight(age, halfLife)`** = `0.5^(age/halfLife)` (halfLife ≤ 0 → 1). **Az egyetlen decay-primitív**, amit a bandit használ (és amit a Platt/IC átvehet).
- `betaPosteriors(arms, halfLife)` — config-onként `Beta(1+Σw·r, 1+Σw·(1−r))` diszkontált számlálókkal → `mean`, `nEff` (Σsúly), `nRaw`.
- `thompsonRank(arms, {halfLife, samples, seed})` — **prob-best Monte Carlóval:** fix-seedes LCG → Box–Muller normál → Marsaglia–Tsang gamma → Beta-minta; számolja, hányszor a legnagyobb az adott arm mintája. Reprodukálható (mint a bootstrap-CI). prob-best-desc rendezve.
- `banditArmsFromRecords(records)` — a config-attribuált ledgerből: rezolvált predikciók configHash szerint, reward = model verte-e a piacot (Brier), age = kronológiai rang a legújabbtól (0 = legfrissebb). Explicit null-guard.

6-csoportos [teszt](../../packages/core/src/thompson.test.mts): forgetting (fél-életidők), diszkontált poszteriorok (nEff-zsugorodás), rank (80% arm prob-best>0.95, prob-best Σ=1, determinizmus), egyenlő arm-ok ~50/50, ledger→arm reward/age, üres.

---

## 3. Bekötés (mérés-only)

[`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts): a `banditArmsFromRecords(allRecs)` + `thompsonRank` → új `banditEval` response-mező; a **#8 fél-életidő a `icHalfLifeTrades` knobból** (>0), különben default 75 rezolvált predikció. UI: új **`BanditEvalCard`** ([`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx)) — config-onként prob-best sáv + win-rate + effektív-n; a fejléc jelzi, ha egy config ≥90% prob-best (a bandit favorizálja).

**A bandit JAVASOL** — a győztes **alkalmazása** (champion-challenger, bounded, a risk-limiteket sosem érintve) **gated follow-up.** A #4 config-stampek a deploytól forward-töltenek → kezdetben az „unlabeled" arm dominál, ahogy a config-címkézett predikciók gyűlnek, a bandit élesedik. **0 trading-hatás.**

---

## 4. Kapcsolat + follow-up

- **Épít:** [`math/30-config-attribution.md`](./30-config-attribution.md) (#4 — az arm-ok forrása) + a proper-score reward (#1).
- **Kiegészíti az AdaHedge-et** ([`online-weights.mts`](../../packages/core/src/online-weights.mts)): az AdaHedge a **jel-súlyokat** hangolja online (megvan), a Thompson a **diszkrét config-választást** — a kettő ortogonális.
- **#8 továbbvitel:** a `forgettingWeight` a megosztott primitív; a Platt-kalibráció ([`calibration.mts`](../../packages/core/src/calibration.mts)) + a realized-IC ([`signal-calibration.mts`](../../services/worker/src/pillars/shared/signal-calibration.mts)) ugyanezt a fél-életidőt átvéve teljesíti ki a „unified forgetting factor"-t (kis follow-up).
- **Follow-up (#6 live-fele):** champion-challenger shadow-promóció — a bandit-javasolt config paperben a champion mellett, proper-score-on, a #1 promóciós-kapun át; bounded lépés + auto-revert; a risk-guardrailek KÍVÜL. RL alfára = tiltva (discovery).
