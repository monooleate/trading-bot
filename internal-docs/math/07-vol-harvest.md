# Tab 07 – Volatility Harvesting

## Áttekintés

A volatility harvesting stratégia az **implied volatility** (amit a predikciós piac beáraz) és a **realized volatility** (ami ténylegesen bekövetkezik) közötti divergenciát exploitálja.

$$\text{Edge} = IV - RV > 0 \Rightarrow \text{Piac túláraz félelemet}$$

---

## Realized Volatility (RV)

### Close-to-close log return módszer

$$RV = \sqrt{\frac{252 \cdot 24 \cdot 60}{n-1} \sum_{i=1}^{n-1} (\ln r_i - \bar{r})^2}$$

ahol $r_i = \frac{C_i}{C_{i-1}}$ a log return és $n$ az 1 perces gyertya szám.

**Annualizálás:** 525,600 periódus/év (percenkénti adat esetén).

### Parkinson volatility

Pontosabb becslés high/low árakat is felhasználva:

$$\sigma_P = \sqrt{\frac{252 \cdot 24 \cdot 60}{4 \ln 2} \cdot \frac{1}{n} \sum_{i=1}^{n} \left(\ln \frac{H_i}{L_i}\right)^2}$$

A Parkinson becslő **hatékonyabb** a close-to-close módszernél, mert az intraday mozgást is figyelembe veszi.

---

## Implied Volatility visszaszámítás

### Naïv binary approximation

Polymarket kontraktárak binary opcióknak tekinthetők. Ha $p$ a YES ár és $T$ az évben mért lejárati idő:

$$\sigma_{IV} \approx \frac{2|p - 0.5|}{\sqrt{T}}$$

**Korlátok:**
- Nem Black-Scholes pontosságú
- Monoton és helyes irányú (ha $p$ nő, $IV$ nő)
- 15 perces kontraktoknál $T = 15/(365 \cdot 24 \cdot 60)$

---

## Volatility Spread

$$\text{Spread}_{15m} = IV_{avg} - RV_{15m}$$

| Spread értéke | Interpretáció | Kereskedési jel |
|---------------|---------------|-----------------|
| > +50% | Nagyon magas félelem prémium | SELL both sides |
| +20% – +50% | Emelt prémium | Óvatosan SELL |
| -10% – +20% | Normál | WAIT |
| < -10% | RV > IV (ritka!) | BUY volatility |

---

## Locked Profit Scanner

Ha $p_{YES} + p_{NO} < 1 - \text{fee}$, mindkét oldal megvásárlásával garantált profit:

$$\text{Net profit} = 1.00 - (p_{YES} + p_{NO}) - \text{fee}_{total}$$

**Fee struktúra (2026 Polymarket):**
$$\text{fee}_{total} = f \cdot p_{YES} + f \cdot p_{NO}$$

ahol $f \approx 0.02$ (2% taker fee/oldal, 50% odds-nál 1.56% effektív).

### Kritikus megjegyzés

A scanner **mid árakat** mutat. A valódi belépési cost = **ask ár**:

$$p_{ask} \approx p_{mid} + \frac{\text{spread}}{2} \approx p_{mid} + 0.01 \text{ – } 0.03$$

Egy 3¢-nek látszó edge könnyen eltűnik a spread miatt. A **VWAP arb scanner** (Tab 11) ezt korrigálja.

---

## Adatforrások

- **Binance 1m klines**: `GET /api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60`
- **Polymarket CLOB midpoint**: `GET clob.polymarket.com/midpoint?token_id=...`
- **Polymarket Gamma API**: `GET gamma-api.polymarket.com/markets?active=true&tag_slug=crypto`

---

## Használat

### Dashboard (Tab 07)

1. Nyisd meg a Tab 07 // Vol Harvest panelt
2. **⟳ Frissít** – párhuzamosan lekéri Binance klines + PM kontraktárakat
3. 3 ablakra (5m, 15m, 30m) mutatja a realized vol-t
4. Locked profit scanner automatikusan fut a BTC UP/DOWN piacokon
5. **Auto 2m** bekapcsolásával folyamatosan frissül

### Python CLI

```bash
# Demo
python vol_divergence.py --demo

# Folyamatos 2 perces figyelés
python vol_divergence.py --watch

# JSON output (pipe-olható)
python vol_divergence.py --json | jq '.markets[]'
```

---

## Forrás

- Parkinson, M. (1980). *The Extreme Value Method for Estimating the Variance of the Rate of Return*. Journal of Business.
- Derman, E. & Miller, M. (2016). *The Volatility Smile*. Wiley.
