"""Справочники: города, категории и профиль города."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response
from sqlalchemy import text

from geopuls.api.deps import SessionDep, load_data_version, require_city
from geopuls.api.geojson import make_etag
from geopuls.api.problems import DATA_CACHE_CONTROL
from geopuls.api.schemas import (
    BBoxOut,
    CategoryOut,
    CityOut,
    CityProfileOut,
    LatLngOut,
    LayerSourceOut,
    ProfileCategoryOut,
    ProfileGridOut,
    ProfileLayerOut,
)

router = APIRouter(prefix="/api/v1/meta", tags=["meta"])

CITIES_SQL = """
SELECT c.slug, c.name, c.region, c.h3_res,
       round((ST_Area(c.boundary) / 1000000)::numeric, 1) AS area_km2,
       ST_Y(c.center::geometry) AS center_lat,
       ST_X(c.center::geometry) AS center_lon,
       ST_YMin(c.bbox::geometry) AS min_lat,
       ST_XMin(c.bbox::geometry) AS min_lon,
       ST_YMax(c.bbox::geometry) AS max_lat,
       ST_XMax(c.bbox::geometry) AS max_lon
FROM cities c
WHERE c.is_active AND c.boundary IS NOT NULL AND c.bbox IS NOT NULL AND c.center IS NOT NULL
ORDER BY c.name
"""

#: Тот же набор полей для одного города — профиль города отдаёт его карточкой.
CITY_SQL = """
SELECT c.slug, c.name, c.region, c.h3_res,
       round((ST_Area(c.boundary) / 1000000)::numeric, 1) AS area_km2,
       ST_Y(c.center::geometry) AS center_lat,
       ST_X(c.center::geometry) AS center_lon,
       ST_YMin(c.bbox::geometry) AS min_lat,
       ST_XMin(c.bbox::geometry) AS min_lon,
       ST_YMax(c.bbox::geometry) AS max_lat,
       ST_XMax(c.bbox::geometry) AS max_lon
FROM cities c
WHERE c.slug = :slug AND c.is_active
"""

CATEGORIES_SQL = """
SELECT cat.slug, cat.name_ru, cat.color, COALESCE(counted.poi_count, 0) AS poi_count
FROM categories cat
LEFT JOIN (
    SELECT pc.category_id, count(*) AS poi_count
    FROM poi_categories pc
    JOIN pois p ON p.id = pc.poi_id AND p.is_active
    GROUP BY pc.category_id
) counted ON counted.category_id = cat.id
WHERE cat.is_active
ORDER BY cat.sort_order, cat.slug
"""

#: Профильные запросы: числа считает БД одним обращением, чтобы они не разъезжались между собой.
#: «Непустая ячейка» определяется по базовому слою (конкуренты): пустая ячейка — это не «нет бизнеса»,
#: а «нет размеченных объектов», и профиль города обязан объяснять именно эту разницу (ТЗ §4.2).
PROFILE_GRID_SQL = """
SELECT
    (SELECT count(*) FROM city_cells cc
      WHERE cc.city_id = c.id AND cc.resolution = c.h3_res) AS cells,
    (SELECT count(DISTINCT cm.h3_index) FROM cell_metrics cm
      WHERE cm.city_id = c.id AND cm.resolution = c.h3_res
        AND cm.layer_id = (SELECT l.id FROM layers l WHERE l.slug = 'competitors')
        AND cm.value > 0) AS cells_non_empty,
    (SELECT count(DISTINCT p.id) FROM pois p
      JOIN poi_categories pc ON pc.poi_id = p.id
      JOIN categories cat ON cat.id = pc.category_id
      WHERE p.is_active
        AND cat.layer_id = (SELECT l.id FROM layers l WHERE l.slug = 'competitors')) AS poi_count
FROM cities c
WHERE c.id = :city_id
"""

PROFILE_CATEGORIES_SQL = """
SELECT cat.slug, cat.name_ru, cat.color, COALESCE(counted.poi_count, 0) AS poi_count
FROM categories cat
LEFT JOIN (
    SELECT pc.category_id, count(*) AS poi_count
    FROM poi_categories pc
    JOIN pois p ON p.id = pc.poi_id AND p.is_active
    GROUP BY pc.category_id
) counted ON counted.category_id = cat.id
WHERE cat.is_active
  AND cat.layer_id = (SELECT l.id FROM layers l WHERE l.slug = 'competitors')
ORDER BY cat.sort_order, cat.slug
"""

#: Покрытие слоя считается по числу ячеек сетки с метрикой, а не по числу строк: у базового слоя строк
#: несколько на ячейку (по категориям), и «покрытие» иначе выглядело бы завышенным.
PROFILE_LAYERS_SQL = """
SELECT l.slug, l.name_ru, l.metric_kind, l.unit, l.color,
       count(DISTINCT cm.h3_index) AS covered_count,
       count(DISTINCT cm.h3_index) FILTER (WHERE cm.value > 0) AS non_empty_count,
       COALESCE(max(cm.value), 0) AS max_value
FROM layers l
LEFT JOIN cell_metrics cm
       ON cm.layer_id = l.id AND cm.city_id = :city_id AND cm.resolution = :res
WHERE l.is_active
GROUP BY l.slug, l.name_ru, l.metric_kind, l.unit, l.color, l.sort_order
ORDER BY l.sort_order, l.slug
"""

SOURCES_SQL = """
SELECT d.slug, d.title, d.license, d.license_url, d.attribution_text, d.citation, d.source_url,
       d.data_version
FROM datasets d
ORDER BY d.title
"""


def _city_out(row: dict[str, Any], version: Any) -> CityOut:
    """Строка города в форме ответа: используется и списком, и профилем."""
    return CityOut(
        slug=row["slug"],
        name=row["name"],
        region=row["region"],
        h3_res=row["h3_res"],
        area_km2=float(row["area_km2"]),
        center=LatLngOut(lat=float(row["center_lat"]), lon=float(row["center_lon"])),
        bbox=BBoxOut(
            min_lat=float(row["min_lat"]),
            min_lon=float(row["min_lon"]),
            max_lat=float(row["max_lat"]),
            max_lon=float(row["max_lon"]),
        ),
        data_version=version.version,
        updated_at=version.updated_at,
    )


@router.get("/cities", response_model=list[CityOut], summary="Города с данными")
async def list_cities(session: SessionDep) -> list[CityOut]:
    """Список активных городов: центр, bbox, площадь и версия данных."""
    version = await load_data_version(session)
    rows = (await session.execute(text(CITIES_SQL))).mappings().all()

    return [_city_out(dict(row), version) for row in rows]


@router.get("/categories", response_model=list[CategoryOut], summary="Категории и объёмы данных")
async def list_categories(session: SessionDep) -> list[CategoryOut]:
    """Категории MVP с числом активных POI (для селектора и подписи «мало данных»)."""
    rows = (await session.execute(text(CATEGORIES_SQL))).mappings().all()

    return [
        CategoryOut(
            slug=row["slug"],
            name=row["name_ru"],
            color=row["color"],
            poi_count=int(row["poi_count"]),
        )
        for row in rows
    ]


@router.get(
    "/cities/{slug}/profile",
    response_model=CityProfileOut,
    summary="Профиль города: сводка по данным",
    responses={
        304: {"description": "Данные не изменились (ETag совпал)"},
        404: {"description": "Город не найден"},
    },
)
async def get_city_profile(
    request: Request,
    response: Response,
    session: SessionDep,
    slug: str,
) -> CityProfileOut | Response:
    """Сводка по городу одним ответом: охват сетки, категории, слои и источники.

    Зачем отдельный эндпоинт, а не сборка из существующих ответов: `/cells` для профиля пришлось бы
    тянуть целиком (около 500 КБ), а числа из разных запросов могут разойтись между собой. Здесь всё
    считает БД, ответ кэшируется ETag по версии данных.

    Выводов и советов в ответе нет — только наблюдения (ADR 0015): сколько объектов, по каким
    категориям и слоям, из каких источников и на какую дату.
    """
    city = await require_city(session, slug)
    version = await load_data_version(session)
    etag = make_etag("profile", slug, version.version)

    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": DATA_CACHE_CONTROL})

    city_row = (await session.execute(text(CITY_SQL), {"slug": slug})).mappings().one()
    grid_row = (await session.execute(text(PROFILE_GRID_SQL), {"city_id": city["id"]})).mappings().one()
    category_rows = (await session.execute(text(PROFILE_CATEGORIES_SQL))).mappings().all()
    layer_rows = (
        (await session.execute(text(PROFILE_LAYERS_SQL), {"city_id": city["id"], "res": city_row["h3_res"]}))
        .mappings()
        .all()
    )
    source_rows = (await session.execute(text(SOURCES_SQL))).mappings().all()

    cells = int(grid_row["cells"])
    poi_count = int(grid_row["poi_count"])
    cells_non_empty = int(grid_row["cells_non_empty"])

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = DATA_CACHE_CONTROL

    return CityProfileOut(
        city=_city_out(dict(city_row), version),
        grid=ProfileGridOut(
            res=int(city_row["h3_res"]),
            cells=cells,
            cells_non_empty=cells_non_empty,
            empty_share=round(100.0 * (cells - cells_non_empty) / cells, 1) if cells else 0.0,
            poi_count=poi_count,
        ),
        categories=[
            ProfileCategoryOut(
                slug=row["slug"],
                name=row["name_ru"],
                color=row["color"],
                poi_count=int(row["poi_count"]),
                share=round(100.0 * int(row["poi_count"]) / poi_count, 1) if poi_count else None,
            )
            for row in category_rows
        ],
        layers=[
            ProfileLayerOut(
                slug=row["slug"],
                name=row["name_ru"],
                metric_kind=row["metric_kind"],
                unit=row["unit"],
                color=row["color"],
                covered_count=int(row["covered_count"]),
                non_empty_count=int(row["non_empty_count"]),
                # Без округления: числа профиля обязаны совпадать с ответом по слою
                max_value=float(row["max_value"]),
            )
            for row in layer_rows
        ],
        sources=[
            LayerSourceOut(
                slug=row["slug"],
                title=row["title"],
                license=row["license"],
                license_url=row["license_url"],
                attribution_text=row["attribution_text"],
                citation=row["citation"],
                source_url=row["source_url"],
                data_version=row["data_version"],
            )
            for row in source_rows
        ],
    )
