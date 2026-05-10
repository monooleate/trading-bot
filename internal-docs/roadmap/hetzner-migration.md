# Hetzner VPS Migrációs Action Plan

> **Olvasás sorrend:** ezt a fájlt egy következő session-nek készítettük el.
> A meglévő `internal-docs/roadmap/` doksik (`hetzner-infrastructure.md`,
> `migration-strangler-fig.md`, `risk-coordinator-considerations.md`) megtartják az érvényüket —
> ez a plan a **konkrét, EdgeCalc-specifikus** lépéseket írja le, amiket
> egy implementáló sessionben sorrendben végre lehet hajtani.

---

## Context

Az EdgeCalc Hyperliquid + Funding Arbitrage modulok jelenleg
**Netlify Functions-ként léteznek** (`netlify/functions/auto-trader/hyperliquid/*`,
`netlify/functions/auto-trader/hyperliquid/funding-arb/*`), de éles
deployment sehol nem fut — minden paper mode.

**Probléma a Netlify-on:**
- 10 másodperces serverless timeout → atomic 2-leg HL+Binance hedge megbízhatatlan
- Cold start kezelés → in-memory session state minden hívásnál elveszik
- Nincs 24/7 WebSocket → fillCallback és real-time order lifecycle nem működik
- A P2.2 (Binance/PM divergencia detektor) és P3.3 (LP refresh window
  execution) **definíció szerint sosem fog futni Netlify-on** — folyamatos
  WS feed kell

**Cél:** Hetzner VPS-en futó execution layer, Netlify-on maradó signal
layer + frontend, közöttük HMAC-aláírt webhook bridge.

---

## Architektúra a migráció után

```
NETLIFY (signal réteg + UI, ingyenes — marad)
  ├─ Cron 3 percenként:
  │   /signal-combiner    → IR = IC × √N → final_prob + kelly
  │   /resolution-risk    → settlement risk filter
  │   /trader-settings    → runtime override Blobs
  ├─ Frontend (Astro + React)
  └─ Ha edge > threshold → HMAC webhook → Hetzner

HETZNER CX22 (€4/hó) vagy CCX23 (€43/hó, 4 vCPU, 16GB)
  ├─ PM2: edgecalc-hl-execution     ← /hyperliquid/* port
  ├─ PM2: edgecalc-funding-arb      ← /hyperliquid/funding-arb/* port
  ├─ PM2: edgecalc-divergence-ws    ← P2.2 új
  ├─ PM2: edgecalc-lp-refresh       ← P3.3 új
  ├─ PM2: edgecalc-webhook-receiver ← Netlify signal befogadás
  ├─ PM2: edgecalc-telegram-bot     ← /status /stop /pause /resume
  ├─ Postgres 16:    sessions, fills, positions, audit log
  ├─ Redis 7:        kill switch flag, real-time state
  └─ Caddy:          edgecalc.jmeszaros.dev TLS

POLYMARKET, BINANCE, HYPERLIQUID  ← unchanged execution targets
```

---

## Fázis 1 — VPS setup (1 nap)

**Cél:** működő Hetzner instance Bun + PM2 + Caddy + Postgres + Redis stackkel.

**Sizing döntés:**
- **CX22** (€4/hó, 2 vCPU, 4GB) — elég, ha csak HL execution + funding arb
- **CCX23** (€43/hó, 4 vCPU, 16GB) — javasolt a P2.2 + P3.3 új modulokkal
  együtt (4-6 párhuzamos WebSocket feed: Binance kline_1s, Coinbase L2,
  Polymarket CLOB, Hyperliquid + esetleg Bybit)

**Tennivaló:**
1. `migration/reference/VPS-SETUP_detailed_done_26-04-03.md` lépéseit
   végrehajtani (Ubuntu 24.04, SSH hardening, UFW, fail2ban, Caddy,
   needrestart kernel flag)
2. `apt install -y postgresql redis-server`
3. Bun: `curl -fsSL https://bun.sh/install | bash`
4. PM2: `npm i -g pm2 && pm2 startup`
5. DNS: Cloudflare A record `edgecalc.jmeszaros.dev` és
   `api.edgecalc.jmeszaros.dev` → VPS IP
6. Caddy reverse proxy `:443 → :7100` (api.edgecalc.jmeszaros.dev)

**.env template Hetzner-en (`/etc/edgecalc.env`):**
```
# Crypto
HL_PRIVATE_KEY=
HL_TESTNET=true            # Fázis 7 cutover-ig kötelezően true
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_TESTNET=true

# Polymarket
POLYMARKET_PRIVATE_KEY=    # csak ha Hetzner-ről redeem-elünk; addig localhostról
POLYMARKET_PROXY_ADDRESS=

# Postgres
POSTGRES_URL=postgres://edgecalc:strong_pw@localhost/edgecalc

# Redis
REDIS_URL=redis://localhost:6379/0

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Webhook auth (Netlify → Hetzner)
WEBHOOK_HMAC_SECRET=       # 32+ karakter random; ugyanez a Netlify env-ben

# Risk
PAPER_MODE=true            # default true; cutover criteria teljesülése után false
SESSION_LOSS_LIMIT_USD=50
DAILY_LOSS_LIMIT_USD=200
```

**Out:** Hetzner instance fut, `ssh edgecalc@…` működik, `psql`/`redis-cli` készen.

---

## Fázis 2 — HL execution port (2-3 nap)

**Cél:** `netlify/functions/auto-trader/hyperliquid/*` átírva Bun-ra,
PM2-n futó hosszú életű process.

**Repo struktúra (új mappa Hetzneren `~/edgecalc-execution/`):**
```
edgecalc-execution/
├── package.json
├── pm2.config.cjs
├── src/
│   ├── hl/
│   │   ├── index.ts             ← bun entrypoint
│   │   ├── hl-client.ts         ← változtatás minimális
│   │   ├── signal-source.ts     ← webhook receiver-ből táplálkozik
│   │   ├── decision-engine.ts
│   │   ├── kelly-sizer.ts
│   │   ├── volatility-gate.ts
│   │   ├── order-manager.ts     ← fillCallback WS-en
│   │   └── session-manager.ts   ← Postgres backed
│   ├── shared/
│   │   ├── postgres.ts
│   │   ├── redis.ts
│   │   ├── webhook-auth.ts      ← HMAC verify
│   │   └── telegram.ts
│   └── webhook-receiver/
│       └── index.ts             ← Hono / native HTTP, port 7100
└── migrations/
    └── 001_init_hl.sql
```

**Postgres séma:**
```sql
CREATE TABLE hl_sessions (
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  bankroll_start NUMERIC NOT NULL,
  paper_mode BOOLEAN NOT NULL,
  stopped BOOLEAN DEFAULT FALSE,
  stopped_reason TEXT
);
CREATE TABLE hl_positions (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES hl_sessions(id),
  coin TEXT NOT NULL,
  direction TEXT NOT NULL,    -- LONG | SHORT
  size_coins NUMERIC NOT NULL,
  entry_price NUMERIC NOT NULL,
  tp_price NUMERIC,
  sl_price NUMERIC,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  exit_price NUMERIC,
  pnl NUMERIC
);
CREATE TABLE hl_fills (
  id UUID PRIMARY KEY,
  position_id UUID REFERENCES hl_positions(id),
  side TEXT NOT NULL,
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  fee NUMERIC,
  ts TIMESTAMPTZ NOT NULL
);
```

**Webhook szerződés (Netlify → Hetzner):**
```
POST https://api.edgecalc.jmeszaros.dev/webhook/hl-signal
Headers:
  Content-Type: application/json
  X-Edgecalc-Timestamp: <unix ms>
  X-Edgecalc-Signature: hex(HMAC-SHA256(secret, timestamp + "." + body))
Body:
{
  "kind": "hl_signal_v1",
  "coin": "BTC",
  "direction": "LONG",
  "finalProb": 0.62,
  "kellyFraction": 0.04,
  "edge": 0.08,
  "ttlMs": 60000
}
```

**Replay-protection:** timestamp ±60s window + Redis nonce set 5 min TTL.

**Acceptance criteria:**
- [ ] `pm2 status` → `edgecalc-hl-execution` `online`
- [ ] HL testnet WebSocket fillCallback működik (open + auto-close paper trade)
- [ ] Postgres: 10+ paper position rögzítve teljes lifecycle-lel
- [ ] Webhook signature mismatch → 401, korrekt aláírás → 202

---

## Fázis 3 — Funding arb port (2-3 nap)

**Cél:** `netlify/functions/auto-trader/hyperliquid/funding-arb/*` átköltöztetése.

**Új PM2 process:** `edgecalc-funding-arb` (külön a HL execution-tól, mert
külön bankroll allokációja és külön kill switch flagje van).

**Postgres séma:**
```sql
CREATE TABLE fr_sessions (
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ,
  bankroll_allocated NUMERIC,
  paper_mode BOOLEAN
);
CREATE TABLE fr_positions (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES fr_sessions(id),
  coin TEXT,
  hl_side TEXT,           -- SHORT
  binance_side TEXT,      -- LONG (spot hedge)
  hl_size NUMERIC,
  binance_size NUMERIC,
  hl_avg_price NUMERIC,
  binance_avg_price NUMERIC,
  expected_apy NUMERIC,   -- annualized %
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  realized_pnl NUMERIC
);
```

**Atomic 2-leg open:**
1. Place HL SHORT IOC limit order
2. **HA HL fill OK** → place Binance spot BUY IOC
3. **HA Binance fail** → close HL SHORT immediately (slippage cap: 0.2%)
4. **HA HL fail** → no Binance side ever; abort
5. Both fills → write `fr_positions` row, mark active

A 10s Netlify timeout már nem akadály.

**Acceptance criteria:**
- [ ] 20+ paper open/close cycle, 0 hedge slippage anomaly
- [ ] Annualized PnL kalkuláció megegyezik a Netlify implementáció pretendált értékével
- [ ] Telegram alert minden open + close

---

## Fázis 4 — P2.2 Binance/PM Divergencia detektor (3-4 nap)

**Cél:** Új modul, ami **csak Hetzner-en valósítható meg** — folyamatos
WebSocket feed Binance + Polymarket CLOB.

**Új PM2 process:** `edgecalc-divergence-ws`

**Workflow:**
```
WS subscribe Binance:   wss://stream.binance.com:9443/ws/btcusdt@kline_1s
WS subscribe PM CLOB:   wss://ws-subscriptions-clob.polymarket.com/ws/market
                        → minden aktív BTC short market YES token

Tick handler (minden Binance kline):
  if |new_price - prev_price| > $50 ÉS Δt < 30 másodperc:
    PM YES árának vizsgálata az adott market-en
    if PM YES price még nem mozgott (lag > 2 másodperc):
      → divergence_event {market, direction, expected_pm_price, ttl: 2-3s}
      → Telegram alert (PAPER mode-ban csak alert, LIVE mode-ban auto-trigger)
      → írás Postgres-be: divergence_events tábla
```

**Postgres séma:**
```sql
CREATE TABLE divergence_events (
  id UUID PRIMARY KEY,
  detected_at TIMESTAMPTZ,
  market_slug TEXT,
  binance_price_jump NUMERIC,
  pm_price_at_event NUMERIC,
  expected_pm_price NUMERIC,
  ttl_ms INT,
  acted_on BOOLEAN DEFAULT FALSE,
  trade_id UUID REFERENCES hl_positions(id) -- ha auto-trigger volt
);
```

**Acceptance:**
- [ ] 50+ alert generálva 1 hét alatt
- [ ] False positive rate (utólagosan: PM nem konvergált a várt irányba) < 30%
- [ ] WS auto-reconnect <5s connection drop esetén

---

## Fázis 5 — P3.3 LP Refresh Window execution (5-7 nap)

**Cél:** Új modul az A.5 (LP Subgroup A/B) wallet-ek stale quote-jai ellen.

**Előfeltétel:** A.5 LP klasszifikáció működik, és van egy "confirmed LP wallet"
lista (Postgres-be töltve a `warproxxx/poly_data` Python script + apex-wallets
közös eredményéből).

**Új PM2 process:** `edgecalc-lp-refresh`

**Workflow:**
```
1. LP wallet fill stream:
   - Polymarket Data API /trades?proxyWallet=<lp> figyelése (poll 1s)
   - Vagy ideális esetben CLOB WS subscribe market-szinten + szűrés
2. Trigger: LP fill detektálva
3. Ellenőrzés:
   - Binance kline + Coinbase L2 az utolsó 8-15 másodpercben jelentős mozgást mutat
   - LP quote még nem frissült (price unchanged)
4. Action: hit the stale quote opposite side
   - Place GTC limit on the *other* side at the LP's stale price
   - Cancel after 8-15s window if not filled
5. Risk: SL -12c entry-től, daily cap -$400, no overnight
6. Kill switch: Redis flag `lp:killswitch` → minden új trigger blokkolva
```

**Telegram alert minden trigger + close-ra.**

**Acceptance:**
- [ ] 20+ paper trade, 0 risk-cap megsértés
- [ ] Average edge >5c (a master-plan hipotézis szerint)

---

## Fázis 6 — Telegram bot + monitoring (1-2 nap)

**Új PM2 process:** `edgecalc-telegram-bot`

**Library:** `grammy` (TypeScript-native, jól típusolt, Bun-kompatibilis)

**Parancsok:**
- `/status` — összes futó session összefoglaló (HL + funding-arb + divergence + lp-refresh)
- `/stop` — globális kill switch: minden process leáll a `lp:killswitch`
  Redis flag-en keresztül + új tradek tiltva
- `/pause` — csak új tradek tiltva, meglévők futnak tovább
- `/resume` — pause feloldása
- `/pnl` — napi PnL aggregátum minden modulra
- `/positions` — open positions listája

**Daily summary 07:00 CET:** előző 24h PnL, win rate, top winners/losers,
divergence event count.

**Globális kill switch implementáció:**
- Redis SET `kill:global=1` minden module előtt ellenőrzendő
- `/stop` parancs → SET kill:global=1, küld broadcastot minden processnek
  (Redis pub/sub `kill-channel`)
- Process restart-okra perzisztens (a fél szándékos manual `redis-cli DEL kill:global` kell a feloldáshoz)

**Acceptance:**
- [ ] `/stop` 3× egymás után → minden process azonnali stop
- [ ] Daily summary 7 napon át pontosan kalkulálódik

---

## Fázis 7 — Cutover validation (2 hét paper)

**Cél:** mielőtt PAPER_MODE=false, 2 hetes paper futás minden modulra.

**Cutover criteria checklist:**
- [ ] **HL execution:** 100+ paper trade complete, 0 fill mismatch (HL fill !=
      Postgres record)
- [ ] **Funding arb:** 20+ atomic 2-leg open/close, 0 hedge slippage anomaly,
      0 stranded leg
- [ ] **Divergence detektor:** 50+ alert, false positive rate <30%
- [ ] **LP refresh:** 20+ paper trade, average edge >5c, 0 risk-cap megsértés
- [ ] **Telegram bot:** kill switch teszt háromszor (azonnali stop minden modul)
- [ ] **Postgres backup:** napi pg_dump cron + 14 nap retention
- [ ] **Caddy TLS:** A+ rating SSL Labs-on
- [ ] **WAL-archiving:** Postgres WAL streaming bekapcsolva (S3 vagy másik VPS)
- [ ] **Webhook secret rotáció:** legalább 1× rotált a 2 hét alatt sikeresen
- [ ] **Disaster recovery proba:** simulated VPS halálesetból 30 perc alatt
      visszaállás új instancen (Postgres dump + git clone + .env)

**Csak ha mind teljesül → flip `PAPER_MODE=false` egy modulra egyszerre,
további 1 hét megfigyelés. Sorrend: Funding arb → HL execution → Divergence
→ LP refresh.**

---

## Out-of-scope (mégegy későbbi sessionnek)

- **Postgres replication** második VPS-re (HA setup) — csak ha napi PnL
  > $500 stabilan
- **Grafana / Prometheus** dashboardok — Telegram daily summary elég eleinte
- **Bybit execution venue** — a `migration-strangler-fig.md` említi, de nem kritikus
- **HLP Vault automatizálás** — manuális USDC deposit elég
- **Multi-region failover** — egy CX22 elég 99.5% uptime-hoz

---

## Implementáció priorizálás

| Fázis | Idő | Kritikusság | Megjegyzés |
|-------|-----|-------------|------------|
| 1 — VPS setup | 1 nap | KRITIKUS | nélküle semmi nem fut |
| 2 — HL port | 2-3 nap | KRITIKUS | fő ROI a serverless timeoutok megoldása |
| 3 — Funding arb port | 2-3 nap | MAGAS | atomic 2-leg most már stabil |
| 4 — Divergence WS | 3-4 nap | KÖZEPES | új edge forrás, paper-only először |
| 5 — LP refresh | 5-7 nap | KÖZEPES | előfeltétel: poly_data + A.5 confirmed |
| 6 — Telegram bot | 1-2 nap | MAGAS | risk control, kill switch |
| 7 — Cutover | 2 hét | KRITIKUS | live-ra váltás biztonsága |

**Teljes idő paper-ready állapotig:** ~3-4 hét egyszemélyes fejlesztéssel.

---

## Kapcsolódó már elkészült doksik

- `hetzner-infrastructure.md` — alacsonyabb szintű VPS spec (Postgres,
  Caddy, Bun verzió)
- `migration-strangler-fig.md` — 9 fázisos absztrakt strangler-fig terv
- `risk-coordinator-considerations.md` — miért NINCS cross-pillér koordinátor és
  mit kell helyette beépíteni (per-venue watchdog, HL 2 wallet, globális stop)
- `new-strategies.md` — 37 stratégia, top 11 a Hetzner utánra
- `../archive/grabit-vps-setup.md` — referencia setup script egy korábbi
  VPS-ről (CX22, ugyanazon stack)

Ezeket a Fázis 1 előtt egyszer át kell olvasni.
