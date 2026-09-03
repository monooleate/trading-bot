# 26 — Effective Number of Bets (diverzifikáció-monitor)

> **Forrás:** [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) §4.C (B49 #9) — „a legakcióképesebb egyetlen diagnózis". **Implementálva:** 2026-09-03 (66. session). **Sprint-tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49).
> **Státusz:** kész, **mérés-only** (0 trading-hatás). `tsc` exit 0 + 35/35 teszt + build zöld.

---

## 1. A kérdés

A könyv 6 botot futtat, de a crypto (BTC-threshold) + HL-perp (BTC/ETH/SOL) + funding-arb mind **crypto-béta** → a „6 független tét" valójában lehet ~2-3. Az **ENB** egyetlen számban megmondja: hány **valóban független** tétet tart a könyv? ENB = N → N független; ENB → 1 → minden egyetlen rejtett faktorra tölt.

---

## 2. A matek (pure)

[`packages/core/src/enb.mts`](../../packages/core/src/enb.mts) — tiszta, I/O-mentes.

- `pearson(x,y)` + `correlationMatrix(series[])` — N igazított hozam-sorozatból N×N korrelációs mátrix (NaN-pár → 0 korreláció).
- `jacobiEigenvalues(sym)` — ciklikus Jacobi sajátérték-solver kis szimmetrikus mátrixra (t-forma, numerikusan stabil).
- `effectiveNumberOfBets(corr)` → **sajátérték-entrópia effektív rang:** `p_i = λ_i / Σλ`, **ENB = exp(−Σ p_i ln p_i)** ∈ [1,N]; `topFactorShare = λ_max / Σλ` (a PC1-ben lévő variancia-hányad — magas = koncentrált). PCA-alapú ENB (a min-torsion finomítás follow-up, a PCA effektív-rang az őszinte első vágás).

7-csoportos [teszt](../../packages/core/src/enb.test.mts): pearson, Jacobi (ismert mátrixok {2,3}, {1,3}, I3), ENB szélsők (identity→N, all-1→1), parciális (1<ENB<2, magasabb ρ → alacsonyabb ENB), a barbell-eset (4 bot de 3 egy faktoron → ENB≈2), edge.

---

## 3. Bekötés (measurement-only)

[`edge-tracker.mts`](../../services/api/src/routes/edge-tracker.mts): minden bot (STORE_SPECS) closed-trade-jéből **per-bot napi-PnL sorozat** a közös dátum-unió fölött → `correlationMatrix` → `effectiveNumberOfBets` → `enb` response-mező (+ `labels` a botnevek). Csak azok a botok kerülnek be, amelyeknek van nem-nulla napjuk (≥2 aktív bot + ≥2 közös nap kell). UI: [`EdgeTrackerPanel.tsx`](../../apps/web/src/components/EdgeTrackerPanel.tsx) **`EnbCard`** — ENB/N, diverzifikáció %, top-faktor %, + figyelmeztetés ha koncentrált (ENB/N < 0,6). Nincs trading-hatás.

---

## 4. Hogyan olvasd

- **ENB ≈ N** (pl. 5/6) → jól diverzifikált könyv.
- **ENB << N** (pl. 2/6) + magas top-faktor % → **koncentrált**: egy BTC-mozgás egyszerre üti a „független" crypto-béta botokat (a barbell-kockázat, amit a #2 exposure-cap kezel). Ez a szám igazolja/hangolja a #2 cap-et.

---

## 5. Maradó (follow-up — sprints.md B49)

- **Min-torsion ENB** (Meucci) a PCA effektív-rang helyett — a PCA-sajátvektorok instabilak; a min-torsion faktorok közelebb maradnak az eredeti stratégiákhoz. Párosítani az effektív-ranggal.
- **Napi-return normalizálás** bankrollra (jelenleg napi-PnL; a korreláció skálainvariáns, de a return tisztább).
- **A #8 portfólió-overlay + a #2 cap hangolása** az ENB alapján (közös „align per-bot PnL to a common daily series" réteg).
