# Tab 06 – Order Flow Analysis

## Áttekintés

Az order flow elemzés azt méri, hogy **informált kereskedők** (insider-ek, algoritmusok) hogyan pozicionálnak mielőtt az ár elmozdul. Három egymást kiegészítő modell:

1. **Kyle λ** – adverse selection mérés
2. **VPIN** – toxikus order flow detektor  
3. **Hawkes folyamat** – trade clustering MLE

---

## Kyle Lambda (λ)

### Matematikai alap

Kyle (1985) modelljében az árváltozás lineáris a nettó order flow-ban:

$$\Delta p_t = \lambda \cdot (Q_t - \bar{Q})$$

ahol:
- $\Delta p_t$ = árváltozás a $t$ periódusban
- $Q_t$ = nettó vételi nyomás (buy volume – sell volume)
- $\lambda$ = Kyle lambda, az adverse selection intenzitása
- $\bar{Q}$ = átlagos order flow

### Regressziós becslés

$$\lambda = \frac{\text{Cov}(\Delta p, Q)}{\text{Var}(Q)}$$

**Interpretáció:**
- $\lambda$ **magas** → kis order flow nagy ármozgást okoz → informált kereskedők aktívak
- $\lambda$ **alacsony** → piac likvid, kevés adverse selection

### Implementáció

```python
# orderflow_analyzer.py
def calc_kyle_lambda(trades: list[Trade]) -> float:
    prices    = [t.price for t in trades]
    volumes   = [t.size * (1 if t.side == "BUY" else -1) for t in trades]
    dp        = np.diff(prices)
    q         = volumes[1:]
    cov_dp_q  = np.cov(dp, q)[0, 1]
    var_q     = np.var(q)
    return cov_dp_q / var_q if var_q > 0 else 0
```

---

## VPIN (Volume-synchronized Probability of Informed Trading)

### Matematikai alap

Easley et al. (2012) modellje:

$$\text{VPIN} = \frac{\sum_{\tau=1}^{n} |V_\tau^B - V_\tau^S|}{\sum_{\tau=1}^{n} V_\tau}$$

ahol:
- $V_\tau^B$ = buy volume a $\tau$-adik bucket-ben
- $V_\tau^S$ = sell volume a $\tau$-adik bucket-ben
- $n$ = bucket-ek száma (tipikusan 50)

### Toxikus flow kritérium

$$\text{VPIN} > 0.7 \Rightarrow \text{Informált kereskedők aktívak}$$

**Fizikai intuíció:** Ha minden trade-ben a buy és sell volumenek nagyon egyenlőtlenek (valaki mindig csak vesz vagy csak elad), az erős információs aszimmetriát jelez. A likvid, hatékony piacon a vevők és eladók egyensúlyban vannak.

### Implementáció

```python
def calc_vpin(trades: list[Trade], bucket_size: int = 50) -> float:
    buckets = [trades[i:i+bucket_size] 
               for i in range(0, len(trades), bucket_size)]
    imbalances = []
    for bucket in buckets:
        buy_vol  = sum(t.size for t in bucket if t.side == "BUY")
        sell_vol = sum(t.size for t in bucket if t.side == "SELL")
        total    = buy_vol + sell_vol
        if total > 0:
            imbalances.append(abs(buy_vol - sell_vol) / total)
    return float(np.mean(imbalances)) if imbalances else 0.5
```

---

## Hawkes folyamat

### Matematikai alap

A Hawkes (1971) pontfolyamat az esemény-klaszterezés modellje. Az intenzitás:

$$\lambda^*(t) = \mu + \sum_{t_i < t} \alpha \cdot e^{-\beta(t - t_i)}$$

ahol:
- $\mu$ = alapintenzitás (background rate)
- $\alpha$ = self-excitation (korábbi trade-ek hatása)
- $\beta$ = decay rate (az excitation elhalási sebessége)
- $t_i$ = korábbi trade időpontjai

### Maximum Likelihood Estimation

A log-likelihood:

$$\mathcal{L}(\mu, \alpha, \beta) = -\int_0^T \lambda^*(t) dt + \sum_{t_i} \log \lambda^*(t_i)$$

Az MLE megoldása:

$$\hat{\mu}, \hat{\alpha}, \hat{\beta} = \arg\max \mathcal{L}$$

### Kereskedési jelzés

- $\hat{\alpha}/\hat{\beta} > 1$ → **szuperkritikus** folyamat: trade-ek egymást gerjesztik → volatilitás robbanás várható
- $\hat{\alpha}/\hat{\beta} < 1$ → **szubkritikus**: a klaszterezés elhal → visszatérés az alapszinthez

---

## Avellaneda-Stoikov Market Making

### Matematikai alap

Az AS (2008) modell optimális bid-ask spreadet számol:

**Reservation price (kockázatsemleges ár):**
$$r(s, q, t) = s - q \cdot \gamma \cdot \sigma^2 \cdot (T - t)$$

**Optimális spread:**
$$\delta^a + \delta^b = \gamma \sigma^2 (T-t) + \frac{2}{\gamma} \ln\left(1 + \frac{\gamma}{\kappa}\right)$$

ahol:
- $s$ = mid price
- $q$ = jelenlegi inventory
- $\gamma$ = kockázatkerülési paraméter
- $\sigma$ = volatilitás
- $\kappa$ = order flow intenzitás
- $T-t$ = lejáratig hátralévő idő

### Implementáció a dashboardban

```typescript
// Netlify function: orderflow-analysis.mts
const reservationPrice = midPrice - inventory * gamma * sigma2 * timeToExpiry;
const optimalSpread    = gamma * sigma2 * timeToExpiry 
                       + (2/gamma) * Math.log(1 + gamma/kappa);
const bidPrice = reservationPrice - optimalSpread / 2;
const askPrice = reservationPrice + optimalSpread / 2;
```

---

## Használat

### Dashboard (Tab 06)

1. Nyisd meg a Tab 06 // Order Flow panelt
2. Kattints **⟳ Frissít** – lekéri a live Polymarket trade data-t
3. Értelmezés:
   - **Kyle λ > 0.5**: informált kereskedők aktívak, follow the money
   - **VPIN > 0.7**: toxikus flow, árugrás várható
   - **Hawkes α/β > 1**: trade klaszterezés, volatilitás növekszik
   - **AS bid/ask**: optimális market making spreads

### Python CLI

```bash
# Demo (szintetikus adat)
python orderflow_analyzer.py --demo

# Élő elemzés egy konkrét tokenre
python orderflow_analyzer.py --token-id <TOKEN_ID>

# Elérhető piacok listája
python orderflow_analyzer.py --list-markets
```

---

## Forrás

- Kyle, A.S. (1985). *Continuous Auctions and Insider Trading*. Econometrica.
- Easley, D. et al. (2012). *Flow Toxicity and Liquidity in a High-frequency World*. RFS.
- Hawkes, A.G. (1971). *Spectra of Some Self-Exciting and Mutually Exciting Point Processes*. Biometrika.
- Avellaneda, M. & Stoikov, S. (2008). *High-frequency Trading in a Limit Order Book*. Quantitative Finance.
