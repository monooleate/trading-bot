# Changelog — 2026-04-21 Session

Four sprints delivered this session. Listed newest-first. Links point to
the detailed design docs under `internal-docs/`.

---

## [0.6.0] – 2026-04-21 — Weather Module Patch

Implements [edgecalc-weather-patch.md](edgecalc-weather-patch.md).
Full details: [weather-patch.md](weather-patch.md).

### Fix 1 — Settlement station corrections

Polymarket weather markets settle on airport METAR, not city-center
values. Fixed against the `alteregoeth-ai/weatherbot` ground truth.

**Changed** — `netlify/functions/auto-trader/weather/station-config.mts`:
- London: `EGLL` → **`EGLC`** (London City, not Heathrow)
- New York: `KNYC` → **`KLGA`** (LaGuardia, not Central Park / JFK)
- Coordinates, timezone, and `city_offset` updated to match

**Added** — two missing cities:
- Dallas: **`KDAL`** (Love Field, explicitly NOT `KDFW`/Fort Worth)
- Tokyo: **`RJTT`** (Haneda, explicitly NOT `RJAA`/Narita)

Unchanged (already correct): Chicago KORD, Miami KMIA, Seattle KSEA,
Atlanta KATL, Shanghai ZSPD, Los Angeles KLAX, Hong Kong VHHH, Seoul RKSS.

**Added** — regression guard
`netlify/functions/auto-trader/weather/station-config.test.mts`:
ICAO check, "forbidden ICAO" check (KDFW, EGLL, RJAA, KNYC), coordinate
drift tolerance, season helper sanity. Runs via `npx tsx`. **8/8 passed.**

### Fix 2 — 31-member GFS ensemble (opt-in)

Replaces the fixed GFS+ECMWF blend with a 31-member ensemble vote when
enabled.

**Added** — `netlify/functions/auto-trader/weather/ensemble-forecast.mts`:
- Fetches Open-Meteo `/v1/ensemble` endpoint
- Extracts daily max per member, computes mean + stddev
- `ensembleProbAbove(threshold)` for bucket voting
- `ensembleConfidence(threshold)` for unanimity-based confidence
- Never throws — returns `null` on any failure

**Changed** — `forecast-engine.mts`:
- `USE_ENSEMBLE=true` env toggle activates ensemble path
- When ≥5 members return → ensemble mean replaces blend, stddev → confidence
- Fallback: any ensemble failure → original GFS+ECMWF+NOAA blend
- `ForecastResult` gained optional `ensembleDetail` field (backwards compat)

### Fix 3 — Dynamic Error Balancing (DEB)

Per-city rolling MAE window; weights inverse-proportional to recent error.

**Added** — `netlify/functions/auto-trader/weather/deb.mts`:
- 30-trade rolling window per city in Netlify Blobs (`weather-deb-v1`)
- `< 10 samples` → fixed default weights returned (bootstrap guardrail)
- DEB weights blended 60/40 with prior (overfitting protection)
- `recordDebSample()`, `getDebWeights()`, `getDebDiagnostics()` exports

**Changed** — `forecast-engine.mts`:
- `computeEnsemble()` now takes DEB weights as input
- `getForecast()` loads DEB weights per-city before blending

**Changed** — `weather/index.mts`:
- After trade close → `recordDebSample()` called with per-model predictions
- Paper mode: synthetic actual ~ N(ensembleMean, 1°C) to exercise the
  pipeline without biasing any model
- Live mode: TODO real-METAR reconciliation (separate future job)

### Backwards compatibility

- NDJSON log schema unchanged
- `ClosedTrade` type unchanged
- `ForecastResult` additive only (two new optional fields)
- Without `USE_ENSEMBLE=true` and < 10 DEB samples per city, forecast
  output is identical to pre-patch

---

## [0.5.1] – 2026-04-21 — Funding Rate Arbitrage

Implements [edgecalc-funding-arb-patch.md](edgecalc-funding-arb-patch.md).
Built on top of the directional Hyperliquid engine as a distinct execution
layer. Full details: [hyperliquid.md](hyperliquid.md#funding-rate-arbitrage-second-layer).

### Strategy

Delta-neutral carry — SHORT Hyperliquid perp + LONG Binance spot.
Net directional exposure: 0. Net income: `hlFunding - binanceFunding` per hour.

### Added — Backend `netlify/functions/auto-trader/hyperliquid/funding-arb/`

- `types.mts` — `FundingData`, `ArbOpportunity`, `ArbPosition`, `ArbSessionState`
- `config.mts` — env-driven thresholds (min spread, OI floor, capital cap)
- `fr-scanner.mts` — HL `metaAndAssetCtxs` + Binance `premiumIndex`,
  normalised to hourly rates
- `arb-detector.mts` — fee-aware viability + break-even-days check + ranking
- `hedge-manager.mts` — Binance spot adapter (paper sim + live HMAC-SHA256)
- `fr-executor.mts` — atomic two-leg open/close with auto-unwind on
  partial failure (never leaves naked directional exposure)
- `fr-session.mts` — separate Blobs store (`hyperliquid-arb-session-v1`)
  with funding accrual math
- `index.mts` — `runFundingArbLoop()` + `getArbStatus`/`arbReset`/`arbStop`/`arbResume`

### Changed — dispatcher + UI

- `auto-trader/index.mts` — new `layer` field on the request
  (`"directional"` | `"arb"`); hyperliquid category routes to the arb
  handlers when `layer=arb`
- `shared/types.mts` — `LogEvent` extended with `ARB_OPEN`, `ARB_CLOSE`
- `src/components/CategoryDashboard.tsx` — second tab under
  `/trade/hyperliquid`: "Funding Arb"
- `src/components/trader/FundingArbPanel.tsx` (new) — open positions
  table, top-5 opportunity snapshot, last-run log, Scan+Run / Reset /
  Stop / Resume controls

### Close conditions

- Spread drops below `FR_MIN_SPREAD_TO_CLOSE`
- Spread flips negative (shorts would start paying)
- Position age exceeds `FR_MAX_HOLD_DAYS`

### New env vars

```env
BINANCE_API_KEY=...                # SPOT permission only — never futures/withdraw
BINANCE_API_SECRET=...
FR_MIN_SPREAD_HOURLY=0.0001
FR_MIN_OPEN_INTEREST=5000000
FR_MAX_ARB_POSITIONS=3
FR_MAX_CAPITAL_PCT=0.40
FR_MIN_POSITION_USDC=50
FR_MAX_HOLD_DAYS=14
FR_MIN_SPREAD_TO_CLOSE=0.00005
FR_FEE_ROUNDTRIP_HL=0.0009
FR_FEE_ROUNDTRIP_BINANCE=0.002
```

---

## [0.5.0] – 2026-04-21 — Hyperliquid Execution Engine

Implements [edgecalc-hyperliquid-prompt.md](edgecalc-hyperliquid-prompt.md).
Full details: [hyperliquid.md](hyperliquid.md).

Adapted from the prompt's Hetzner/PM2/WebSocket design to the existing
Netlify serverless architecture — cron + Blobs + REST polling + lazy-loaded
SDK adapter. Paper mode fully functional; live mode requires
`@nktkas/hyperliquid` + `viem` + `HL_PRIVATE_KEY`.

### Added — Frontend

- `src/components/HomePage.tsx` — 6th category card "Hyperliquid" (AUTO, perp fee 0.035%)
- `src/pages/trade/[category].astro` — `hyperliquid` added to `getStaticPaths`
- `src/components/CategoryDashboard.tsx` — new category routing branch
- `src/components/trader/HyperliquidTrader.tsx` (new) — session stats
  (bankroll / PnL / trades / open / loss-streak), TESTNET/MAINNET badge,
  per-coin result rows, Run / Reset / Stop / Resume / Refresh

### Added — Backend `netlify/functions/auto-trader/hyperliquid/`

- `index.mts` — `runHyperliquidTrader()` main loop + control handlers
- `types.mts` — `HlCoin`, `HlTradeSignal`, `HlPosition`, `HlSessionState`
- `config.mts` — env-driven config + asset index map + HL endpoints
- `hl-client.mts` — REST wrapper (`allMids`, `clearinghouseState`)
  + lazy-loaded live-order adapter (`@nktkas/hyperliquid` + viem)
- `signal-source.mts` — pulls signal-combiner per coin, maps binary
  probability → LONG/SHORT direction + edge
- `kelly-sizer.mts` — binary Kelly → perp coin size (quarter-Kelly,
  3x leverage cap, 15% bankroll cap, TP/SL 2:1 RR geometry)
- `volatility-gate.mts` — 12×1h RV filter (Binance fut → spot → CryptoCompare)
- `decision-engine.mts` — ordered gates: stopped/paused, session loss,
  max open, consecutive-loss pause, coin cooldown, active-signal count,
  resolution-risk SKIP, fee-aware net-edge threshold, volatility
- `order-manager.mts` — `placeHlEntry` (paper sim + live adapter) + TP/SL
  auto-placement + paper PnL simulator
- `session-manager.mts` — Netlify Blobs-backed state
  (`hyperliquid-session-v1`), paper/live split keys

### Changed — dispatcher

- `auto-trader/index.mts` — `category=hyperliquid` routes to the
  self-contained handler set. `crypto` and `weather` flows unchanged.

### New env vars

```env
HL_PAPER_MODE=true
HL_PRIVATE_KEY=0x...
HL_WALLET_ADDRESS=0x...
HL_MAX_LEVERAGE=3
HL_MAX_PCT_BANKROLL=0.15
HL_SESSION_LOSS_LIMIT=50
HL_MAX_OPEN_POSITIONS=3
HL_EDGE_THRESHOLD_PAPER=0.12
HL_EDGE_THRESHOLD_LIVE=0.18
HL_COOLDOWN_SECONDS=300
HL_CONSEC_LOSS_LIMIT=3
HL_CONSEC_LOSS_PAUSE_HOURS=1
HL_VOL_GATE_RV_PCT=120
HL_ROUNDTRIP_FEE_PCT=0.0007
```

---

## [0.4.0] – 2026-04-20 — Resolution Risk Scorer

Implements [edgecalc-resolution-risk-prompt.md](edgecalc-resolution-risk-prompt.md).
Also present in the main [CHANGELOG.md](CHANGELOG.md).

Implements the `resolution_risk` term from
`E[X]adjusted = P(YES) - price - resolution_risk - execution_drag`. The
signal-combiner previously evaluated only the first two terms, so trades
could win on prediction but lose on settlement mechanics (ambiguous rules,
timezone boundaries, oracle switches).

### Added — Backend

- `netlify/functions/_resolution-risk.ts` — shared module:
  - `analyseResolutionRisk(slug | MarketMeta)` — heuristic-first,
    Claude API fallback, 30 min Netlify Blobs cache
  - `fetchMarketMeta(slug)` — Gamma events + markets API with
    description/resolutionSource capture
  - `applyResolutionAdjustment(finalProb, marketPrice, risk)` —
    adjusted_prob / adjusted_edge helper
  - Heuristics for BTC/ETH up-down (LOW), weather METAR (MEDIUM/HIGH),
    sports (LOW), thin-rules politicals (HIGH)
  - Claude Sonnet-4 prompt with system + JSON-only output contract
  - Weighting: source_clarity 25%, deadline_precision 20%, wording_ambiguity
    25%, historical_disputes 15%, source_availability 15%
  - Categories: LOW < 0.15 (×0.97), MEDIUM < 0.35 (×0.85),
    HIGH < 0.60 (×0.70), SKIP ≥ 0.60 (×0)
  - Graceful degradation: Claude failure → conservative heuristic fallback
- `netlify/functions/resolution-risk.mts` — GET `?slug=` + POST endpoint

### Changed — signal-combiner (additive)

- `MarketInfo` extended with `rules`, `resolutionSource`, `category`,
  `closed` (pulled from existing Gamma fetch — no extra API calls)
- Resolution-risk runs as the 9th parallel task alongside the 8 signal
  fetches, with `.catch(() => null)` fallback
- Response extended with: `resolution_risk`, `adjusted_probability`,
  `adjusted_edge_pct`, `trade_recommended`, `trade_blocked_reason`
- `recommendation.action` downgraded to `SKIP` (risk category SKIP) or
  `WATCH` (edge below threshold); original in `recommendation.original_action`
- `?skip_risk=1` query param disables the analysis

---

## Notes

- All patches are backwards-compatible — existing paper-trading flows,
  NDJSON log schemas, and API response shapes are unchanged
- Full `tsc --noEmit` run introduces **zero new type errors** across all
  four sprints (pre-existing errors in weather/cond-prob-matrix/
  scheduled-scan unchanged)
- No new runtime dependencies added — `@nktkas/hyperliquid` is lazy-loaded
  only when going live on Hyperliquid mainnet
