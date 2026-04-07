# EdgeCalc – Polymarket Trading Dashboard

**Verzió:** v8  
**Stack:** Astro 5 + React 18 + Netlify Functions + Supabase  
**Python scriptek:** 4 lokális elemző eszköz  

---

## Mi ez?

EdgeCalc egy kvantitatív kereskedési elemző dashboard Polymarket predikciós piacokhoz. Nem copy-trade bot, nem affiliate platform – saját implementáció matematikai alapokon, nyilvánosan elérhető akadémiai irodalom alapján.

**Fő forrásaink:**
- *"Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets"* (arXiv:2508.03474v1)
- *Grinold & Kahn: Active Portfolio Management* (Fundamental Law)
- Hubble Research: Polymarket bot detection methodology
- Avellaneda-Stoikov market making framework

---

## Architektúra

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (Astro 5 + React 18)                              │
│  11 tab, minden tab önálló React komponens                  │
├─────────────────────────────────────────────────────────────┤
│  Netlify Functions (15 serverless endpoint)                 │
│  Cache: Netlify Blobs KV store                              │
├───────────────┬─────────────────────────────────────────────┤
│  Polymarket   │  Binance/Bybit                              │
│  Gamma API    │  Futures API                                │
│  CLOB API     │  Funding rates                              │
│  Data API     │  Klines (OHLCV)                             │
└───────────────┴─────────────────────────────────────────────┘
```

---

## A 11 Tab áttekintése

| Tab | Neve | Fő technika | Dokumentáció |
|-----|------|-------------|--------------|
| 01 | Scanner | Polymarket piac scanner, EV calc | [01-scanner.md](./01-scanner.md) |
| 02 | EV Calc | Expected Value + Kelly | [02-ev-kelly.md](./02-ev-kelly.md) |
| 03 | Funding Arb | Delta-neutral funding rate | [03-funding-arb.md](./03-funding-arb.md) |
| 04 | Swarm | Multi-agent Monte Carlo | [04-swarm.md](./04-swarm.md) |
| 05 | Trading | Bybit/Binance/Polymarket exec | [05-trading.md](./05-trading.md) |
| 06 | Order Flow | Kyle λ + VPIN + Hawkes | [06-orderflow.md](./06-orderflow.md) |
| 07 | Vol Harvest | IV vs RV divergence | [07-vol-harvest.md](./07-vol-harvest.md) |
| 08 | Apex Wallets | Bot detector + Category specialist | [08-apex-wallets.md](./08-apex-wallets.md) |
| 09 | Cond. Prob | Marginal polytope violations | [09-cond-prob.md](./09-cond-prob.md) |
| 10 | Signals | Fundamental Law kombinátor | [10-signal-combiner.md](./10-signal-combiner.md) |
| 11 | Arb Matrix | VWAP + LLM Dependency + Polytope | [11-arb-matrix.md](./11-arb-matrix.md) |

---

## Python CLI scriptek

| Script | Funkció | Fő parancsok |
|--------|---------|--------------|
| `apex_wallet_profiler.py` | Leaderboard + Sharpe + Payout + Category | `--demo`, `--consensus`, `--profile 0x...` |
| `vol_divergence.py` | BTC realized vs implied vol | `--demo`, `--watch`, `--json` |
| `orderflow_analyzer.py` | Kyle λ + VPIN + Hawkes MLE | `--demo`, `--list-markets` |
| `conditional_prob_matrix.py` | Monotonicity + Complement violations | `--demo`, `--scan-btc`, `--cli` |

---

## Netlify Functions (15 endpoint)

| Endpoint | Cache | Funkció |
|----------|-------|---------|
| `/apex-wallets` | 5-10 perc | Leaderboard, profil, consensus, bot detect |
| `/vol-divergence` | 2 perc | Binance klines + PM implied vol |
| `/orderflow-analysis` | 5 perc | Kyle λ, VPIN, Hawkes |
| `/cond-prob-matrix` | 5 perc | Constraint violation scanner |
| `/signal-combiner` | 3 perc | IR = IC × √N kombinátor |
| `/vwap-arb` | 90 mp | Order book VWAP arb scanner |
| `/llm-dependency` | 30 perc | Claude API piac függőség |
| `/funding-rates` | 8 óra | Binance funding rates |
| `/polymarket-proxy` | 1 óra | Gamma API CORS proxy |
| `/bybit-trade` | – | Bybit v5 authenticated |
| `/binance-trade` | – | Binance Futures authenticated |
| `/polymarket-trade` | – | PM CLOB order exec |
| `/auth` | – | JWT + SHA-256 session |
| `/user-settings` | – | Bankroll/Kelly Blobs |
| `/scheduled-scan` | cron | Óránkénti auto-refresh |

---

## Gyors indítás

```bash
# Kicsomagolás és telepítés
unzip edge-calc-v8.zip && cd edge-calc
npm install

# Lokális dev (Netlify CLI szükséges)
netlify dev   # localhost:8888

# Build
npm run build

# Deploy
netlify deploy --prod --dir=dist
```

### Szükséges env vars (Netlify dashboard):

```
JWT_SECRET=<32+ karakter>
AUTH_PASSWORD_HASH=<sha256>
ANTHROPIC_API_KEY=<sk-ant-...>   # LLM dependency detectorhoz
BYBIT_API_KEY=...
BYBIT_API_SECRET=...
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
```

### Hash generálás:
```bash
node -e "console.log(require('crypto').createHash('sha256').update('jelszo').digest('hex'))"
```

---

## Részletes dokumentáció

→ [01-scanner.md](./01-scanner.md) – Piac scanner és EV kalkulátor  
→ [02-ev-kelly.md](./02-ev-kelly.md) – Expected Value és Kelly criterion  
→ [03-funding-arb.md](./03-funding-arb.md) – Funding rate arbitrázs  
→ [06-orderflow.md](./06-orderflow.md) – Order flow analízis (Kyle λ, VPIN, Hawkes)  
→ [07-vol-harvest.md](./07-vol-harvest.md) – Volatility harvesting  
→ [08-apex-wallets.md](./08-apex-wallets.md) – Apex wallet profiler  
→ [09-cond-prob.md](./09-cond-prob.md) – Conditional probability matrix  
→ [10-signal-combiner.md](./10-signal-combiner.md) – Signal kombinátor  
→ [11-arb-matrix.md](./11-arb-matrix.md) – Arbitrage matrix  
→ [roadmap.md](./roadmap.md) – Fejlesztési útvonal
