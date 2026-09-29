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

# Версия из архива: `git archive` подставляет в VERSION коммит и ссылку, из которых собран архив
# (см. .gitattributes), поэтому /version на сервере не приходится проставлять руками.
if [ -f VERSION ]; then
    archive_commit="$(sed -n 's/^commit=//p' VERSION | head -1)"
    archive_refs="$(sed -n 's/^refs=//p' VERSION | head -1)"
    log "версия из архива: ${archive_commit}${archive_refs}"
    if [ -n "$archive_commit" ] && [ -f .env ]; then
        if grep -q '^GEOPULS_GIT_SHA=' .env; then
            sed -i "s/^GEOPULS_GIT_SHA=.*/GEOPULS_GIT_SHA=${archive_commit}/" .env
        else
            echo "GEOPULS_GIT_SHA=${archive_commit}" >> .env
        fi
    fi
fi

log "пересборка и запуск"
bash infra/ops/deploy.sh

# Caddy держит соединение с контейнером API по имени, а после пересоздания api получает новый адрес:
# без перезапуска прокси какое-то время отдаёт 502 (проверено на проде). Перезапускаем и проверяем снова.
log "перезапуск Caddy после пересоздания api"
docker compose restart caddy >/dev/null 2>&1 || true
sleep 3
domain="$(grep -E '^DOMAIN=' .env | tail -1 | cut -d= -f2-)"
if [ -n "$domain" ]; then
    curl -fsS -m 20 "https://$domain/healthz" >/dev/null && log "публичный адрес отвечает после обновления" \
        || log "ВНИМАНИЕ: публичный адрес не ответил — проверьте Caddy вручную"
fi

log "проверка данных после обновления"
docker compose exec -T db psql -U "$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)" \
    -d "$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)" -t -A -c \
    "SELECT 'pois=' || count(*) FROM pois"
