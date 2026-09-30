#!/usr/bin/env bash
# Деплой текущего коммита рабочей копии на прод — то же, что делает tools/deploy.ps1 с ноутбука,
# но запускается прямо на сервере: удобно из терминала code-server, когда работаешь не со своей машины.
#
#   bash infra/ops/deploy-from-worktree.sh
#
# Почему отдельный скрипт: tools/deploy.ps1 собирает архив у разработчика и заливает его по SFTP.
# На сервере архив уже лежит рядом — достаточно `git archive` из рабочей копии, дальше стандартный
# update.sh (бэкап → распаковка в /opt/geopuls → пересборка → проверка публичного адреса).
set -euo pipefail

WORK_DIR="${WORK_DIR:-/root/work/Geopuls}"
APP_DIR="${APP_DIR:-/opt/geopuls}"
ARCHIVE="${ARCHIVE:-/tmp/geopuls-src.tar.gz}"

log() { echo "[$(date -Is)] $*"; }

[ -d "$WORK_DIR/.git" ] || { echo "нет рабочей копии $WORK_DIR" >&2; exit 1; }

# Незакоммиченное в архив не попадёт: деплоить «что-то своё, но не в git» — верный способ потерять,
# что именно сейчас на проде.
if [ -n "$(git -C "$WORK_DIR" status --porcelain)" ]; then
    log "ВНИМАНИЕ: в рабочей копии есть незакоммиченные изменения — в архив попадёт только HEAD"
    git -C "$WORK_DIR" status --short | head -10
    exit 2
fi

head_sha="$(git -C "$WORK_DIR" rev-parse --short HEAD)"
log "деплой коммита ${head_sha} из ${WORK_DIR}"
git -C "$WORK_DIR" archive --format=tar.gz -o "$ARCHIVE" HEAD
log "архив: $(du -h "$ARCHIVE" | cut -f1)"

ARCHIVE="$ARCHIVE" APP_DIR="$APP_DIR" bash "$APP_DIR/infra/ops/update.sh"

log "готово. Не забудьте: git push origin main (иначе коммит есть только на сервере)"
