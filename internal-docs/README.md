# EdgeCalc Auto-Trader – Architecture

> Quantitative Polymarket auto-trading system built on EdgeCalc signal infrastructure.

---

## Overview

EdgeCalc Auto-Trader is a **serverless trading bot** that runs on Netlify Functions.
It consumes signals from the existing EdgeCalc dashboard endpoints and executes
trades on Polymarket via the CLOB API.

**Core principle:** Signal layer is inherited (not rewritten), execution layer is new.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│  SIGNAL LAYER  (inherited from EdgeCalc v8)             │
│                                                         │
│  /funding-rates        → funding rate anomaly score     │
│  /orderflow-analysis   → Kyle λ + VPIN + Hawkes         │
│  /vol-divergence       → IV vs RV spread                │
│  /apex-wallets         → smart money consensus          │
│  /signal-combiner      → IR = IC × √N aggregation      │
│  /cond-prob-matrix     → monotonicity violations        │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│  AUTO-TRADER  (new, /auto-trader endpoint)              │
│                                                         │
│  1. Market Discovery   → Gamma API BTC up/down finder   │
│  2. Signal Aggregation → parallel fetch from above      │
│  3. Decision Engine    → edge threshold + Kelly sizing  │
│  4. Execution          → @polymarket/clob-client orders │
│  5. Session Manager    → PnL tracking, loss limits      │
│  6. Monitoring         → Telegram alerts + NDJSON log   │
└─────────────────────────────────────────────────────────┘
```

---

## File Structure

```
netlify/functions/auto-trader/
├── index.ts                    ← Netlify Function entry point
│                                  Actions: run | status | reset | stop
│                                  Scheduled: */3 * * * *
├── crypto/
│   ├── btc-market-finder.ts    ← Gamma API: active BTC up/down markets
│   ├── signal-aggregator.ts    ← Fetches signal-combiner + fallback
│   ├── decision-engine.ts      ← Edge calc, fee deduction, Kelly cap
│   ├── execution.ts            ← @polymarket/clob-client BUY/SELL
│   ├── order-lifecycle.ts      ← Fill polling, emergency FOK sell
│   └── session-manager.ts      ← Netlify Blobs state persistence
├── shared/
│   ├── types.ts                ← All TypeScript interfaces
│   ├── config.ts               ← Env vars, API endpoints, constants
│   ├── logger.ts               ← NDJSON event logger
│   └── telegram.ts             ← Telegram Bot API alerts
├── sports/index.ts             ← Sprint 2 placeholder
├── politics/index.ts           ← Sprint 3 placeholder
└── macro/index.ts              ← Sprint 4 placeholder

src/components/trader/
├── CategorySelector.tsx        ← 4-category picker UI
├── CryptoTrader.tsx            ← Crypto dashboard (run/status/reset/stop)
└── TraderStatus.tsx            ← Router: category → trader view
```

---

## Category Strategy Map

| Category | Sprint | Mode | Edge Source | Min Edge | Fee |
|----------|--------|------|-------------|----------|-----|
| Crypto   | 1      | AUTO | FR + VPIN + Vol + Apex + CondProb | 15% | 1.8% |
| Sports   | 2      | ALERT | Statistical model vs fan bias | 8% | 0.6% |
| Politics | 3      | ALERT | LLM sentiment + polls | TBD | ~1% |
| Macro    | 4      | ALERT | Weather/Fed/CPI data | TBD | TBD |

Only **Crypto** is implemented in Sprint 1. Others are placeholder stubs.

---

## Decision Engine Parameters

```
edge_threshold       = 15% net (after 3.6% roundtrip fees)
max_kelly_fraction   = 20% bankroll per trade
cooldown             = 300s per market slug
session_loss_limit   = $20 (configurable via env)
min_open_interest    = $500
min_active_signals   = 2
```

### Edge Calculation

```
gross_edge  = |final_prob - market_price|
net_edge    = gross_edge - 0.036          (1.8% entry + 1.8% exit)
shouldTrade = net_edge > EDGE_THRESHOLD
```

### Kelly Sizing

```
kelly_full    = max(0, (p*b - q) / b)     where b = 1/price - 1
kelly_quarter = kelly_full * 0.25          institutional standard
kelly_capped  = min(kelly_quarter, 0.20)   hard cap
position_size = bankroll * kelly_capped
```

---

## Execution Flow

```
1. findBtcMarkets()           → active BTC up/down markets from Gamma API
2. aggregateSignals(slug)     → call /signal-combiner (or fallback to individual)
3. makeDecision(signal, ...)  → edge check, kelly sizing, cooldown/loss guards
4. placeBuyOrder(...)         → GTC limit order via clob-client (or paper sim)
5. handleBuyLifecycle(...)    → wait for fill (paper: instant, live: poll)
6. handleSellLifecycle(...)   → GTC sell → emergency FOK if timeout
7. saveSession(...)           → persist to Netlify Blobs
8. alertTradeClosed(...)      → Telegram notification
```

---

## Environment Variables

```env
# Required for live trading
POLY_PRIVATE_KEY=0x...
POLY_FUNDER_ADDRESS=0x...
POLY_SIGNATURE_TYPE=1

# Auto-trader config
PAPER_MODE=true                  # MUST be explicitly set to false for live
SESSION_LOSS_LIMIT=20
MAX_KELLY_FRACTION=0.20
EDGE_THRESHOLD_CRYPTO=0.15
COOLDOWN_SECONDS=300

# Monitoring
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

---

## API Endpoints

```
GET  /auto-trader?action=status    → current session state
POST /auto-trader { action: "run" }    → execute one trading cycle
POST /auto-trader { action: "reset" }  → reset session to defaults
POST /auto-trader { action: "stop" }   → stop session (manual)
```

Scheduled: runs automatically every 3 minutes via Netlify cron.

---

## Signal Documentation (Inherited)

The following docs describe the EdgeCalc signal modules consumed by the auto-trader:

| File | Signal | Math |
|------|--------|------|
| `02-ev-kelly.md` | EV + Kelly criterion | f* = (pb-q)/b |
| `06-orderflow.md` | Order flow analysis | Kyle λ, VPIN, Hawkes |
| `07-vol-harvest.md` | Volatility divergence | IV vs RV spread |
| `08-apex-wallets.md` | Smart money tracking | Payout ratio, bot detect |
| `09-cond-prob.md` | Conditional probability | Marginal polytope violations |
| `10-signal-combiner.md` | Signal combination | Grinold-Kahn IR = IC × √N |
| `11-arb-matrix.md` | Arbitrage detection | VWAP scanner, LLM dependency |
| `12-realtime-websocket.md` | WebSocket architecture | Future: real-time feed |
