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
# Импорт PBF держит индекс локаций osmium: замер на проде дал пик 1.78 ГиБ в контейнере импорта и
# минимум 0.95 ГиБ свободной памяти на хосте (3.9 ГиБ всего). Порог 2000 МБ оставляет запас на рост
# выгрузки; если свободной памяти меньше, полный импорт пропускается (см. ниже) — сервис важнее данных.
MIN_FREE_MB="${MIN_FREE_MB:-2000}"
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
    log "скачиваю выгрузку: $PBF_URL"
    # Три вещи, найденные на проде 01.10.2026 (без них плановое обновление падало молча):
    # 1. `-A` обязателен: без User-Agent Geofabrik отвечает 301 на адрес со слэшем на конце и curl
    #    уходит в бесконечный цикл редиректов.
    # 2. `-z` (условный запрос по дате) на этом прокси тоже даёт 404 — поэтому не используем.
    # 3. Ответ нестабилен: один и тот же запрос то 200, то цикл 301 (2 из 5 попыток в проверке).
    #    Поэтому скачивание повторяем, а не падаем с первой неудачи.
    # Файл пишем во временный и подменяем только после успеха: оборванная загрузка не должна испортить
    # рабочую выгрузку. `--max-redirs 5` — страховка от бесконечного цикла.
    ATTEMPT=1
    MAX_ATTEMPTS="${PBF_DOWNLOAD_ATTEMPTS:-3}"
    rm -f "$PBF_PATH.tmp"
    while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
        if curl -fsS -L --max-redirs 5 -m 3600 \
            -A "GEOPULS/1.0 (data refresh; +https://github.com/StanislavGolis/Geopuls)" \
            -o "$PBF_PATH.tmp" "$PBF_URL"; then
            break
        fi
        log "попытка $ATTEMPT из $MAX_ATTEMPTS не удалась — повтор через 20 с"
        rm -f "$PBF_PATH.tmp"
        ATTEMPT=$((ATTEMPT + 1))
        sleep 20
    done
    if [ ! -s "$PBF_PATH.tmp" ]; then
        notify "не удалось скачать выгрузку OSM за $MAX_ATTEMPTS попыток: $PBF_URL"
        exit 1
    fi
    mv -f "$PBF_PATH.tmp" "$PBF_PATH"
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
