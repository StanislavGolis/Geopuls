"""Модели данных ГЕОПУЛЬС.

Импорт всех моделей здесь обязателен: Alembic берёт схему из ``Base.metadata``,
и таблицы, не импортированные в этом модуле, в миграции не попадут.
"""

from __future__ import annotations

from geopuls.models.base import Base
from geopuls.models.catalog import Category, DataVersion
from geopuls.models.geo import CellStat, City, CityCell
from geopuls.models.ingest import ImportRun
from geopuls.models.pois import Poi, PoiCategory

__all__ = [
    "Base",
    "Category",
    "CellStat",
    "City",
    "CityCell",
    "DataVersion",
    "ImportRun",
    "Poi",
    "PoiCategory",
]
