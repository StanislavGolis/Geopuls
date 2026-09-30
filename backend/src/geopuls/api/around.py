"""Что вокруг точки: конкуренты и инфраструктура в радиусе (ТЗ §3.2, план развития этап 3).

Зачем отдельный эндпоинт: сетка H3 отвечает «сколько в ячейке», а предприниматель прикидывает
«что в пяти минутах пешком от адреса». Круг радиуса 500 м не совпадает с границами гекса, и по сетке
его не собрать — ТЗ §3.2 прямо требует `ST_DWithin`, а не приближение через `grid_disk`.

Считаем по объектам, а не по ячейкам: у слоёв разная метрика (плотность, доля площади, километры),
а в круге честно измеряется только количество и расстояние. Поэтому в ответе — ``objects`` и
``nearest_m``: «рядом 3 конкурента, ближайший в 80 м» вместо «доля площади 12%», которую мы не считали.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import text

from geopuls.api.deps import SessionDep, load_data_version, require_category, require_city
from geopuls.api.geojson import make_etag
from geopuls.api.layers import load_active_layers, source_out
from geopuls.api.problems import DATA_CACHE_CONTROL, ProblemException
from geopuls.api.schemas import (
    AroundLayerOut,
    AroundMeta,
    AroundResponse,
    LatLngOut,
    LayerSourceOut,
    ProblemOut,
)

router = APIRouter(prefix="/api/v1", tags=["around"])

#: Пределы радиуса: меньше 100 м — это уже «внутри здания», больше 2 км — это уже другой продукт.
MIN_RADIUS_M = 100
MAX_RADIUS_M = 2000
DEFAULT_RADIUS_M = 500

#: Слой, в котором «конкурент» = объект выбранной категории: остальные слои берём целиком.
COMPETITORS_SLUG = "competitors"

#: Объекты слоёв в радиусе: с расстоянием до точки и именем (для «ближайший — кофейня, 80 м»).
AROUND_SQL = """
WITH point AS (SELECT ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography AS geom)
SELECT l.slug AS layer, l.name_ru AS layer_name, l.metric_kind, l.unit,
       cat.slug AS category, p.name AS poi_name,
       round(ST_Distance(p.location, point.geom)::numeric, 1) AS distance_m
FROM pois p
JOIN poi_categories pc ON pc.poi_id = p.id
JOIN categories cat ON cat.id = pc.category_id
JOIN layers l ON l.id = cat.layer_id
CROSS JOIN point
WHERE p.is_active AND l.is_active
  AND ST_DWithin(p.location, point.geom, :radius_m)
  AND (l.slug <> :competitors OR cat.slug = :category)
ORDER BY l.sort_order, l.slug, distance_m
"""


@router.get(
    "/around",
    response_model=AroundResponse,
    summary="Что вокруг точки в радиусе",
    responses={
        304: {"description": "Данные не изменились (ETag совпал)"},
        400: {"model": ProblemOut, "description": "Не указана категория конкурентов"},
        404: {"model": ProblemOut, "description": "Город или категория не найдены"},
    },
)
async def get_around(
    request: Request,
    response: Response,
    session: SessionDep,
    city: Annotated[str, Query(description="slug города, например tomsk")],
    lat: Annotated[float, Query(ge=-90, le=90, description="широта точки")],
    lon: Annotated[float, Query(ge=-180, le=180, description="долгота точки")],
    category: Annotated[str | None, Query(description="категория конкурентов, например cafe")] = None,
    radius_m: Annotated[int, Query(ge=MIN_RADIUS_M, le=MAX_RADIUS_M, description="радиус в метрах")] = DEFAULT_RADIUS_M,
) -> AroundResponse | Response:
    """Объекты всех слоёв в радиусе: сколько их и как близко ближайший.

    Категория обязательна: без неё «конкуренты» — это все категории, то есть не конкуренты.
    Слои без объектов рядом тоже попадают в ответ: «нет остановок в 500 м» — это тоже ответ.
    """
    await require_city(session, city)
    if not category:
        raise ProblemException(400, "Укажите категорию: без неё непонятно, кого считать конкурентами")
    await require_category(session, category)

    version = await load_data_version(session)
    etag = make_etag("around", city, lat, lon, radius_m, category, version.version)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": DATA_CACHE_CONTROL})

    rows = (
        (
            await session.execute(
                text(AROUND_SQL),
                {
                    "lon": lon,
                    "lat": lat,
                    "radius_m": radius_m,
                    "category": category,
                    "competitors": COMPETITORS_SLUG,
                },
            )
        )
        .mappings()
        .all()
    )

    found: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = found.get(row["layer"])
        if entry is None:
            entry = {
                "slug": row["layer"],
                "name": row["layer_name"],
                "metric_kind": row["metric_kind"],
                "unit": row["unit"],
                "objects": 0,
                "nearest_m": None,
                "nearest_name": None,
            }
            found[row["layer"]] = entry
        entry["objects"] += 1
        if entry["nearest_m"] is None or row["distance_m"] < entry["nearest_m"]:
            entry["nearest_m"] = float(row["distance_m"])
            entry["nearest_name"] = row["poi_name"]

    registry = await load_active_layers(session)
    layers: list[AroundLayerOut] = []
    for slug, meta in registry.items():
        entry = found.get(
            slug,
            {
                "slug": slug,
                "name": meta["name_ru"],
                "metric_kind": meta["metric_kind"],
                "unit": meta["unit"],
                "objects": 0,
                "nearest_m": None,
                "nearest_name": None,
            },
        )
        # В строке слоя-конкурентов показываем категорию, по которой считали: иначе непонятно, чьи это
        layers.append(AroundLayerOut(category=category if slug == COMPETITORS_SLUG else None, **entry))

    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = DATA_CACHE_CONTROL
    return AroundResponse(
        point=LatLngOut(lat=lat, lon=lon),
        meta=AroundMeta(
            city=city,
            radius_m=radius_m,
            category=category,
            data_version=version.version,
            updated_at=version.updated_at,
        ),
        layers=layers,
        sources=_unique_sources(registry),
    )


def _unique_sources(registry: dict[str, dict[str, Any]]) -> list[LayerSourceOut]:
    """Источники без повторов: один датасет питает несколько слоёв, а в ответе он должен быть один раз."""
    seen: dict[str, LayerSourceOut] = {}
    for meta in registry.values():
        source = source_out(meta)
        if source is not None:
            seen.setdefault(source.slug, source)
    return list(seen.values())
