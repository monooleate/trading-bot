# Tab 10 – Signal Combiner

## Áttekintés

A Signal Combiner a dashboard összes jelzését (Tab 06-09) **egyetlen súlyozott valószínűség-becslésbe** foglalja össze, a Grinold-Kahn Fundamental Law of Active Management alapján.

$$IR = IC \times \sqrt{N}$$

---

## Fundamental Law of Active Management

### Grinold-Kahn (1994)

Az **Information Ratio** (kockázatkorrigált edge):

$$IR = IC \times \sqrt{N}$$

ahol:
- $IC$ = Information Coefficient – az egyes jelzések prediktív ereje (korreláció a tényleges eredménnyel)
- $N$ = független jelzések száma
- $IR$ = a kombinált rendszer kockázatkorrigált hozama

### Miért jobb 50 gyenge jel mint 1 erős?

Intézményi jelzések: $IC \in [0.05, 0.15]$ – azaz **a legjobb jelzés is 85-95%-ban téved**.

| Konfiguráció | IR |
|---|---|
| 1 jel, $IC = 0.10$ | $0.10 \times \sqrt{1} = 0.10$ |
| 5 jel, $IC = 0.07$ | $0.07 \times \sqrt{5} = 0.157$ |
| 50 jel, $IC = 0.07$ | $0.07 \times \sqrt{50} = 0.495$ |

**Következtetés:** az 5 jelzéses rendszerünk 57%-kal jobb IR-t ér el mint egyetlen erős jelzés.

---

## Az 5 jelzés és IC becslések

| Jelzés | Tab | IC becslés | Alap |
|--------|-----|-----------|------|
| Vol Divergence | 07 | 0.06 | IV-RV spread mint kontraindikátor |
| Order Flow | 06 | 0.09 | Kyle λ + VPIN informált flow detekció |
| Apex Consensus | 08 | 0.08 | Smart money tracking |
| Cond. Prob | 09 | 0.07 | Matematikai mispricing |
| Funding Rate | 03 | 0.05 | Cross-venue carry |

**Átlag IC:** 0.070  
**Effektív N:** 3.0 (50% korreláció-veszteség becslés)  
**IR:** $0.070 \times \sqrt{3.0} = 0.121$

---

## A 11-lépéses Alpha Combination (Grinold-Kahn)

### Step 1-4: Normalizálás

Minden jelzés implied probability-t ad $p_i \in [0, 1]$:

$$\hat{p}_i = f(\text{signal}_i) \rightarrow [0, 1]$$

### Step 6: Cross-sectional demeaning

A közös komponens eltávolítása:

$$d_i = p_i - \bar{p}$$

ahol $\bar{p} = \frac{1}{N} \sum_j p_j$.

**Miért fontos?** Ha minden jelzés egyszerre mozog ugyanolyan irányba (pl. makrogazdasági esemény hatására), ez közös komponens – nem független information. A demeaning kiszűri ezt.

### Step 9: IC-súlyozás

A jelzések súlya arányos az information coefficient-tel és a residuális eltéréssel:

$$w_i \propto IC_i \cdot (1 + |d_i| \cdot 0.5)$$

A $|d_i|$ tag erősebben súlyozza azokat a jelzéseket amelyek **eltérnek az átlagtól** – ezek hordozzák a legtöbb független információt.

### Step 10: Normalizálás

$$w_i^{norm} = \frac{w_i}{\sum_j w_j}$$

### Weighted combination

$$p_{combined} = \sum_i w_i^{norm} \cdot p_i$$

---

## Kelly criterion (empirikus)

### Alap Kelly formula (binary market)

$$f^* = \frac{p \cdot b - q}{b}$$

ahol $b = \frac{1}{p_{combined}} - 1$ (payout odds) és $q = 1 - p$.

### CV_edge korrekció

A cikk empirikus Kelly formulája:

$$f_{empirical} = f^* \cdot (1 - CV_{edge})$$

ahol $CV_{edge}$ az edge-becslés variabilitása. Mi az IR-ből becsüljük:

$$CV_{edge} = \max(0, 1 - IR \cdot 0.8)$$

**Intuíció:** Ha az IR alacsony (bizonytalan edge), erősen csökkentjük a Kelly frakciót. Magas IR esetén (konvergáló jelzések) közelebb maradunk a full Kelly-hez.

### ¼-Kelly

$$f_{¼K} = \frac{1}{4} \cdot f_{empirical}$$

A ¼-Kelly az intézményi standard – megvéd a modell-hibáktól és a paraméter-bizonytalanságtól.

---

## Interpretáció

### Action logika

| $p_{combined}$ | IR | Akció |
|---|---|---|
| < 0.45 vagy > 0.55, IR > 0.2 | Magas | BUY YES/NO |
| < 0.45 vagy > 0.55, IR < 0.1 | Alacsony | WATCH |
| 0.45-0.55 | Bármely | WAIT |

### Effektív N

Az $N$ a Fundamental Law-ban **nem a jelzések száma**, hanem az egymástól független jelzések effektív száma:

$$N_{eff} = N \cdot (1 - \bar{\rho})$$

ahol $\bar{\rho}$ az átlagos páronkénti korreláció. A mi 5 jelzésünkre $N_{eff} \approx 3.0$ konzervatív becslés.

---

## Használat

### Dashboard (Tab 10)

1. **⟳ Combine** – párhuzamosan lekéri az összes jelzést és kombinálja
2. **Action box** – HIGH/MEDIUM/LOW confidence + konkrét akció (BUY YES/NO/WAIT)
3. **Probability gauge** – 0-100% skálán a kombinált valószínűség
4. **Signal weights** – minden jelzés súlya és implied probability bar-on ábrázolva
5. **Auto 3m** – automatikus frissítés 3 percenként

### Interpretáció

- Az **IR = 0.157** azt jelenti: a rendszer a véletlen felett 15.7%-kal teljesít
- A **¼-Kelly** a bankroll hány százalékát kockáztassa egy trades
- Ha csak 2-3 jelzés érhető el (API hiba), az IR csökken → Kelly is csökken

---

## Limitációk és pontosítások

### Jelenlegi egyszerűsítések

1. **IC becslések priorok** – nem 500+ periódusú historikus return series-ből számítva
2. **CV_edge** – nem valódi Monte Carlo 10,000 path-ból, hanem IR-ből becsült
3. **Korreláció struktúra** – az $N_{eff}$ = 3.0 fix becslés, nem mért

### Valódi Grinold-Kahn implementáció igénye

- 500+ periódus historikus return history minden jelzésre
- OLS regresszió a Step 9 residual számításhoz
- Monte Carlo szimulációk a CV_edge-hez

Ezek implementálhatók ha a rendszer 3-6 hónapig gyűjt adatot.

---

## Forrás

- Grinold, R.C. & Kahn, R.N. (1994). *Active Portfolio Management*. Probus Publishing.
- Grinold, R.C. (1989). *The Fundamental Law of Active Management*. Journal of Portfolio Management.
- Rohonchain: *The Math Behind Combining 50 Weak Signals Into One Winning Trade* (2026)
