# Hyperliquid Auto-Trader

Hyperliquid perpetual-futures execution engine built as a new category alongside
`crypto` and `weather`. Reuses the EdgeCalc signal layer (signal-combiner) but
converts binary-market probabilities into perp LONG/SHORT directional trades.

Status: **execution engine base** — paper mode is fully functional; live mode
is wired but requires `@nktkas/hyperliquid` + `viem` + `HL_PRIVATE_KEY` to place
real orders.

---

## Adaptation vs. the original VPS prompt

The source prompt (`edgecalc-hyperliquid-prompt.md`) specified a standalone
Hetzner VPS with Bun + PM2 + WebSocket feeds. This implementation adapts the
same engine to the existing Netlify-serverless architecture:

| Original (VPS)                     | This implementation (Netlify)                 |
|------------------------------------|-----------------------------------------------|
| PM2 long-running daemon            | Scheduled function, 3-minute cron             |
| WebSocket `userFills` subscription | REST polling via `InfoClient` each run        |
| `/tmp/session.json`                | Netlify Blobs (`hyperliquid-session-v1`)      |
| Direct `@nktkas/hyperliquid` SDK   | Lazy-load adapter (paper-mode works without) |
| Telegram bot commands              | UI buttons + existing `shared/telegram.mts`   |
| `/health` /`/signal` endpoints     | `auto-trader-api` with `category=hyperliquid` |

Everything else — the Kelly sizer, volatility gate, TP/SL geometry, session-
loss stop, consecutive-loss pause, 3x leverage cap — is preserved.

---

## Frontend

| Route                     | File                                                   |
|---------------------------|--------------------------------------------------------|
| Homepage card (6th)       | `src/components/HomePage.tsx`                          |
| `/trade/hyperliquid`      | `src/pages/trade/[category].astro` (+ getStaticPaths)  |
| Category routing          | `src/components/CategoryDashboard.tsx`                 |
| Main UI                   | `src/components/trader/HyperliquidTrader.tsx`          |

The UI is a sibling of `CryptoTrader.tsx` / `WeatherTrader.tsx`: session stats
(bankroll, PnL, trades, open, consecutive losses), Run / Reset / Stop / Resume
controls, per-coin result rows.

---

## Backend (`netlify/functions/auto-trader/hyperliquid/`)

```
hyperliquid/
  index.mts              ← runHyperliquidTrader() main loop + control handlers
  types.mts              ← HlCoin, HlTradeSignal, HlPosition, HlSessionState
  config.mts             ← env-driven config + asset index map + HL endpoints
  hl-client.mts          ← REST wrapper (allMids, clearinghouseState) + live adapter
  signal-source.mts      ← pulls signal-combiner + maps binary prob → direction
  kelly-sizer.mts        ← binary Kelly → perp coin size (¼-Kelly, 3x cap, 15% bankroll cap)
  volatility-gate.mts    ← 12×1h RV filter (Binance fut → spot → CryptoCompare)
  decision-engine.mts    ← final gates (cooldown, session loss, consec loss, edge, risk)
  order-manager.mts      ← placeHlEntry (paper sim + live adapter) + TP/SL + paper PnL sim
  session-manager.mts    ← Netlify Blobs-backed state (paper / live keys)
```

### Data flow per run

```
Netlify cron → auto-trader/index.mts (category=hyperliquid)
  → runHyperliquidTrader()
     for each coin in [BTC, ETH, SOL]:
       getHlSignalForCoin(coin)
         → find related Polymarket market ("bitcoin-up-or-down…")
         → GET /signal-combiner?slug=…
         → map combined_probability → LONG/SHORT + edge
       volatilityGate(coin)          (skipped in paper)
       makeHlDecision(signal, session, config)
       getCurrentPrice(coin)         via HL /info allMids
       kellyToPerpSize(…)
       placeHlEntry(…)               paper sim OR live SDK
       if paperMode:
         simulatePaperPnl(…)
         closePosition(…)
         apply consecutive-loss pause / session-loss stop
  → saveHlSession(state)
  → return summary
```

### Reuse from existing EdgeCalc code

- **Signal layer** — `signal-combiner` endpoint used as-is. Included the new
  `resolution_risk.category` from v0.4.0 → SKIP category also blocks perp entries.
- **Logger** — `auto-trader/shared/logger.mts` (NDJSON events tagged with
  `venue: "hyperliquid"`).
- **Telegram** — `auto-trader/shared/telegram.mts` (`alertError` on exceptions).
- **Dispatcher** — `auto-trader/index.mts` routes `category=hyperliquid` to the
  self-contained handler set (`runHyperliquidTrader`, `getHlStatus`, `hlReset`,
  `hlStop`, `hlResume`). `crypto` and `weather` flows unchanged.

---

## API

All calls go through the existing `/.netlify/functions/auto-trader-api`.

```
GET  ?action=status&category=hyperliquid
POST { action: "run"    | "reset" | "stop" | "resume", category: "hyperliquid" }
```

Response shape (run):

```json
{
  "ok": true,
  "action": "run",
  "category": "hyperliquid",
  "paperMode": true,
  "coinsScanned": 3,
  "results": [
    { "coin": "BTC", "action": "traded", "direction": "LONG", "entry": 84250, "exit": 85230, "pnl": 12.34, "reason": "tp" },
    { "coin": "ETH", "action": "skip", "reason": "Net edge 2.1% < 12.0% threshold" },
    { "coin": "SOL", "action": "skip", "reason": "Only 2/5 signals active" }
  ],
  "session": {
    "paperMode": true,
    "bankrollCurrent": 212.34,
    "sessionPnL": 12.34,
    "sessionLoss": 0,
    "tradeCount": 1,
    "openPositions": 0,
    "consecutiveLosses": 0
  }
}
```

---

## Decision gates (order of evaluation)

1. Session stopped / paused
2. Session loss limit
3. Max open positions (default 3)
4. Consecutive-loss pause (3 losses → 1 hour pause)
5. Coin cooldown (default 5 min)
6. Already have open position on this coin
7. `activeSignals < 3` (need ≥3 independent signals)
8. Resolution-risk category = SKIP
9. Fee-aware net edge below threshold (paper 12%, live 18%)
10. Volatility gate (live only, RV > 120% blocks)

---

## Position sizing math

Binary-market Kelly from the signal-combiner is `f* = (p·b - q) / b`.
For a perp we apply:

```
quarter_kelly   = kelly * 0.25
capped_fraction = min(quarter_kelly, max_pct_bankroll)   // default 15%
size_usdc       = bankroll * capped_fraction
size_coins      = (size_usdc * leverage) / current_price
```

Leverage is hard-capped at 3x (config `HL_MAX_LEVERAGE`). TP/SL is asymmetric
2:1: `TP = entry ± 2·edge`, `SL = entry ± 1·edge`.

---

## Environment variables

```env
# Mode
HL_PAPER_MODE=true                 # true = testnet endpoints + simulated orders
HL_PRIVATE_KEY=0x...               # required for live
HL_WALLET_ADDRESS=0x...

# Risk
HL_MAX_LEVERAGE=3
HL_MAX_PCT_BANKROLL=0.15
HL_SESSION_LOSS_LIMIT=50
HL_MAX_OPEN_POSITIONS=3

# Gates
HL_EDGE_THRESHOLD_PAPER=0.12
HL_EDGE_THRESHOLD_LIVE=0.18
HL_COOLDOWN_SECONDS=300
HL_CONSEC_LOSS_LIMIT=3
HL_CONSEC_LOSS_PAUSE_HOURS=1
HL_VOL_GATE_RV_PCT=120
HL_ROUNDTRIP_FEE_PCT=0.0007
```

Defaults match the original VPS prompt's constraints.

---

## Going live (TODO for next sprint)

1. `npm install @nktkas/hyperliquid viem` — the order adapter in
   `hl-client.mts` lazy-loads these; without them live mode refuses entries.
2. Set `HL_PRIVATE_KEY` + `HL_WALLET_ADDRESS` in Netlify env.
3. Set `HL_PAPER_MODE=false`.
4. Verify `info.meta()` matches the hard-coded `ASSET_INDEX` map in
   `config.mts` — if Hyperliquid adds/reorders assets this must update.
5. Run at least 20 testnet trades with `HL_PAPER_MODE=true` against
   `api.hyperliquid-testnet.xyz` before flipping the switch.
6. Wire WebSocket fill notifications (currently polling via REST on each cron
   tick). Netlify functions can't hold long-lived WebSockets, so this needs a
   background worker — out of scope for the base engine.

---

## Not included in this sprint

- `@nktkas/hyperliquid` SDK install (lazy-loaded — install when going live)
- WebSocket fill subscription (needs separate worker, out of scope for serverless)
- Telegram command bot (/status, /stop) — UI buttons handle this already
- Daily 07:00 summary alert — trivial cron addition when needed

---

## Funding Rate Arbitrage (second layer)

Built on top of the directional engine as a distinct execution layer. Shares
the HL REST client + Blobs pattern but runs against a separate session store
so a stopped arb layer doesn't block directional trades (and vice versa).

**Strategy** — delta-neutral carry:
- SHORT the Hyperliquid perp (collects positive funding)
- LONG the Binance spot (hedge — no funding, no directional exposure)
- Net directional: 0. Net income per hour: `hlFunding - binanceFunding`

Closed automatically when the spread decays below `FR_MIN_SPREAD_TO_CLOSE`,
flips negative, or the position exceeds `FR_MAX_HOLD_DAYS`.

### Layered trading model (how the pieces fit)

```
Layer 1 — HLP Vault           ~20%/yr  manual, not coded
Layer 2 — Funding Arbitrage   ~25-40%/yr  this module (delta-neutral)
Layer 3 — Directional         signal-driven (Hyperliquid perp base)
```

### Files (under `netlify/functions/auto-trader/hyperliquid/funding-arb/`)

```
funding-arb/
  types.mts          ← FundingData, ArbOpportunity, ArbPosition, ArbSessionState
  config.mts         ← FR_MIN_SPREAD_HOURLY, OI floor, capital cap, fee constants
  fr-scanner.mts     ← HL `metaAndAssetCtxs` + Binance `premiumIndex` → normalised hourly
  arb-detector.mts   ← fee-aware viability + break-even-days check + ranking
  hedge-manager.mts  ← Binance spot adapter (paper sim + live HMAC SHA-256)
  fr-executor.mts    ← atomic two-leg open/close with auto-unwind on partial
  fr-session.mts     ← separate Blobs store + funding accrual math
  index.mts          ← runFundingArbLoop() + status/reset/stop/resume
```

### Data flow per run

```
POST { category: "hyperliquid", layer: "arb", action: "run" }
  → runFundingArbLoop()
     1. accrueFunding()                 ← credit hours elapsed since last run
     2. scanFundings(ARB_COINS)         ← HL + Binance in parallel
     3. for each OPEN position:
          close if spread < minSpreadToClose | flipped negative | max hold reached
     4. for each viable opportunity (ranked by spread):
          skip if max open positions or coin already held
          size = min(headroom * 0.5, OI * 0.001)
          openArbPosition()  — HL SHORT first, Binance LONG second
          if Binance leg fails → auto-unwind HL short (delta-neutral guarantee)
     5. save session, return run summary + top-5 opportunity snapshot
```

### API

Dispatcher accepts a new `layer` field; default is `directional` for
backwards compat.

```
POST /.netlify/functions/auto-trader-api
  { category: "hyperliquid", layer: "arb", action: "run" | "status" | "reset" | "stop" | "resume" }

GET  /.netlify/functions/auto-trader-api?category=hyperliquid&layer=arb&action=status
```

### Environment variables

```env
# Binance spot hedge leg (SPOT permission only — never futures/withdraw)
BINANCE_API_KEY=...
BINANCE_API_SECRET=...

# Funding-arb thresholds
FR_MIN_SPREAD_HOURLY=0.0001        # 0.01%/h minimum
FR_MIN_OPEN_INTEREST=5000000       # $5M OI floor per coin
FR_MAX_ARB_POSITIONS=3
FR_MAX_CAPITAL_PCT=0.40            # max 40% of bankroll in the arb layer
FR_MIN_POSITION_USDC=50
FR_MAX_HOLD_DAYS=14
FR_MIN_SPREAD_TO_CLOSE=0.00005
FR_FEE_ROUNDTRIP_HL=0.0009         # 0.045% × 2
FR_FEE_ROUNDTRIP_BINANCE=0.002     # 0.1%  × 2
```

### UI

Second tab ("Funding Arb") under `/trade/hyperliquid`
([FundingArbPanel.tsx](../src/components/trader/FundingArbPanel.tsx)):

- Open positions table (coin, size, entry spread, accrued funding, age)
- Top-5 opportunity snapshot from the last scan (annualised + hourly spread, OI)
- Last-run action log with skip reasons
- Scan+Run / Reset / Stop / Resume

### Going live checklist (arb-specific)

1. Register a Binance account and create an API key with **SPOT trading**
   permission only (no futures, no withdrawal).
2. Set `BINANCE_API_KEY` + `BINANCE_API_SECRET` in Netlify env.
3. Set `HL_PAPER_MODE=false` and follow the directional-engine live checklist
   (HL SDK install + private key).
4. Paper-run for at least 48 hours and confirm:
   - `accumulatedFunding` grows at roughly `sizeUSDC × spread × hours`
   - Close triggers fire when spread decays below threshold
   - Two-leg unwind fires if either leg fails (test by deliberately setting
     wrong Binance symbol in config)
5. Flip `HL_PAPER_MODE=false` only after (4).

### Critical guardrails

- If Binance leg fails after HL short succeeds, the HL short is auto-unwound
  via a reduce-only IOC buy — the system never leaves a naked directional
  position from an arb attempt. ([fr-executor.mts:57](../netlify/functions/auto-trader/hyperliquid/funding-arb/fr-executor.mts))
- Spread flipping negative immediately triggers close — shorts would
  otherwise start paying instead of receiving.
- Capital cap (default 40% of bankroll) enforced on entries; directional
  layer is unaffected.
- Minimum position $50 — below this, Binance + HL fees eat the yield.
