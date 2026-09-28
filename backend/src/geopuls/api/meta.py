"""Справочники: города и категории."""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import text

from geopuls.api.deps import SessionDep, load_data_version
from geopuls.api.schemas import BBoxOut, CategoryOut, CityOut, LatLngOut

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


@router.get("/cities", response_model=list[CityOut], summary="Города с данными")
async def list_cities(session: SessionDep) -> list[CityOut]:
    """Список активных городов: центр, bbox, площадь и версия данных."""
    version = await load_data_version(session)
    rows = (await session.execute(text(CITIES_SQL))).mappings().all()

    return [
        CityOut(
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
        for row in rows
    ]


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
