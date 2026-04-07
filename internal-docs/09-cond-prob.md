# Tab 09 – Conditional Probability Matrix

## Áttekintés

A conditional probability matrix azokat az eseteket keresi ahol **két vagy több Polymarket piac árai matematikailag inkonzisztensek**. Három violation típus:

1. **Monotonicity** – ha A ⊂ B logikailag, P(A) ≤ P(B) kötelező
2. **Complement** – P(YES) + P(NO) ≠ 1.000
3. **Conditional** – P(A ∩ B) > min(P(A), P(B))

---

## Marginal Polytope

### Matematikai alap (cikk alapján)

$n$ feltétel esetén $2^n$ lehetséges kimenetel van, de csak $n$ valid outcome létezik (pontosan egy teljesül).

A valid payoff vektorok halmaza:
$$Z = \{\phi(\omega) : \omega \in \Omega\}$$

Az arbitrage-free árak a konvex burokban kell legyenek:
$$M = \text{conv}(Z)$$

Ha az árak $M$-en kívül esnek → **exploitálható arbitrázs**.

**Integer programming formuláció:**
$$Z = \{z \in \{0,1\}^I : A^T z \geq b\}$$

Lineáris korlátok váltják fel az exponenciális enumerációt. Pl. Duke vs Cornell:
- Brute force: $2^{14} = 16{,}384$ kombináció
- IP: **3 lineáris korlát**

---

## Monotonicity Violation

### Definíció

Ha $A \subseteq B$ logikailag (A teljesülése maga után vonja B teljesülését):

$$P(A) \leq P(B)$$

**Példák:**

| Market A | Market B | Korlát |
|----------|----------|--------|
| BTC > $120k 2025-ben | BTC > $100k 2025-ben | $P(120k) \leq P(100k)$ |
| Fed vágás Május | Fed vágás Q2 | $P(Máj) \leq P(Q2)$ |
| Trump wins PA | Trump wins presidency | $P(PA) \geq P(presidency)$ ez nem biztos, de korrelált |

### Profit számítás

Ha $P(A) > P(B) + \epsilon$:

$$\text{Edge} = P(A) - P(B) \text{ (centben)}$$
$$\text{Akció: SELL } A \text{ YES, BUY } B \text{ YES}$$

---

## Complement Violation

### Definíció

$$P(YES) + P(NO) \neq 1.000$$

**Ha $> 1$:** mindkét oldal eladható (locked profit)  
**Ha $< 1$:** mindkét oldal megvehető (locked profit)

### Nettó profit (fee után)

$$\pi_{net} = 1.00 - (p_{YES} + p_{NO}) - f \cdot (p_{YES} + p_{NO})$$

ahol $f \approx 0.02$ (taker fee).

---

## Conditional Probability Violation

### Definíció

A valószínűség szorzási szabályából:

$$P(A \cap B) \leq \min(P(A), P(B))$$

Ha két korrelált piac ára azt implikálja hogy $P(A \cap B) > \min(P(A), P(B))$, az matematikai lehetetlenség.

---

## Severity és Pozícióméretezés

### Severity index

$$\text{Severity} = \min\left(1, \frac{\text{violation size}}{0.20}\right)$$

### ¼-Kelly méretezés

$$f_{¼K} = \frac{1}{4} \cdot \frac{p \cdot \text{Edge} - (1-p)}{\text{Edge}}$$

ahol $p \approx \text{Severity}$ (a violation konfidencia proxija).

---

## Auto-scan logika

A rendszer automatikusan csoportosítja a top 40 piacot kulcsszavak szerint:

- **BTC csoport**: bitcoin, btc, 15-minute, up-or-down
- **Fed csoport**: fed, rate cut, fomc, interest rate
- **ETH csoport**: ethereum, eth

Minden csoporton belül minden párra ellenőrzi a monotonicity és complement feltételeket.

---

## Polymarket CLI integráció

```bash
# Telepítés
brew tap Polymarket/polymarket-cli https://github.com/Polymarket/polymarket-cli
brew install polymarket

# Piac keresés
polymarket markets search "bitcoin" --limit 5

# Midpoint lekérés
polymarket -o json clob midpoint <TOKEN_ID>

# Order book
polymarket clob book <TOKEN_ID>

# Python script CLI móddal
python conditional_prob_matrix.py --cli --scan-btc
```

---

## Használat

### Dashboard (Tab 09)

**Auto scan** (alapértelmezett):
- Top 40 aktív piac csoportosítva → violation keresés
- Minden violation: severity bar, edge cents, ¼-Kelly pozíció

**BTC / Fed csoport:**
- Előre definiált piacon belüli implication chain-ek
- Pl. BTC $120k → $100k → $80k → $60k monotonicity

### Python CLI

```bash
# Demo (szintetikus inkonzisztens piacok)
python conditional_prob_matrix.py --demo

# BTC árszint scan
python conditional_prob_matrix.py --scan-btc

# Fed kamat piacok
python conditional_prob_matrix.py --scan-fed

# Egyedi slugok
python conditional_prob_matrix.py --custom slug-a slug-b slug-c

# CLI módban (Polymarket CLI szükséges)
python conditional_prob_matrix.py --cli --scan-btc

# JSON output
python conditional_prob_matrix.py --scan-btc --json
```

---

## Limitációk

1. **Mid árak** – a scanner mid price-ot használ, nem ask-ot. VWAP korrekció: Tab 11
2. **Execution risk** – CLOB nem atomi: az egyik leg kitölthet, a másik nem
3. **Frank-Wolfe** – a teljes Bregman projection megvalósításához Gurobi IP solver kell
4. **LLM verifikáció** – komplex függőségeknél a Tab 11 LLM detector ajánlott

---

## Forrás

- *"Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets"* (arXiv:2508.03474v1)
- *"Arbitrage-Free Combinatorial Market Making via Integer Programming"* (arXiv:1606.02825v2)
- Rockafellar, R.T. (1970). *Convex Analysis*. Princeton University Press.
