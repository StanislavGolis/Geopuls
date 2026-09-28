# ГЕОПУЛЬС

Веб-сервис тепловых карт плотности организаций по городам России. Помогает предпринимателю малого
бизнеса визуально оценить конкурентную среду и выбрать район для открытия точки — в малых и средних
городах, куда не доходят Яндекс Геоаналитика и 2ГИС Про.

**Позиционирование:** «Карта пустых зон. Не прогноз трафика, а ответ на вопрос — где уже есть бизнес,
а где его нет».

**Формула:** открытые данные (OSM, Geofabrik) → полная H3-сетка города → плотность POI по ячейкам →
тепловая карта → список POI → решение о локации.

## Статус

Этап 0 (каркас) и Этап 0.5 (разведка данных) закрыты. Продуктовый код (импортёр, агрегация,
API-данные) ещё не реализован.

- [x] Каркас репозитория, Docker Compose, CI, `.gitignore` / `.gitattributes`
- [x] ТЗ v0.2 (`docs/tz.md`) с исправленными источником данных, метрикой и подложкой карты
- [x] Backend: FastAPI `/healthz`, `/readyz`, `/version`
- [x] **Этап 0.5: разведка данных OSM по Томску** — категории MVP утверждены, риск пустых категорий снят (`docs/recon/`)
- [x] Фронтенд: MapLibre + демо-тепловой слой H3 res 9 (реальные данные — Этап 4)
- [ ] Модель данных и миграции (Alembic) — Этап 1
- [ ] Импорт OSM (Geofabrik PBF) — Этап 2
- [ ] Агрегация H3 — Этап 3
- [ ] API `/cells`, `/pois` — Этап 4
- [ ] Клик по ячейке → список POI — Этап 6

## Документация

| Документ | Что внутри |
|---|---|
| [`docs/tz.md`](docs/tz.md) | ТЗ v0.2 — источники и лицензии данных, расчёты, схема данных, API, НФТ, инфраструктура, этапы, риски |
| [`docs/recon/`](docs/recon) | Разведка данных: покрытие OSM по Томску (сырые числа) и решение по категориям MVP |
| [`docs/decisions/`](docs/decisions) | ADR: стек и версии, подложка карты, источник данных |
| [`docs/archive/tz-v0.1.md`](docs/archive/tz-v0.1.md) | Исходное ТЗ v0.1 (без изменений, для истории) |

## Технологический стек (кратко)

| Слой | Решение | Почему |
|---|---|---|
| Данные | Geofabrik PBF/GPKG (Сибирский ФО), Overpass API — резерв | Детерминированная версия выгрузки, нет лимитов и падений Overpass |
| Хранение | PostgreSQL 17 + PostGIS 3.5 | Точный радиус (`ST_DWithin`), клип по полигону города, хранение точек в `GEOGRAPHY` |
| Агрегация | H3 res 9 (`h3-py` 4.5) | Ячейка ≈ 200 м по ребру; ядро H3 4.5 совпадает с фронтендом |
| API | FastAPI + SQLAlchemy 2.0 (async) + Alembic + Pydantic v2 | Быстрый старт, типизация, миграции |
| Фронтенд | Next.js 16 + TypeScript + MapLibre GL JS 6 + `h3-js` 4.5 | Тепловой слой H3, MapLibre без токена, задел под SEO-лендинг |
| Подложка карты | MVP — OpenFreeMap; прод — self-host PMTiles (Protomaps) | `tile.openstreetmap.org` запрещён для продакшена коммерческих сервисов |
| Инфра | Docker Compose, Caddy (TLS), PostgreSQL-бэкапы | Один VPS, автоматический HTTPS |

## Быстрый старт

Требуется Docker (проверено на Docker 29) и Node.js LTS.

```bash
cp .env.example .env          # задать пароли и домен
docker compose up -d db       # PostgreSQL 17 + PostGIS 3.5

# backend
cd backend
uv sync                       # создаёт .venv и ставит зависимости по uv.lock
uv run pytest                 # тесты
uv run uvicorn geopuls.main:app --reload --port 8000
# → http://localhost:8000/healthz

# frontend
cd ../frontend
npm install
npm run dev
# → http://localhost:3000
```

Полный стек в контейнерах: `docker compose up --build` (db + api + web + caddy).

## Структура репозитория

```
backend/        FastAPI-приложение (src-layout, uv, pytest, ruff)
  src/geopuls/  код приложения (config, main, api/)
  tests/        тесты
frontend/       Next.js 16 + MapLibre (app/, components/, lib/)
infra/          Caddyfile и прочая инфраструктура
docs/           ТЗ и ADR
data/raw/       выгрузки OSM (в git не коммитятся)
```

## Лицензии и атрибуция

- Данные © OpenStreetMap contributors, лицензия **ODbL 1.0**. Атрибуция обязательна на карте, в отчётах и в экспортах.
- Подложка OpenFreeMap: атрибуция «OpenFreeMap © OpenMapTiles Data from OpenStreetMap» (MapLibre подставляет автоматически).
- Парсинг 2ГИС, Яндекс.Карт и Google Maps не используется ни в каком виде.
- Код проекта — проприетарный, все права защищены (см. `LICENSE`).
