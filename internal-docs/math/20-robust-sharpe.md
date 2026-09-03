# 20 — Robust Sharpe: PSR / MinTRL / DSR (validációs réteg)

> **Forrás:** [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) §4.B (B49 #3). **Implementálva:** 2026-09-03 (60. session). **Sprint-tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49).
> **Státusz:** kész, a PSR/MinTRL **advisory** (mindig megjelenik), a live-kapuk **default OFF** (operator opt-in). `tsc` exit 0 + 30/30 teszt + build zöld.
> **Elsődleges forrás:** Bailey & López de Prado, *The Sharpe Ratio Efficient Frontier* (deflated-sharpe PDF).

---

## 1. A probléma (kódból)

A rendszer **forward paper track-recordon** validál, nincs backtest-motor. Két torzítás:
1. **Kis minta + fat-tail:** a nyers Sharpe túlbecsli a szignifikanciát, amikor az edge „4 longshoton ül" (a crypto +$690 patológia). A `computeSummary` bootstrap-CI-je jelezte a szélességet, de nem adott valószínűséget.
2. **Config-hunting:** az overfitting-kockázat nem a backtest-trialek, hanem a **knob-konfigurációk száma, amiket egyetlen növekvő recordra próbáltunk** (a changelog tucatnyit mutat). Ezt semmi nem korrigálta.

A megoldás **forward-native** (nem kell backtest-motor):
- **PSR** — `P(valódi SR > benchmark)`, a minta-hossz + ferdeség + csúcsosság korrekciójával.
- **MinTRL** — hány trade kell a Sharpe adott konfidenciájú szignifikanciájához → az **elvi paper→live kapu** (az önkényes „30 trade" helyett).
- **DSR** — PSR a **legjobb-N-trialből** várható (szerencse-)Sharpe ellen → az edge-et lehúzza aszerint, mennyit config-huntoltál.

---

## 2. A matek (pure module)

[`packages/core/src/sharpe-robust.mts`](../../packages/core/src/sharpe-robust.mts) — tiszta, I/O-mentes. Az `SR` a **per-trade** Sharpe (a per-trade hozamok átlaga/szórása), `n` = trade-szám; a kurtózis **nyers** (normál = 3), a `(γ₄−1)/4` taghoz igazítva.

```
PSR(SR*) = Φ[ (SR − SR*)·√(n−1) / √(1 − skew·SR + ((kurt−1)/4)·SR²) ]

MinTRL   = 1 + [1 − skew·SR + ((kurt−1)/4)·SR²]·( z_conf / (SR − SR*) )²    (∞ ha SR ≤ SR*)

E[max SR_N] ≈ σ_SR·[ (1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)) ]   (γ = Euler–Mascheroni)
DSR = PSR(SR* = E[max SR_N])
```

Helperek: `skewness`, `kurtosis` (method-of-moments, population variance), `normalCdf` (A&S erf), `normalInv` (Acklam). 6-csoportos [teszt](../../packages/core/src/sharpe-robust.test.mts): normál CDF/inverz, ferdeség/csúcsosság, PSR (n-monoton, fat-tail csökkenti, SR==benchmark→0.5), MinTRL (kis SR → több trade, SR≤0 → ∞), E[maxSR]/DSR (trial-monoton, DSR < PSR-vs-0).

---

## 3. Bekötés

| Réteg | Fájl | Mit |
|---|---|---|
| Summary | [`packages/core/src/statistics.mts`](../../packages/core/src/statistics.mts) `computeSummary` | új `returnSkew`, `returnKurtosis`, `psr`, `minTrl` mezők (a nyers per-trade Sharpe-ból). `minTrl` = 999999 sentinel ha SR≤0 (JSON-biztos „∞") |
| Edge Tracker UI | [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx) | 2 új KPI-kártya (**PSR**, **MinTRL** vs a meglévő trade-szám) a bővített summary-sorban |
| Readiness | [`shared/live-readiness.mts`](../../services/worker/src/pillars/shared/live-readiness.mts) | a summary-blokk mindig hordozza `psr`/`minTrl`/`dsr`/`trialsCount`. Két **opt-in** kapu: `minPsr` (PSR ≥ küszöb) + `useMinTrl` (trade-szám ≥ MinTRL). σ_SR proxy = a bootstrap-CI félszélessége. DSR = deflatedSharpe(...) |
| Trials-log | [`trader-settings.mts`](../../services/api/src/routes/trader-settings.mts) | minden knob-változás egy „trial" → `appendTrial(changedKeys)` a POST-ban; `countTrials()` adja a DSR N-jét (a runner tölti be tickenként) |

**Knobok** (SCHEMA, category `common`, group „Live readiness"): `liveReadyMinPsr` (default **0** = advisory), `liveReadyUseMinTrl` (0/1, default **0**). Nincs új env-vár.

---

## 4. Miért advisory / opt-in

- A PSR/MinTRL **mindig megjelenik** (mérés), de a live-kapuk **default OFF** — egy blokkoló readiness-gate viselkedés-változtató, a repo mintája szerint operator opt-in (+ a live-flip amúgy is B10-blokkolt).
- **MinTRL a helyes „kész-e?" szám:** fat-tailű longshot-botnál gyakran több száz trade; tiszta edge-nél kevesebb — az önkényes fix 30 helyett.
- **Honest N (trials):** rendszer-szintű count (a knobok cross-bot); egy közelítő N a helyes korrekció (Bailey/LdP: „even a rough N meaningfully raises the bar"). A per-kategória attribúció follow-up.

---

## 5. Maradó (follow-up — sprints.md B49)

- **Trials σ_SR:** jelenleg a bootstrap-CI félszélessége a proxy; a valódi cross-config Sharpe-szórás tárolása (a Sharpe mentése minden trial-határon) pontosabb DSR-t adna.
- **Per-kategória trials** attribúció (most rendszer-szintű N).
- **HL/F-arb readiness** ugyanígy megkapja a PSR/MinTRL/DSR-t (jelenleg a crypto + a generikus status-út wired; a HL saját status-útja follow-up).
- **#4 walk-forward scoring a ledgeren** — a másik fele a validációs rétegnek (külön B49-tétel).
