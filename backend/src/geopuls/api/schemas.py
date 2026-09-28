"""Схемы ответов API (контракт OpenAPI)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class BBoxOut(BaseModel):
    """Прямоугольник города в градусах."""

    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float


class LatLngOut(BaseModel):
    lat: float
    lon: float


class CityOut(BaseModel):
    slug: str
    name: str
    region: str | None = None
    h3_res: int
    area_km2: float
    center: LatLngOut
    bbox: BBoxOut
    data_version: str | None = None
    updated_at: datetime | None = None


class CategoryOut(BaseModel):
    slug: str
    name: str
    color: str
    poi_count: int


class CellsMeta(BaseModel):
    """Метаданные теплового слоя: дата данных и шкала легенды."""

    city: str
    category: str
    res: int
    data_version: str | None = None
    updated_at: datetime | None = None
    cell_count: int
    non_empty_count: int
    poi_count: int
    max_density: float
    density_breaks: list[float]
    bbox_filter: str | None = None


class CellsResponse(BaseModel):
    """GeoJSON FeatureCollection теплового слоя.

    ``features`` отдаются готовыми GeoJSON-объектами (геометрия — полигон ячейки H3):
    валидировать 1500+ вложенных геометрий через Pydantic на каждый запрос незачем.
    """

    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[dict[str, Any]]
    meta: CellsMeta


class PoiOut(BaseModel):
    osm_type: str
    osm_id: int
    name: str | None = None
    brand: str | None = None
    address: str | None = None
    categories: list[str] = Field(default_factory=list)
    lat: float
    lon: float
    osm_url: str


class PoisMeta(BaseModel):
    city: str
    cell: str
    res: int
    category: str | None = None
    total: int
    returned: int
    limit: int
    offset: int
    data_version: str | None = None


class PoisResponse(BaseModel):
    items: list[PoiOut]
    meta: PoisMeta


class ProblemOut(BaseModel):
    """Тело ошибки в формате RFC 9457 (документируется в OpenAPI)."""

    type: str = "about:blank"
    title: str
    status: int
    detail: str
    instance: str
