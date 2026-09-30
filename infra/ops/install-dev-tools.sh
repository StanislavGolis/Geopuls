#!/usr/bin/env bash
# Инструменты разработки на VPS для code-server: Node.js (фронтенд), uv (бэкенд), PowerShell (tools/*.ps1),
# рабочая копия репозитория и расширения редактора.
#
#   bash infra/ops/install-dev-tools.sh
#
# Зачем: code-server — только редактор. Чтобы продолжать разработку с телефона или чужого ноутбука, на
# сервере должны быть наши инструменты: pytest и ruff через uv, next и vitest через node, а tools/*.ps1 —
# через pwsh. Прод-копия в /opt/geopuls — это распакованный архив без git-истории, поэтому для работы
# клонируется отдельная копия репозитория (по умолчанию /root/work/Geopuls).
#
# Скрипт идемпотентен: уже установленное не переустанавливается, клон репозитория только обновляется.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/StanislavGolis/Geopuls.git}"
WORK_DIR="${WORK_DIR:-/root/work}"
PWSH_VERSION="${PWSH_VERSION:-7.6.6}"
GIT_USER_NAME="${GIT_USER_NAME:-StanislavGolis}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-stanislav.golis@yandex.ru}"
EXTENSIONS=(
    saoudrizwan.claude-dev   # Cline — агент, которым пользуемся
    ms-python.python         # Python: тесты и отладка бэкенда
    charliermarsh.ruff       # ruff: линтер и форматтер бэкенда
    dbaeumer.vscode-eslint   # eslint: линтер фронтенда
)

log() { echo "[$(date -Is)] $*"; }

log "Node.js и npm (фронтенд: next, vitest)"
if ! command -v node >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm >/dev/null
fi
log "node $(node --version), npm $(npm --version)"

log "uv (бэкенд: pytest, ruff — в окружении проекта)"
if [ ! -x /root/.local/bin/uv ]; then
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
fi
# Сервис code-server запущен systemd и про ~/.local/bin не знает: кладём симлинк в системный PATH
ln -sf /root/.local/bin/uv /usr/local/bin/uv
log "uv $(uv --version)"

log "PowerShell (tools/*.ps1 — наши скрипты проверки и деплоя)"
if ! command -v pwsh >/dev/null 2>&1; then
    deb="/tmp/powershell_${PWSH_VERSION}-1.deb_amd64.deb"
    curl -fsSL -o "$deb" \
        "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell_${PWSH_VERSION}-1.deb_amd64.deb"
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$deb" >/dev/null
    rm -f "$deb"
fi
log "pwsh $(pwsh -NoLogo -Command '$PSVersionTable.PSVersion.ToString()')"

log "рабочая копия репозитория: ${WORK_DIR}/Geopuls"
mkdir -p "$WORK_DIR"
if [ -d "${WORK_DIR}/Geopuls/.git" ]; then
    git -C "${WORK_DIR}/Geopuls" fetch --all --prune
else
    git clone "$REPO_URL" "${WORK_DIR}/Geopuls"
fi
git -C "${WORK_DIR}/Geopuls" config user.name "$GIT_USER_NAME"
git -C "${WORK_DIR}/Geopuls" config user.email "$GIT_USER_EMAIL"
log "коммит в рабочей копии: $(git -C "${WORK_DIR}/Geopuls" rev-parse --short HEAD)"

log "расширения редактора (маркетплейс Open VSX)"
for extension in "${EXTENSIONS[@]}"; do
    if code-server --install-extension "$extension" --force >/dev/null 2>&1; then
        log "  ок: ${extension}"
    else
        log "  ПРОПУСК: ${extension} (поставьте из интерфейса, если нужно)"
    fi
done

log "перезапуск редактора, чтобы расширения подхватились"
systemctl restart code-server@root
sleep 3
systemctl is-active code-server@root
log "готово. Рабочая папка: ${WORK_DIR}/Geopuls; вход: https://code.<домен>/"
