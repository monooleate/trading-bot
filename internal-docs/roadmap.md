# EdgeCalc – Fejlesztési Útvonal

## Jelenlegi állapot (v8)

✅ 11 tab, 15 Netlify Function, 4 Python script  
✅ Matematikai alap: Kyle λ, VPIN, Hawkes, Grinold-Kahn, Bregman  
✅ Bot detector (Hubble Research módszertan)  
✅ Payout ratio + category specialist szűrés  
✅ LLM dependency detector (Claude API)  
✅ VWAP arbitrázs scanner  
✅ Signal kombinátor (Fundamental Law)  

---

## Fázis 1 – Deploy és élő tesztelés (0-4 hét)

### 1.1 Netlify deploy

```bash
# GitHub repo létrehozás
git init && git add . && git commit -m "v8 initial"
git remote add origin https://github.com/USER/edge-calc.git
git push -u origin main

# Netlify import
netlify link
netlify env:set JWT_SECRET $(openssl rand -hex 32)
netlify env:set AUTH_PASSWORD_HASH $(echo -n "jelszo" | sha256sum | cut -d' ' -f1)
netlify env:set ANTHROPIC_API_KEY sk-ant-...
netlify deploy --prod
```

### 1.2 Polymarket fiók és USDC

1. polymarket.com → email bejelentkezés
2. USDC bridgelés Polygon hálózatra ($50-100 kezdő tőke)
3. Proxy wallet address kimentése (Tab 08 profil teszteléshez)

### 1.3 Első éles tesztek

**Sorrend:**
1. Vol Harvest (Tab 07) → locked profit scanner, csak ha net > 5¢
2. Cond Prob (Tab 09) → monotonicity violations ellenőrzése
3. Apex Wallets (Tab 08) → consensus jelzések követése kis mérettel

**Bankroll allokáció javasolt:**
- Tab 07 (locked profit): max 20% bankroll
- Tab 09 (cond prob): max 10% bankroll  
- Tab 08 (consensus): ¼-Kelly a dashboardon számolt érték

---

## Fázis 2 – Adatgyűjtés és historikus kalibráció (1-3 hónap)

### 2.1 Trade logging

Minden végrehajtott trade naplózása:

```typescript
// Supabase tábla
create table trades (
  id          uuid primary key,
  timestamp   timestamptz,
  tab         text,           -- melyik tab adta a jelet
  signal_p    float,          -- becsült valószínűség
  market_p    float,          -- piaci ár belépéskor
  outcome     float,          -- tényleges eredmény (0 vagy 1)
  pnl         float,
  kelly_used  float
);
```

### 2.2 IC kalibráció

Ha legalább 50 trade-et rögzítettünk, kiszámítható a valódi IC:

$$IC = \text{Corr}(p_{signal}, \text{outcome})$$

Ez visszakerül a Signal Combiner IC becslésekbe – a prior-okat valódi mért értékek váltják fel.

### 2.3 CV_edge Monte Carlo

10,000 bootstrap szimulációból:

```python
def calc_cv_edge(trades: list[Trade], n_sim: int = 10000) -> float:
    edge_estimates = []
    for _ in range(n_sim):
        sample = np.random.choice(trades, size=len(trades), replace=True)
        edge   = np.mean([t.signal_p - t.market_p for t in sample])
        edge_estimates.append(edge)
    return np.std(edge_estimates) / np.mean(edge_estimates)
```

---

## Fázis 3 – Valódi Grinold-Kahn (3-6 hónap)

### 3.1 500+ periódus return history

Az alpha combination Step 9 (residual regression) csak elegendő historikus adattal működik pontosan:

```python
# Step 9: OLS residual
from sklearn.linear_model import LinearRegression
reg = LinearRegression(fit_intercept=False)
reg.fit(Lambda_matrix, E_normalized)
residuals = E_normalized - reg.predict(Lambda_matrix)
weights   = residuals / volatilities
```

### 3.2 Valódi cross-sectional demeaning

Az 500 periódusú adatból a jelzések shared variance-a pontosan mérhető:

$$\Sigma_{signals} = \text{Cov}(r_1, r_2, r_3, r_4, r_5)$$

Az effektív N a korreláció-mátrix sajátértékeiből:

$$N_{eff} = \frac{(\sum_i \lambda_i)^2}{\sum_i \lambda_i^2}$$

---

## Fázis 4 – Frank-Wolfe Implementáció (6+ hónap)

### 4.1 Gurobi setup

A teljes Bregman projekció IP solvert igényel:

```python
# Gurobi licenc (academic: ingyenes, commercial: ~$10k/év)
import gurobipy as gp

model = gp.Model()
z     = model.addVars(n_conditions, vtype=gp.GRB.BINARY)
# Implication constraints
for (i, j) in implications:
    model.addConstr(z[i] <= z[j])
model.optimize()
```

### 4.2 Alchemy Polygon node

Real-time block-level VWAP:

```typescript
const provider = new AlchemyProvider('matic', process.env.ALCHEMY_KEY);
provider.on('block', async (blockNum) => {
  const block = await provider.getBlock(blockNum, true);
  // trades in this block
  const trades = block.transactions.filter(tx => 
    tx.to === POLYMARKET_CTF_ADDRESS
  );
  const vwap_yes = calcBlockVWAP(trades, 'YES');
  const vwap_no  = calcBlockVWAP(trades, 'NO');
  if (Math.abs(vwap_yes + vwap_no - 1.0) > 0.02) {
    // Arbitrázs detektálva
    await submitParallelOrders(vwap_yes, vwap_no);
  }
});
```

### 4.3 Sub-2040ms execution

Production execution stack:
- WebSocket CLOB feed → < 5ms
- Pre-calculated IP projections → < 10ms
- Direct Polygon RPC → ~15ms
- Párhuzamos order submission → ~10ms
- Polygon block inclusion → ~2000ms (elkerülhetetlen)

---

## Fázis 5 – Automatizálás (6-12 hónap)

### 5.1 Autonomous execution

A Signal Combiner (Tab 10) action outputját automatikusan végrehajtani:

```typescript
// Ha IR > 0.2 és p > 0.6 és kelly_q > 0.01
if (combo.information_ratio > 0.2 && 
    Math.abs(combo.combined_probability - 0.5) > 0.1 &&
    combo.kelly_quarter > 0.01) {
  await executePolymarketOrder({
    side:  combo.combined_probability > 0.5 ? 'YES' : 'NO',
    size:  bankroll * combo.kelly_quarter,
    market: bestMarket.slug,
  });
}
```

### 5.2 Hummingbot funding rate arb

Exchange-oldalon a funding rate arbitrázst automatizálni:

```bash
# Hummingbot setup
docker pull hummingbot/hummingbot
# Funding rate arb strategy Hyperliquid/Binance
hummingbot create --strategy funding-rate-arb \
  --exchange1 binance --exchange2 hyperliquid \
  --token BTCUSDT
```

### 5.3 mac-code integráció (ha Apple Silicon van)

Lokális Qwen 35B modell a LLM dependency detectorhoz:

```bash
# Mac mini M4, 16GB RAM
llama-server --model ~/models/Qwen3.5-35B-A3B-IQ2_M.gguf \
  --port 8000 --n-gpu-layers 99

# Python script módosítás
BASE_URL = "http://localhost:8000/v1"  # instead of Anthropic API
```

$0/hó infrastruktúra cost, 30 tok/s, rate limit nélkül.

---

## Infrastruktúra fejlesztés

### Jelenlegi limitációk

| Komponens | Jelenlegi | Ideális |
|-----------|-----------|---------|
| VWAP scanner | Netlify Function (90mp cache) | WebSocket real-time |
| Bot detector | Historikus trade history | Real-time stream |
| LLM dep. | Claude API (30 perc cache) | Lokális modell (0 cost) |
| Frank-Wolfe | Nincs | Gurobi + Alchemy |
| Trade logging | Nincs | Supabase tábla |

### Éves infrastruktúra cost becslés

| Elem | Cost |
|------|------|
| Netlify (Pro) | $19/hó |
| Claude API (LLM dep) | ~$5-20/hó |
| Alchemy Polygon | $49/hó (growth plan) |
| Gurobi (academic) | $0 |
| **Total** | **~$75-90/hó** |

Ha az automata execution 1-2 érdemi arbitrázst talál havonta → pozitív ROI.

---

## Kutatási irányok

### Posztokból kimaradt de érdekes

1. **Sports latency arbitrage** – stadion feed vs TV delay (15-40mp), Sportradar API ($500-5000/hó) szükséges
2. **Cross-platform arb** – Polymarket vs Kalshi árkülönbségek (pl. `polymarketanalytics.com` already cross-lists)
3. **Resolution bias** – a paper mérte: 5-15% között árazott piacok csak 4-9%-ban resolvnak YES → szisztematikus favorite-longshot bias
4. **POLY token governance** – ha megjelenik a POLY token, dispute resolution stakes új market making lehetőség

### Akadémiai irodalom amit még nem implementáltunk

- **Budish et al. (2015)**: *The High-Frequency Trading Arms Race* – batch auction vs continuous trading
- **Cartea & Jaimungal (2015)**: execution optimal liquidation Polymarket kontextusban
- **Lopez de Prado (2018)**: *Advances in Financial Machine Learning* – feature engineering jelzésekhez
