#!/usr/bin/env bash
# edgecalc-health.sh — lightweight watchdog for the co-hosted edgecalc stack.
# Runs from cron on the analytics box (see infra/monitor/README.md). Read-only:
# it inspects the edgecalc containers only, never touches the umami stack.
# Logs one line per run to /opt/edgecalc/logs/monitor.log and, when something
# is wrong AND Telegram is configured in /opt/edgecalc/.env, sends one alert.
#
# Checks: the 3 edgecalc containers running · api /health · workers ticked
# recently · disk % · swap MB. Deliberately shallow ("lightweight") — extend
# as needed.

set -uo pipefail

LOGDIR=/opt/edgecalc/logs
LOG="$LOGDIR/monitor.log"
mkdir -p "$LOGDIR"
ts=$(date -u +%FT%TZ)
problems=()

# 1) containers up
for c in edgecalc-workers edgecalc-api edgecalc-model; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  [ "$st" = running ] || problems+=("$c=$st")
done

# 2) api /health (uses the api's own bun — no extra container)
if ! docker exec edgecalc-api bun -e "fetch('http://localhost:7000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  problems+=("api_health_fail")
fi

# 3) workers ticked within the last ~7 min (interval is 180s)
if [ "$(docker logs --since 420s edgecalc-workers 2>&1 | grep -c 'tick done')" -lt 1 ]; then
  problems+=("worker_no_recent_tick")
fi

# 4) disk %
disk=$(df -P / | awk 'NR==2{print $5+0}')
[ "${disk:-0}" -lt 90 ] || problems+=("disk_${disk}pct")

# 5) swap MB (co-host pressure signal → >600 MB means it's time to look)
swap_mb=$(awk '/SwapTotal/{t=$2}/SwapFree/{f=$2}END{printf "%d",(t-f)/1024}' /proc/meminfo)
[ "${swap_mb:-0}" -lt 600 ] || problems+=("swap_${swap_mb}mb")

if [ ${#problems[@]} -eq 0 ]; then
  echo "$ts OK disk=${disk}% swap=${swap_mb}mb" >> "$LOG"
else
  echo "$ts ALERT ${problems[*]} (disk=${disk}% swap=${swap_mb}mb)" >> "$LOG"
  # optional Telegram alert (only if configured; never fails the script)
  set -a; . /opt/edgecalc/.env 2>/dev/null || true; set +a
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -fsS --max-time 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=🚨 edgecalc watchdog: ${problems[*]}" >/dev/null 2>&1 || true
  fi
fi

# keep the log bounded
tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" || true
