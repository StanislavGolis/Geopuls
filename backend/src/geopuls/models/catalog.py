"""Справочники: категории POI и версии данных."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from geopuls.models.base import Base


class Category(Base):
    """Категория POI и её маппинг на OSM-теги.

    ``osm_tags`` — данные, а не код: список пар ``[{"key": "amenity", "value": "cafe"}]``.
    Правила внутри одной категории объединяются через «или» (см. `geopuls.categories`).
    """

    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(50), unique=True)
    name_ru: Mapped[str] = mapped_column(String(200))
    osm_tags: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    color: Mapped[str] = mapped_column(String(20), server_default=text("'#1f6fb2'"))
    #: Слой, внутри которого категория является вариантом (ADR 0013): сегодня — «Конкуренты»
    layer_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("layers.id", ondelete="SET NULL"))
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    sort_order: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DataVersion(Base):
    """Версия данных (дата выгрузки OSM): попадает в API-ответы, кэш и интерфейс."""

    __tablename__ = "data_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[str] = mapped_column(String(50), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
