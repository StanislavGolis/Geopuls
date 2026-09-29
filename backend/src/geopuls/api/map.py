"""Колоночный ответ карты по набору слоёв (ADR 0013, шаг 4 Этапа 8).

Зачем отдельный эндпоинт, а не расширение `/layers/{slug}/cells`: тот отвечает одним слоем и
повторяет геометрию ячеек в каждом ответе. Набор «базовый слой + два наложения» в такой схеме стоил
бы трёх копий полигонов — на Томске это ~480 КБ JSON на копию, то есть ~1,4 МБ на карту.

`GET /api/v1/map` отдаёт геометрию **один раз** (`cells.geometry`), а значения — колонками,
выровненными с `cells.h3` (`layers[].values`). Добавление слоя теперь стоит не геометрии, а только
колонки чисел.

Соглашения о значениях (важно для честности карты):

    ``values[i] = 0``     — в ячейке объектов нет: это и есть «пустая зона», продукт сервиса;
    ``values[i] = null``  — у слоя нет значения для этой ячейки (слой собран не по всей сетке).

Правило читаемости («карту красит один слой, наложений не больше двух», ADR 0013) проверяется
здесь, а не только в интерфейсе: контракт не должен позволять запросить нечитаемую карту.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import text

from geopuls.aggregate import compute_density_breaks
from geopuls.api.cells import legend_classes_from
from geopuls.api.deps import SessionDep, load_data_version, require_city
from geopuls.api.geojson import cell_polygon, h3_text, make_etag, parse_bbox
from geopuls.api.layers import (
    load_categories_by_layer,
    load_layers,
    require_layer_variant,
    source_out,
)
from geopuls.api.problems import DATA_CACHE_CONTROL, ProblemException
from geopuls.api.schemas import MapCellsOut, MapLayerColumn, MapMeta, MapResponse

router = APIRouter(prefix="/api/v1", tags=["map"])

#: Сколько наложений разрешено поверх базового слоя (ADR 0013): карта обязана остаться читаемой.
MAX_OVERLAYS = 2
#: Формат slug слоя и категории: латиница в нижнем регистре (как в справочниках).
LAYER_REF_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


GRID_SQL = """
SELECT l.slug AS layer, cat.slug AS category, cm.h3_index, cm.value, cm.extras,
       cm.data_version AS version
FROM cell_metrics cm
JOIN city_cells cc
  ON cc.city_id = cm.city_id AND cc.resolution = cm.resolution AND cc.h3_index = cm.h3_index
JOIN layers l ON l.id = cm.layer_id
JOIN datasets d ON d.id = l.dataset_id
JOIN cities c ON c.id = cm.city_id
LEFT JOIN categories cat ON cat.id = cm.category_id
WHERE c.slug = :city AND cm.resolution = :res
  AND cm.data_version = d.data_version
  AND l.slug = ANY(CAST(:layers AS text[]))
  AND (cm.category_id IS NULL OR cat.slug = ANY(CAST(:categories AS text[])))
  AND (
    NOT :use_bbox
    OR (
        ST_X(cc.centroid::geometry) BETWEEN :min_lon AND :max_lon
        AND ST_Y(cc.centroid::geometry) BETWEEN :min_lat AND :max_lat
    )
  )
ORDER BY l.slug, cm.h3_index
"""


def split_layer_ref(value: str, *, param: str) -> tuple[str, str | None]:
    """Разобрать ссылку на слой: ``slug`` или ``slug:category``.

    Мусор в параметре — ошибка 400, а не молча пустая карта: иначе пользователь увидит «нет данных»
    там, где на самом деле опечатка в ссылке.
    """
    slug, _, category = value.strip().partition(":")
    category = category.strip() or None
    if not LAYER_REF_PATTERN.match(slug):
        raise ProblemException(400, f"Некорректный slug слоя в параметре {param}: {value}")
    if category is not None and not LAYER_REF_PATTERN.match(category):
        raise ProblemException(400, f"Некорректный slug категории в параметре {param}: {value}")
    return slug, category


def parse_overlays(raw: str | None) -> list[tuple[str, str | None]]:
    """Разобрать список наложений: ``population,transport:stop``.

    Пустые части (висячие запятые) отбрасываем, повтор слоя и превышение лимита — ошибка.
    """
    if not raw:
        return []

    refs: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    for part in raw.split(","):
        if not part.strip():
            continue
        slug, category = split_layer_ref(part, param="overlays")
        if slug in seen:
            raise ProblemException(400, f"Слой {slug} указан в наложениях дважды")
        seen.add(slug)
        refs.append((slug, category))

    if len(refs) > MAX_OVERLAYS:
        raise ProblemException(
            400,
            f"Наложений не может быть больше {MAX_OVERLAYS}: карта станет нечитаемой (ADR 0013)",
        )
    return refs


def as_number(value: object) -> float | None:
    """Число из ``extras``: агрегатор пишет числа, но слой может прийти и из внешнего источника."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def build_layer_column(
    *,
    layer: dict[str, Any],
    category: str | None,
    role: Literal["base", "overlay"],
    cell_indexes: list[int],
    rows: dict[int, dict[str, Any]],
    classes: int,
) -> MapLayerColumn:
    """Собрать колонку слоя, выровненную с ячейками базового слоя.

    Ячейка без строки метрики получает ``None``: ноль означал бы «объектов нет», а этого мы не знаем.
    """
    extra_keys = sorted({key for row in rows.values() for key in (row["extras"] or {})})
    extras: dict[str, list[float | None]] = {key: [] for key in extra_keys}

    values: list[float | None] = []
    non_empty = 0
    total = 0.0
    max_value = 0.0

    for h3_index in cell_indexes:
        row = rows.get(h3_index)
        if row is None:
            values.append(None)
            for key in extra_keys:
                extras[key].append(None)
            continue

        value = float(row["value"])
        values.append(round(value, 4))
        payload = row["extras"] or {}
        for key in extra_keys:
            extras[key].append(as_number(payload.get(key)))

        if value > 0:
            non_empty += 1
            total += value
            max_value = max(max_value, value)

    return MapLayerColumn(
        slug=str(layer["slug"]),
        name=str(layer["name_ru"]),
        category=category,
        role=role,
        metric_kind=str(layer["metric_kind"]),
        unit=layer["unit"],
        scale=str(layer["scale"]),
        color=str(layer["color"]),
        values=values,
        extras=extras,
        covered_count=len(rows),
        non_empty_count=non_empty,
        total_value=round(total, 4),
        max_value=round(max_value, 4),
        breaks=compute_density_breaks([value for value in values if value and value > 0], classes=classes),
        source=source_out(layer),
    )


@router.get(
    "/map",
    response_model=MapResponse,
    summary="Карта: базовый слой и наложения одним колоночным ответом",
    responses={
        304: {"description": "Данные не изменились (ETag совпал)"},
        400: {"description": "Некорректный набор слоёв или bbox"},
        404: {"description": "Город, слой или категория не найдены"},
        503: {"description": "Метрики базового слоя ещё не собраны"},
    },
)
async def get_map(
    request: Request,
    response: Response,
    session: SessionDep,
    city: Annotated[str, Query(description="slug города, например tomsk")],
    base: Annotated[str, Query(description="базовый слой, который красит карту: slug или slug:category")],
    res: Annotated[int, Query(ge=8, le=9, description="разрешение H3 (8 — обзор, 9 — детально)")] = 9,
    overlays: Annotated[str | None, Query(description="наложения через запятую (не больше двух)")] = None,
    bbox: Annotated[str | None, Query(description="min_lon,min_lat,max_lon,max_lat")] = None,
) -> MapResponse | Response:
    """Геометрия сетки один раз и колонки значений всех запрошенных слоёв.

    Сетку задаёт базовый слой: он красит карту, и именно его ячейки (включая пустые) образуют «карту
    пустых зон». Значения наложений выравниваются по этим же ячейкам.
    """
    await require_city(session, city)

    base_slug, base_category = split_layer_ref(base, param="base")
    overlay_refs = parse_overlays(overlays)
    if base_slug in {slug for slug, _ in overlay_refs}:
        raise ProblemException(400, f"Слой {base_slug} указан и как базовый, и как наложение")

    slugs = [base_slug, *(slug for slug, _ in overlay_refs)]
    layers = await load_layers(session, slugs)
    missing = [slug for slug in slugs if slug not in layers]
    if missing:
        raise ProblemException(404, f"Слой не найден: {', '.join(missing)}")
    if not layers[base_slug]["can_be_base"]:
        raise ProblemException(400, f"Слой {base_slug} не может красить карту: он рисуется только наложением")

    categories_by_layer = await load_categories_by_layer(session)
    base_category = await require_layer_variant(session, layers[base_slug], base_category, categories_by_layer)
    # Вариант слоя с одним вариантом подставляется сам: тогда и фильтр, и подписи знают категорию
    overlay_refs = [
        (slug, await require_layer_variant(session, layers[slug], category, categories_by_layer))
        for slug, category in overlay_refs
    ]

    min_lon = min_lat = max_lon = max_lat = 0.0
    use_bbox = False
    if bbox:
        try:
            min_lon, min_lat, max_lon, max_lat = parse_bbox(bbox)
        except ValueError as exc:
            raise ProblemException(400, str(exc)) from exc
        use_bbox = True

    targets: dict[str, str | None] = {base_slug: base_category}
    for slug, category in overlay_refs:
        targets[slug] = category

    rows = (
        (
            await session.execute(
                text(GRID_SQL),
                {
                    "city": city,
                    "res": res,
                    "layers": slugs,
                    "categories": [category for category in targets.values() if category],
                    "use_bbox": use_bbox,
                    "min_lon": min_lon,
                    "min_lat": min_lat,
                    "max_lon": max_lon,
                    "max_lat": max_lat,
                },
            )
        )
        .mappings()
        .all()
    )

    by_layer: dict[str, dict[int, dict[str, Any]]] = {}
    for row in rows:
        by_layer.setdefault(row["layer"], {})[row["h3_index"]] = dict(row)

    base_rows = by_layer.get(base_slug, {})
    if not base_rows:
        raise ProblemException(
            503,
            f"Для слоя {base_slug} ({city}, res {res}) нет собранных метрик. "
            f"Выполните агрегацию: uv run python -m geopuls.aggregate --city {city}",
        )

    # Колонки выравниваем по ячейкам базового слоя: он задаёт сетку, которую видит пользователь
    cell_indexes = sorted(base_rows)
    classes = legend_classes_from(getattr(request.app.state, "settings", None))
    columns = [
        build_layer_column(
            layer=layers[slug],
            category=category,
            role="base" if slug == base_slug else "overlay",
            cell_indexes=cell_indexes,
            rows=by_layer.get(slug, {}),
            classes=classes,
        )
        for slug, category in targets.items()
    ]

    # ETag — по всему набору слоёв: ссылка с другими наложениями обязана получить другой ответ
    versions = sorted({str(row["version"]) for layer_rows in by_layer.values() for row in layer_rows.values()})
    overlay_signature = ",".join(f"{slug}:{category or ''}" for slug, category in overlay_refs)
    etag = make_etag("map", city, res, base, overlay_signature, bbox or "", *versions)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": DATA_CACHE_CONTROL})

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = DATA_CACHE_CONTROL

    sources: list[Any] = []
    seen_sources: set[str] = set()
    for column in columns:
        source = column.source
        if source is not None and source.slug not in seen_sources:
            seen_sources.add(source.slug)
            sources.append(source)

    version = await load_data_version(session)
    return MapResponse(
        cells=MapCellsOut(
            h3=[h3_text(h3_index) for h3_index in cell_indexes],
            geometry=[cell_polygon(h3_index)["coordinates"][0] for h3_index in cell_indexes],
        ),
        layers=columns,
        meta=MapMeta(
            city=city,
            res=res,
            cell_count=len(cell_indexes),
            base=base,
            overlays=[f"{slug}:{category}" if category else slug for slug, category in overlay_refs],
            # Версия показанного снимка, а не «текущая» в справочнике: тем же правилом живут `/cells` и
            # `/layers/{slug}/cells` — между импортом и агрегацией карта показывает то, что нарисовано
            data_version=min(str(row["version"]) for row in base_rows.values()),
            updated_at=version.updated_at,
            bbox_filter=bbox,
            sources=sources,
        ),
    )
