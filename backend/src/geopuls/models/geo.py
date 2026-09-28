"""Города и H3-сетка: полная сетка города, включая пустые ячейки (раздел 6 ТЗ)."""

from __future__ import annotations

from datetime import datetime

from geoalchemy2 import Geography, WKBElement
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from geopuls.models.base import Base


class City(Base):
    """Город: полигон (не bbox!) — по нему строятся ячейки и клип объектов.

    Пространственные индексы заданы явно (`spatial_index=False` у GeoAlchemy2),
    чтобы Alembic видел их в миграциях.
    """

    __tablename__ = "cities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(50), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    region: Mapped[str | None] = mapped_column(String(200))
    osm_relation_id: Mapped[int | None] = mapped_column(BigInteger)
    boundary: Mapped[WKBElement | None] = mapped_column(
        Geography(geometry_type="MULTIPOLYGON", srid=4326, spatial_index=False)
    )
    bbox: Mapped[WKBElement | None] = mapped_column(Geography(geometry_type="POLYGON", srid=4326, spatial_index=False))
    center: Mapped[WKBElement | None] = mapped_column(Geography(geometry_type="POINT", srid=4326, spatial_index=False))
    h3_res: Mapped[int] = mapped_column(SmallInteger, server_default=text("9"))
    population: Mapped[int | None] = mapped_column(Integer)
    timezone: Mapped[str | None] = mapped_column(String(50))
    # Происхождение полигона: 'nominatim' | 'osm-pbf' | 'bbox' | 'manual'
    boundary_source: Mapped[str | None] = mapped_column(String(30))
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_cities_boundary", "boundary", postgresql_using="gist"),
        Index("ix_cities_bbox", "bbox", postgresql_using="gist"),
        Index("ix_cities_center", "center", postgresql_using="gist"),
    )


class CityCell(Base):
    """Полная H3-сетка города для конкретного разрешения.

    Заполняется по полигону города и включает ячейки с нулём объектов —
    именно они и есть продукт «карта пустых зон».
    """

    __tablename__ = "city_cells"

    city_id: Mapped[int] = mapped_column(Integer, ForeignKey("cities.id", ondelete="CASCADE"), primary_key=True)
    resolution: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    h3_index: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    centroid: Mapped[WKBElement | None] = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False)
    )
    area_km2: Mapped[float] = mapped_column(Float)

    __table_args__ = (Index("ix_city_cells_centroid", "centroid", postgresql_using="gist"),)


class CellStat(Base):
    """Агрегат по ячейке и категории: количество POI, плотность и зрелость данных.

    ``density`` (POI на км²) — основная метрика цвета тепловой карты:
    площадь ячейки H3 res 9 различается до 1.99× (см. docs/recon/).
    """

    __tablename__ = "cell_stats"

    city_id: Mapped[int] = mapped_column(Integer, ForeignKey("cities.id", ondelete="CASCADE"), primary_key=True)
    resolution: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    h3_index: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    category_id: Mapped[int] = mapped_column(Integer, ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True)
    poi_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    density: Mapped[float] = mapped_column(Float, server_default=text("0"))
    has_address_ratio: Mapped[float | None] = mapped_column(Float)
