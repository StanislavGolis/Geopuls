#!/usr/bin/env bash
# Развёртывание с нуля: Docker → архив коммита → .env → сборка и запуск → данные из дампа.
#
# Скрипт выполняется на СЕРВЕРЕ. Архив и .env готовятся локально (docs/deploy.md, раздел «Первый деплой»).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/geopuls}"
ARCHIVE="${ARCHIVE:-/tmp/geopuls-src.tar.gz}"
DUMP="${DUMP:-}"

log() { echo "[$(date -Is)] $*"; }

[ -d "$APP_DIR" ] || { echo "нет каталога $APP_DIR" >&2; exit 1; }
cd "$APP_DIR"

[ -f .env ] || { echo "нет $APP_DIR/.env" >&2; exit 1; }

log "1/4 распаковываю исходники в $APP_DIR"
tar -xzf "$ARCHIVE" -C "$APP_DIR"
chmod +x infra/ops/*.sh

log "2/4 сборка и запуск прод-профиля"
bash infra/ops/deploy.sh

if [ -n "$DUMP" ]; then
    log "3/4 загружаю данные из дампа: $DUMP"
    docker compose cp "$DUMP" db:/tmp/geopuls-init.dump
    docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists --exit-on-error /tmp/geopuls-init.dump'
    docker compose exec -T db rm -f /tmp/geopuls-init.dump
    log "данные восстановлены"
else
    log "3/4 дамп не передан — данные нужно загрузить отдельно (infra/ops/refresh-data.sh)"
fi

log "4/4 установка cron"
mkdir -p /var/log/geopuls
install -m 644 infra/ops/cron.geopuls /etc/cron.d/geopuls
log "готово"
