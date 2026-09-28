# ГЕОПУЛЬС — frontend (Next.js + MapLibre)

Карта теплового слоя плотности организаций: данные приходят из API ГЕОПУЛЬС
(`/api/v1/cells`), цвета — по классам, которые считает бэкенд.

## Локальный запуск

```bash
npm install
cp ../.env.example .env.local      # NEXT_PUBLIC_* переменные
npm run dev                        # http://localhost:3000
npm run typecheck                  # tsc --noEmit
npm run test                       # vitest
npm run build                      # прод-сборка (standalone для Docker)
```

Нужен запущенный API: `cd ../backend && uv run uvicorn geopuls.main:app --port 8000`
(в `.env.local` укажите `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`).

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | адрес API | `http://localhost:8000` |
| `NEXT_PUBLIC_BASEMAP_STYLE_URL` | стиль подложки MapLibre | OpenFreeMap Liberty |
| `GEOPULS_LIVE_API_URL` | включает «живые» тесты против реального API | — (тесты пропускаются) |

## Структура

| Файл | Что делает |
|---|---|
| `components/MapExplorer.tsx` | состояние города/категории/разрешения, загрузка данных, состояния (загрузка, пустота, ошибка, повтор) |
| `components/MapView.tsx` | MapLibre: тепловой слой H3, раскраска, сообщение разрешения по зуму |
| `components/Legend.tsx` | классы плотности, предупреждение о неполноте данных, единицы измерения |
| `lib/heat.ts` | раскраска и классы (чистые функции), выбор разрешения по зуму |
| `lib/api.ts` | клиент API, разбор ошибок RFC 9457 в `ApiError` |

## Тесты

```bash
npm run test                                        # 26 тестов; живые пропускаются
GEOPULS_LIVE_API_URL=http://127.0.0.1:8000 npm run test   # + 5 живых тестов против API
```

«Живые» тесты проверяют связку «компонент → HTTP → бэкенд» без моков (реальные города, сетка
Томска, объекты ячейки, разбор 404). Если переменная задана, а бэкенд недоступен, тесты падают —
это осознанно: opt-in означает «проверь мою связку с API».

Ограничение: рендеринг MapLibre в jsdom не проверяется (нет WebGL) — визуальная проверка карты
ручная, см. `docs/decisions/0008-frontend.md`.

## Лицензии

Карта: данные © OpenStreetMap contributors (ODbL). Подложка: OpenFreeMap © OpenMapTiles.
Атрибуция обязательна — не удаляйте её из интерфейса и экспортов.
