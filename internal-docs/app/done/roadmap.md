# EdgeCalc Auto-Trader – Roadmap

---

## Sprint 1: Crypto Execution Core ← DONE

**Status:** Implementation complete, paper testing pending

### Completed
- [x] Project setup (types, config, shared modules)
- [x] BTC market finder (Gamma API)
- [x] Signal aggregator (signal-combiner integration)
- [x] Decision engine (edge threshold, Kelly cap, cooldown)
- [x] Execution layer (clob-client, paper mode)
- [x] Order lifecycle (fill polling, emergency sell)
- [x] Session manager (Netlify Blobs, PnL)
- [x] Telegram alerts
- [x] NDJSON logger
- [x] Main entry point + category router
- [x] CategorySelector UI
- [x] CryptoTrader dashboard UI
- [x] Architecture documentation

### Remaining (before live)
- [ ] Paper mode: 10+ trading cycles without errors
- [ ] Telegram bot setup and alert testing
- [ ] Session loss limit trigger test
- [ ] Deploy to Netlify and verify cron execution
- [x] Dashboard integration (auto-trader tab added to main Dashboard)

---

## Weather Module ← DONE

- [x] Settlement station config (10 cities, ICAO + city offsets)
- [x] METAR Fahrenheit rounding simulator
- [x] Forecast engine (GFS + ECMWF + NOAA ensemble)
- [x] Model lag detector (6h cycles)
- [x] Bucket matcher (normal distribution)
- [x] Decision engine (edge 12%, confidence 65%)
- [x] WeatherTrader UI

---

## Edge Tracker Tab ← DONE

- [x] `ClosedTrade` extension with signal metadata
- [x] Auto-trader wire-up (crypto + weather populate trade context)
- [x] Mock trade generator (100 trades)
- [x] Statistics module (Summary, Calibration, Signal IC, Edge Decay, Heatmap, Distribution)
- [x] `edge-tracker.mts` Netlify Function with filter support
- [x] EdgeTrackerPanel UI with 6 KPI cards + 6 SVG/CSS charts
- [x] Integration into Crypto + Weather CategoryDashboard

---

## Sprint 2: Sports Alerts

**Target:** Alert-based system for sports betting markets

- [ ] Stats data source integration (NBA, NFL, Premier League)
- [ ] Form analysis + head-to-head model
- [ ] Home advantage adjustments
- [ ] Fan/narrative bias detection
- [ ] Edge threshold: 8% (lower fees: 0.6%)
- [ ] Alert-only mode (no auto-execution)

---

## Sprint 3: Politics Alerts

**Target:** LLM-powered political market analysis

- [ ] Poll aggregation pipeline
- [ ] Claude API news sentiment analysis (already integrated)
- [ ] Slow-market timing strategy
- [ ] Alert-only mode

---

## Sprint 4: Macro/Other

**Target:** Weather, Fed, economic indicator markets

- [ ] Open-Meteo API weather data
- [ ] Fed meeting calendar integration
- [ ] CPI/economic indicator schedule
- [ ] Threshold alert system

---

## Post-Sprint: Production Hardening

- [ ] Trade logging to Supabase (persistent history)
- [ ] IC calibration after 50+ trades
- [ ] WebSocket real-time VWAP scanner
- [ ] Multi-market portfolio optimization
- [ ] Trade history UI tab (Tab 12)
- [ ] Risk dashboard with drawdown charts
- [ ] Backtesting framework
