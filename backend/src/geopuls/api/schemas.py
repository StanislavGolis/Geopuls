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


class LayerSourceOut(BaseModel):
    """Источник данных слоя: лицензия и атрибуция нужны интерфейсу и экспорту (ADR 0013)."""

    slug: str
    title: str
    license: str | None = None
    license_url: str | None = None
    attribution_text: str | None = None
    citation: str | None = None
    source_url: str | None = None
    data_version: str | None = None


class LayerOut(BaseModel):
    """Слой карты: чем измеряется, в каких единицах и может ли красить карту."""

    slug: str
    name: str
    kind: str
    metric_kind: str
    unit: str | None = None
    scale: str
    color: str
    can_be_base: bool
    categories: list[str] = Field(default_factory=list)
    source: LayerSourceOut | None = None


class LayersResponse(BaseModel):
    layers: list[LayerOut]
    data_version: str | None = None


class ProfileGridOut(BaseModel):
    """Охват сетки города: сколько ячеек и как они заполнены данными конкурентов."""

    res: int
    cells: int
    cells_non_empty: int
    #: Доля пустых ячеек, %. Пустая ячейка — это не «нет бизнеса», а «нет размеченных объектов»:
    #: именно эту разницу профиль города и обязан объяснять (ТЗ §4.2).
    empty_share: float
    poi_count: int


class ProfileCategoryOut(BaseModel):
    """Категория конкурентов в профиле города: сколько объектов и какую долю они занимают."""

    slug: str
    name: str
    color: str
    poi_count: int
    share: float | None = None


class ProfileLayerOut(BaseModel):
    """Слой в профиле: метрика, покрытие и максимум — те же правила, что в легенде карты."""

    slug: str
    name: str
    metric_kind: str
    unit: str | None = None
    color: str
    covered_count: int
    non_empty_count: int
    max_value: float


class CityProfileOut(BaseModel):
    """Профиль города: сводка, по которой видно, что это за город и насколько полны данные.

    Не содержит выводов и рекомендаций (ADR 0015) — только наблюдения: сколько объектов, по каким
    категориям и слоям, из каких источников и на какую дату.
    """

    type: Literal["CityProfile"] = "CityProfile"
    city: CityOut
    grid: ProfileGridOut
    categories: list[ProfileCategoryOut] = Field(default_factory=list)
    layers: list[ProfileLayerOut] = Field(default_factory=list)
    sources: list[LayerSourceOut] = Field(default_factory=list)


class LayerCellsMeta(BaseModel):
    """Метаданные слоя: единица измерения, шкала легенды и источники видимых данных."""

    city: str
    layer: str
    category: str | None = None
    res: int
    metric_kind: str
    unit: str | None = None
    data_version: str | None = None
    updated_at: datetime | None = None
    cell_count: int
    non_empty_count: int
    total_value: float
    max_value: float
    breaks: list[float]
    sources: list[LayerSourceOut] = Field(default_factory=list)
    bbox_filter: str | None = None


class LayerCellsResponse(BaseModel):
    """GeoJSON слоя: значение метрики в ``properties.value``, тип — в ``properties.value_kind``."""

    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[dict[str, Any]]
    meta: LayerCellsMeta


class CellMetricOut(BaseModel):
    """Одно значение в профиле ячейки: слой, вариант (если есть) и дополнительные показатели."""

    layer: str
    layer_name: str
    category: str | None = None
    metric_kind: str
    unit: str | None = None
    value: float
    extras: dict[str, Any] | None = None


class CellProfileMeta(BaseModel):
    city: str
    cell: str
    res: int
    data_version: str | None = None
    updated_at: datetime | None = None


class CellProfileResponse(BaseModel):
    """Все значения ячейки по слоям — основа для объяснения «здесь жильё и остановка, кафе нет»."""

    metrics: list[CellMetricOut]
    meta: CellProfileMeta


class MapLayerColumn(BaseModel):
    """Один слой в колоночном ответе: массив значений, выровненный с ``cells.h3``.

    ``values[i] is None`` означает «у слоя нет значения для этой ячейки» (слой собран не по всей
    сетке). Это честнее нуля: ноль утверждает «объектов нет», ``None`` — «мы не знаем».
    """

    slug: str
    name: str
    category: str | None = None
    role: Literal["base", "overlay"]
    metric_kind: str
    unit: str | None = None
    scale: str
    color: str
    values: list[float | None]
    extras: dict[str, list[float | None]] = Field(default_factory=dict)
    covered_count: int
    non_empty_count: int
    total_value: float
    max_value: float
    breaks: list[float]
    source: LayerSourceOut | None = None


class MapCellsOut(BaseModel):
    """Колоночный набор ячеек: H3-индекс и геометрия — один раз на весь набор слоёв (ADR 0013).

    Полигон ячейки от слоя не зависит, поэтому хранится в ответе в единственном экземпляре: именно
    на этом колоночный формат и экономит (геометрия — самое дорогое в ответе).
    """

    h3: list[str]
    geometry: list[list[list[float]]]


class MapMeta(BaseModel):
    """Метаданные колоночной карты: что запрошено, по какому снимку данных и из каких источников."""

    city: str
    res: int
    cell_count: int
    base: str
    overlays: list[str] = Field(default_factory=list)
    data_version: str | None = None
    updated_at: datetime | None = None
    bbox_filter: str | None = None
    sources: list[LayerSourceOut] = Field(default_factory=list)


class MapResponse(BaseModel):
    """Карта целиком: колонки ячеек и значения всех запрошенных слоёв одним ответом."""

    type: Literal["LayerGrid"] = "LayerGrid"
    cells: MapCellsOut
    layers: list[MapLayerColumn]
    meta: MapMeta
