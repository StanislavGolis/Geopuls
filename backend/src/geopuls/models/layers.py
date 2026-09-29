"""Слои карты, источники данных и метрики по ячейкам (ADR 0013).

Почему отдельные таблицы, а не «ещё одна категория»: у слоёв разные метрики (количество, доля
площади, человек на км², длина пути), разные источники (OSM, растры GHSL) и разные лицензии.
Категория остаётся вариантом внутри слоя: сегодняшние восемь категорий — это слой «Конкуренты».

Историю храним с первого дня: ``data_version`` входит в ключ ``cell_metrics``, поэтому снимки
не затирают друг друга, и «открылось/закрылось за полгода» становится возможным без миграции
задним числом.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Computed,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from geopuls.models.base import Base

#: Виды слоёв: объекты OSM, растровые источники, производные (композитные) метрики.
LAYER_KINDS = ("osm", "raster", "composite")
#: Типы метрик: смысл значения задаётся слоем, а не догадками читателя.
METRIC_KINDS = ("count", "density", "area_share", "people", "people_density", "ratio", "length", "presence")


class Dataset(Base):
    """Источник данных и его условия: лицензия, атрибуция, версия.

    Версия ведётся по источнику, а не по городу: OSM обновляется еженедельно, растровые слои —
    раз в несколько лет и имеют «эпоху» (например, GHSL R2023A).
    """

    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(50), unique=True)
    title: Mapped[str] = mapped_column(String(200))
    license: Mapped[str | None] = mapped_column(String(100))
    license_url: Mapped[str | None] = mapped_column(Text)
    #: Текст для строки атрибуции в интерфейсе и подписи экспорта.
    attribution_text: Mapped[str | None] = mapped_column(Text)
    #: Как цитировать источник (для GHSL и подобных требуется указание публикации).
    citation: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    data_version: Mapped[str | None] = mapped_column(String(50))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Layer(Base):
    """Слой карты: продуктовая единица (конкуренты, население, транспорт, …)."""

    __tablename__ = "layers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(50), unique=True)
    name_ru: Mapped[str] = mapped_column(String(200))
    #: 'osm' | 'raster' | 'composite'
    kind: Mapped[str] = mapped_column(String(20))
    #: Что означает ``cell_metrics.value``: 'count' | 'density' | 'area_share' | … (см. METRIC_KINDS)
    metric_kind: Mapped[str] = mapped_column(String(20))
    unit: Mapped[str | None] = mapped_column(String(50))
    #: Как считать границы классов легенды: 'quantile' | 'linear' | 'log'
    scale: Mapped[str] = mapped_column(String(20), server_default=text("'quantile'"))
    color: Mapped[str] = mapped_column(String(20), server_default=text("'#1f6fb2'"))
    #: Может ли слой задавать заливку карты: красящим может быть только один слой за раз.
    can_be_base: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    dataset_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("datasets.id", ondelete="SET NULL"))
    sort_order: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CellMetric(Base):
    """Значение метрики слоя по ячейке H3 (включая пустые ячейки: ноль — это тоже значение).

    Ключ включает ``data_version``: пересборка того же среза перезаписывает строки, а новая
    выгрузка добавляет снимок. ``category_key`` — техническая колонка ``coalesce(category_id, 0)``,
    нужна, потому что NULL не может быть частью первичного ключа.
    """

    __tablename__ = "cell_metrics"

    city_id: Mapped[int] = mapped_column(Integer, ForeignKey("cities.id", ondelete="CASCADE"), primary_key=True)
    layer_id: Mapped[int] = mapped_column(Integer, ForeignKey("layers.id", ondelete="CASCADE"), primary_key=True)
    #: Технический ключ категории: 0 — «вариантов нет» (метрика не про категорию)
    category_key: Mapped[int] = mapped_column(
        Integer, Computed("coalesce(category_id, 0)", persisted=True), primary_key=True
    )
    resolution: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    h3_index: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    data_version: Mapped[str] = mapped_column(String(50), primary_key=True)

    category_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("categories.id", ondelete="CASCADE"))
    #: Смысл значения задаётся слоем; тип дублируется в строке, чтобы значение читалось без join
    value: Mapped[float] = mapped_column(Float, server_default=text("0"))
    value_kind: Mapped[str] = mapped_column(String(20))
    #: Дополнительные показатели той же ячейки (число объектов, доля адресов, этажность, …)
    extras: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    dataset_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("datasets.id", ondelete="SET NULL"))
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_cell_metrics_city_layer_res", "city_id", "layer_id", "resolution"),
        Index("ix_cell_metrics_h3", "h3_index"),
    )
