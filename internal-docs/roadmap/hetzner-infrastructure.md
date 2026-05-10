# EdgeCalc — Infrastructure (Hetzner VPS layout)

> **Dátum:** 2026-04-24
> **Cél:** A Netlify-ról saját VPS-re költöztetett EdgeCalc rendszer infrastruktúra-specifikációja. Ez a dokumentum **a fizikai/logikai layer**: szerver, network, processzek, szolgáltatások, deploy pipeline.
> **Modell:** Pilléres (saját bankroll, saját kill switch pillérenként). Cross-venue risk koordinátor NINCS — minden pillér izolált.
> **Kapcsolódó docok:** `migration-strangler-fig.md`, `risk-coordinator-considerations.md` (csak referencia, nem implementáljuk), `new-strategies.md`

---

## 1. Szerver-választás

### Indulás (Phase 1, 0-3 hónap)

**Hetzner Cloud CCX23** — Falkenstein DC (FSN1)

| Paraméter | Érték |
|---|---|
| vCPU | 4 dedikált AMD EPYC |
| RAM | 16 GB DDR4 ECC |
| Storage | 160 GB NVMe SSD |
| Traffic | 20 TB / hó (bőven elég) |
| Backup | +20% (~€7/hó), automatikus napi |
| Ár | ~€36/hó + €7 backup = **~€43/hó** |

**Miért CCX23 (dedikált) és nem CX/CPX (shared)?**
- WebSocket loop-ok és latency-érzékeny code → **steady CPU access** kritikus
- Shared vCPU-n "noisy neighbor" probléma → unpredictable spike-ok latency-ben
- A CCX23 dedikált AMD EPYC mag, nincs CPU steal

**Miért Falkenstein (FSN1)?**
- Magyarországról ~25-30ms ping (Helsinki ~45ms, Nuremberg ~30ms — közel)
- Hetzner legnagyobb DC-je, hardware-pool legbővebb → snapshot/restore/upgrade gyors
- Frankfurt internet exchange közel → Polygon RPC, Bybit/Binance EU gateway-ek alacsony latency
- Olcsóbb mint Helsinki (zöldenergia premium nélkül)

### Skálázási útvonal (Phase 2, 3+ hónap)

Ha tényleg fut a rendszer és kinövöd:

**Hetzner Cloud CCX33** (8 vCPU / 32 GB RAM / 240 GB NVMe, ~€69/hó)
- Triggerek: ML pipeline pl. (XGBoost training), Postgres trade history > 50 GB, > 10 párhuzamos pillér
- Upgrade: snapshot → új gép → IP transfer → ~10 perc downtime

**Cross-region edge node** (opcionális, csak ha latency-arb pillér profitabilis):
- AWS Tokyo `t3.small` (~$15/hó) **csak** Binance WebSocket collector
- Wireguard VPN tunnel Hetzner-re, Redis pub/sub push events
- 80-120ms előny Binance event-en
- **NE építsd meg** amíg a paper trade nem igazolja az edge-et

---

## 2. OS és base setup

### OS
**Ubuntu 24.04 LTS** (Noble Numbat)
- LTS support 2029-ig
- Hetzner Cloud snapshot template natív
- systemd, journald, modern kernel (6.8+)

### Base packages
```bash
apt update && apt upgrade -y
apt install -y \
  curl wget git build-essential \
  ufw fail2ban unattended-upgrades \
  htop iotop nload tmux \
  postgresql-16 postgresql-contrib-16 \
  redis-server \
  caddy \
  python3-pip python3-venv \
  jq sqlite3
```

### User setup
```bash
# Trading user (nem root!)
useradd -m -s /bin/bash -G sudo edgecalc
mkdir -p /home/edgecalc/.ssh
# SSH key feltöltése (lokális gépedről):
# ssh-copy-id edgecalc@<vps-ip>
passwd -l root  # root login letiltása
```

### SSH hardening (`/etc/ssh/sshd_config.d/99-hardening.conf`)
```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers edgecalc
Port 22                    # Vagy custom port pl. 2222
ClientAliveInterval 300
ClientAliveCountMax 2
```

### Firewall (UFW)
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp           # SSH (vagy custom port)
ufw allow 80/tcp           # HTTP (Caddy → redirect HTTPS)
ufw allow 443/tcp          # HTTPS (Caddy)
# Postgres és Redis NEM publikus — csak localhost
ufw enable
```

### fail2ban
```bash
# /etc/fail2ban/jail.local
[sshd]
enabled = true
maxretry = 3
findtime = 600
bantime = 86400
```

### Automatikus security update
```bash
dpkg-reconfigure -plow unattended-upgrades
# Engedélyezd: csak security update auto, többi manuális
```

### Time sync (kritikus a latency-arb-hoz!)
```bash
apt install -y chrony
systemctl enable chrony
chronyc tracking            # ellenőrzés: < 10ms drift
```

---

## 3. Runtime — Bun + Node.js fallback

### Bun (elsődleges JS runtime)
**Bun v1.1+** — TypeScript-natív, 3-4x gyorsabb mint Node.js, beépített WebSocket client.

```bash
# Bun install (edgecalc user-ként)
curl -fsSL https://bun.sh/install | bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
bun --version              # >= 1.1
```

**Miért Bun és nem Node.js?**
- Natív TypeScript execution (nincs `tsx`/`esbuild` build step a fejlesztéshez)
- Beépített WebSocket client gyorsabb mint `ws` Node-on
- 30-50% kisebb memory footprint
- Process startup ~50ms (Node ~200ms)

**Mikor Node.js?**
- ccxt library (Bybit/Binance signing) — Bun-on működik, de Node.js stabilabb
- Néhány legacy CLI tool

```bash
# Node.js fallback (csak ha kell)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2
```

### Process manager: PM2

```bash
npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 30
pm2 startup systemd -u edgecalc --hp /home/edgecalc
```

**Miért PM2 és nem systemd közvetlenül?**
- Cluster mode, zero-downtime reload
- Beépített log management
- Process monitoring (`pm2 monit`) szebb mint `journalctl`
- `pm2 save` / `pm2 resurrect` snapshot-ölhető state

---

## 4. Adatrétegek

### PostgreSQL 16 (saját, lokális)

**Konfiguráció** (`/etc/postgresql/16/main/postgresql.conf`):
```ini
listen_addresses = 'localhost'           # NEM publikus!
port = 5432
max_connections = 100
shared_buffers = 4GB                     # 25% RAM
effective_cache_size = 12GB              # 75% RAM
work_mem = 64MB
maintenance_work_mem = 512MB
wal_buffers = 16MB
default_statistics_target = 100
random_page_cost = 1.1                   # NVMe SSD
effective_io_concurrency = 200           # NVMe SSD
checkpoint_completion_target = 0.9
synchronous_commit = on                  # trade log: data integrity > speed
```

**Database setup**:
```bash
sudo -u postgres psql
CREATE USER edgecalc WITH PASSWORD '...';
CREATE DATABASE edgecalc_prod OWNER edgecalc;
CREATE DATABASE edgecalc_paper OWNER edgecalc;  # paper mode külön DB
GRANT ALL PRIVILEGES ON DATABASE edgecalc_prod TO edgecalc;
GRANT ALL PRIVILEGES ON DATABASE edgecalc_paper TO edgecalc;
\q
```

**Backup stratégia** (két szintű):
1. **Logical backup (napi)**: `pg_dump edgecalc_prod | gzip > /backups/edgecalc_$(date +%F).sql.gz`
   - Cron: napi 03:00 UTC, 30 nap retention
   - Hetzner Storage Box-ra szinkron (€4/hó 1TB)
2. **Physical backup (PITR)**: PgBackRest vagy WAL-G
   - Csak ha tényleg élesben fut és minden second trade számít

**Session state schema** — minden pillér kap egy táblát + közös trade log:
```sql
-- Minden pillérnek saját state táblája (izolált)
CREATE TABLE pillar_state_poly_crypto (
  id SERIAL PRIMARY KEY,
  state_key TEXT UNIQUE NOT NULL,
  state_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pillar_state_poly_weather (...);
CREATE TABLE pillar_state_hl_directional (...);
CREATE TABLE pillar_state_hl_bybit_arb (...);
CREATE TABLE pillar_state_latency_arb (...);

-- Közös trade log (read-only union view, minden pillér ide ír)
CREATE TABLE trade_log (
  id BIGSERIAL PRIMARY KEY,
  pillar TEXT NOT NULL,                  -- 'poly-crypto', 'hl-directional', etc.
  venue TEXT NOT NULL,                   -- 'polymarket', 'hyperliquid', 'bybit'
  mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
  market_id TEXT,
  side TEXT,
  size NUMERIC,
  entry_price NUMERIC,
  exit_price NUMERIC,
  pnl_usd NUMERIC,
  fees_usd NUMERIC,
  signal_breakdown JSONB,                -- IC calibration-höz
  predicted_prob NUMERIC,                -- calibration plot
  realized_outcome NUMERIC,              -- 0 or 1
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  metadata JSONB
);

CREATE INDEX idx_trade_log_pillar ON trade_log(pillar);
CREATE INDEX idx_trade_log_closed_at ON trade_log(closed_at DESC);
CREATE INDEX idx_trade_log_mode ON trade_log(mode);

-- IC kalibrálás materializált view (50+ trade után frissítve)
CREATE MATERIALIZED VIEW signal_ic_calibration AS
  SELECT
    pillar,
    signal_name,
    COUNT(*) as n,
    CORR((signal_breakdown->>signal_name)::NUMERIC, realized_outcome) AS ic
  FROM trade_log,
    LATERAL jsonb_object_keys(signal_breakdown) AS signal_name
  WHERE closed_at IS NOT NULL
    AND mode = 'live'
  GROUP BY pillar, signal_name
  HAVING COUNT(*) >= 50;
```

### Redis 7 (cache + pub/sub event bus)

**Konfiguráció** (`/etc/redis/redis.conf`):
```ini
bind 127.0.0.1                           # NEM publikus!
port 6379
maxmemory 2gb
maxmemory-policy allkeys-lru             # cache eviction
appendonly no                            # cache, nem perzisztens
save ""                                  # nincs RDB snapshot (cache)
```

**Használati minták**:
- **Cache**: signal-combiner output (3 perc TTL), polymarket markets (1h TTL), funding rates (8h TTL)
- **Pub/Sub event bus**:
  - `events:binance:btc:trade` → minden Binance BTC trade event
  - `events:binance:btc:book` → BTC order book update (top 10 levels)
  - `events:binance:funding` → funding rate update óránként
  - `events:hyperliquid:btc:mark` → HL mark price
  - `events:polymarket:book:<token_id>` → Polymarket CLOB book change
- **Streams** (perzisztens event log, debug-hoz):
  - `XADD stream:trades:opened * pillar poly-crypto market_id 0x... ...`
  - 7 nap retention (`MAXLEN ~ 100000`)

**Miért nincs külön message broker (NATS, RabbitMQ)?**
- Redis pub/sub elég 5-10 pillérhez
- Egy szolgáltatás kevesebb (egyszerűbb monitoring, kevesebb failure point)
- NATS-re majd akkor váltunk, ha 100k+ msg/sec lesz (nem most)

---

## 5. Reverse proxy — Caddy

**Caddy 2** automatikus HTTPS-szel (Let's Encrypt).

`/etc/caddy/Caddyfile`:
```caddy
# Frontend (Astro static build)
edgecalc.jmeszaros.dev {
    root * /home/edgecalc/edgecalc/dist
    file_server
    encode gzip zstd
    
    # SPA fallback
    try_files {path} /index.html
    
    # Headers
    header {
        Strict-Transport-Security "max-age=31536000;"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }
}

# API gateway (minden pillér API-ja innen routolódik)
api.edgecalc.jmeszaros.dev {
    # Auth (JWT) middleware Caddy plugin-en, vagy backend ellenőrzi
    
    # Status endpoint-ok
    handle /api/status/* {
        reverse_proxy localhost:7000          # status-aggregator process
    }
    
    # Pillér-specifikus endpoint-ok
    handle /api/pillars/poly-crypto/* {
        reverse_proxy localhost:7101
    }
    handle /api/pillars/poly-weather/* {
        reverse_proxy localhost:7102
    }
    handle /api/pillars/hl-directional/* {
        reverse_proxy localhost:7103
    }
    handle /api/pillars/hl-bybit-arb/* {
        reverse_proxy localhost:7104
    }
    handle /api/pillars/latency-arb/* {
        reverse_proxy localhost:7105
    }
    
    # Signal layer (read-only, minden pillér ezt olvassa)
    handle /api/signals/* {
        reverse_proxy localhost:7200
    }
    
    # Edge tracker (read-only stats UI)
    handle /api/edge-tracker/* {
        reverse_proxy localhost:7300
    }
    
    # Tools API (régi 11 tab funkciói)
    handle /api/tools/* {
        reverse_proxy localhost:7400
    }
    
    # Default deny
    handle {
        respond "Not found" 404
    }
    
    encode gzip
    log {
        output file /var/log/caddy/api.log
        format json
    }
}
```

**Port allokáció (lokális, csak Caddy mögött)**:
| Port | Process |
|---|---|
| 7000 | status-aggregator |
| 7101–7199 | pillér API-k |
| 7200–7299 | signal layer |
| 7300–7399 | edge tracker |
| 7400–7499 | tools API |
| 7500–7599 | shared services (binance-collector status, stb.) |

---

## 6. Process layout (PM2 ecosystem)

`/home/edgecalc/edgecalc/ecosystem.config.cjs`:
```javascript
module.exports = {
  apps: [
    // ─── SHARED INFRASTRUCTURE PROCESSES ───────────────────
    {
      name: 'binance-ws-collector',
      script: './shared/binance-collector/index.ts',
      interpreter: 'bun',
      env: { PORT: 7501 },
      max_memory_restart: '500M',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 100,
      // Single instance, NEM cluster (WS connection állapota)
    },
    {
      name: 'polymarket-feed',
      script: './shared/polymarket-feed/index.ts',
      interpreter: 'bun',
      env: { PORT: 7502 },
      max_memory_restart: '500M',
    },
    {
      name: 'hyperliquid-feed',
      script: './shared/hyperliquid-feed/index.ts',
      interpreter: 'bun',
      env: { PORT: 7503 },
      max_memory_restart: '500M',
    },
    {
      name: 'bybit-feed',
      script: './shared/bybit-feed/index.ts',
      interpreter: 'bun',
      env: { PORT: 7504 },
      max_memory_restart: '500M',
    },
    
    // ─── SIGNAL LAYER ──────────────────────────────────────
    {
      name: 'signal-combiner',
      script: './signal/combiner/index.ts',
      interpreter: 'bun',
      env: { PORT: 7200 },
      instances: 2,                       // CPU-bound, lehet cluster
      exec_mode: 'cluster',
    },
    {
      name: 'resolution-risk',
      script: './signal/resolution-risk/index.ts',
      interpreter: 'bun',
      env: { PORT: 7201 },
    },
    
    // ─── PILLÉREK ──────────────────────────────────────────
    {
      name: 'pillar-poly-crypto',
      script: './pillars/poly-crypto/index.ts',
      interpreter: 'bun',
      env: { 
        PORT: 7101,
        PAPER_MODE: 'false',              // ha live
        BANKROLL_USD: '200',
        SESSION_LOSS_LIMIT: '20',
        EDGE_THRESHOLD: '0.15',
      },
      max_memory_restart: '300M',
    },
    {
      name: 'pillar-poly-weather',
      script: './pillars/poly-weather/index.ts',
      interpreter: 'bun',
      env: { 
        PORT: 7102,
        BANKROLL_USD: '150',
        EDGE_THRESHOLD: '0.12',
      },
    },
    {
      name: 'pillar-hl-directional',
      script: './pillars/hl-directional/index.ts',
      interpreter: 'bun',
      env: { 
        PORT: 7103,
        BANKROLL_USD: '300',
        MAX_LEVERAGE: '3',
      },
    },
    {
      name: 'pillar-hl-bybit-arb',
      script: './pillars/hl-bybit-arb/index.ts',
      interpreter: 'bun',
      env: { 
        PORT: 7104,
        BANKROLL_USD: '400',
      },
    },
    {
      name: 'pillar-latency-arb',
      script: './pillars/latency-arb/index.ts',
      interpreter: 'bun',
      env: { 
        PORT: 7105,
        BANKROLL_USD: '300',
        EXECUTION_VENUE: 'bybit',         // 'bybit' vagy 'polymarket'
      },
    },
    
    // ─── API SERVICES ──────────────────────────────────────
    {
      name: 'status-aggregator',
      script: './api/status/index.ts',
      interpreter: 'bun',
      env: { PORT: 7000 },
    },
    {
      name: 'edge-tracker-api',
      script: './api/edge-tracker/index.ts',
      interpreter: 'bun',
      env: { PORT: 7300 },
    },
    {
      name: 'tools-api',
      script: './api/tools/index.ts',
      interpreter: 'bun',
      env: { PORT: 7400 },
    },
  ]
};
```

**Process indítás**:
```bash
cd /home/edgecalc/edgecalc
pm2 start ecosystem.config.cjs
pm2 save                                  # restart-perzisztens
pm2 logs                                  # streaming logs
pm2 monit                                 # TUI dashboard
```

---

## 7. Mappaszerkezet

```
/home/edgecalc/edgecalc/
├── ecosystem.config.cjs                  # PM2 master config
├── package.json
├── tsconfig.json
├── .env                                  # NEVER commit, csak példa .env.example
├── .env.example
│
├── dist/                                 # Astro build → Caddy serve
├── src/                                  # Frontend (Astro + React)
│   ├── pages/
│   ├── components/
│   └── styles/
│
├── shared/                               # Közös infrastruktúra processzek
│   ├── binance-collector/                # Binance WS feed → Redis pub/sub
│   ├── polymarket-feed/                  # Polymarket CLOB book/trade feed
│   ├── hyperliquid-feed/                 # HL WS feed
│   ├── bybit-feed/                       # Bybit WS feed
│   └── lib/                              # Közös lib-ek (logger, redis client, pg client)
│       ├── logger.ts                     # NDJSON struktúrált log
│       ├── redis.ts                      # ioredis singleton
│       ├── pg.ts                         # postgres connection pool
│       ├── telegram.ts                   # Telegram alert sender
│       └── env.ts                        # zod-validated env
│
├── signal/                               # Signal layer (1:1 átírás Netlify-ról)
│   ├── combiner/                         # 8-signal combiner (vol_div, orderflow, etc.)
│   ├── resolution-risk/                  # Heuristic + Claude fallback
│   ├── vol-divergence/
│   ├── orderflow/
│   ├── apex-wallets/
│   ├── cond-prob/
│   ├── vwap-arb/
│   ├── funding-rates/
│   └── llm-dependency/
│
├── pillars/                              # KERESKEDŐ PILLÉREK (mind izolált)
│   ├── poly-crypto/                      # Polymarket BTC up/down
│   │   ├── index.ts                      # Entry point (HTTP server + loop)
│   │   ├── market-finder.ts
│   │   ├── decision-engine.ts            # 7 gate
│   │   ├── execution.ts                  # Polymarket CLOB
│   │   ├── lifecycle.ts                  # Buy/sell lifecycle
│   │   ├── session.ts                    # Postgres state I/O
│   │   ├── config.ts                     # Per-pillar config
│   │   └── README.md                     # Pillér-specifikus doc
│   ├── poly-weather/                     # Polymarket weather buckets
│   ├── hl-directional/                   # Hyperliquid perp directional
│   ├── hl-bybit-arb/                     # HL perp short + Bybit spot long
│   └── latency-arb/                      # Binance signal → Bybit execution
│
├── api/                                  # HTTP API endpoint-ok (Caddy mögé)
│   ├── status/                           # Aggregált status (minden pillér)
│   ├── edge-tracker/                     # Trade history + statisztikák
│   └── tools/                            # Régi 11 tab functions (read-only)
│
├── scripts/                              # Operációs scriptek
│   ├── deploy.sh                         # Deploy script (lent)
│   ├── backup-db.sh                      # Postgres backup → Storage Box
│   ├── ic-calibrate.sh                   # 50+ trade után IC újraszámítás
│   └── kill-switch.sh                    # Emergency: minden pillér stop
│
├── migrations/                           # SQL migrations (numbered)
│   ├── 001_init.sql
│   ├── 002_signal_calibration.sql
│   └── ...
│
└── docs/                                 # Belső dokumentáció (jelenlegi internal-docs/ átemelve)
    ├── architecture.md                   # Ez maradhat
    ├── hetzner-infrastructure.md         # EZ A FÁJL
    ├── migration-strangler-fig.md        # Külön doc
    ├── pillars/                          # Pillér-specifikus matek doc-ok
    └── changelog/
```

---

## 8. Environment variables (átszervezett, pillér-szerinti)

`/home/edgecalc/edgecalc/.env`:
```env
# ─── BASE ──────────────────────────────────────────────────
NODE_ENV=production
LOG_LEVEL=info                            # debug|info|warn|error

# ─── DATABASE ──────────────────────────────────────────────
DATABASE_URL=postgresql://edgecalc:PWD@localhost:5432/edgecalc_prod
DATABASE_PAPER_URL=postgresql://edgecalc:PWD@localhost:5432/edgecalc_paper

# ─── REDIS ─────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ─── AUTH (frontend protect) ───────────────────────────────
JWT_SECRET=<32+ random>
AUTH_PASSWORD_HASH=<sha256 hex>

# ─── EXTERNAL APIs ─────────────────────────────────────────
ANTHROPIC_API_KEY=                        # resolution-risk fallback + LLM dependency

# ─── BINANCE (READ-ONLY signal feed, NINCS KULCS!) ─────────
# A binance-collector public WebSocket-et használ, nem kell API kulcs.
# A jelenlegi BINANCE_API_KEY/SECRET env-ek TÖRÖLHETŐK!

# ─── BYBIT (KÖZÖS API kulcs minden Bybit-et használó pillérhez) ───
# Egy közös kulcs, SPOT + DERIVATIVES permission
# Pillérek: pillar-hl-bybit-arb (spot leg), pillar-latency-arb (derivatives)
BYBIT_API_KEY=
BYBIT_API_SECRET=
BYBIT_TESTNET=false

# ─── POLYMARKET ────────────────────────────────────────────
POLY_PRIVATE_KEY=0x...
POLY_FUNDER_ADDRESS=0x...
POLY_SIGNATURE_TYPE=1
POLYGON_RPC_URL=https://polygon-rpc.com   # vagy saját Polygon node később

# ─── HYPERLIQUID ───────────────────────────────────────────
HL_PRIVATE_KEY=0x...
HL_WALLET_ADDRESS=0x...

# ─── TELEGRAM (per-pillér csatorna) ────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID_POLY_CRYPTO=
TELEGRAM_CHAT_ID_POLY_WEATHER=
TELEGRAM_CHAT_ID_HL_DIRECTIONAL=
TELEGRAM_CHAT_ID_HL_BYBIT_ARB=
TELEGRAM_CHAT_ID_LATENCY_ARB=
TELEGRAM_CHAT_ID_OPS=                     # Infrastruktúra alertek (process down, db slow, etc.)

# ─── PER-PILLÉR KONFIG (PM2 env-ben is felülírható) ────────

# Pillar 1: Polymarket Crypto
POLY_CRYPTO_PAPER_MODE=true
POLY_CRYPTO_BANKROLL_USD=200
POLY_CRYPTO_SESSION_LOSS_LIMIT=20
POLY_CRYPTO_EDGE_THRESHOLD=0.15
POLY_CRYPTO_KELLY_CAP=0.20
POLY_CRYPTO_COOLDOWN_SEC=300
POLY_CRYPTO_LOOP_INTERVAL_SEC=180         # 3 perces tick

# Pillar 2: Polymarket Weather
POLY_WEATHER_PAPER_MODE=true
POLY_WEATHER_BANKROLL_USD=150
POLY_WEATHER_EDGE_THRESHOLD=0.12
POLY_WEATHER_CONFIDENCE_MIN=0.65
POLY_WEATHER_EXIT_BEFORE_MIN=45
POLY_WEATHER_MAX_POSITION_USD=25
POLY_WEATHER_USE_ENSEMBLE=false
POLY_WEATHER_LOOP_INTERVAL_SEC=900        # 15 perces tick

# Pillar 3: Hyperliquid Directional
HL_DIRECTIONAL_PAPER_MODE=true
HL_DIRECTIONAL_BANKROLL_USD=300
HL_DIRECTIONAL_MAX_LEVERAGE=3
HL_DIRECTIONAL_MAX_PCT_BANKROLL=0.15
HL_DIRECTIONAL_SESSION_LOSS_LIMIT=50
HL_DIRECTIONAL_MAX_OPEN_POSITIONS=3
HL_DIRECTIONAL_EDGE_THRESHOLD=0.18
HL_DIRECTIONAL_COOLDOWN_SEC=300
HL_DIRECTIONAL_CONSEC_LOSS_LIMIT=3
HL_DIRECTIONAL_VOL_GATE_RV_PCT=120
HL_DIRECTIONAL_LOOP_INTERVAL_SEC=180

# Pillar 4: HL + Bybit Funding Arb (Opció 1: HL perp short + Bybit spot long)
HL_BYBIT_ARB_PAPER_MODE=true
HL_BYBIT_ARB_BANKROLL_USD=400
HL_BYBIT_ARB_MIN_SPREAD_HOURLY=0.0001
HL_BYBIT_ARB_MIN_OPEN_INTEREST=5000000
HL_BYBIT_ARB_MAX_POSITIONS=3
HL_BYBIT_ARB_MIN_POSITION_USDC=50
HL_BYBIT_ARB_MAX_HOLD_DAYS=14
HL_BYBIT_ARB_MIN_SPREAD_TO_CLOSE=0.00005
HL_BYBIT_ARB_FEE_HL=0.0009                # roundtrip
HL_BYBIT_ARB_FEE_BYBIT_SPOT=0.002         # spot fee, roundtrip (Bybit ~0.1% per side)
HL_BYBIT_ARB_LOOP_INTERVAL_SEC=600        # 10 perces tick

# Pillar 5: Latency Arb (Binance signal → Bybit execution)
LATENCY_ARB_PAPER_MODE=true
LATENCY_ARB_BANKROLL_USD=300
LATENCY_ARB_EXECUTION_VENUE=bybit         # 'bybit' (default) | 'polymarket'
LATENCY_ARB_MIN_EDGE_BPS=15               # 0.15% min edge
LATENCY_ARB_MAX_POSITION_USD=50
LATENCY_ARB_MAX_HOLD_SECONDS=10
LATENCY_ARB_BINANCE_PRICE_LAG_MS=200      # min stale-ség threshold
# Latency arb: NEM cron-based, esemény-vezérelt loop (Redis pub/sub consume)
```

---

## 9. Deploy pipeline

### Lokális → VPS deploy

`scripts/deploy.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

VPS_HOST="edgecalc@<vps-ip>"
APP_DIR="/home/edgecalc/edgecalc"

echo "→ Building frontend (Astro)..."
bun run build

echo "→ Syncing to VPS..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='dist' \
  --exclude='logs' \
  --exclude='.git' \
  ./ "${VPS_HOST}:${APP_DIR}/"

# Frontend build külön sync (mert .gitignore-ban van)
rsync -avz --delete dist/ "${VPS_HOST}:${APP_DIR}/dist/"

echo "→ Installing dependencies on VPS..."
ssh "${VPS_HOST}" "cd ${APP_DIR} && bun install --production"

echo "→ Running migrations..."
ssh "${VPS_HOST}" "cd ${APP_DIR} && bun run migrate"

echo "→ Reloading PM2 (zero-downtime)..."
ssh "${VPS_HOST}" "pm2 reload ecosystem.config.cjs"

echo "→ Caddy reload (Astro frontend változott)..."
ssh "${VPS_HOST}" "sudo systemctl reload caddy"

echo "✓ Deploy complete."
```

### Git workflow
- `main` branch → production deploy (manual `./scripts/deploy.sh`)
- `dev` branch → fejlesztés
- Nincs CI/CD induláskor (overengineering 1 fő fejlesztőhöz)
- Később GitHub Actions: `main` push → SSH-n trigger deploy script

### Database migrations
- Egyszerű SQL fájlok `migrations/` mappában, sorszámozva
- Migration runner: `node-pg-migrate` vagy saját 50 LOC bash script
- Minden migration **idempotens** (`IF NOT EXISTS`)

---

## 10. Monitoring

### Phase 1 (induláshoz elég)
**Telegram alertek** + **PM2 logs** + **`pm2 monit` TUI**
- Pillér crash → PM2 auto-restart + Telegram alert (`alertOps`)
- Trade open/close → per-pillér Telegram csatorna
- Session loss limit → Telegram + pillér stop
- Postgres connection drop → Telegram + reconnect retry

### Phase 2 (3+ hónap után, ha tényleg fut)
**Grafana + Prometheus** stack:
```
prometheus (metrics scrape) → grafana (dashboards) → alertmanager (alerting)
```

Mit mérünk:
- Per-pillér: open positions, session PnL, win rate (rolling 7d), avg edge
- Signal layer: signal-combiner latency p50/p95/p99, IC calibration drift
- Infra: CPU/RAM/disk, Postgres connection count, Redis memory, network I/O
- Latency-critical: Binance event → decision → order placed (p50/p95/p99 ms)

Grafana dashboard-ok per-pillér + 1 közös "infrastructure overview".

---

## 11. Disaster Recovery (DR)

### Backup
1. **Postgres napi dump** → `/backups/edgecalc_YYYY-MM-DD.sql.gz`
2. **Hetzner Storage Box** (€4/hó 1TB) → cron rsync `/backups/` → Storage Box
3. **Hetzner Cloud snapshot** (heti, manuális) → teljes VPS snapshot

### Recovery scenarios
| Scenario | Recovery |
|---|---|
| Pillér process crash | PM2 auto-restart, max 5 sec downtime |
| Postgres corruption | Restore napi dump-ból, max 24h trade history vesztés |
| VPS halálos hardware fail | Snapshot-ból új VPS boot, IP transfer, ~30 perc |
| Hetzner DC kiesés (FSN1) | Snapshot restore másik DC-ben (NBG/HEL), ~1 óra |
| API key kompromittálva | Kill switch script (`scripts/kill-switch.sh`), API key revoke, új kulcs |

### Kill switch script
`scripts/kill-switch.sh`:
```bash
#!/usr/bin/env bash
# Vészhelyzeti összes pillér stop, paper modeba kapcsol mindent.
# Használat: ssh edgecalc@vps "bash kill-switch.sh"
set -e
echo "EMERGENCY STOP — minden pillér leállítása"
pm2 stop pillar-poly-crypto pillar-poly-weather \
        pillar-hl-directional pillar-hl-bybit-arb \
        pillar-latency-arb
echo "Telegram alert..."
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID_OPS}" \
  -d "text=🚨 KILL SWITCH AKTIVÁLVA — minden pillér leállt"
echo "✓ Kész. Manual restart: pm2 start ecosystem.config.cjs"
```

---

## 12. Költségvetés (havi)

| Tétel | Szolgáltató | Költség |
|---|---|---|
| VPS (CCX23) | Hetzner Cloud | €36 |
| Backup (20%) | Hetzner Cloud | €7 |
| Storage Box (1TB) | Hetzner | €4 |
| Domain (edgecalc.jmeszaros.dev) | (subdomain a meglévőből) | €0 |
| Anthropic API (resolution-risk + LLM dep) | Anthropic | ~€10–30 (használat-függő) |
| Telegram bot | Telegram | €0 |
| **Összesen Phase 1** | | **~€57–77/hó** |
| | | |
| Phase 2 plusz: AWS Tokyo edge node | AWS | ~$15 |
| Phase 2 plusz: Postgres szerver szétválasztva (külön VPS) | Hetzner | +€20 |
| **Összesen Phase 2** | | **~€95–115/hó** |

Összehasonlítás: a jelenlegi Netlify Pro (€19/hó) + Functions overage + Blobs storage könnyen €30-40/hó lehet skála után. A különbség nem nagy, de a **képességek nagyságrendileg többek**.

---

## 13. Indítási checklist

```
□ Hetzner Cloud account + CCX23 booking Falkenstein
□ DNS: edgecalc.jmeszaros.dev → VPS IP (Cloudflare proxy ON, csak HTTPS)
□ DNS: api.edgecalc.jmeszaros.dev → ugyanaz
□ SSH key feltöltés, root disable
□ UFW + fail2ban + chrony setup
□ PostgreSQL install + edgecalc DB + edgecalc user
□ Redis install + bind localhost
□ Caddy install + Caddyfile + auto HTTPS verification
□ Bun + Node.js + PM2 install (edgecalc user)
□ Repo clone, .env feltöltés (NEM git-ben!)
□ Migrations run
□ PM2 start ecosystem.config.cjs
□ pm2 save + pm2 startup
□ Telegram bot setup, chat ID-k, teszt üzenet minden csatornán
□ Backup cron + Storage Box mount + első manual backup teszt
□ Hetzner snapshot baseline
□ Pillérek paper mode 24-48 óra futás monitoring
□ Edge Tracker: első trade-ek beérkezése, calibration plot ellenőrzés
□ ELS LIVE pillér: poly-crypto (legkisebb size, legjobban ismert)
```

---

## 14. Mit NEM oldunk meg ebben a fázisban (tudatos döntések)

- **Cross-venue risk koordinátor** — pilléres modell, nincs rá szükség
- **Multi-region failover** — egy DC, snapshot-restore-mást-DC-ben elég DR-nek
- **Kubernetes / Docker** — overengineering 5-10 process-hez, PM2 elég
- **CI/CD pipeline** — manual deploy script elég 1 főnek
- **Distributed tracing (Jaeger, Tempo)** — egy gép, PM2 logs elég
- **Service mesh** — egy gép, lokális socket-ek
- **Saját Polygon node** — Phase 3, csak ha order placement latency a bottleneck

---

**Következő lépés:** `migration-strangler-fig.md` — melyik Netlify Function → melyik VPS process / endpoint, fázisokra bontva.
