# Tab 02 – Expected Value és Kelly Criterion

## Expected Value

$$EV = p \cdot b - (1-p) \cdot 1$$

ahol $p$ = becsült valószínűség, $b = \frac{1}{\text{market price}} - 1$ = payout odds.

**Pozitív EV** ($EV > 0$) kereskedési feltétel.

## Kelly Criterion

$$f^* = \frac{p \cdot b - q}{b}$$

ahol $q = 1 - p$.

### ¼-Kelly (intézményi standard)

$$f_{¼K} = \frac{f^*}{4}$$

Véd a modell-hibák és paraméterbizonytalanság ellen. A legtöbb intézményi quant desk ¼-Kellyt használ.

### Logaritmikus utility

A Kelly criterion maximalizálja a várható logaritmikus hasznosságot:

$$\max_f \mathbb{E}[\ln(1 + f \cdot r)]$$

ahol $r$ a nettó hozam. Ez ekvivalens a geometriai átlag maximalizálásával hosszú távon.

## Funding Rate Arbitrázs (Tab 03)

Delta-neutral stratégia:

1. **Long** Polymarket YES kontraktok (a "carry" oldal)
2. **Short** Binance/Bybit Futures (a fedezeti oldal)
3. **Funding rate bevétel** = rövid oldal fizet (ha pozitív funding)

$$\text{Napi hozam} = \frac{\text{Funding Rate}}{3} \times \text{Pozíció méret}$$

(A Binance 8 óránként fizet, napi 3 periódus.)

**Kockázat:** bázis kockázat (PM és exchange ár eltérése) + likvidációs kockázat.
