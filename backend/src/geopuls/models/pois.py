"""POI и связь многие-ко-многим с категориями."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from geoalchemy2 import Geography, WKBElement
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from geopuls.models.base import Base


class Poi(Base):
    """Объект из OSM, приведённый к точке.

    Правила:
    - координаты хранятся только в ``location`` (никаких отдельных lat/lon — иначе два источника истины);
    - ``h3_r9``/``h3_r8`` заполняются при импорте, чтобы агрегация была обычным `GROUP BY`;
    - ``is_active = false`` означает «объект исчез из OSM» (мягкое удаление), запись не стирается;
    - адрес — отдельными полями + флаг ``has_address`` как индикатор зрелости данных.
    """

    __tablename__ = "pois"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    osm_type: Mapped[str] = mapped_column(String(10))
    osm_id: Mapped[int] = mapped_column(BigInteger)
    name: Mapped[str | None] = mapped_column(String(300))
    brand: Mapped[str | None] = mapped_column(String(200))
    addr_street: Mapped[str | None] = mapped_column(String(200))
    addr_housenumber: Mapped[str | None] = mapped_column(String(50))
    location: Mapped[WKBElement] = mapped_column(Geography(geometry_type="POINT", srid=4326, spatial_index=False))
    #: Геометрия объекта для метрик площади и длины (Этап 9): у way это линия или полигон, у node — NULL.
    #: Точка (`location`) остаётся основой всего остального: по ней идёт привязка к ячейке, список
    #: объектов и фильтр по полигону города.
    geometry: Mapped[WKBElement | None] = mapped_column(
        Geography(geometry_type="GEOMETRY", srid=4326, spatial_index=False)
    )
    h3_r9: Mapped[int] = mapped_column(BigInteger)
    h3_r8: Mapped[int] = mapped_column(BigInteger)
    tags: Mapped[dict[str, Any]] = mapped_column(JSONB)
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    has_address: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    source: Mapped[str] = mapped_column(String(20))
    osm_version: Mapped[int | None] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("osm_type", "osm_id"),
        Index("ix_pois_h3_r9", "h3_r9"),
        Index("ix_pois_h3_r8", "h3_r8"),
        Index("ix_pois_location", "location", postgresql_using="gist"),
        Index("ix_pois_geometry", "geometry", postgresql_using="gist"),
    )


class PoiCategory(Base):
    """Связь POI ↔ категории: один объект может относиться к нескольким категориям."""

    __tablename__ = "poi_categories"

    poi_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("pois.id", ondelete="CASCADE"), primary_key=True)
    category_id: Mapped[int] = mapped_column(Integer, ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True)
