# services/feeds

**Placeholder (Phase 3 / B-lépcső).** WS collectors (Binance / Hyperliquid /
Bybit / Polymarket) → Redis pub/sub, so pillar workers read from one shared
stream instead of each polling. No standalone feed logic exists yet — the
current pillars fetch inline. See `hetzner-docker-setup.md` §1 (`market-feeds`)
and the migration runbook Phase 3.
