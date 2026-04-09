# 12 – Real-time WebSocket Integration

**Status:** Planned (Phase 3)
**Priority:** Medium
**Prerequisites:** Stable trade logging (Phase 2), 50+ trades for IC calibration

---

## Motivation

A jelenlegi polling-alapú rendszer (3 perces cache TTL) nem elegendő:
- **VPIN számítás** trade-by-trade frissítést igényel, nem batch-et
- **Kyle λ** az order flow deriváltja — késleltetett adat torzítja
- **Hawkes intensity** valós idejű event stream nélkül nem számolható
- **VWAP arb scanner** 90 mp cache-szel lemarad az arb ablakokról

## Architektúra

### Adatforrások

```
┌─────────────────────────────────────────────────┐
│                  WebSocket Feeds                 │
├─────────────┬──────────────┬────────────────────┤
│ Polymarket  │   Binance    │      Bybit         │
│ CLOB WS     │   Spot WS    │    Futures WS      │
│             │              │                    │
│ • trades    │ • btcusdt    │ • btcusdt          │
│ • book Δ    │   @trade     │   tickers          │
│ • midpoint  │ • klines     │ • fundingRate      │
│             │   1m stream  │                    │
└─────┬───────┴──────┬───────┴────────┬───────────┘
      │              │                │
      ▼              ▼                ▼
┌─────────────────────────────────────────────────┐
│           WebSocket Aggregator Service           │
│                                                  │
│  • Node.js standalone process                    │
│  • Nem Netlify Function (stateful, long-lived)   │
│  • Futhat VPS-en (Hetzner/Fly.io) vagy lokálisan│
│  • Redis/SQLite local buffer                     │
│                                                  │
│  Számítások real-time:                           │
│  ├─ VPIN (rolling 50-bar window)                 │
│  ├─ Kyle λ (5-perc rolling OLS)                  │
│  ├─ Hawkes intensity λ*(t)                       │
│  ├─ Order book imbalance (tick-by-tick)           │
│  ├─ VWAP vs current price                        │
│  └─ Funding rate (8h cycle tracking)             │
│                                                  │
│  Output: POST → Netlify Function (batch update)  │
│  vagy: SSE/WS → frontend direct                  │
└─────────────────────────────────────────────────┘
```

### Polymarket CLOB WebSocket

```typescript
// Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
// Docs: https://docs.polymarket.com/#websocket-channels

const ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");

ws.onopen = () => {
  // Subscribe to trades for a specific market
  ws.send(JSON.stringify({
    type: "subscribe",
    channel: "market",
    assets_id: TOKEN_ID, // YES token ID
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data.event_type: "trade", "book", "midpoint", "price"
  // data.price, data.size, data.side, data.timestamp
};
```

### Binance WebSocket

```typescript
// Endpoint: wss://stream.binance.com:9443/ws/btcusdt@trade
// Klines: wss://stream.binance.com:9443/ws/btcusdt@kline_1m

const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data.p = price, data.q = quantity, data.m = is buyer maker
};
```

### Bybit WebSocket

```typescript
// Endpoint: wss://stream.bybit.com/v5/public/linear
const ws = new WebSocket("wss://stream.bybit.com/v5/public/linear");

ws.onopen = () => {
  ws.send(JSON.stringify({
    op: "subscribe",
    args: ["tickers.BTCUSDT"],
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data.data.fundingRate, data.data.markPrice
};
```

## Real-time Számítások

### VPIN (Volume-Synchronized Probability of Informed Trading)

```
Rolling window: 50 bar (volume bucket)
Update: minden trade után újraszámol

VPIN = Σ|V_buy - V_sell| / Σ(V_buy + V_sell)

Ha VPIN > 0.7 → informált kereskedők aktívak → várj a belépéssel
Ha VPIN < 0.3 → normál flow → biztonságos belépés
```

### Kyle Lambda (Adverse Selection)

```
5-perc rolling OLS: Δp = λ × Q + ε
ahol Q = net order flow (signed volume)

Magas λ → nagy price impact → gyenge likviditás → ne trade-elj
Alacsony λ → kis price impact → erős likviditás → belépés OK
```

### Hawkes Self-Exciting Intensity

```
λ*(t) = μ + Σ α × e^(-β(t - t_i))

μ = baseline intensity
α = excitation (mennyit ad egy event)
β = decay (milyen gyorsan csökken)

Magas λ*(t) → clustering → valami történik → figyelj
```

## Deployment Opciók

### A) Fly.io (ajánlott)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY ws-aggregator/ .
RUN npm install
CMD ["node", "server.js"]
```

**Fly.io előnyök:**
- $5/hó (shared CPU)
- Persistent WebSocket connections
- Edge deploy (Frankfurt / US-East)
- Auto-restart on crash

### B) Lokális (development)

```bash
# Standalone process
node ws-aggregator/server.js

# Eredmények → Netlify Function POST
# vagy → SQLite local DB → frontend polling
```

### C) Netlify Background Function (korlátozott)

```typescript
// Max 15 perc futásidő
// Nem alkalmas real-time WS-re
// Csak batch processing-re jó
```

## Frontend Integráció

### Server-Sent Events (SSE) — Ajánlott

```typescript
// Frontend
const es = new EventSource("/api/signals/stream");
es.onmessage = (e) => {
  const signal = JSON.parse(e.data);
  // { vpin: 0.45, kyle_lambda: 0.023, hawkes: 1.8, ... }
  updateDashboard(signal);
};
```

### Polling Fallback

```typescript
// Ha SSE nem elérhető, 10 mp polling
setInterval(async () => {
  const res = await fetch("/api/signals/latest");
  const data = await res.json();
  updateDashboard(data);
}, 10000);
```

## Implementációs Sorrend

1. **WS Aggregator Service** (Node.js standalone)
   - Polymarket CLOB WS subscription
   - VPIN + order book imbalance real-time
   - Eredmények SQLite-ba

2. **Binance/Bybit WS**
   - RV számítás tick-by-tick
   - Funding rate tracking

3. **API Bridge**
   - Netlify Function ami lekéri a WS aggregator eredményeit
   - Vagy SSE direct a frontendnek

4. **Frontend Update**
   - Real-time signal bars a Signal Combiner-ben
   - VPIN gauge az Order Flow tab-on

## Költségbecslés

| Komponens | Költség/hó |
|-----------|-----------|
| Fly.io VM (shared) | $5 |
| Netlify Pro (ha kell) | $19 |
| API kulcsok | $0 (free tier) |
| **Összesen** | **$5-24/hó** |

## Megjegyzések

- A Polymarket CLOB WS rate limit: 10 subscription / connection
- Binance WS: 5 stream / connection, max 1024 connection
- Bybit WS: 20 topic / connection
- Reconnect logic szükséges (exponential backoff)
- Heartbeat: 30 mp ping/pong
