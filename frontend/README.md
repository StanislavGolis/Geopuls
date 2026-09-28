# ГЕОПУЛЬС — frontend (Next.js + MapLibre)

Карта теплового слоя плотности организаций: данные приходят из API ГЕОПУЛЬС
(`/api/v1/cells`), цвета — по классам, которые считает бэкенд.

## Локальный запуск

```bash
npm install
cp ../.env.example .env.local      # NEXT_PUBLIC_* переменные
npm run dev                        # http://localhost:3000 (перед запуском копирует воркер MapLibre)
npm run typecheck                  # tsc --noEmit
npm run test                       # vitest
npm run build                      # прод-сборка (standalone для Docker)
npm run test:e2e                   # Playwright: реальный рендеринг карты (нужен запущенный стек)
```

Нужен запущенный API: `cd ../backend && uv run uvicorn geopuls.main:app --port 8000`
(в `.env.local` укажите `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`).

Перед `dev`/`build` скрипт `scripts/copy-maplibre-worker.mjs` копирует воркер MapLibre и его
shared-модуль в `public/` — без этого библиотека не находит свой воркер в сборке Next (Turbopack),
и карта остаётся пустой. Файлы генерируются, в git не хранятся (см. ADR 0009).

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | адрес API | `http://localhost:8000` |
| `NEXT_PUBLIC_BASEMAP_STYLE_URL` | стиль подложки MapLibre | OpenFreeMap Liberty |
| `GEOPULS_LIVE_API_URL` | включает «живые» тесты против реального API | — (тесты пропускаются) |
| `GEOPULS_WEB_URL` | адрес проверяемого фронтенда для E2E | `http://localhost:3000` |

## Структура

| Файл | Что делает |
|---|---|
| `components/MapExplorer.tsx` | состояние города/категории/разрешения, загрузка данных, состояния (загрузка, пустота, ошибка, повтор) |
| `components/MapView.tsx` | MapLibre: тепловой слой H3, раскраска, сообщение разрешения по зуму, деградация без подложки и WebGL2 |
| `components/Legend.tsx` | классы плотности, предупреждение о неполноте данных, единицы измерения |
| `lib/heat.ts` | раскраска и классы (чистые функции), выбор разрешения по зуму |
| `lib/api.ts` | клиент API, разбор ошибок RFC 9457 в `ApiError` |
| `scripts/copy-maplibre-worker.mjs` | копирует воркер MapLibre в `public/` перед `dev`/`build` |
| `e2e/map.smoke.spec.ts` | E2E-проверки карты в реальном браузере (Playwright) |

## Тесты

```bash
npm run test                                             # 30 тестов; живые пропускаются
GEOPULS_LIVE_API_URL=http://127.0.0.1:8000 npm run test   # + 5 живых тестов против API
npx playwright install chromium                          # один раз: браузер для E2E
npm run test:e2e                                         # E2E против http://localhost:3000
```

«Живые» тесты проверяют связку «компонент → HTTP → бэкенд» без моков (реальные города, сетка
Томска, объекты ячейки, разбор 404). Если переменная задана, а бэкенд недоступен, тесты падают —
это осознанно: opt-in означает «проверь мою связку с API».

E2E требует запущенного стека (API на 8000 и web на 3000): проверяются подложка, тепловой слой,
тайлы, размер канваса и отсутствие ошибок в консоли. Проверка идёт в реальном Chromium с
программным WebGL, поэтому покрывает то, что jsdom не умеет.

## Если карта пустая

1. Откройте страницу с `?debug=1` — в консоли появится `window.__geopulsMap` (в продакшене ссылка
   отдаётся только с этим флагом).
2. Проверьте в консоли:
   `__geopulsMap.getLayer('cells-fill')` — слой добавлен;
   `__geopulsMap.querySourceFeatures('cells').length` — данные дошли до источника;
   `__geopulsMap.getStyle().layers.length` — стиль подложки загружен.
3. Если есть сообщение `Worker failed to load` — не скопированы файлы воркера:
   `node scripts/copy-maplibre-worker.mjs` и перезапуск dev-сервера.
4. Если показан баннер «подложка недоступна» — работает тепловой слой, но нет тайлов: проверьте
   сеть до провайдера подложки (или `NEXT_PUBLIC_BASEMAP_STYLE_URL`).
5. Если страница сообщает об отсутствии WebGL2 — включите аппаратное ускорение в браузере.

Подробности разбора — `docs/decisions/0009-maplibre-in-next.md`.

## Лицензии

Карта: данные © OpenStreetMap contributors (ODbL). Подложка: OpenFreeMap © OpenMapTiles.
Атрибуция обязательна — не удаляйте её из интерфейса и экспортов.
