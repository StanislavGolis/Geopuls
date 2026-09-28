"""Список POI внутри ячейки H3 (клик по ячейке на карте)."""

from __future__ import annotations

from typing import Annotated

import h3
from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import text

from geopuls.api.deps import SessionDep, load_data_version, require_city
from geopuls.api.geojson import make_etag
from geopuls.api.problems import DATA_CACHE_CONTROL, ProblemException
from geopuls.api.schemas import PoiOut, PoisMeta, PoisResponse, ProblemOut

router = APIRouter(prefix="/api/v1", tags=["pois"])

#: Колонка H3-индекса зависит от разрешения (значения фиксированы, подстановка безопасна).
CELL_COLUMN = {9: "p.h3_r9", 8: "p.h3_r8"}

CELL_EXISTS_SQL = """
SELECT 1
FROM city_cells cc
JOIN cities c ON c.id = cc.city_id
WHERE c.slug = :city AND cc.resolution = :res AND cc.h3_index = :h3_index
"""

COUNT_SQL = """
SELECT count(*) AS total
FROM pois p
WHERE p.is_active
  AND {cell_column} = :h3_index
  AND ST_Contains((SELECT boundary::geometry FROM cities WHERE slug = :city), p.location::geometry)
  AND (
    CAST(:category AS text) IS NULL
    OR EXISTS (
        SELECT 1 FROM poi_categories pc JOIN categories cat ON cat.id = pc.category_id
        WHERE pc.poi_id = p.id AND cat.slug = :category
    )
  )
"""

ITEMS_SQL = """
SELECT p.osm_type, p.osm_id, p.name, p.brand, p.addr_street, p.addr_housenumber,
       ST_Y(p.location::geometry) AS lat,
       ST_X(p.location::geometry) AS lon,
       cats.slugs AS categories
FROM pois p
JOIN LATERAL (
    SELECT array_agg(c2.slug ORDER BY c2.slug) AS slugs
    FROM poi_categories pc2
    JOIN categories c2 ON c2.id = pc2.category_id
    WHERE pc2.poi_id = p.id
) cats ON TRUE
WHERE p.is_active
  AND {cell_column} = :h3_index
  AND ST_Contains((SELECT boundary::geometry FROM cities WHERE slug = :city), p.location::geometry)
  AND (
    CAST(:category AS text) IS NULL
    OR EXISTS (
        SELECT 1 FROM poi_categories pc JOIN categories cat ON cat.id = pc.category_id
        WHERE pc.poi_id = p.id AND cat.slug = :category
    )
  )
ORDER BY p.name NULLS LAST, p.osm_id
LIMIT :limit OFFSET :offset
"""


def _format_address(row: object) -> str | None:
    street = row["addr_street"]  # type: ignore[index]
    number = row["addr_housenumber"]  # type: ignore[index]
    if street and number:
        return f"{street}, {number}"
    return street or number


@router.get(
    "/pois",
    response_model=PoisResponse,
    summary="Объекты внутри ячейки",
    responses={
        304: {"description": "Данные не изменились (ETag совпал)"},
        404: {"model": ProblemOut, "description": "Город не найден или ячейка вне сетки города"},
    },
)
async def get_pois(
    request: Request,
    response: Response,
    session: SessionDep,
    city: Annotated[str, Query(description="slug города")],
    cell: Annotated[str, Query(description="H3-индекс ячейки (hex)")],
    res: Annotated[int, Query(ge=8, le=9, description="разрешение H3 ячейки")] = 9,
    category: Annotated[str | None, Query(description="фильтр по категории")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PoisResponse | Response:
    """POI внутри ячейки: название, бренд, адрес, категории и ссылка на OpenStreetMap."""
    await require_city(session, city)

    if not h3.is_valid_cell(cell):
        raise ProblemException(400, f"Некорректный H3-индекс: {cell}")

    h3_index = h3.str_to_int(cell)
    cell_exists = (
        await session.execute(
            text(CELL_EXISTS_SQL),
            {"city": city, "res": res, "h3_index": h3_index},
        )
    ).first()
    if cell_exists is None:
        raise ProblemException(404, f"Ячейка {cell} (res {res}) не входит в сетку города {city}")

    params = {"city": city, "h3_index": h3_index, "category": category, "limit": limit, "offset": offset}
    cell_column = CELL_COLUMN[res]

    total = (await session.execute(text(COUNT_SQL.format(cell_column=cell_column)), params)).scalar_one()
    rows = (await session.execute(text(ITEMS_SQL.format(cell_column=cell_column)), params)).mappings().all()
    version = await load_data_version(session)

    items = [
        PoiOut(
            osm_type=row["osm_type"],
            osm_id=row["osm_id"],
            name=row["name"],
            brand=row["brand"],
            address=_format_address(row),
            categories=list(row["categories"] or []),
            lat=float(row["lat"]),
            lon=float(row["lon"]),
            osm_url=f"https://www.openstreetmap.org/{row['osm_type']}/{row['osm_id']}",
        )
        for row in rows
    ]

    etag = make_etag(city, cell, res, category or "", limit, offset, version.version, version.updated_at)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": DATA_CACHE_CONTROL})

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = DATA_CACHE_CONTROL
    return PoisResponse(
        items=items,
        meta=PoisMeta(
            city=city,
            cell=cell,
            res=res,
            category=category,
            total=int(total),
            returned=len(items),
            limit=limit,
            offset=offset,
            data_version=version.version,
        ),
    )
