#!/usr/bin/env bash
# Обновление данных по расписанию (§9.2 ТЗ): свежая выгрузка Geofabrik → geopuls.refresh.
#
#   bash infra/ops/refresh-data.sh                 # скачать (если появилась новее) и обновить
#   bash infra/ops/refresh-data.sh --skip-download # обновить из уже скачанного файла
#   bash infra/ops/refresh-data.sh --skip-import   # только пересобрать агрегаты (быстро)
#
# Команда идемпотентна; ненулевой код возврата — сигнал мониторингу (§9.3).
set -uo pipefail

cd "$(dirname "$0")/../.."
PBF_URL="${GEOPULS_GEOFABRIK_PBF_URL:-https://download.geofabrik.de/russia/siberian-fed-district-latest.osm.pbf}"
CITY="${GEOPULS_CITY:-tomsk}"
MIN_FREE_MB="${MIN_FREE_MB:-1800}"   # импорт PBF держит индекс локаций osmium (~2 ГБ)
RAW_DIR="$PWD/data/raw"
PBF_NAME="$(basename "$PBF_URL")"
PBF_PATH="$RAW_DIR/$PBF_NAME"

SKIP_DOWNLOAD=0
SKIP_IMPORT=0
for arg in "$@"; do
    case "$arg" in
        --skip-download) SKIP_DOWNLOAD=1 ;;
        --skip-import) SKIP_IMPORT=1 ;;
    esac
done

log() { echo "[$(date -Is)] $*"; }
notify() {
    echo "[$(date -Is)] ТРЕВОГА: $1"
    if [ -n "${GEOPULS_ALERT_WEBHOOK:-}" ]; then
        curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
            -d "{\"text\": \"ГЕОПУЛЬС: $1\"}" "$GEOPULS_ALERT_WEBHOOK" >/dev/null || true
    fi
}

mkdir -p "$RAW_DIR"

# Выгрузку скачивает root на хосте, а импорт идёт в контейнере от непривилегированного пользователя
# `app`: он пишет файл кандидатов рядом с PBF. Без смены владельца каталога импорт падал с
# PermissionError (проверено на проде) — отдаём каталог и файл пользователю контейнера.
API_USER="$(docker compose exec -T api id -u 2>/dev/null | tr -dc '0-9' || true)"
API_GROUP="$(docker compose exec -T api id -g 2>/dev/null | tr -dc '0-9' || true)"
API_USER="${API_USER:-1000}"
API_GROUP="${API_GROUP:-1000}"

if [ "$SKIP_DOWNLOAD" = "0" ]; then
    log "скачиваю выгрузку, если на сервере появилась новее: $PBF_URL"
    # curl -z: файл не будет скачан заново, если серверная копия не новее
    if ! curl -fsS -L -m 3600 -z "$PBF_PATH" -o "$PBF_PATH" "$PBF_URL"; then
        notify "не удалось скачать выгрузку OSM: $PBF_URL"
        exit 1
    fi
    log "файл на месте: $PBF_PATH ($(du -h "$PBF_PATH" | cut -f1), изменён $(date -Is -r "$PBF_PATH"))"
fi

# Владелец данных: контейнер должен иметь право писать рядом с выгрузкой (см. комментарий выше)
chown "$API_USER:$API_GROUP" "$RAW_DIR" 2>/dev/null || true
[ -f "$PBF_PATH" ] && chown "$API_USER:$API_GROUP" "$PBF_PATH" 2>/dev/null || true

if [ "$SKIP_IMPORT" = "1" ]; then
    log "пересобираю только агрегаты (импорт POI пропущен)"
    docker compose run --rm api python -m geopuls.refresh --city "$CITY" --skip-import
    exit $?
fi

free_mb="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)"
log "свободной памяти: ${free_mb} МБ (порог для полного импорта: ${MIN_FREE_MB} МБ)"

if [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
    notify "мало свободной памяти (${free_mb} МБ) — полный импорт пропущен, пересобираю агрегаты; нужен разбор вручную"
    docker compose run --rm api python -m geopuls.refresh --city "$CITY" --skip-import
    exit $?
fi

log "полное обновление: справочники → POI → агрегация"
if ! docker compose run --rm api python -m geopuls.refresh --city "$CITY" --pbf "/data/raw/$PBF_NAME"; then
    notify "обновление данных упало (см. лог cron): проверь geopuls.refresh"
    exit 1
fi

log "готово"
