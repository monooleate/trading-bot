# Tab 11 – Arbitrage Matrix

## Áttekintés

Az Arbitrage Matrix három egymást kiegészítő modul:

- **A. VWAP Arb Scanner** – valódi kitölthető árak (nem mid price illúzió)
- **B. LLM Dependency Detector** – Claude API alapú logikai függőség keresés
- **C. Polytope Checker** – manuális marginal polytope ellenőrzés

---

## A. VWAP-based Arbitrage Scanner

### A mid price problémája

A hagyományos locked profit scanner **mid price-ot** néz. Ez félrevezető:

$$p_{mid} = \frac{p_{bid} + p_{ask}}{2}$$

Ha YES mid = 0.48 és NO mid = 0.48:
- Látszólagos edge = $1.00 - 0.96 = 4¢$
- De ha YES ask = 0.51 és NO ask = 0.52 → valódi cost = 1.03 → **veszteség**

### VWAP számítás

A valódi kitölthető átlagár egy $S$ méretű pozícióra:

$$\text{VWAP}(S) = \frac{\sum_i p_i \cdot q_i}{\sum_i q_i}$$

ahol az összegzés az order book szintjein megy, amíg $\sum_i p_i \cdot q_i \leq S$.

### Slippage

$$\text{Slippage} = \text{VWAP}(S) - p_{best}$$

A slippage méri mennyivel fizettünk többet a legjobb árnál.

### Arbitrázs feltétel

$$\text{VWAP}_{YES} + \text{VWAP}_{NO} + \text{fee} < 1.00$$

**$0.05 minimum profit threshold** (a paper alapján – kisebb edge execution risk miatt eltűnik):

$$\pi_{net} = 1.00 - \text{VWAP}_{YES} - \text{VWAP}_{NO} - f \cdot (\text{VWAP}_{YES} + \text{VWAP}_{NO}) > 0.05$$

### Maximum kitölthető méret

$$S_{max} = \min(\text{filled}_{YES}, \text{filled}_{NO})$$

A két oldal likviditásának minimuma korlátozza a pozíció méretét.

---

## B. LLM Dependency Detector

### Motiváció (a cikk alapján)

Az 1,576 azonosított függő market-pár automatikus felismeréséhez a cikk DeepSeek-R1-Distill-Qwen-32B modellt használt. Mi Claude Sonnet-et használunk.

**Accuracy:** 81.45% komplex multi-condition párokon (paper alapján).

### Prompt struktúra

```
Market A: "Will Trump win Pennsylvania?"
Market B: "Will Trump win the 2024 presidential election?"

→ JSON output:
{
  "has_dependency": true,
  "dependency_type": "IMPLICATION",
  "direction": "A_IMPLIES_B",  // PA win → presidency plausible
  "constraint": "Winning PA is almost necessary for winning presidency",
  "arbitrage_condition": "P(win PA) should correlate with P(win presidency)",
  "confidence": 0.87,
  "reasoning": "Historical electoral college math shows PA is pivotal"
}
```

### Dependency típusok

| Típus | Leírás | Arbitrázs implikáció |
|-------|--------|----------------------|
| IMPLICATION | A → B | P(A) ≤ P(B) kötelező |
| SUBSET | A ⊆ B | P(A) ≤ P(B) kötelező |
| MUTUAL_EXCLUSION | A ∩ B = ∅ | P(A) + P(B) ≤ 1 |
| CORRELATED | Korrelált de nem determinisztikus | Soft constraint |

### Auto-scan logika

1. Top 30 aktív piac lekérése
2. Kulcsszó alapú kategorizálás (BTC, Fed, választás, sport...)
3. Kategórián belül 2-3 pár elemzése Claude API-val
4. Max 6 pár / scan (API cost limit)
5. 30 perces cache (LLM hívás drága)

---

## C. Marginal Polytope Checker

### Matematikai alap

$n$ feltétel esetén a valid kimeneteleket integer programmal leírjuk:

$$Z = \{z \in \{0,1\}^I : A^T z \geq b\}$$

A marginal polytope:
$$M = \text{conv}(Z)$$

Az arbitrage-free árak ∈ M. Minden ∉ M pont exploitálható.

### Bregman projekció

Az optimális arbitrázs trade kiszámítása:

$$\mu^* = \arg\min_{\mu \in M} D(\mu \| \theta)$$

ahol $D(\mu \| \theta)$ a Kullback-Leibler divergencia (LMSR esetén):

$$D_{KL}(\mu \| \theta) = \sum_i \mu_i \ln \frac{\mu_i}{\theta_i}$$

A maximális profit = $D(\mu^* \| \theta)$.

### Frank-Wolfe algoritmus

A Bregman projekció iteratív megközelítése:

```
Z₀ = üres aktív halmaz
while g(μₜ) > ε:
    μₜ = argmin F(μ) over conv(Zₜ₋₁)   # konvex opt
    zₜ = argmin ∇F(μₜ)·z over Z          # IP oracle (Gurobi)
    Zₜ = Zₜ₋₁ ∪ {zₜ}
    g(μₜ) = ∇F(μₜ)·(μₜ - zₜ)            # konvergencia gap
```

**Convergence rate:** $O(L \cdot \text{diam}(M) / t)$

**Megjegyzés:** Ez teljes körűen nem implementált – Gurobi IP solver és historikus transaction data szükséges. A Tab 11 Polytope Checker a manuális, egyszerűsített változat.

---

## Execution risk (CLOB non-atomicity)

A Polymarket CLOB-on az arbitrázs **nem atomi**:

```
1. Submit YES order → kitölt $0.30-on ✓
2. Ár elmozdul a YES vásárlás miatt
3. Submit NO order → csak $0.78-on tölt ✗
4. Total cost: $1.08, payout: $1.00 → -$0.08 veszteség
```

**Megoldás:** Párhuzamos order submission (30ms-en belül):

```
Latency breakdown (production system):
WebSocket feed:     <5ms
Decision:          <10ms
Direct RPC:        ~15ms
Parallel submit:   ~10ms
Polygon block:     ~2000ms (elkerülhetetlen)
─────────────────────────
Total:             ~2040ms
```

---

## Használat

### Dashboard (Tab 11)

**A. VWAP tab:**
- VWAP Scan → order book mélységből számolt valódi árral dolgozik
- Minden piacon: YES VWAP, NO VWAP, gross cost, net profit (fee után), max pozíció
- Slug megadásával konkrét piacot is elemezhetsz

**B. LLM Dependency tab:**
- Kézi mód: két piac kérdését beírod → Claude elemez
- Auto scan: top piacok automatikus kategorizálása és ellenőrzése
- 30 perces cache a Claude API hívások miatt

**C. Polytope tab:**
- Piacok és YES árak manuális bevitele
- Potenciális monotonicity violation keresés
- Eredmény → LLM tabban verifikálható

---

## Forrás

- *"Unravelling the Probabilistic Forest"* (arXiv:2508.03474v1) – $40M arbitrázs dokumentálva
- *"Arbitrage-Free Combinatorial Market Making via Integer Programming"* (arXiv:1606.02825v2) – Frank-Wolfe
- Rohonchain: *The Math Needed for Trading on Polymarket* (2026)
- Bregman, L.M. (1967). *The relaxation method of finding the common point of convex sets*
