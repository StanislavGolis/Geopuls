# ГЕОПУЛЬС — frontend (Next.js + MapLibre)

Карта с тепловым слоем H3. На Этапе 0 тепловой слой строится на **демо-данных**, вычисленных
в браузере (`h3-js`), — это проверяет связку MapLibre + H3 до появления API.

## Локальный запуск

```bash
npm install
cp ../.env.example .env.local      # NEXT_PUBLIC_* переменные
npm run dev                        # http://localhost:3000
npm run typecheck                  # tsc --noEmit
npm run build                      # прод-сборка (standalone для Docker)
```

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | адрес API | `http://localhost:8000` |
| `NEXT_PUBLIC_BASEMAP_STYLE_URL` | стиль подложки MapLibre | OpenFreeMap Liberty |
| `NEXT_PUBLIC_DATA_VERSION` | подпись «данные на <дата>» | `демо-данные (Этап 0)` |

## Что уже реализовано

- `app/page.tsx` — экран карты: селекторы города и категории, плашка данных, дисклеймер, атрибуция.
- `components/MapView.tsx` — MapLibre + H3 res 9: 169 демо-ячеек вокруг Томска, раскраска по
  плотности, клик по ячейке, легенда с абсолютными значениями и отдельным цветом для нуля,
  устойчивость к недоступной подложке.
- `lib/api.ts` — обёртка запросов к API.

## Что дальше (по docs/tz.md)

- Этап 4: заменить демо-слой на данные `/api/v1/cells` (плотность, `data_version`).
- Этап 5: переключение res 8/9 по зуму, мобильный bottom sheet, витрина состояний загрузки/ошибки.
- Этап 6: список POI по клику (`/api/v1/pois`), shareable URL, экспорт PNG/CSV.

## Лицензии

Карта: данные © OpenStreetMap contributors (ODbL). Подложка: OpenFreeMap © OpenMapTiles.
Атрибуция обязательна — не удаляйте её из интерфейса и экспортов.
