"""Реестр слоёв, значения слоя по сетке города и профиль ячейки (ADR 0013).

Почему отдельный роутер, а не расширение `/cells`: у слоя есть тип метрики и единица измерения,
и значение читается из `cell_metrics`, где в ключе лежит версия данных. Старый `/cells` продолжает
работать поверх `cell_stats` — фронтенд переключается на слои на следующем шаге.

Эндпоинты:
    GET /api/v1/layers                     — реестр слоёв (чем измеряются, в чём, какие категории)
    GET /api/v1/layers/{slug}/cells        — значения слоя по ячейкам города
    GET /api/v1/cells/{h3}                 — профиль ячейки: значения всех слоёв
"""

from __future__ import annotations

from typing import Annotated, Any

import h3
from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from geopuls.aggregate import compute_density_breaks
from geopuls.api.cells import legend_classes_from
from geopuls.api.deps import DataVersionInfo, SessionDep, load_data_version, require_city
from geopuls.api.geojson import cell_feature, h3_text, make_etag, parse_bbox
from geopuls.api.problems import DATA_CACHE_CONTROL, ProblemException
from geopuls.api.schemas import (
    CellMetricOut,
    CellProfileMeta,
    CellProfileResponse,
    LayerCellsMeta,
    LayerCellsResponse,
    LayerOut,
    LayerSourceOut,
    LayersResponse,
)

router = APIRouter(prefix="/api/v1", tags=["layers"])

LAYERS_SQL = """
SELECT l.slug, l.name_ru, l.kind, l.metric_kind, l.unit, l.scale, l.color, l.can_be_base, l.sort_order,
       d.slug AS dataset_slug, d.title AS dataset_title, d.license, d.license_url,
       d.attribution_text, d.citation, d.source_url, d.data_version
FROM layers l
LEFT JOIN datasets d ON d.id = l.dataset_id
WHERE l.is_active
ORDER BY l.sort_order, l.slug
"""

LAYER_SQL = LAYERS_SQL.replace("WHERE l.is_active", "WHERE l.is_active AND l.slug = :layer")

LAYER_CATEGORIES_SQL = """
SELECT l.slug AS layer, c.slug AS category
FROM categories c JOIN layers l ON l.id = c.layer_id
WHERE c.is_active
ORDER BY l.slug, c.sort_order
"""

LAYER_CELLS_SQL = """
SELECT cm.h3_index, cm.value, cm.value_kind, cm.extras, cm.data_version AS version,
       cat.slug AS category
FROM cell_metrics cm
JOIN city_cells cc
  ON cc.city_id = cm.city_id AND cc.resolution = cm.resolution AND cc.h3_index = cm.h3_index
JOIN layers l ON l.id = cm.layer_id
JOIN datasets d ON d.id = l.dataset_id
JOIN cities c ON c.id = cm.city_id
LEFT JOIN categories cat ON cat.id = cm.category_id
WHERE c.slug = :city AND l.slug = :layer AND cm.resolution = :res
  AND cm.data_version = d.data_version
  AND (CAST(:category AS text) IS NULL OR cat.slug = :category)
  AND (
    NOT :use_bbox
    OR (
        ST_X(cc.centroid::geometry) BETWEEN :min_lon AND :max_lon
        AND ST_Y(cc.centroid::geometry) BETWEEN :min_lat AND :max_lat
    )
  )
ORDER BY cm.h3_index
"""

CELL_PROFILE_SQL = """
SELECT l.slug AS layer, l.name_ru AS layer_name, l.metric_kind, l.unit, l.sort_order,
       cat.slug AS category, cat.sort_order AS category_order, cm.data_version AS version,
       cm.value, cm.extras
FROM cell_metrics cm
JOIN layers l ON l.id = cm.layer_id
JOIN datasets d ON d.id = l.dataset_id
JOIN cities c ON c.id = cm.city_id
LEFT JOIN categories cat ON cat.id = cm.category_id
WHERE c.slug = :city AND cm.h3_index = :h3_index AND cm.resolution = :res AND l.is_active
  AND cm.data_version = d.data_version
ORDER BY l.sort_order, cat.sort_order
"""


def source_out(row: dict[str, Any]) -> LayerSourceOut | None:
    """Источник слоя в форме ответа (None, если источник не задан)."""
    if not row.get("dataset_slug"):
        return None
    return LayerSourceOut(
        slug=row["dataset_slug"],
        title=row["dataset_title"],
        license=row["license"],
        license_url=row["license_url"],
        attribution_text=row["attribution_text"],
        citation=row["citation"],
        source_url=row["source_url"],
        data_version=row["data_version"],
    )


async def load_categories_by_layer(session: AsyncSession) -> dict[str, list[str]]:
    """Категории по слоям: одним запросом, чтобы реестр не делал N обращений."""
    rows = (await session.execute(text(LAYER_CATEGORIES_SQL))).mappings().all()
    grouped: dict[str, list[str]] = {}
    for row in rows:
        grouped.setdefault(row["layer"], []).append(row["category"])
    return grouped


async def require_layer(session: AsyncSession, slug: str) -> dict[str, Any]:
    """Слой по slug: 404, если его нет или он выключен."""
    row = (await session.execute(text(LAYER_SQL), {"layer": slug})).mappings().one_or_none()
    if row is None:
        raise ProblemException(404, f"Слой не найден: {slug}")
    return dict(row)


async def require_layer_category(session: AsyncSession, layer_slug: str, category: str) -> str:
    """Проверить, что категория принадлежит слою: иначе фильтр молча вернул бы пустую карту."""
    row = (
        (
            await session.execute(
                text(
                    "SELECT c.slug FROM categories c JOIN layers l ON l.id = c.layer_id "
                    "WHERE c.slug = :category AND c.is_active AND l.slug = :layer"
                ),
                {"category": category, "layer": layer_slug},
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise ProblemException(404, f"Категория {category} не найдена в слое {layer_slug}")
    return str(row["slug"])


@router.get("/layers", response_model=LayersResponse, summary="Реестр слоёв карты")
async def get_layers(
    session: SessionDep,
    city: Annotated[str | None, Query(description="slug города: нужен, чтобы вернуть версию данных")] = None,
) -> LayersResponse:
    """Слои карты: метрика, единица измерения, категории слоя и источник с лицензией.

    Из этого ответа интерфейс строит панель слоёв: какие бывают, что измеряют и может ли слой
    красить карту (``can_be_base``).
    """
    if city is not None:
        await require_city(session, city)
    rows = (await session.execute(text(LAYERS_SQL))).mappings().all()
    categories = await load_categories_by_layer(session)
    version = await load_data_version(session) if city is not None else None

    return LayersResponse(
        layers=[
            LayerOut(
                slug=row["slug"],
                name=row["name_ru"],
                kind=row["kind"],
                metric_kind=row["metric_kind"],
                unit=row["unit"],
                scale=row["scale"],
                color=row["color"],
                can_be_base=row["can_be_base"],
                categories=categories.get(row["slug"], []),
                source=source_out(dict(row)),
            )
            for row in rows
        ],
        data_version=version.version if version else None,
    )


@router.get(
    "/layers/{slug}/cells",
    response_model=LayerCellsResponse,
    summary="Значения слоя по ячейкам города",
    responses={
        304: {"description": "Данные не изменились (ETag совпал)"},
        404: {"description": "Город, слой или категория не найдены"},
        503: {"description": "Метрики слоя ещё не собраны"},
    },
)
async def get_layer_cells(
    request: Request,
    response: Response,
    session: SessionDep,
    slug: str,
    city: Annotated[str, Query(description="slug города, например tomsk")],
    res: Annotated[int, Query(ge=8, le=9, description="разрешение H3 (8 — обзор, 9 — детально)")] = 9,
    category: Annotated[str | None, Query(description="вариант внутри слоя (для слоя конкурентов — категория)")] = None,
    bbox: Annotated[str | None, Query(description="min_lon,min_lat,max_lon,max_lat")] = None,
) -> LayerCellsResponse | Response:
    """GeoJSON слоя: ``properties.value`` — значение метрики, тип — в ``properties.value_kind``.

    Нулевые ячейки присутствуют: пустая зона — это тоже значение, и именно она — продукт.
    Категория обязательна для слоёв с вариантами (конкуренты) и запрещена для остальных: иначе
    на одну ячейку пришлось бы несколько значений, и карта потеряла бы смысл.
    """
    await require_city(session, city)
    layer = await require_layer(session, slug)
    layer_categories = (await load_categories_by_layer(session)).get(slug, [])
    if layer_categories and category is None:
        raise ProblemException(
            400, f"Слой {slug} состоит из категорий — укажите category ({', '.join(layer_categories)})"
        )
    if category is not None:
        if not layer_categories:
            raise ProblemException(400, f"Слой {slug} не делится на категории")
        await require_layer_category(session, slug, category)

    min_lon = min_lat = max_lon = max_lat = 0.0
    use_bbox = False
    if bbox:
        try:
            min_lon, min_lat, max_lon, max_lat = parse_bbox(bbox)
        except ValueError as exc:
            raise ProblemException(400, str(exc)) from exc
        use_bbox = True

    version = await load_data_version(session)
    rows = (
        (
            await session.execute(
                text(LAYER_CELLS_SQL),
                {
                    "city": city,
                    "layer": slug,
                    "res": res,
                    "category": category,
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
    if not rows:
        raise ProblemException(
            503,
            f"Для слоя {slug} ({city}, res {res}) нет собранных метрик. "
            f"Выполните агрегацию: uv run python -m geopuls.aggregate --city {city}",
        )
    return build_layer_cells_response(
        request=request,
        response=response,
        rows=rows,
        layer=layer,
        city=city,
        slug=slug,
        category=category,
        res=res,
        version=version,
        bbox=bbox,
    )


def build_layer_cells_response(
    *,
    request: Request,
    response: Response,
    rows: list[dict[str, Any]],
    layer: dict[str, Any],
    city: str,
    slug: str,
    category: str | None,
    res: int,
    version: DataVersionInfo,
    bbox: str | None,
) -> LayerCellsResponse | Response:
    """Собрать ответ слоя: объекты GeoJSON, метаданные, шкала легенды, ETag и 304."""
    features: list[dict[str, Any]] = []
    values: list[float] = []
    for row in rows:
        value = float(row["value"])
        properties: dict[str, Any] = {
            "h3": h3_text(row["h3_index"]),
            "value": round(value, 4),
            "value_kind": row["value_kind"],
        }
        if row["extras"]:
            properties.update(row["extras"])
        features.append(cell_feature(row["h3_index"], properties))
        if value > 0:
            values.append(value)

    classes = legend_classes_from(getattr(request.app.state, "settings", None))
    # Версия в meta и ETag — версия показанного снимка, а не «текущая» в справочнике:
    # между импортом и агрегацией карта должна показывать то, что реально на ней нарисовано
    snapshot_version = rows[0]["version"]
    etag = make_etag(city, slug, category, res, snapshot_version, bbox or "")
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": DATA_CACHE_CONTROL})

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = DATA_CACHE_CONTROL
    source = source_out(dict(layer))
    return LayerCellsResponse(
        features=features,
        meta=LayerCellsMeta(
            city=city,
            layer=slug,
            category=category,
            res=res,
            metric_kind=str(layer["metric_kind"]),
            unit=layer["unit"],
            data_version=snapshot_version,
            updated_at=version.updated_at,
            cell_count=len(rows),
            non_empty_count=len(values),
            total_value=round(sum(values), 4),
            max_value=round(max(values), 4) if values else 0.0,
            breaks=compute_density_breaks(values, classes=classes),
            sources=[source] if source is not None else [],
            bbox_filter=bbox,
        ),
    )


@router.get(
    "/cells/{h3_index}",
    response_model=CellProfileResponse,
    summary="Профиль ячейки: значения всех слоёв",
    responses={404: {"description": "Ячейка вне сетки города"}},
)
async def get_cell_profile(
    session: SessionDep,
    h3_index: str,
    city: Annotated[str, Query(description="slug города")],
    res: Annotated[int, Query(ge=8, le=9, description="разрешение H3 ячейки")] = 9,
) -> CellProfileResponse:
    """Все значения ячейки: основа для объяснения «здесь жильё и остановка, кафе нет».

    Отдаём только факты и числа — никаких баллов и рекомендаций (ТЗ §12).
    """
    await require_city(session, city)
    try:
        cell_int = h3.str_to_int(h3_index)
    except ValueError as exc:
        raise ProblemException(400, f"Некорректный H3-индекс: {h3_index}") from exc

    version = await load_data_version(session)
    rows = (
        (
            await session.execute(
                text(CELL_PROFILE_SQL),
                {
                    "city": city,
                    "h3_index": cell_int,
                    "res": res,
                },
            )
        )
        .mappings()
        .all()
    )
    if not rows:
        raise ProblemException(404, f"Ячейка {h3_index} вне сетки города {city}")

    return CellProfileResponse(
        metrics=[
            CellMetricOut(
                layer=row["layer"],
                layer_name=row["layer_name"],
                category=row["category"],
                metric_kind=row["metric_kind"],
                unit=row["unit"],
                value=round(float(row["value"]), 4),
                extras=row["extras"],
            )
            for row in rows
        ],
        meta=CellProfileMeta(
            city=city,
            cell=h3_index,
            res=res,
            data_version=rows[0]["version"],
            updated_at=version.updated_at,
        ),
    )
