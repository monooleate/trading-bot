# Playbook — EdgeCalc live ops (Hetzner `analytics` co-host)

> Operational runbook for the **live** Docker stack deployed 2026-09-02.
> Live URL: **https://trade.jmeszaros.dev** (paper). Box: `analytics`
> (91.99.218.165), Debian 13, CX33. Co-hosted next to umami — **never touch the
> umami containers** (`analytics-caddy-1`/`-umami-1`/`-db-1`); only edit the
> `analytics` Caddyfile when publishing a new site, with backup + validate.

## Where things live
- **Code/config:** `/opt/edgecalc` (git clone of `main`). Secrets: `/opt/edgecalc/.env` (chmod 600).
- **Compose project:** `edgecalc` (separate from `analytics`). Containers: `edgecalc-workers`, `edgecalc-api`, `edgecalc-model`.
- **State:** the umami Postgres (`analytics-db-1`), DB `edgecalc`, user `edgecalc` — normalized `pillar_*` tables + `prediction_ledger` + `blob_kv` + `settings`.
- **Networks:** `analytics_edge` (egress + caddy↔api), `analytics_internal` (DB).
- **Logs:** `docker logs`; watchdog → `/opt/edgecalc/logs/monitor.log`.

## Health / status
```bash
cd /opt/edgecalc
docker compose ps
docker logs -f edgecalc-workers          # pillar ticks, orders
docker logs --tail 20 edgecalc-api       # "[api] listening on :7000"
free -h; docker stats --no-stream        # RAM/swap (co-host)
tail -f /opt/edgecalc/logs/monitor.log   # watchdog (every 15 min)
# public checks
curl -fsS https://trade.jmeszaros.dev/health
docker exec analytics-db-1 psql -U umami -d edgecalc -c "SELECT category,mode,bankroll_current,trade_count,stopped FROM pillar_session ORDER BY 1"
```

## Deploy an update (from a pushed `main`)
```bash
cd /opt/edgecalc && git fetch origin -q && git reset --hard origin/main
docker compose --profile migrate run --rm --build migrate   # if migrations changed
docker compose up -d --build                                 # rolling-ish; state is in PG
```
Frontend is baked into the `api` image (server.ts serves it) — no separate dist step.

## Kill-switch
```bash
docker compose -p edgecalc stop workers     # stop all pillar loops (api stays up)
docker compose -p edgecalc down             # stop the whole trading stack
docker compose -p edgecalc up -d            # bring back
```
Umami is unaffected either way.

## Bot control (paper) — via the API (auth = dashboard JWT)
`action=status|run|reset|stop|resume|reconcile|topup` on `/.netlify/functions/auto-trader-api`
(`category=crypto|weather|hyperliquid|funding-arb|sports`). Easiest from the dashboard UI.
Settings/knobs: the Settings panel → `trader-settings` (stored in the `settings` table).

## Monitoring
Server-side watchdog: `infra/monitor/edgecalc-health.sh` via cron `*/15` (see
`infra/monitor/README.md`). Fill `TELEGRAM_*` in `.env` to get alerts, else it
only logs. Rescale to 16 GB (CX42) if `free -h` shows sustained >0.5 GB swap.

## Backups (TODO — not yet automated)
The `edgecalc` DB lives in the umami Postgres. A daily `pg_dump edgecalc` +
Storage Box push is a recommended follow-up (the generic §15 `backup` container
or a host cron). Not set up as of 2026-09-02.

## Known open items (non-blocking)
- Forecasting knobs #2–#9 are **default-off** (measurement-first); enable per
  positive walk-forward gain on the Edge Tracker.
- Ledger writes to `blob_kv` (not the normalized `prediction_ledger` table) —
  coordinated worker+api follow-up.
- Phase 7: load the real Chronos-Bolt weight in `edgecalc-model` (after 16 GB rescale).
