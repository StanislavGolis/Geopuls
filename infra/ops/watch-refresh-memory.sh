#!/usr/bin/env bash
# Замерщик памяти на время обновления данных: пишет свободную память, swap и объём контейнера импорта.
#
#   nohup bash infra/ops/watch-refresh-memory.sh /var/log/geopuls/refresh-memory.log &
#
# Зачем: импорт выгрузки OSM держит индекс локаций osmium и пиково ест память. Замер на проде
# (Томск, выгрузка Сибирского ФО 557 МБ, 2 vCPU) дал пик 1.78 ГиБ в контейнере импорта, минимум
# свободной памяти 0.95 ГиБ, swap не потребовался. По этим числам выставлен MIN_FREE_MB в
# refresh-data.sh и добавлен swap-файл (infra/ops/install-swap.sh).
set -uo pipefail

LOG="${1:-/tmp/refresh-memory.log}"

echo "start $(date -Is)" >> "$LOG"
while pgrep -f 'geopuls.refresh' >/dev/null 2>&1; do
    avail="$(free -m | awk '/Mem:/ {print $7}')"
    swap_used="$(free -m | awk '/Swap:/ {print $3}')"
    container="$(docker stats --no-stream --format '{{.MemUsage}}' 2>/dev/null | head -1 | cut -d/ -f1 | tr -d ' ')"
    echo "$(date -Is) avail_mb=$avail swap_used_mb=$swap_used import=$container" >> "$LOG"
    sleep 30
done
echo "finish $(date -Is)" >> "$LOG"
