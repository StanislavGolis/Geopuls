#!/usr/bin/env bash
# Мониторинг прод-стенда (cron каждые 5 минут) — раздел 9.3 ТЗ.
#
# Проверки: /healthz, /readyz (с порогом «недоступен 5 минут»), свежесть данных (≤ 14 дней),
# диск и память (< 85 %), состояние контейнеров. Отчёт — в JSON, алерт — в вебхук.
#
#   GEOPULS_ALERT_WEBHOOK="https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>" \
#       bash infra/ops/monitor.sh
#
# Ненулевой код возврата означает, что хотя бы одна проверка провалилась (cron это доставит письмом).
set -uo pipefail

cd "$(dirname "$0")/../.."
STATE_DIR="${STATE_DIR:-/var/log/geopuls}"
DOMAIN="$(grep -E '^DOMAIN=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
DOMAIN="${DOMAIN:-localhost}"
WEBHOOK="${GEOPULS_ALERT_WEBHOOK:-}"
MAX_DATA_AGE_DAYS="${MAX_DATA_AGE_DAYS:-14}"
MAX_DISK_PERCENT="${MAX_DISK_PERCENT:-85}"
MAX_MEM_PERCENT="${MAX_MEM_PERCENT:-85}"
READYZ_FAILURES_TO_ALERT="${READYZ_FAILURES_TO_ALERT:-2}"   # 2 запуска по 5 мин = 10 минут недоступности

mkdir -p "$STATE_DIR"
FAILED=()
RESULTS=()

notify() {
    local message="$1"
    echo "[$(date -Is)] ТРЕВОГА: $message"
    if [ -n "$WEBHOOK" ]; then
        curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
            -d "{\"text\": \"ГЕОПУЛЬС: $message\"}" "$WEBHOOK" >/dev/null \
            || echo "[$(date -Is)] не удалось отправить алерт в вебхук"
    fi
}

check_http() {
    local name="$1" url="$2" expected="${3:-200}"
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$url" || echo 000)"
    RESULTS+=("$name=$code")
    if [ "$code" != "$expected" ]; then
        FAILED+=("$name ответил $code (ожидался $expected)")
        return 1
    fi
    return 0
}

# 1. Процесс и БД через внешний адрес (тот же путь, что видят пользователи)
check_http healthz "https://$DOMAIN/healthz" || notify "/healthz недоступен (GET https://$DOMAIN/healthz)"
check_http version "https://$DOMAIN/version" || true

if check_http readyz "https://$DOMAIN/readyz"; then
    echo 0 > "$STATE_DIR/readyz_failures"
else
    failures=$(( $(cat "$STATE_DIR/readyz_failures" 2>/dev/null || echo 0) + 1 ))
    echo "$failures" > "$STATE_DIR/readyz_failures"
    RESULTS+=("readyz_failures=$failures")
    if [ "$failures" -ge "$READYZ_FAILURES_TO_ALERT" ]; then
        notify "/readyz недоступен $(( failures * 5 )) минут подряд (проверь контейнеры: docker compose ps)"
    fi
fi

# 2. Свежесть данных: если выгрузка старше порога — напоминаем, что нужно обновление
version_json="$(curl -fsS -m 15 "https://$DOMAIN/api/v1/meta/cities" 2>/dev/null || true)"
data_version="$(echo "$version_json" | grep -o '"data_version":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
if [ -n "$data_version" ]; then
    data_age_days=$(( ( $(date +%s) - $(date -d "$data_version" +%s 2>/dev/null || date +%s) ) / 86400 ))
    RESULTS+=("data_version=$data_version" "data_age_days=$data_age_days")
    if [ "$data_age_days" -gt "$MAX_DATA_AGE_DAYS" ]; then
        notify "данные старше $MAX_DATA_AGE_DAYS дней (выгрузка $data_version): проверь расписание обновления"
    fi
else
    FAILED+=("/api/v1/meta/cities не ответил — не удалось проверить свежесть данных")
fi

# 3. Диск и память
disk_percent="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
mem_percent="$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {printf "%d", (t-a)*100/t}' /proc/meminfo)"
RESULTS+=("disk_percent=$disk_percent" "mem_percent=$mem_percent")
[ "$disk_percent" -gt "$MAX_DISK_PERCENT" ] && notify "диск занят на $disk_percent % (порог $MAX_DISK_PERCENT %)"
[ "$mem_percent" -gt "$MAX_MEM_PERCENT" ] && notify "память занята на $mem_percent % (порог $MAX_MEM_PERCENT %)"

# 4. Контейнеры
containers_down="$(docker compose ps --format '{{.Service}} {{.State}}' | awk '$2 != "running" {print $1}' | tr '\n' ' ')"
RESULTS+=("containers_down=${containers_down:-нет}")
if [ -n "$containers_down" ]; then
    FAILED+=("контейнеры не запущены: $containers_down")
    notify "контейнеры не запущены: $containers_down"
fi

# 5. Последний бэкап
last_backup="$(ls -1t backups/geopuls-*.dump 2>/dev/null | head -1 || true)"
if [ -n "$last_backup" ]; then
    backup_age_h=$(( ( $(date +%s) - $(stat -c %Y "$last_backup") ) / 3600 ))
    RESULTS+=("last_backup=$last_backup" "backup_age_hours=$backup_age_h")
    [ "$backup_age_h" -gt 48 ] && notify "последний бэкап старше 48 часов ($last_backup)"
else
    FAILED+=("резервных копий нет")
    notify "резервных копий не найдено в $(pwd)/backups"
fi

printf '{"timestamp":"%s","results":"%s","failures":%d}\n' \
    "$(date -Is)" "$(IFS='; '; echo "${RESULTS[*]}")" "${#FAILED[@]}" >> "$STATE_DIR/monitor.json"

if [ "${#FAILED[@]}" -gt 0 ]; then
    echo "[$(date -Is)] провалено проверок: ${#FAILED[@]}: $(IFS='; '; echo "${FAILED[*]}")"
    exit 1
fi
echo "[$(date -Is)] все проверки пройдены: $(IFS='; '; echo "${RESULTS[*]}")"
