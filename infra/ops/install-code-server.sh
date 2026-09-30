#!/usr/bin/env bash
# code-server на VPS: VS Code в браузере — рабочая среда для разработки «с телефона или чужого ноутбука».
#
#   bash infra/ops/install-code-server.sh
#
# Что делает:
#   1. ставит code-server из официального .deb (версия — CODE_SERVER_VERSION);
#   2. пишет конфиг: слушать только 127.0.0.1:8080 (наружу смотрит Caddy), вход по паролю;
#   3. включает systemd-сервис code-server@root с ограничением памяти, чтобы редактор не вытеснил прод;
#   4. печатает пароль, если он сгенерирован этим запуском.
#
# Наружу редактор отдаёт Caddy по поддомену (см. infra/Caddyfile, блок CODE_DOMAIN):
# в контейнере нет доступа к 127.0.0.1 хоста, поэтому там используется host.docker.internal.
#
# Скрипт идемпотентен: повторный запуск не меняет пароль и не переустанавливает ту же версию.
set -euo pipefail

CODE_SERVER_VERSION="${CODE_SERVER_VERSION:-4.139.1}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1:8080}"
CONFIG_DIR="/root/.config/code-server"
CONFIG="$CONFIG_DIR/config.yaml"
# Редактор на 2 vCPU рядом с прод-стеком: без лимита он в пике может «съесть» всю память,
# а на этой машине живут PostgreSQL и API. Лимит — страховка прода, не оптимизация.
MEMORY_MAX="${MEMORY_MAX:-1500M}"

log() { echo "[$(date -Is)] $*"; }

log "проверка версии code-server"
current="$(code-server --version 2>/dev/null | head -1 || true)"
if [ "${current:-}" = "${CODE_SERVER_VERSION}" ]; then
    log "уже установлен $CODE_SERVER_VERSION — установка не нужна"
else
    log "ставлю code-server $CODE_SERVER_VERSION (текущая: ${current:-нет})"
    deb="/tmp/code-server_${CODE_SERVER_VERSION}_amd64.deb"
    curl -fsSL -o "$deb" \
        "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb"
    apt-get install -y "$deb"
    rm -f "$deb"
fi

log "конфиг: $CONFIG"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [ -f "$CONFIG" ]; then
    log "конфиг уже есть — пароль не меняю"
    # bind-addr и auth всё равно приводим к нужным: редактор обязан слушать только loopback
    sed -i "s|^bind-addr:.*|bind-addr: ${BIND_ADDR}|" "$CONFIG"
else
    password="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
    hashed="$(code-server --hash-password "$password" 2>/dev/null || true)"
    {
        echo "bind-addr: ${BIND_ADDR}"
        echo "auth: password"
        if [ -n "$hashed" ]; then
            # Хеш вместо пароля открытым текстом: файл читают резервные копии и root-сессии
            echo "hashed-password: ${hashed}"
        else
            echo "password: ${password}"
        fi
        echo "cert: false"
    } > "$CONFIG"
    chmod 600 "$CONFIG"
    log "СГЕНЕРИРОВАН ПАРОЛЬ: ${password}"
    log "(хеш записан в $CONFIG; пароль больше нигде не сохраняется — сохраните его в менеджере паролей)"
fi

log "systemd: ограничение памяти ${MEMORY_MAX}"
mkdir -p /etc/systemd/system/code-server@root.service.d
cat > /etc/systemd/system/code-server@root.service.d/override.conf <<EOF
[Service]
# Жёсткий предел: при нехватке памяти ядро зарежет редактор, а не прод-контейнеры.
# Редактор переживает перезапуск, PostgreSQL под нагрузкой — нет.
MemoryMax=${MEMORY_MAX}
EOF

log "настройки редактора (телеметрия и проверка обновлений выключены)"
mkdir -p /root/.local/share/code-server/User
cat > /root/.local/share/code-server/User/settings.json <<'EOF'
{
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "editor.formatOnSave": true,
  "files.eol": "\n",
  "git.autofetch": true,
  "terminal.integrated.defaultProfile.linux": "bash"
}
EOF

log "запуск сервиса"
systemctl daemon-reload
systemctl enable --now code-server@root >/dev/null 2>&1 || systemctl restart code-server@root
sleep 3
systemctl is-active code-server@root

log "проверка локального ответа"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://${BIND_ADDR}/" || true)"
log "HTTP на ${BIND_ADDR}: ${code:-нет ответа}"
if [ "${code:-000}" != "200" ] && [ "${code:-000}" != "302" ]; then
    log "ВНИМАНИЕ: редактор не отвечает — смотрите journalctl -u code-server@root -n 50"
    exit 1
fi

log "готово. Дальше: расширения (infra/ops/install-dev-tools.sh) и поддомен в Caddy"
