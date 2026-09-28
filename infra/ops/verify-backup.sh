#!/usr/bin/env bash
# Проверка резервной копии: разворачиваем дамп в ОТДЕЛЬНУЮ базу и сверяем число строк.
#
#   bash infra/ops/verify-backup.sh                     # берёт самый свежий дамп из ./backups
#   bash infra/ops/verify-backup.sh backups/geopuls-2026-09-28-2219.dump
#
# DoD §11.1 требует, чтобы восстановление было проверено, а не заявлено: скрипт завершается с
# ненулевым кодом, если цифры разошлись. Рабочая база при этом не затрагивается.
set -euo pipefail

cd "$(dirname "$0")/../.."
CHECK_DB="${CHECK_DB:-geopuls_restore_check}"
KEEP_CHECK="${KEEP_CHECK:-0}"
TABLES="pois city_cells cell_stats cities categories data_versions"

DUMP="${1:-$(ls -1t backups/geopuls-*.dump 2>/dev/null | head -1 || true)}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "дамп не найден: $DUMP" >&2; exit 1; }

log() { echo "[$(date -Is)] $*"; }

# Пользователь и база берутся из .env через docker compose, здесь нужны имена для psql
DB_USER="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
DB_NAME="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
DB_USER="${DB_USER:-geopuls}"
DB_NAME="${DB_NAME:-geopuls}"

QUERY=""
for table in $TABLES; do
    QUERY="${QUERY}${QUERY:+ UNION ALL }SELECT '$table' AS t, count(*) FROM $table"
done
QUERY="$QUERY ORDER BY 1"

counts() {
    docker compose exec -T db psql -U "$DB_USER" -d "$1" -t -A -F, -c "$QUERY"
}

log "1/4 копирую дамп в контейнер db"
docker compose cp "$DUMP" db:/tmp/geopuls-restore.dump

log "2/4 пересоздаю проверочную базу $CHECK_DB"
docker compose exec -T db dropdb -U "$DB_USER" --if-exists "$CHECK_DB"
docker compose exec -T db createdb -U "$DB_USER" "$CHECK_DB"

log "3/4 восстанавливаю копию"
docker compose exec -T db pg_restore -U "$DB_USER" -d "$CHECK_DB" --no-owner --exit-on-error /tmp/geopuls-restore.dump
docker compose exec -T db rm -f /tmp/geopuls-restore.dump

log "4/4 сверяю число строк с рабочей базой $DB_NAME"
SOURCE_COUNTS="$(counts "$DB_NAME")"
RESTORED_COUNTS="$(counts "$CHECK_DB")"

printf '%-16s %10s %10s\n' 'таблица' 'источник' 'копия'
while IFS=, read -r table count; do
    restored="$(echo "$RESTORED_COUNTS" | awk -F, -v t="$table" '$1 == t { print $2 }')"
    printf '%-16s %10s %10s\n' "$table" "$count" "${restored:-нет}"
done <<< "$SOURCE_COUNTS"

status=0
if [ "$SOURCE_COUNTS" != "$RESTORED_COUNTS" ]; then
    log "РАСХОЖДЕНИЕ: восстановленная копия отличается от источника"
    status=1
else
    log "восстановление проверено: цифры совпадают"
fi

if [ "$KEEP_CHECK" != "1" ]; then
    docker compose exec -T db dropdb -U "$DB_USER" --if-exists "$CHECK_DB"
fi

exit "$status"
