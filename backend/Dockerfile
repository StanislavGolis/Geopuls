# syntax=docker/dockerfile:1

# ── Сборка зависимостей ──────────────────────────────────────────────────────
# pyosmium (чтение OSM PBF) для свежих версий Python может собираться из исходников,
# поэтому компилятор и заголовки нужны только на этом этапе — в рабочий образ они не попадают.
FROM python:3.14-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /uvx /bin/

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        build-essential cmake libexpat1-dev zlib1g-dev libbz2-dev \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

# Сначала зависимости — кэш слоёв не сбрасывается при изменении исходников
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-install-project --no-dev

COPY src ./src
RUN uv sync --locked --no-dev

# ── Рабочий образ ───────────────────────────────────────────────────────────
FROM python:3.14-slim AS runtime

# libexpat1 нужен расширению pyosmium (чтение OSM PBF) во время работы, а не только при сборке
RUN apt-get update \
    && apt-get install --no-install-recommends -y libexpat1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
# Проект установлен editable-установкой, поэтому исходники нужны и в рабочем образе
COPY --from=builder /app/src /app/src

# Миграции и точка входа: без них контейнер не сможет подготовить БД при старте
COPY alembic.ini ./
COPY migrations ./migrations
COPY docker-entrypoint.sh ./docker-entrypoint.sh
# sed: на Windows файл может попасть в контекст сборки с CRLF и сломать shebang
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

RUN useradd --create-home --shell /usr/sbin/nologin app && chown -R app:app /app
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["uvicorn", "geopuls.main:app", "--host", "0.0.0.0", "--port", "8000"]

