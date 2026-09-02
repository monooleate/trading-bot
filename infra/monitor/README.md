# infra/monitor

Lightweight server-side watchdog for the co-hosted edgecalc stack. Runs from
cron on the `analytics` box, independent of any Claude/dev session.

## What it checks (`edgecalc-health.sh`, every 15 min)
- the 3 edgecalc containers (`edgecalc-workers`/`-api`/`-model`) are `running`
- `api` `/health` responds
- `edgecalc-workers` logged a `tick done` in the last ~7 min (not stuck)
- disk `< 90%`, swap `< 600 MB` (co-host pressure signal)

Read-only, and it only inspects the edgecalc containers — the umami stack is
never touched. One line per run → `/opt/edgecalc/logs/monitor.log` (kept to the
last 2000 lines). On a problem it appends `ALERT …` and, **if** `TELEGRAM_BOT_TOKEN`
+ `TELEGRAM_CHAT_ID` are set in `/opt/edgecalc/.env`, sends one Telegram message.

## Install (on the box)
```bash
chmod +x /opt/edgecalc/infra/monitor/edgecalc-health.sh
( crontab -l 2>/dev/null | grep -v edgecalc-health.sh ; \
  echo "*/15 * * * * /opt/edgecalc/infra/monitor/edgecalc-health.sh" ) | crontab -
```
Enable alerts by filling `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`
(otherwise it just logs). Watch it live: `tail -f /opt/edgecalc/logs/monitor.log`.
