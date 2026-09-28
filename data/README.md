# Данные

Исходные выгрузки OSM **не коммитятся** (`.gitignore`: `data/raw/*`, `*.osm.pbf`): файл
Сибирского ФО — 557 МБ и обновляется ежедневно.

## Загрузка выгрузки

```powershell
# PowerShell (Windows/macOS/Linux)
pwsh -File tools/fetch-osm-extract.ps1 -OutFile data/raw/siberian-fed-district-260927.osm.pbf
```

Скрипт скачивает файл 16 параллельными диапазонами (одиночное соединение к Geofabrik даёт
≈ 0.35 МБ/с — проверено 28.09.2026), проверяет размер каждой части, собирает файл и сверяет MD5
с опубликованным Geofabrik. Незавершённый запуск можно повторить: недостающие части докачаются.

Эквивалент в одну строку (если не нужен параллелизм):

```bash
curl -L --retry 5 -o data/raw/siberian-fed-district-latest.osm.pbf \
  https://download.geofabrik.de/russia/siberian-fed-district-latest.osm.pbf
```

## Разведка покрытия (Этап 0.5)

Показывает, сколько объектов реально размечено в OSM под категории MVP и что осталось «за кадром» —
на этих числах утверждается список категорий (см. `docs/recon/`).

```powershell
cd backend
uv run python -m geopuls.recon.pbf_scan `
  --pbf ..\data\raw\siberian-fed-district-260927.osm.pbf `
  --city "Томск" --bbox 56.30,84.70,56.65,85.30 --center 56.4847,84.9482 --center-radius-km 10 `
  --out-json ..\docs\recon\tomsk-coverage.json --out-md ..\docs\recon\tomsk-coverage.md
```

Флаги разведки:

| Флаг | Значение |
|---|---|
| `--bbox min_lat,min_lon,max_lat,max_lon` | область подсчёта (для Томска — с запасом вокруг города) |
| `--center lat,lon` + `--center-radius-km` | «ядро» города: отдельный столбец в отчёте, чтобы видеть покрытие центра отдельно от пригородов |
| `--top-values N` | сколько значений каждого ключа (`amenity`, `shop`, ...) показывать в отчёте |

Сканирование 557 МБ занимает порядка 20 минут (собирается индекс координат для геометрии ways).

## Граница города

Для сидирования `cities` нужен полигон города (по нему строятся H3-ячейки и клип POI):

```powershell
cd backend
uv run python -m geopuls.importers.boundary --city "Томск" --out ..\data\raw\tomsk-boundary.json
```

Запрос делается один раз (Nominatim: User-Agent с контактом, ≤ 1 запроса в секунду), результат
кэшируется в файл вместе с лицензией ODbL и `osm_relation_id`. Обоснование выбора источника —
`docs/decisions/0004-city-boundary.md`.

## Импорт POI (Этап 2)

Полный цикл: сканирование выгрузки → файл-кандидатов (рядом с PBF) → запись в БД.

```powershell
cd backend
# один проход по выгрузке обслуживает все активные города (отбор по объединению их bbox)
uv run python -m geopuls.importers.poi --pbf ..\data\raw\siberian-fed-district-260927.osm.pbf

# только сканирование и отчёт (без записи в БД)
uv run python -m geopuls.importers.poi --pbf ..\data\raw\... --dry-run

# повторная запись из готового файла-кандидатов — секунды вместо десятков минут
uv run python -m geopuls.importers.poi --from-dump ..\data\raw\....poi-candidates.jsonl

# быстрая проверка на части данных (мягкое удаление в этом режиме не выполняется)
uv run python -m geopuls.importers.poi --pbf ..\data\raw\... --limit 2000
```

Что происходит при импорте: upsert в `pois` + связи `poi_categories`, расчёт H3-индексов
(res 9 и 8), мягкое удаление исчезнувших из OSM объектов (`is_active = false`), запись
`data_versions` и журнала `import_runs`. Механика и обоснование — `docs/decisions/0005-poi-import.md`.

## Агрегация H3 (Этап 3)

После импорта POI нужно пересобрать сетку города и статистику по ячейкам:

```powershell
cd backend
uv run python -m geopuls.aggregate --city tomsk             # res 9 и 8
uv run python -m geopuls.aggregate --city tomsk --dry-run   # посчитать без записи в БД
uv run python -m geopuls.aggregate --city tomsk --res 9     # только детальный слой
```

Команда строит полную сетку по полигону города (включая **пустые** ячейки), считает плотность
POI/км² и долю адресов, а также границы классов легенды. Площадь сетки сверяется с площадью
полигона: при расхождении больше ±15% печатается предупреждение (`--strict` делает это ошибкой
с кодом 3). Запуск занимает секунды — пересобирайте после каждого импорта.
Подробности и замеры — `docs/decisions/0006-h3-aggregation.md`.

## Что где лежит

| Каталог | Назначение | В git |
|---|---|---|
| `raw/` | скачанные выгрузки OSM (PBF/GPKG) | нет |
| `processed/` | промежуточные результаты (например, отчёты разведки в JSON) | нет |

Правило проекта: **дата выгрузки фиксируется** — имя файла содержит версию (`...-260927.osm.pbf`),
а сама дата попадает в `import_runs` и в `data_version`, который видит пользователь в интерфейсе
(см. `docs/tz.md`, разделы 2.3 и 6).
