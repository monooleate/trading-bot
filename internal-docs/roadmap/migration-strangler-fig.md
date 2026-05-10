# EdgeCalc — Migration Plan (Netlify → Hetzner VPS)

> **Dátum:** 2026-04-24
> **Cél:** Lépésről-lépésre átköltöztetés a jelenlegi Netlify Functions architektúráról saját VPS-re. Minden Netlify Function → VPS process / endpoint mapping, prioritás szerint sorba rendezve.
> **Filozófia:** **Strangler Fig pattern** — nem big-bang refactor, hanem fokozatos kiváltás. A Netlify rendszer **végig fut paralel**, amíg az új rendszer minden funkcióját átveszi.

---

## 0. Migration alapelvek

1. **Strangler Fig**: az új rendszer modulonként veszi át a forgalmat, a régi addig fut. Mindkét rendszer ugyanazt a Postgres trade history-t írja a comparability miatt.
2. **Paper-first**: minden átköltöztetett pillér **minimum 100 paper trade**-en igazol a VPS-en, mielőtt live forgalomra kapcsoljuk.
3. **Pilléres izoláció**: egy pillér átállítása nem érinti a többit.
4. **Reverzibilitás**: minden fázisban van rollback path (DNS visszaállítás vagy PM2 stop).
5. **Read-before-write**: először a read-only signal layer költözik, csak utána az execution.
6. **Az architecture.md jelenlegi 4 Sprint state-jét megőrizzük** — a v0.6.0 auto-trader funkcionalitás **1:1 átkerül**, nem írjuk újra.

---

## 1. Komponens-térkép (jelenlegi → új)

### Frontend

| Jelenlegi (Netlify) | Új (VPS) | Megjegyzés |
|---|---|---|
| Astro static build → Netlify CDN | Astro build → Caddy file_server | 1:1, csak deploy target változik |
| `src/pages/index.astro` | ugyanaz | HomePage marad |
| `src/pages/tools.astro` | ugyanaz | /tools dashboard marad |
| `src/pages/trade/[category].astro` | ugyanaz | /trade/* útvonalak maradnak |
| `src/components/*` | ugyanaz | UI komponensek 1:1 átkerülnek |
| `src/styles/global.css` (CSS var system) | ugyanaz | Design system marad |

**Változás**: az API hívások base URL-je `<site>/.netlify/functions/` → `https://api.edgecalc.jmeszaros.dev/api/`. Ezt egy `import.meta.env.PUBLIC_API_BASE` env var-ral oldjuk meg, hogy mindkét deploy target-en működjön.

### Netlify Functions → VPS processes

A jelenlegi 16 function + 1 scheduled function az alábbi módon kerül VPS-re:

#### Csoport A: SHARED INFRASTRUCTURE (új processzek, nincs Netlify párja)
| Új VPS process | Port | Mit csinál | Indok |
|---|---|---|---|
| `binance-ws-collector` | 7501 | Binance public WebSocket → Redis pub/sub | **Új**, eddig REST poll volt scheduled-scan-ben |
| `polymarket-feed` | 7502 | Polymarket CLOB book/trade WS → Redis | **Új**, eddig REST poll |
| `hyperliquid-feed` | 7503 | HL WS feed → Redis | **Új**, eddig REST |
| `bybit-feed` | 7504 | Bybit WS feed → Redis | **Új**, latency-arb pillérnek + funding arb-nak |

**Miért újak**: a Netlify Functions 15s timeout miatt persistent WS impossible volt. VPS-en **ezek a hot path foundation**.

#### Csoport B: SIGNAL LAYER (1:1 átírás)
| Netlify Function (.mts) | VPS process | Port | Migration típus |
|---|---|---|---|
| `signal-combiner.mts` | `signal/combiner/` | 7200 | 1:1 átírás, Redis cache |
| `vol-divergence.mts` | `signal/vol-divergence/` | (combiner hívja) | Beolvasztva combinerbe vagy külön module |
| `orderflow-analysis.mts` | `signal/orderflow/` | (combiner hívja) | 1:1 |
| `apex-wallets.mts` | `signal/apex-wallets/` | (combiner hívja) | 1:1 + **bug fix** (architecture.md 14.bug) |
| `cond-prob-matrix.mts` | `signal/cond-prob/` | (combiner hívja) | 1:1 |
| `vwap-arb.mts` | `signal/vwap-arb/` | (combiner hívja) | 1:1, később WS-alapra |
| `funding-rates.mts` | `signal/funding-rates/` | (combiner hívja) | **Bybit-elsődleges**, Binance fallback |
| `llm-dependency.mts` | `signal/llm-dependency/` | (combiner hívja) | 1:1, Claude API |
| `resolution-risk.mts` + `_resolution-risk.ts` | `signal/resolution-risk/` | 7201 | 1:1 |
| `polymarket-proxy.mts` | `signal/polymarket-proxy/` | (combiner-en belül) | Beolvasztva |
| `scheduled-scan.mts` | `signal/cache-warmer/` | Bun scheduler vagy cron | 1:1 logika |

#### Csoport C: AUTO-TRADER → PILLÉREK (refaktorálás)
A jelenlegi 3 motor (crypto, weather, hyperliquid) közvetlenül átkerül **3 pillér**-be, plusz **2 új pillér** (HL+Bybit funding arb, latency arb):

| Netlify (jelenlegi) | VPS pillér | Port | Migration típus |
|---|---|---|---|
| `auto-trader/crypto/` | `pillars/poly-crypto/` | 7101 | 1:1 + Postgres state, paper→live külön DB |
| `auto-trader/weather/` | `pillars/poly-weather/` | 7102 | 1:1 |
| `auto-trader/hyperliquid/` (directional) | `pillars/hl-directional/` | 7103 | 1:1 |
| `auto-trader/hyperliquid/funding-arb/` | `pillars/hl-bybit-arb/` | 7104 | **Refaktor**: Binance hedge → Bybit hedge |
| (NINCS jelenlegi) | `pillars/latency-arb/` | 7105 | **Új**: Binance signal → Bybit/Polymarket execution |
| `auto-trader.mts` (dispatcher + cron) | (megszűnik) | — | Pillérek saját loop-pal futnak, dispatcher fölösleges |
| `auto-trader-api.mts` (UI hívás) | Pillér saját HTTP API | per-pillar port | Per-pillér REST endpoint |

#### Csoport D: TOOLS API (1:1 átírás)
| Netlify Function | VPS process | Port |
|---|---|---|
| `polymarket-trade.mts` (manual trade) | `api/tools/polymarket-trade/` | 7400 |
| `bybit-trade.mts` (manual trade) | `api/tools/bybit-trade/` | 7400 |
| `binance-trade.mts` (manual trade) | `api/tools/binance-trade/` | 7400 |
| `trade-logger.mts` | `api/tools/trade-logger/` | 7400 |
| `edge-tracker.mts` + `edge-tracker/*` | `api/edge-tracker/` | 7300 |

#### Csoport E: AUTH (változás)
| Netlify | Új |
|---|---|
| `auth.mts` (login, JWT issue) | `api/auth/` (Caddy mögött) |
| `_auth-guard.ts` (helper) | `shared/lib/auth.ts` |
| `user-settings.mts` (Blobs prefs) | `api/user-settings/` (Postgres) |

---

## 2. Adatmigráció — Blobs → Postgres + Redis

A jelenlegi 11 Blobs store átkerül vagy Postgres-be (perzisztens) vagy Redis-be (cache):

| Blobs store | Cél | Indok |
|---|---|---|
| `polymarket-cache-v3` | **Redis** (1h TTL) | Cache, eldobható |
| `funding-cache-v3` | **Redis** (8h TTL) | Cache |
| `signal-combiner-v3` | **Redis** (3 perc TTL) | Cache |
| `resolution-risk-v1` | **Redis** (30 perc TTL) | Cache |
| `vol-divergence-v3`, `orderflow-v3`, `cond-prob-v3`, `apex-*-v3`, `vwap-arb-v3`, `llm-dep-v3` | **Redis** (signal-szerinti TTL) | Cache |
| `auto-trader-state` (session-ök) | **Postgres** (`pillar_state_<name>`) | Perzisztens state |
| `hyperliquid-session-v1` | **Postgres** (`pillar_state_hl_directional`) | Perzisztens |
| `hyperliquid-arb-session-v1` | **Postgres** (`pillar_state_hl_bybit_arb`) | Perzisztens |
| `weather-deb-v1` | **Postgres** (`weather_deb` táblá, per-city rolling MAE) | Perzisztens, 30-trade window |
| `trade-log-v1` | **Postgres** (`trade_log`) | Lecseréli a Blobs fallback-et a Supabase helyett |

### Migration script
`scripts/migrate-blobs-to-postgres.ts`:
```typescript
// Egyszer fut a Netlify env-en, kiolvassa az összes Blobs store-t,
// és Postgres connection-en betölti a VPS DB-be.
import { getStore } from '@netlify/blobs';
import { Pool } from 'pg';

const pg = new Pool({ connectionString: process.env.VPS_DATABASE_URL });

async function migrateSession(category: string) {
  const store = getStore('auto-trader-state');
  const session = await store.get(`auto-trader-session-${category}`, { type: 'json' });
  if (!session) return;
  
  await pg.query(
    `INSERT INTO pillar_state_${category} (state_key, state_value)
     VALUES ('session', $1)
     ON CONFLICT (state_key) DO UPDATE SET state_value = $1, updated_at = NOW()`,
    [JSON.stringify(session)]
  );
  
  // closedTrades → trade_log
  for (const trade of session.closedTrades || []) {
    await pg.query(
      `INSERT INTO trade_log (pillar, venue, mode, market_id, side, size, entry_price, exit_price, pnl_usd, opened_at, closed_at, signal_breakdown, predicted_prob, realized_outcome, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [`poly-${category}`, 'polymarket', trade.mode || 'paper', trade.marketId, trade.side, trade.size, trade.entryPrice, trade.exitPrice, trade.pnl, trade.openedAt, trade.closedAt, trade.signalBreakdown, trade.predictedProb, trade.realizedOutcome, trade.metadata || {}]
    );
  }
}

await migrateSession('crypto');
await migrateSession('weather');
// ... HL külön Blobs store
```

**Migráció időzítése**: a Netlify rendszer **lefagyasztva** (paper mode, nincs új trade), majd 1x futtatás. Időtartam: 5-10 perc.

---

## 3. Migráció fázisokra bontva

### **FÁZIS 0 — Előkészítés** (1 hét)

**Cél**: VPS készenálljon, semmi nem fut még rajta.

```
□ Hetzner CCX23 felvétel Falkenstein DC
□ Ubuntu 24.04 install + base hardening (infrastructure.md §2)
□ Postgres + Redis + Caddy + Bun + Node.js + PM2 install
□ Database schema migration (init.sql)
□ DNS setup: edgecalc.jmeszaros.dev + api.edgecalc.jmeszaros.dev
□ Caddy auto HTTPS sikeres első cert (Let's Encrypt)
□ SSH csak public key, root disabled, fail2ban aktív
□ Telegram bot setup, OPS channel ID
□ Repo clone /home/edgecalc/edgecalc/, üres .env (csak DB + Redis)
□ Smoke test: bun --version, psql -U edgecalc, redis-cli ping, curl https://edgecalc.jmeszaros.dev (404 még OK)
```

**Rollback**: Hetzner gép törlése, DNS visszaállítás. Költség: ~€2 (1 hét proráta).

---

### **FÁZIS 1 — Frontend + Tools API (read-only)** (1 hét)

**Cél**: a frontend és a 11 Tools tab átkerül VPS-re, a Netlify Functions még futnak párhuzamosan.

```
□ Astro frontend deploy (rsync + Caddy)
□ PUBLIC_API_BASE env var → https://api.edgecalc.jmeszaros.dev
□ Tools API processzek (api/tools/*) PM2-vel indít:
  □ polymarket-proxy → /api/tools/polymarket-proxy
  □ signal-combiner (read-only mode, no execution) → /api/signals/combiner
  □ Tools tabhoz tartozó signal endpoint-ok
□ Edge Tracker API (read-only stats) → /api/edge-tracker
□ Auth (JWT) PM2 process → /api/auth
□ DNS váltás: edgecalc.jmeszaros.dev → VPS Caddy
□ Régi Netlify URL (edgecalc.netlify.app) megmarad fallback-nek
□ Manual smoke test minden /tools tab UI-ról
□ 24h megfigyelés: error rate, response time
```

**Rollback**: DNS visszairányítás Netlify-ra (TTL miatt 5-30 perc).

**Mit nem csinálunk még**: trade execution, pillérek, scheduled tasks. Azok még Netlify-on futnak.

---

### **FÁZIS 2 — Signal layer teljes átköltöztetés** (1 hét)

**Cél**: az összes signal generálás VPS-en történik, a Netlify signal-combiner kikapcsolva.

```
□ binance-ws-collector PM2 process indít
  □ Subscribe: btcusdt@trade, ethusdt@trade, solusdt@trade
  □ Subscribe: btcusdt@depth20@100ms, ethusdt@depth20@100ms
  □ Subscribe: !forceOrder@arr (liquidation feed)
  □ Redis pub/sub publish: events:binance:btc:trade, etc.
  □ 24h stabilitás monitoring (uptime, msg/sec, restart count)
□ polymarket-feed PM2 process — CLOB book WS
□ hyperliquid-feed PM2 process
□ bybit-feed PM2 process (induláshoz BTC/ETH/SOL spot + perp)
□ Signal layer modulok refaktor: REST poll helyett Redis subscribe
  □ vol-divergence: Redis events:binance:btc:trade konzumál
  □ orderflow: events:polymarket:book:<token_id> konzumál
  □ ... (többi signal)
□ signal-combiner PM2 process indít, Redis cache (3 perc TTL)
□ resolution-risk PM2 process
□ Signal API endpoint-ok (/api/signals/*) tesztelése
□ /tools dashboard 11 tab végigtesztelése: minden ugyanazt mutatja, mint Netlify-on
□ 48-72h párhuzamos futás: Netlify signal-combiner + VPS signal-combiner
□ Eredmény-összevetés: ha < 5% eltérés a combined_probability értékekben, OK
□ Netlify signal-combiner cron OFF
```

**Rollback**: PM2 stop signal processzek + Netlify signal-combiner cron ON.

**Mit nyerünk**: a signal réteg már WS-driven, sub-second update. A pillérek (még Netlify-on) is ezeket az új gyorsabb signaleket konzumálják (HTTPS REST-en VPS-ről).

---

### **FÁZIS 3 — Pillér 1: Polymarket Crypto (paper)** (1 hét)

**Cél**: első pillér átköltöztetés, **csak paper mode**, párhuzamos futás Netlify crypto auto-trader-rel.

```
□ pillars/poly-crypto/ kód: 1:1 átírás auto-trader/crypto/-ből
  □ Postgres state I/O (helyett Blobs)
  □ 3 perces loop (Bun setInterval, helyett Netlify cron)
  □ Decision engine 7 gate ugyanaz
  □ Execution: viem + clob-client ugyanaz
  □ Lifecycle: GTC + FOK emergency ugyanaz
□ Telegram csatorna setup: TELEGRAM_CHAT_ID_POLY_CRYPTO
□ pillar-poly-crypto PM2 indít, PAPER_MODE=true
□ Netlify crypto auto-trader **paper mode-ban marad** (live OFF)
□ 1 hét párhuzamos paper futás
□ Trade comparison: VPS pillér vs Netlify auto-trader, ugyanazokra a market-ekre
  ugyanazokat a döntéseket hozza-e (95%+ egyezés cél)
□ Eltérés esetén: debug log + bug fix
□ 1 hét végén: VPS pillér 100+ paper trade, kalibráltan working → GO live signal
```

**Rollback**: PM2 stop pillar-poly-crypto. Netlify crypto auto-trader fut tovább.

---

### **FÁZIS 4 — Pillér 1 LIVE + Pillér 2 (poly-weather, paper)** (1 hét)

```
□ pillar-poly-crypto PAPER_MODE=false (LIVE!)
  □ BANKROLL_USD=200 (kis tét induláshoz)
  □ SESSION_LOSS_LIMIT=20
  □ Netlify crypto auto-trader STOP (cron OFF + scheduled function disable)
□ 24h éles megfigyelés, Telegram alertek figyelése
□ Párhuzamosan: pillar-poly-weather kód átírás
□ pillar-poly-weather PM2 indít, PAPER_MODE=true
□ 1 hét paper futás Weather pilléren
```

**Live Phase 1 KPI**: első 7 napon nem haladja meg az -10% session loss-ot. Ha igen → vissza paper-be, debug.

---

### **FÁZIS 5 — Pillér 2 LIVE + Pillér 3 (hl-directional, paper)** (1 hét)

```
□ pillar-poly-weather LIVE
□ pillar-hl-directional kód, PAPER_MODE=true
  □ HL WS feed integration (hyperliquid-feed)
  □ Volatility gate (Binance feed-ből)
  □ Per-coin Kelly sizing
□ 1 hét paper futás
```

---

### **FÁZIS 6 — Pillér 3 LIVE + Pillér 4 (hl-bybit-arb, paper)** (2 hét)

**Új komplexitás**: a funding arb átírása Binance spot → Bybit spot.

```
□ pillar-hl-directional LIVE
□ pillar-hl-bybit-arb fejlesztés:
  □ HL perp short leg: változatlan (auto-trader/hyperliquid/funding-arb/-ből)
  □ Bybit spot long leg: ÚJ adapter (helyett Binance HMAC-SHA256)
    □ Bybit V5 REST + sign (HMAC-SHA256, eltérő format mint Binance!)
    □ Spot order placement, cancel, balance check
    □ Funding fetch: Bybit V5 funding history endpoint
  □ atomic two-leg open/close: ugyanaz (fr-executor.mts logika)
  □ auto-unwind partial failure: ugyanaz
□ Bybit testnet smoke test: spot buy 5 USDT, sell, balance check
□ Bybit mainnet smoke test: ugyanaz, kis méret
□ 2 hét paper futás (funding rates ritkán változnak gyorsan, kell idő)
□ Funding accrual matek validation: várt vs realized funding bevétel
```

**Új env var-ok**:
```env
BYBIT_API_KEY=                   # közös kulcs
BYBIT_API_SECRET=
BYBIT_TESTNET=false
HL_BYBIT_ARB_FEE_BYBIT_SPOT=0.002  # roundtrip Bybit spot fee
```

**Régi env var-ok TÖRÖL**:
```env
# BINANCE_API_KEY              # spot leg már nem kell Binance-en
# BINANCE_API_SECRET
# BINANCE_TESTNET
# FR_FEE_ROUNDTRIP_BINANCE     # → HL_BYBIT_ARB_FEE_BYBIT_SPOT
```

---

### **FÁZIS 7 — Pillér 4 LIVE + minden Netlify Function OFF** (1 hét)

```
□ pillar-hl-bybit-arb LIVE (kis bankroll induláshoz, $100-150)
□ Az összes Netlify scheduled function disable
□ Az összes Netlify Function átirányítva: 503 Service Migrated → új URL
□ Netlify deploy: csak Astro frontend (ha még tartjuk fallback-nek)
  Vagy: Netlify projekt teljes törlése (egyszerűbb)
□ DNS-szel csak VPS, fallback nélkül
□ Edge Tracker UI ellenőrzés: minden adat Postgres-ből jön, minden pillér megjelenik
□ Postgres backup verify (első valós backup)
```

**Ettől a ponttól**: a rendszer **100% VPS-en fut**, Netlify nincs.

---

### **FÁZIS 8 — Pillér 5: Latency Arb (új, paper)** (2-3 hét)

**Ez a leírt új stratégia**: Binance WS event → Bybit/Polymarket execution sub-second.

**Phase 8a — paper mode, csak proof-of-concept**:
```
□ pillars/latency-arb/ kód:
  □ Subscribe: events:binance:btc:trade (Redis pub/sub)
  □ Trade event → calculate Binance implied probability for short-term Polymarket BTC up/down market
  □ Fetch Polymarket CLOB book for matching market (cached, < 200ms)
  □ Calculate edge: |binance_implied_prob - polymarket_price| > min_edge_bps
  □ Decision: paper trade simulation (latency includes!)
□ Per-decision logging: timestamp_binance_event, timestamp_decision, timestamp_order_placed,
  timestamp_market_resolved, edge_at_decision, edge_at_resolution, pnl
□ KPI mérés: how many opportunities/day, avg edge, median latency
□ 2-3 hét paper futás, statisztika gyűjtés
```

**Decision criterion live-ra váltáshoz**:
- 100+ paper "trade", win rate > 55%, avg PnL > 0
- Median decision latency < 500ms
- Nincs technical glitch (lost connection, missed event)

**Ha a paper KPI-k nem győzik meg → felfüggesztjük a pillért**. Ez egy spekulatív stratégia, és csak akkor megy live-ba, ha bizonyít.

**Phase 8b — live, ha bizonyít**:
```
□ Bybit spot/perp execution adapter (ha még nincs az hl-bybit-arb-ből)
□ Vagy Polymarket CLOB execution (ha ott jobb az edge)
□ LATENCY_ARB_BANKROLL_USD=100 (legkisebb, mert legkevesebb track record)
□ MAX_POSITION_USD=20 (még kisebb pozíciók)
□ MAX_HOLD_SECONDS=10 (gyors ki-be, nem buy-hold)
□ Live első hét: napi review minden trade-ről
```

---

### **FÁZIS 9 — Konszolidáció + post-mortem** (1-2 hét)

```
□ 5 pillér mind live, vagy "paused" státuszban dokumentálva
□ Edge Tracker: minden pillér valós trade-ekkel, calibration plot per-pillar
□ IC kalibrálás futtatás: 50+ trade → recalibrate signal IC
□ Per-pillér PnL review: mit tartunk, mit állítunk le, mit méretezünk fel
□ Post-mortem dokumentum: mi ment jól, mi ment rosszul, mit változtatnánk
□ Backup + DR teszt: 1 manual snapshot restore új VPS-re, working
```

---

## 4. Migráció időzítés (összesen)

| Fázis | Idő | Cumulative |
|---|---|---|
| 0. Előkészítés | 1 hét | 1 hét |
| 1. Frontend + Tools | 1 hét | 2 hét |
| 2. Signal layer | 1 hét | 3 hét |
| 3. Pillér 1 (poly-crypto, paper) | 1 hét | 4 hét |
| 4. Pillér 1 LIVE + Pillér 2 paper | 1 hét | 5 hét |
| 5. Pillér 2 LIVE + Pillér 3 paper | 1 hét | 6 hét |
| 6. Pillér 3 LIVE + Pillér 4 paper | 2 hét | 8 hét |
| 7. Pillér 4 LIVE + Netlify OFF | 1 hét | 9 hét |
| 8. Pillér 5 (latency-arb) | 2-3 hét | 11-12 hét |
| 9. Konszolidáció | 1-2 hét | 12-14 hét |

**Reális becslés: 3 hónap a teljes migráció + új pillér.** Ez akkor, ha párhuzamosan dolgozol más projekteken is (Grabit, klimamfc, stb.). Csak EdgeCalc-ra fókuszálva 6-8 hét.

---

## 5. Risk register (mi mehet rosszul)

| Kockázat | Valószínűség | Hatás | Mitigation |
|---|---|---|---|
| Postgres data loss migráció közben | LOW | HIGH | Pre-migration backup, Postgres dump verify |
| Pillér viselkedés-eltérés VPS vs Netlify | MEDIUM | MEDIUM | Párhuzamos paper futás 1 hét, comparison script |
| Bybit API HMAC sign bug (új code) | MEDIUM | HIGH | Testnet-en alapos tesztelés, kis size live induláskor |
| Hetzner DC downtime | LOW | HIGH | Snapshot heti, restore-mást-DC-ben tesztelve |
| WebSocket disconnect race condition | MEDIUM | MEDIUM | Reconnect logic + heartbeat + dead man's switch |
| API key kompromittálás (rsync hiba .env-vel) | LOW | CRITICAL | .env soha nem rsync-ben, manual SSH másolás, Vault later |
| Live első napon nagy loss | MEDIUM | MEDIUM | Kicsi bankroll + tight session loss limit első héten |
| Costs runaway (Anthropic API) | LOW | LOW | Per-day spend cap monitoring, alert > $5/day |

---

## 6. Mit NE csinálj migráció közben

- **Új feature fejlesztés** — fagyasztva a migráció ideje alatt, kivéve a Bybit adapter (az kell)
- **Refactor "amíg úgyis átírom"** — strangler fig = 1:1 átírás, semmi extra
- **Több pillért egyszerre live** — egyenként, megfigyeléssel
- **Skip paper mode-ot** — soha, még ha "mégis ugyanaz a kód" érzed
- **DNS TTL max** — migráció előtt 1 héttel TTL-t csökkentsd 300s-re, hogy gyors rollback legyen
- **Big-bang cut-over** — soha, mindig overlap window

---

## 7. Sikerkritérium (mit jelent "kész migráció")

```
✓ 5 pillér mind PM2-vel fut, auto-restart on crash
✓ Postgres trade history minden pillér adatát tartalmazza
✓ Edge Tracker UI minden pillért külön kategóriaként mutat
✓ Per-pillér PnL, win rate, calibration plot working
✓ Telegram alertek minden pillérre + OPS-ra working
✓ Caddy HTTPS auto-renewal working (3 hónap után verify)
✓ Backup script lefutott legalább 30x napi cron-on, 1 restore tesztelve
✓ Postgres dump file méret monitoring (< 100MB induláshoz, growth tracking)
✓ Netlify projekt törölve vagy minimal frontend-only fallback marad
✓ Architecture.md frissítve "v9 — VPS migration complete" verzióra
✓ Új CLAUDE.md → VPS workflow, PM2 commands, deploy script reference
```

---

**Következő dokumentum**: `risk-coordinator.md` — bár pilléres modellt választottál (és NEM építünk koordinátort), érdemes dokumentálni mit ad fel ezzel és mikor érdemes később bevezetni.
