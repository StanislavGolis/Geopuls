# ГЕОПУЛЬС — backend (FastAPI)

Служебный каркас API (Этап 0). Реализованы `/healthz`, `/readyz`, `/version`;
данные, модель и контракты — по `docs/tz.md` (разделы 6–7).

## Локальный запуск

```bash
uv sync                                             # создаёт .venv и uv.lock
uv run pytest                                       # тесты (БД не нужна)
uv run ruff check .                                 # линтер
uv run uvicorn geopuls.main:app --reload --port 8000
```

Требуется Python 3.14 (см. `.python-version`) и `uv`.

## Конфигурация

Все переменные — с префиксом `GEOPULS_`, читаются из окружения или из `.env`:

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `GEOPULS_DATABASE_URL` | DSN SQLAlchemy (async) | `postgresql+asyncpg://geopuls:geopuls@localhost:5432/geopuls` |
| `GEOPULS_ENVIRONMENT` | окружение (`local` / `production`) | `local` |
| `GEOPULS_LOG_LEVEL` | уровень логов | `INFO` |
| `GEOPULS_GIT_SHA` | коммит сборки, отдаётся в `/version` | — |
| `GEOPULS_CORS_ORIGINS` | JSON-массив origin'ов фронтенда | `["http://localhost:3000"]` |
| `GEOPULS_GEOFABRIK_PBF_URL` | выгрузка OSM (см. ADR 0003) | Siberian FD |
| `GEOPULS_BASEMAP_STYLE_URL` | стиль подложки для фронтенда | OpenFreeMap Liberty |

## Эндпоинты

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/healthz` | `{"status": "ok"}` — без обращения к БД |
| GET | `/readyz` | 200 либо 503 с причиной (`database: error`) |
| GET | `/version` | версии приложения, Python и ядра H3 |
| GET | `/docs` | OpenAPI-документация |

## Тесты

```bash
uv run pytest                      # юнит-тесты, БД не нужна; интеграционные пропускаются
```

Интеграционные тесты (сид, схема, импорт POI) работают на **отдельной** базе: они чистят таблицы,
поэтому `conftest.py` откажется запускать их против базы без `test` в имени.

```powershell
# из корня репозитория: создаёт geopuls_test и применяет миграции
pwsh -File tools/init-test-db.ps1

cd backend
$env:GEOPULS_CI_DB='1'
uv run pytest                      # интеграционные тесты на geopuls_test
```

Свою базу можно указать явно: `$env:GEOPULS_TEST_DATABASE_URL='postgresql+asyncpg://...'` (имя базы
обязательно должно содержать `test`).

## Docker

```bash
docker build -t geopuls-api ./backend          # требует uv.lock в контексте
docker run --rm -p 8000:8000 geopuls-api
```

`/readyz` в контейнере вернёт 503, пока не задан `GEOPULS_DATABASE_URL` — это ожидаемое поведение.
