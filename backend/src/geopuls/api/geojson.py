"""Помощники GeoJSON: полигон H3-ячейки и ETag для кэша."""

from __future__ import annotations

import hashlib
from typing import Any

import h3

#: Точность координат: 6 знаков — примерно 11 см, для ячейки ~200 м достаточно,
#: а размер ответа ощутимо меньше.
COORD_PRECISION = 6


def cell_polygon(h3_index: int) -> dict[str, Any]:
    """Полигон ячейки H3 в GeoJSON: координаты ``[lon, lat]``, кольцо замкнуто.

    h3-py возвращает пары ``(lat, lng)``, поэтому порядок меняем вручную
    (в h3-js для этого есть флаг ``geo_json``, в Python его нет).
    """
    boundary = h3.cell_to_boundary(h3.int_to_str(h3_index))
    ring = [[round(lon, COORD_PRECISION), round(lat, COORD_PRECISION)] for lat, lon in boundary]
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def h3_text(h3_index: int) -> str:
    """Текстовый H3-индекс (int64 в БД → hex-строка для API и h3-js на фронтенде)."""
    return h3.int_to_str(h3_index)


def cell_feature(h3_index: int, properties: dict[str, Any]) -> dict[str, Any]:
    """GeoJSON-объект ячейки: ``id`` — текстовый H3-индекс (совместим с h3-js на фронтенде)."""
    return {
        "type": "Feature",
        "id": h3_text(h3_index),
        "properties": properties,
        "geometry": cell_polygon(h3_index),
    }


def make_etag(*parts: object) -> str:
    """ETag по составу ответа: город, категория, разрешение, версия данных (и фильтр bbox)."""
    payload = "|".join("" if part is None else str(part) for part in parts)
    digest = hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]
    return f'"{digest}"'


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    """Разобрать ``min_lon,min_lat,max_lon,max_lat`` (порядок как в GeoJSON)."""
    parts = [item.strip() for item in value.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox задаётся как min_lon,min_lat,max_lon,max_lat")
    try:
        min_lon, min_lat, max_lon, max_lat = (float(item) for item in parts)
    except ValueError as exc:
        raise ValueError("координаты bbox должны быть числами") from exc
    if min_lon >= max_lon or min_lat >= max_lat:
        raise ValueError("bbox должен задавать непустую область")
    return min_lon, min_lat, max_lon, max_lat
