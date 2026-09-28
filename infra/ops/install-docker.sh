#!/usr/bin/env bash
# Установка Docker и плагина compose на чистый сервер (один раз, от root).
#
#   bash infra/ops/install-docker.sh
#
# Скрипт официальный (get.docker.com), ничего не меняет в репозитории.
set -euo pipefail

if command -v docker >/dev/null 2>&1; then
    echo "Docker уже установлен: $(docker --version)"
    docker compose version || true
    exit 0
fi

echo "=== Устанавливаю Docker (официальный скрипт) ==="
curl -fsSL https://get.docker.com | sh

systemctl enable --now docker

echo
docker --version
docker compose version
echo
echo "Готово. Проверка: docker run --rm hello-world"
