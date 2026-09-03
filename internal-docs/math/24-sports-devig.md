# 24 — Sports de-vig (Shin) — a fabrikált fair-value leváltása

> **Forrás:** [`roadmap/model-discovery-expansion.md`](../roadmap/model-discovery-expansion.md) §4.E sports (B49 #7, = B37). **Shin implementálva:** 2026-09-03 (64. session). **Sprint-tracker:** [`sprints.md` B49](../roadmap/sprints.md#b49).
> **Státusz:** a de-vig matek (multiplicative + power + **Shin**) kész + tesztelt. A **live odds-feed** (the-odds-api + ODDS_API_KEY + event-matching) a **maradó adat-task** (B37) — enélkül a de-vig matek él, de nincs mit betáplálni (a shrink-fallback fut, zéró regresszió).

---

## 1. A probléma

A sports bot „fair value"-ja **fabrikált**: `predicted = 0.5 + (yesPrice − 0.5)·0.55` — a Polymarket **saját árát** húzza 0.5 felé. Ez körkörös (a piac ellen fogad a piac árával) → nincs valódi edge-forrás (~10% WR, evGap −$2677), és **megőrzi a favorite-longshot bias-t**. A fix: egy **sharp könyv** (Pinnacle) de-viggelt valódi valószínűsége mint fair value; belépés csak ha `devigged_true − pm_price > fee`.

---

## 2. A de-vig matek (pure)

[`packages/core/src/devig.mts`](../../packages/core/src/devig.mts): a nyers implied `q_i = 1/odds_i` a vig miatt > 1-re összegződik (overround); a de-vig visszaadja az 1-re összegződő valódi valószínűségeket.

| Módszer | Képlet | FLB-kezelés |
|---|---|---|
| **Multiplicative** | `p_i = q_i / Σq_j` | **Nincs** — arányosan skáláz → a favorite-longshot bias-t **megőrzi** (a legrosszabb kalibráció). |
| **Power** | `p_i = q_i^k`, `Σ q_i^k = 1` (bisekció k-ra) | A longshotokat gyorsabban zsugorítja → korrigálja az FLB-t. |
| **Shin** (B49 #7) | `p_i(z) = [√(z² + 4(1−z)·q_i²/B) − z] / (2(1−z))`, `Σ p_i = 1` (bisekció z-re) | Az **insider-frakció z** modell → **a legjobban kalibrált** (Štrumbelj 2014); a longshotokat a helyes mértékben húzza le. Fallback power-re, ha nincs margin / nincs gyök. |

`twoWayFairYes(oddsYes, oddsNo, method)` → a bináris de-viggelt P(YES). `americanToDecimal` a US-odds feedhez. 7+ csoportos [teszt](../../packages/core/src/devig.test.mts) (Shin: összeg=1, no-vig fallback, FLB-korrekció favorite > multiplicative, 3-way, heavy-fav).

**Miért Shin a default a sportsra:** a multiplicative pont a bot bukás-módját (longshot-túlbecslés) hagyná meg; a Shin a peer-reviewed legjobb kalibráció (Štrumbelj 2014), a power a fallback/cross-check.

---

## 3. Bekötés + a maradó adat-task

- **Fogyasztó (kész):** [`sports/decision-engine.mts`](../../services/worker/src/pillars/sports/decision-engine.mts) `market.pinnacleFairYes`-t használ fair value-ként, ha `usePinnacleFairValue` (knob `sportsUsePinnacle`) ON + a mező jelen van; különben a shrink-fallback (zéró regresszió). Ez a #9 (session-53) óta megvan.
- **Termelő (HIÁNYZIK — B37 adat-task):** semmi nem tölti fel a `market.pinnacleFairYes`-t → kell egy **odds-feed**: the-odds-api (`region=eu` = Pinnacle, $30/hó, `ODDS_API_KEY`) → a Polymarket-esemény ↔ the-odds-api-esemény **matchelése** (a nehéz 80%) → `twoWayFairYes(oddsYes, oddsNo, "shin")` → `pinnacleFairYes`. Enélkül a Shin-matek nem tüzel.
- **KPI (follow-up):** CLV vs a Pinnacle-close (a belépő ár / close arány) — az igazi edge-metrika (Buchdahl); a cél a **pozitív CLV paperen**, nem nagy PnL.

---

## 4. Realista edge-plafon (skeptikus)

A de-viggelt Pinnacle-close a marginig hatékony → **nincs residual edge Pinnacle ellen**; az edge kizárólag a **laggos Polymarket-ár** vs a Pinnacle-igazság réséből jön (staleness, nem „megverem Pinnacle-t"). Az arXiv 2605.00864 szerint a rés szűk + likviditás-cap (~$15/lehetőség, 3,6s ablak) → a cél a szűk, pre-game / kevésbé-likvid piacokon szerezhető kis edge, kis mérettel, elsőként. **A Shin de-vig megállítja a ~90% vérzést (kiüti a fabrikált longshot-túlbecslést), de nem gyárt nagy edge-t.** Amíg az odds-feed nincs bekötve, a sports maradjon leállítva/loss-limit-capelve.

---

## 5. Maradó (sprints.md B49 / B37 / B44)

- **Odds-feed** (the-odds-api + ODDS_API_KEY + event-matching) → `pinnacleFairYes` feltöltése Shin-nel. **A #7 tüzeléséhez ez kell.**
- **CLV-KPI** az Edge Trackerre.
- **NO-oldali edge leg-mismatch** + paper settlement fee-parity (B44).
- Freshness-gate (csak friss Pinnacle-quote-hoz képest laggos PM-árra) + a longshot-floor megtartása.
