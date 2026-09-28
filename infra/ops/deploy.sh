#!/usr/bin/env bash
# Развёртывание ГЕОПУЛЬС на сервере: сборка образов и запуск прод-профиля (Caddy + автоматический TLS).
#
#   bash infra/ops/deploy.sh
#
# Требуется .env в корне репозитория (см. .env.example и docs/deploy.md). Наружу открыты только 80/443
# у Caddy: БД, API и фронтенд публикуются на 127.0.0.1 (см. docker-compose.yml).
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] || { echo "нет файла .env — скопируйте .env.example и заполните (docs/deploy.md)" >&2; exit 1; }

DOMAIN="$(grep -E '^DOMAIN=' .env | tail -1 | cut -d= -f2-)"
echo "[$(date -Is)] домен: ${DOMAIN:-не задан}"
echo "[$(date -Is)] 1/3 сборка образов (первый раз — несколько минут: зависимости + сборка Next)"
docker compose --profile prod build

echo "[$(date -Is)] 2/3 запуск контейнеров"
docker compose --profile prod up -d

echo "[$(date -Is)] 3/3 ожидание готовности db → api → web"
for _ in $(seq 1 60); do
    healthy="$(docker compose ps --format '{{.Status}}' | grep -c '(healthy)' || true)"
    [ "$healthy" -ge 3 ] && break
    sleep 5
done

docker compose ps

if [ "$healthy" -lt 3 ]; then
    echo "[$(date -Is)] стек поднялся не полностью, логи:" >&2
    docker compose logs --tail 50 >&2
    exit 1
fi

echo "[$(date -Is)] 4/4 проверка публичных эндпоинтов"
curl -fsS -m 20 "https://$DOMAIN/healthz" && echo "  /healthz — ок"
curl -fsS -m 20 "https://$DOMAIN/readyz" && echo "  /readyz — ок"
echo "[$(date -Is)] развёртывание завершено: https://$DOMAIN/"
