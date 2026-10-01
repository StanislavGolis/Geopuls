"""Объекты слоя геометрией: подсветка дополнительных слоёв на карте (план §6, этап 7).

Зачем отдельный эндпоинт: `/api/v1/map` отдаёт ячейки H3, по которым слой измеряется, но не сами объекты —
без них слой нельзя проверить глазами, видно только числа. Здесь отдаём объекты своей геометрией:
парковки и жильё — полигонами, пешеходные пути — линиями, остановки и точки притяжения — точками.

Обязательный bbox — следствие замера, а не придирка: жильё по всему городу это 2.3 МБ JSON, пешеходные
пути — 0.9 МБ, а в типичном виде карты (≈1.5 × 2.2 км) — 66 и 94 КБ. Упрощаем контуры на 3 м
(`ST_SimplifyPreserveTopology`): контур нужен, чтобы узнать объект на карте, а измеряют пусть ячейки.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import text

from geopuls.api.deps import SessionDep, load_data_version, require_city
from geopuls.api.geojson import make_etag, parse_bbox
from geopuls.api.layers import require_layer, source_out
from geopuls.api.problems import DATA_CACHE_CONTROL, ProblemException
from geopuls.api.schemas import (
    LayerObjectFeature,
    LayerObjectProperties,
    LayerObjectsMeta,
    LayerObjectsResponse,
    ProblemOut,
)

router = APIRouter(prefix="/api/v1", tags=["layers"])

#: Сколько объектов отдаём за один раз. Больше — уже не «посмотреть глазами», а выгрузка.
DEFAULT_LIMIT = 2000
MAX_LIMIT = 5000

#: Упрощение контура в градусах (≈3 м): узнаваемость сохраняется, объём падает в разы.
SIMPLIFY_DEGREES = 0.00003

#: Сколько знаков после запятой оставляем в координатах (≈0.1 м): больше — шум в JSON.
COORDINATE_DIGITS = 6

OBJECTS_SQL = """
WITH bbox_area AS (
    SELECT ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326)::geometry AS bbox
)
SELECT p.osm_type, p.osm_id, p.name, cat.slug AS category,
       CASE WHEN p.geometry IS NULL THEN 'Point' ELSE GeometryType(p.geometry::geometry) END AS geom_type,
       ST_AsGeoJSON(
           CASE
               WHEN p.geometry IS NULL THEN p.location::geometry
               ELSE ST_SimplifyPreserveTopology(p.geometry::geometry, :tolerance)
           END,
           :digits
       )::jsonb AS geometry
FROM pois p
JOIN poi_categories pc ON pc.poi_id = p.id
JOIN categories cat ON cat.id = pc.category_id
JOIN layers l ON l.id = cat.layer_id
CROSS JOIN bbox_area
WHERE p.is_active AND l.slug = :layer
  AND ST_Intersects(p.location::geometry, bbox_area.bbox)
ORDER BY p.osm_id
LIMIT :limit
"""

COUNT_SQL = """
WITH bbox_area AS (
    SELECT ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326)::geometry AS bbox
)
SELECT count(*)
FROM pois p
JOIN poi_categories pc ON pc.poi_id = p.id
JOIN categories cat ON cat.id = pc.category_id
JOIN layers l ON l.id = cat.layer_id
CROSS JOIN bbox_area
WHERE p.is_active AND l.slug = :layer
  AND ST_Intersects(p.location::geometry, bbox_area.bbox)
"""


@router.get(
    "/layers/{slug}/objects",
    response_model=LayerObjectsResponse,
    summary="Объекты слоя в границах вида карты",
    responses={
        304: {"description": "Данные не изменились (ETag совпал)"},
        400: {"model": ProblemOut, "description": "Некорректный bbox"},
        404: {"model": ProblemOut, "description": "Город или слой не найдены"},
    },
)
async def get_layer_objects(
    request: Request,
    response: Response,
    session: SessionDep,
    slug: str,
    city: Annotated[str, Query(description="slug города, например tomsk")],
    bbox: Annotated[str, Query(description="границы вида: min_lon,min_lat,max_lon,max_lat")],
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT, description="сколько объектов вернуть")] = DEFAULT_LIMIT,
) -> LayerObjectsResponse | Response:
    """Объекты слоя своей геометрией — «проверить слой глазами».

    Границы вида обязательны: слой целиком (жильё — 15 050 полигонов) в браузер не отдаём. Если объектов
    в границах больше лимита, честно сообщаем об этом в `meta.truncated` — интерфейс покажет, что видит
    не всё.
    """
    await require_city(session, city)
    layer = await require_layer(session, slug)

    try:
        min_lon, min_lat, max_lon, max_lat = parse_bbox(bbox)
    except ValueError as exc:
        raise ProblemException(400, str(exc)) from exc

    version = await load_data_version(session)
    etag = make_etag("objects", city, slug, bbox, limit, version.version)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": DATA_CACHE_CONTROL})

    params: dict[str, Any] = {
        "layer": slug,
        "min_lon": min_lon,
        "min_lat": min_lat,
        "max_lon": max_lon,
        "max_lat": max_lat,
        "limit": limit,
        "tolerance": SIMPLIFY_DEGREES,
        "digits": COORDINATE_DIGITS,
    }

    total = (await session.execute(text(COUNT_SQL), params)).scalar_one()
    rows = (await session.execute(text(OBJECTS_SQL), params)).mappings().all()

    features = [
        LayerObjectFeature(
            geometry=row["geometry"],
            properties=LayerObjectProperties(
                osm=f"{row['osm_type']}/{row['osm_id']}",
                name=row["name"],
                category=row["category"],
                geom_type=row["geom_type"],
            ),
        )
        for row in rows
    ]

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = DATA_CACHE_CONTROL

    # Источник с лицензией: объекты слоя — данные OSM, атрибуция нужна и в подписи на карте
    source = source_out(layer)
    return LayerObjectsResponse(
        features=features,
        meta=LayerObjectsMeta(
            layer=slug,
            layer_name=str(layer["name_ru"]),
            bbox=bbox,
            limit=limit,
            total=total,
            returned=len(features),
            truncated=total > len(features),
            data_version=version.version,
            updated_at=version.updated_at,
        ),
        sources=[source] if source is not None else [],
    )
