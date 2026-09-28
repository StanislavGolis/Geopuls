"""Тепловой слой: H3-ячейки города с плотностью POI."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import text

from geopuls.aggregate import compute_density_breaks
from geopuls.api.deps import SessionDep, load_data_version, require_category, require_city
from geopuls.api.geojson import cell_feature, h3_text, make_etag, parse_bbox
from geopuls.api.problems import DATA_CACHE_CONTROL, ProblemException
from geopuls.api.schemas import CellsMeta, CellsResponse, ProblemOut

router = APIRouter(prefix="/api/v1", tags=["cells"])

CELLS_SQL = """
SELECT cs.h3_index, cs.poi_count, cs.density, cs.has_address_ratio
FROM cell_stats cs
JOIN cities c ON c.id = cs.city_id
JOIN categories cat ON cat.id = cs.category_id
JOIN city_cells cc
  ON cc.city_id = cs.city_id AND cc.resolution = cs.resolution AND cc.h3_index = cs.h3_index
WHERE c.slug = :city AND cat.slug = :category AND cs.resolution = :res
  AND (
    NOT :use_bbox
    OR (
        ST_X(cc.centroid::geometry) BETWEEN :min_lon AND :max_lon
        AND ST_Y(cc.centroid::geometry) BETWEEN :min_lat AND :max_lat
    )
  )
ORDER BY cs.h3_index
"""


@router.get(
    "/cells",
    response_model=CellsResponse,
    summary="Тепловой слой города по категории",
    responses={
        304: {"description": "Данные не изменились (ETag совпал)"},
        404: {"model": ProblemOut, "description": "Город или категория не найдены"},
        503: {"model": ProblemOut, "description": "Данные города ещё не собраны"},
    },
)
async def get_cells(
    request: Request,
    response: Response,
    session: SessionDep,
    city: Annotated[str, Query(description="slug города, например tomsk")],
    category: Annotated[str, Query(description="slug категории, например cafe")],
    res: Annotated[int, Query(ge=8, le=9, description="разрешение H3 (8 — обзор, 9 — детально)")] = 9,
    bbox: Annotated[str | None, Query(description="min_lon,min_lat,max_lon,max_lat")] = None,
) -> CellsResponse | Response:
    """GeoJSON-сетка города: ``count`` и ``density`` (POI/км²) по каждой ячейке.

    Нулевые ячейки присутствуют в ответе — это и есть «карта пустых зон».
    Границы классов легенды (`meta.density_breaks`) считает бэкенд, чтобы web-, PNG- и
    PDF-представления выглядели одинаково.
    """
    await require_city(session, city)
    await require_category(session, category)

    min_lon = min_lat = max_lon = max_lat = 0.0
    use_bbox = False
    if bbox:
        try:
            min_lon, min_lat, max_lon, max_lat = parse_bbox(bbox)
        except ValueError as exc:
            raise ProblemException(400, str(exc)) from exc
        use_bbox = True

    rows = (
        (
            await session.execute(
                text(CELLS_SQL),
                {
                    "city": city,
                    "category": category,
                    "res": res,
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
            f"Для города {city} и категории {category} (res {res}) нет собранной сетки. "
            "Выполните агрегацию: uv run python -m geopuls.aggregate --city "
            f"{city}",
        )

    features: list[dict[str, Any]] = [
        cell_feature(
            row["h3_index"],
            {
                "h3": h3_text(row["h3_index"]),
                "count": row["poi_count"],
                "density": round(float(row["density"]), 2),
                "has_address_ratio": (
                    round(float(row["has_address_ratio"]), 3) if row["has_address_ratio"] is not None else None
                ),
            },
        )
        for row in rows
    ]

    densities = [float(row["density"]) for row in rows if row["poi_count"] > 0]
    version = await load_data_version(session)
    meta = CellsMeta(
        city=city,
        category=category,
        res=res,
        data_version=version.version,
        updated_at=version.updated_at,
        cell_count=len(rows),
        non_empty_count=len(densities),
        poi_count=sum(int(row["poi_count"]) for row in rows),
        max_density=round(max(densities), 2) if densities else 0.0,
        density_breaks=compute_density_breaks(densities),
        bbox_filter=bbox,
    )

    etag = make_etag(city, category, res, version.version, version.updated_at, bbox or "")
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": DATA_CACHE_CONTROL})

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = DATA_CACHE_CONTROL
    return CellsResponse(features=features, meta=meta)
