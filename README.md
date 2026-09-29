# ГЕОПУЛЬС

Веб-сервис тепловых карт плотности организаций по городам России. Помогает предпринимателю малого
бизнеса визуально оценить конкурентную среду и выбрать район для открытия точки — в малых и средних
городах, куда не доходят Яндекс Геоаналитика и 2ГИС Про.

**Позиционирование:** «Карта пустых зон. Не прогноз трафика, а ответ на вопрос — где уже есть бизнес,
а где его нет».

**Формула:** открытые данные (OSM, Geofabrik) → полная H3-сетка города → плотность POI по ячейкам →
тепловая карта → список POI → решение о локации.

## Статус

MVP собран и развёрнут на проде: **https://201.34.158.13.sslip.io** (HTTPS, Let's Encrypt; мониторинг,
бэкапы и расписание обновления данных — в cron). Релиз — тег **`v0.1.0-mvp`**. См. `docs/deploy.md`
и `docs/acceptance/`.

- [x] Каркас репозитория, Docker Compose, CI, `.gitignore` / `.gitattributes`
- [x] ТЗ v0.2 (`docs/tz.md`) с исправленными источником данных, метрикой и подложкой карты
- [x] Backend: FastAPI `/healthz`, `/readyz`, `/version`
- [x] **Этап 0.5: разведка данных OSM по Томску** — категории MVP утверждены, риск пустых категорий снят (`docs/recon/`)
- [x] **Этап 1: модель данных** — 8 таблиц, Alembic-миграции (PostGIS), сид категорий и Томска; CI проверяет `alembic check`
- [x] **Этап 2: импорт OSM** — один проход по выгрузке Geofabrik (557 МБ) → 2 100 POI по 8 категориям с H3-индексами, мягкое удаление, журнал импортов
- [x] **Этап 3: агрегация H3** — полная сетка города (1 507 ячеек res 9, включая пустые), плотность POI/км² и доля адресов по ячейкам; 78% ячеек пустые
- [x] **Этап 4: API** — `/api/v1/meta/cities`, `/meta/categories`, `/cells` (GeoJSON + `meta.density_breaks`), `/pois`; ETag/304, gzip, ошибки RFC 9457 (`docs/decisions/0007-api-contract.md`)
- [x] **Этап 5: фронтенд на реальных данных** — карта берёт сетку из API, легенда из `density_breaks`, res 8/9 по зуму, состояния загрузки/пустоты/ошибки, мобильная вёрстка; рендеринг проверен в реальном браузере (E2E Playwright) — `docs/decisions/0008-frontend.md`, `0009-maplibre-in-next.md`
- [x] **Этап 6: клик по ячейке, ссылка и экспорт** — список объектов ячейки из `/api/v1/pois`, подсветка выбранной ячейки, состояние в URL (`city`, `category`, `cell`, `res`, `zoom`, `center`) и кнопка «Поделиться», экспорт PNG (с атрибуцией) и CSV всей сетки (`docs/decisions/0010-share-export.md`)
- [x] **Этап 7 (частично): дизайн-спека внедрена** — токены и типографика, светлая шапка, палитра YlOrRd с числом классов как параметром, постоянная строка атрибуции, состояния (скелетон, офлайн, 503), мобильные чипы и свёрнутая легенда, доступность (`docs/decisions/0012-ui-style-tokens.md`)
- [x] **Этап 7: эксплуатация и прод** — команда обновления данных `geopuls.refresh` (идемпотентна, тест), бэкап БД и проверка восстановления со сверкой строк, нагрузочный прогон и Lighthouse, прод за Caddy (HTTPS, мониторинг в cron, расписание обновления, авто-бэкапы) — `docs/deploy.md`, `docs/acceptance/`

## API (кратко)

```bash
curl "http://localhost:8000/api/v1/meta/cities"
curl "http://localhost:8000/api/v1/meta/categories"
curl "http://localhost:8000/api/v1/cells?city=tomsk&category=cafe"          # GeoJSON, 59 КБ gzip
curl "http://localhost:8000/api/v1/cells?city=tomsk&category=cafe&res=8"    # обзорный слой
curl "http://localhost:8000/api/v1/pois?city=tomsk&cell=890b80db643ffff"    # объекты ячейки
```

Документация и схема — `http://localhost:8000/docs` (OpenAPI). Полное описание контракта, кодов
ответов и кэширования — `docs/tz.md`, раздел 7.

## Документация

| Документ | Что внутри |
|---|---|
| [`docs/tz.md`](docs/tz.md) | ТЗ v0.2 — источники и лицензии данных, расчёты, схема данных, API, НФТ, инфраструктура, этапы, риски |
| [`docs/recon/`](docs/recon) | Разведка данных: покрытие OSM по Томску (сырые числа) и решение по категориям MVP |
| [`docs/design/design.md`](docs/design/design.md) | Дизайн-спека v0.2: токены, типографика, компоненты, состояния, мобильная версия, чек-лист реализации |
| [`docs/acceptance/`](docs/acceptance) | Отчёты приёмки: бэкап и восстановление БД, нагрузочный прогон, Lighthouse, прод-развёртывание |
| [`docs/deploy.md`](docs/deploy.md) | Развёртывание и эксплуатация на сервере: деплой, обновление, домен и TLS, бэкапы, мониторинг, cron, безопасность |
| [`docs/decisions/`](docs/decisions) | ADR: стек и версии, подложка карты, источники данных, граница города, импорт POI, агрегация H3, контракт API, фронтенд, сборка MapLibre в Next, ссылки и экспорт, контейнеры, стили интерфейса, слои карты |
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
npm run test                  # vitest: раскраска, клиент API, легенда, состояния
npm run test:e2e              # Playwright: реальный рендеринг карты (нужен запущенный стек)
npm run dev
# → http://localhost:3000
```

Живые тесты фронтенда против запущенного API (проверяют связку «компонент → HTTP → бэкенд»):

```bash
cd backend && uv run uvicorn geopuls.main:app --port 8000      # в отдельном терминале
cd frontend && GEOPULS_LIVE_API_URL=http://127.0.0.1:8000 npm run test
```

Либо весь локальный стек одной командой (БД в Docker + API и фронтенд нативно, с логами в `data/processed/`):

```powershell
pwsh -File tools/dev-up.ps1      # поднимает БД, API и фронтенд, печатает ссылки
pwsh -File tools/dev-down.ps1    # останавливает
```

## Весь стек в контейнерах

Одна команда собирает и поднимает всё: PostgreSQL + PostGIS, API и фронтенд.

```powershell
pwsh -File tools/docker-up.ps1       # сборка образов + запуск + ожидание готовности
# Карта: http://localhost:3000/?city=tomsk&category=cafe
# API:   http://127.0.0.1:8000/docs
pwsh -File tools/docker-down.ps1     # остановка (данные БД сохраняются)
pwsh -File tools/docker-down.ps1 -Purge   # остановка и удаление тома с данными
```

Обновление данных и резервные копии:

```powershell
pwsh -File tools/refresh-data.ps1 -Pbf data\raw\siberian-fed-district-260927.osm.pbf  # справочники → POI → агрегация
pwsh -File tools/refresh-data.ps1 -SkipImport                                          # только пересобрать агрегаты
pwsh -File tools/db-backup.ps1                                                         # дамп в data/backups, ротация 14 дней
pwsh -File tools/db-restore.ps1 -Dump data/backups/<файл>.dump                          # восстановление + сверка строк
```

Что происходит при запуске:

- `db` — PostgreSQL 17 + PostGIS 3.5, данные в томе `pgdata`;
- `api` — при старте применяет миграции Alembic и идемпотентно сидирует справочник категорий
  (`backend/docker-entrypoint.sh`), затем поднимает Uvicorn; готовность проверяется `/healthz`;
- `web` — Next.js (standalone-сборка), стартует только после healthy-API.

Порты настраиваются через `.env` (`API_PORT`, `WEB_PORT`) — CORS API и адрес API для фронтенда
следуют за ними. Прод-профиль с автоматическим HTTPS: `pwsh -File tools/docker-up.ps1 -Prod`
(Caddy на 80/443, домен в `DOMAIN`).

Данные OSM в контейнеры не входят: на свежем томе поднимается пустая сетка (категории уже есть).
Город и объекты загружаются одной командой из данных на хосте (папка `data/` смонтирована в `/data`):

```powershell
docker compose run --rm api python -m geopuls.seed --city tomsk --city-name Томск `
  --region "Томская область" --timezone Asia/Tomsk --boundary-file /data/raw/tomsk-boundary.json
docker compose run --rm api python -m geopuls.importers.poi --pbf /data/raw/siberian-fed-district-latest.osm.pbf
docker compose run --rm api python -m geopuls.aggregate --city tomsk
```

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
