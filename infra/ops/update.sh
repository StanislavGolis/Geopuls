#!/usr/bin/env bash
# Обновление прода до нового коммита: распаковка архива исходников и пересборка.
#
#   ARCHIVE=/tmp/geopuls-src.tar.gz bash infra/ops/update.sh
#
# Данные и том БД не трогаются, .env остаётся на месте (архив его не содержит). Перед обновлением
# полезно снять бэкап: bash infra/ops/backup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/geopuls}"
ARCHIVE="${ARCHIVE:-/tmp/geopuls-src.tar.gz}"

log() { echo "[$(date -Is)] $*"; }

cd "$APP_DIR"
[ -f "$ARCHIVE" ] || { echo "нет архива $ARCHIVE" >&2; exit 1; }

log "бэкап перед обновлением"
bash infra/ops/backup.sh

log "распаковка исходников"
tar -xzf "$ARCHIVE" -C "$APP_DIR"
chmod +x infra/ops/*.sh backend/docker-entrypoint.sh 2>/dev/null || true

log "пересборка и запуск"
bash infra/ops/deploy.sh

log "проверка данных после обновления"
docker compose exec -T db psql -U "$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)" \
    -d "$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)" -t -A -c \
    "SELECT 'pois=' || count(*) FROM pois"
