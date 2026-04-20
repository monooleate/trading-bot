# Changelog

All notable changes to the EdgeCalc Auto-Trader project.

---

## [0.4.0] – 2026-04-20

### Resolution Risk Scorer

Implements the `resolution_risk` term from `E[X]adjusted = P(YES) - price - resolution_risk - execution_drag`.
The signal-combiner previously only evaluated the first two terms, so trades could win on prediction but lose on settlement mechanics (ambiguous rules, timezone boundaries, oracle switches).

**Added – Backend**

- `netlify/functions/_resolution-risk.ts` – Shared module:
  - `analyseResolutionRisk(slug | MarketMeta)` – heuristic-first, Claude API fallback, 30 min Netlify Blobs cache
  - `fetchMarketMeta(slug)` – Gamma events + markets API with description/resolutionSource capture
  - `applyResolutionAdjustment(finalProb, marketPrice, risk)` – adjusted_prob/adjusted_edge helper
  - Heuristics for BTC/ETH up-down (LOW), weather METAR (MEDIUM/HIGH), sports (LOW), thin-rules politicals (HIGH)
  - Claude Sonnet-4 prompt with system + JSON-only output contract
  - Score weighting: source_clarity 25%, deadline_precision 20%, wording_ambiguity 25%, historical_disputes 15%, source_availability 15%
  - Category mapping: LOW < 0.15 (×0.97), MEDIUM < 0.35 (×0.85), HIGH < 0.60 (×0.70), SKIP ≥ 0.60 (×0)
  - Graceful degradation: Claude failure → conservative fallback heuristic (not cached, retries next call)
- `netlify/functions/resolution-risk.mts` – GET `?slug=` and POST endpoints exposing the shared module

**Changed**

- `netlify/functions/signal-combiner.mts`:
  - `MarketInfo` extended with `rules`, `resolutionSource`, `category`, `closed` (pulled from existing Gamma events fetch — no extra API calls)
  - Resolution-risk runs as the 9th parallel task alongside the 8 signal fetches, with `.catch(() => null)` graceful fallback
  - Response additively extended: `resolution_risk`, `adjusted_probability`, `adjusted_edge_pct`, `trade_recommended`, `trade_blocked_reason`
  - `recommendation.action` downgraded to `SKIP` (risk category SKIP) or `WATCH` (edge below threshold); original action preserved in `recommendation.original_action`
  - `?skip_risk=1` query param disables the analysis
  - Legacy output fields unchanged — fully backwards compatible

**Design notes**

- Heuristic-first to minimise Claude cost; ~70% of markets short-circuit before the API call
- Expired/closed markets return SKIP immediately without caching
- Cache is per-slug, 30 min TTL (resolution rules rarely change mid-market)
- Shared module pattern (underscore-prefixed file) matches `_auth-guard.ts` convention

---

## [0.3.0] – 2026-04-14

### Edge Tracker Tab (statistical edge realization analysis)

**Added – Backend**

- `netlify/functions/edge-tracker.mts` – GET handler, aggregates closed trades from Netlify Blobs session state
- `netlify/functions/edge-tracker/statistics.mts` – Pure statistical functions:
  - `computeSummary` (winRate, Sharpe, Kelly optimal/used, Max DD, calibration deviation)
  - `computeCumulativePnl` (actual + random baseline + EV baseline)
  - `computeCalibration` (probability buckets with predicted vs actual win rate)
  - `computeSignalIC` (Pearson correlation per signal)
  - `computeEdgeDecay` (weekly buckets + linear regression)
  - `computeWinRateHeatmap` (hour × category)
  - `computePnlDistribution` (20-bin histogram)
- `netlify/functions/edge-tracker/mock-trades.mts` – 100-trade mock generator for empty-state
- Filter support: `mode=paper|live|both`, `category=all|crypto|weather`, `days=7|30|90|all`
- Extended `ClosedTrade` type with: `category`, `predictedProb`, `marketPriceAtEntry`, `edgeAtEntry`, `signalBreakdown`
- Auto-trader wire-up: crypto and weather modules now populate trade metadata on close

**Added – Frontend**

- `src/components/EdgeTrackerPanel.tsx` – Main Edge Tracker UI (~600 lines, single file)
  - FilterBar (mode/category/days chip rows)
  - 6 KPI cards (Total PnL, Win Rate, Sharpe, Avg Edge, Max DD, Kelly Efficiency)
  - Chart 1: Cumulative PnL (SVG, 3 lines)
  - Chart 2: Calibration scatter (SVG, 45° reference line)
  - Chart 3: Signal IC horizontal bars (CSS grid, significance threshold marker)
  - Chart 4: Edge Decay weekly line + linear regression
  - Chart 5: Win Rate Heatmap (hour × category CSS grid)
  - Chart 6: PnL Distribution histogram
  - Recent trades table (last 50)
- No external chart library – all SVG/CSS native
- Min-trade-count warning (< 20 trades)
- Mock data banner when sessions are empty

**Changed**

- `src/components/CategoryDashboard.tsx` – Added Edge Tracker tab for crypto + weather categories

---

## [0.2.0] – 2026-04-13

### UI Restructuring + Weather Module

**Added**

- 5-category HomePage (`/`) with Crypto/Weather AUTO + Sports/Politics/Macro ALERT
- Dynamic route `/trade/[category]` with tab bar per category
- `/tools` route with legacy Dashboard tabs
- DashboardShell shared component with localStorage bankroll persistence
- Full Weather Auto-Trader module:
  - `auto-trader/weather/station-config.mts` – 10 city ICAO mapping with city offsets
  - `auto-trader/weather/metar-simulator.mts` – Fahrenheit rounding bias correction (10/10 unit tests pass)
  - `auto-trader/weather/forecast-engine.mts` – GFS + ECMWF + NOAA ensemble with cloud-cover weighting
  - `auto-trader/weather/model-lag-detector.mts` – 6h model cycle lag window detection
  - `auto-trader/weather/bucket-matcher.mts` – Normal distribution bucket probability matching
  - `auto-trader/weather/decision-engine.mts` – Edge 12%, confidence 65%, 45min auto-exit
  - `auto-trader/weather/index.mts` – Main weather trading loop
- `WeatherTrader.tsx` UI component
- `auto-trader-api.mts` non-scheduled wrapper (bypasses Netlify CLI scheduled-function quirk)

**Changed**

- `auto-trader/index.mts` – Added `category` param routing; weather branch delegates to `runWeatherTrader`

---

## [0.1.0] – 2026-04-12

### Sprint 1: Crypto Execution Core

**Added – Backend (Netlify Functions)**

- `auto-trader/index.ts` – Main entry point with action router (run/status/reset/stop)
- `auto-trader/crypto/btc-market-finder.ts` – Gamma API BTC up/down market discovery
- `auto-trader/crypto/signal-aggregator.ts` – EdgeCalc signal-combiner integration with individual fallback
- `auto-trader/crypto/decision-engine.ts` – Edge threshold (15% net), Kelly cap (20%), cooldown (300s), session loss limit
- `auto-trader/crypto/execution.ts` – @polymarket/clob-client order placement (BUY/SELL GTC + FOK)
- `auto-trader/crypto/order-lifecycle.ts` – Buy fill polling, GTC sell → emergency FOK sell chain
- `auto-trader/crypto/session-manager.ts` – Netlify Blobs state persistence, PnL tracking
- `auto-trader/shared/types.ts` – 15+ TypeScript interfaces (Market, Signal, Decision, Session, Order, Log)
- `auto-trader/shared/config.ts` – Environment variables, API endpoints, IC weights, CORS
- `auto-trader/shared/logger.ts` – NDJSON event logger with buffer
- `auto-trader/shared/telegram.ts` – Telegram Bot API alerts (trade open/close, session stop, error)
- Sprint 2/3/4 placeholder stubs (sports, politics, macro)

**Added – Frontend (React)**

- `src/components/trader/CategorySelector.tsx` – 4-category strategy picker (Crypto active, others disabled)
- `src/components/trader/CryptoTrader.tsx` – Crypto trader dashboard with session stats, controls, run results
- `src/components/trader/TraderStatus.tsx` – Category → trader view router

**Added – Infrastructure**

- `@polymarket/clob-client` dependency (v5.x, includes viem)
- `@polymarket/real-time-data-client` dependency (v1.x)
- `@types/node` dev dependency
- Netlify cron schedule: `*/3 * * * *` for auto-trader function
- Paper mode as default (`PAPER_MODE=true`)

**Added – Documentation**

- `internal-docs/README.md` – Full architecture documentation
- `internal-docs/CHANGELOG.md` – This file
- `internal-docs/roadmap.md` – Sprint roadmap

**Changed**

- `netlify.toml` – Added auto-trader scheduled function config

**Removed**

- Old EdgeCalc Dashboard `internal-docs/README.md` (replaced with auto-trader architecture)
- Old EdgeCalc Dashboard `internal-docs/STATUS.md` (superseded)
- Old EdgeCalc Dashboard `internal-docs/roadmap.md` (replaced with auto-trader roadmap)

### Key Design Decisions

1. **Signal layer reuse** – All 6 EdgeCalc signal endpoints are consumed as-is, not rewritten
2. **Paper mode default** – Live trading requires explicit `PAPER_MODE=false`
3. **Fee-aware edge** – 3.6% roundtrip fee deducted before edge comparison
4. **Session isolation** – Paper and live sessions stored in separate Netlify Blobs keys
5. **Serverless execution** – Runs as Netlify scheduled function, no persistent process needed
