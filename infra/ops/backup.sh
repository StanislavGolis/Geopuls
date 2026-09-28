#!/usr/bin/env bash
# Резервная копия БД ГЕОПУЛЬС (bash-версия tools/db-backup.ps1 для cron на сервере).
#
#   bash infra/ops/backup.sh              # копия в ./backups, храним 14 дней
#   KEEP_DAYS=30 bash infra/ops/backup.sh
#
# Дамп снимается внутри контейнера `db` и копируется на хост: так исключены проблемы с бинарным
# потоком и с правами. Проверка восстановления — verify-backup.sh (обязательна перед релизом).
set -euo pipefail

cd "$(dirname "$0")/../.."
KEEP_DAYS="${KEEP_DAYS:-14}"
OUT_DIR="${OUT_DIR:-$PWD/backups}"
STAMP="$(date +%F-%H%M)"
TARGET="$OUT_DIR/geopuls-$STAMP.dump"

log() { echo "[$(date -Is)] $*"; }

docker compose ps --status running --services | grep -qx db || {
    echo "контейнер db не запущен — бэкап невозможен" >&2
    exit 1
}

mkdir -p "$OUT_DIR"

log "снимаю дамп внутри контейнера db"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/geopuls-backup.dump'

log "копирую дамп на хост: $TARGET"
docker compose cp db:/tmp/geopuls-backup.dump "$TARGET"
docker compose exec -T db rm -f /tmp/geopuls-backup.dump

log "удаляю копии старше $KEEP_DAYS дней"
find "$OUT_DIR" -maxdepth 1 -name 'geopuls-*.dump' -mtime "+$KEEP_DAYS" -delete

log "готово: $TARGET ($(du -h "$TARGET" | cut -f1))"
