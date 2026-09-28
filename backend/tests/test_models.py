"""Тесты метаданных моделей: схема должна соответствовать разделу 6 ТЗ (без БД)."""

from __future__ import annotations

from geoalchemy2 import Geography
from sqlalchemy import BigInteger, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from geopuls.models import Base

EXPECTED_TABLES = {
    "categories",
    "cell_stats",
    "cities",
    "city_cells",
    "data_versions",
    "import_runs",
    "poi_categories",
    "pois",
}


def test_all_tables_are_registered() -> None:
    assert set(Base.metadata.tables) == EXPECTED_TABLES


def test_pois_unique_key_and_indexes() -> None:
    pois = Base.metadata.tables["pois"]

    unique_columns = {
        tuple(constraint.columns.keys()) for constraint in pois.constraints if isinstance(constraint, UniqueConstraint)
    }
    assert ("osm_type", "osm_id") in unique_columns
    assert {index.name for index in pois.indexes} == {"ix_pois_h3_r8", "ix_pois_h3_r9", "ix_pois_location"}


def test_h3_columns_are_bigint_for_fast_aggregation() -> None:
    """Индексы H3 должны храниться как bigint: агрегация становится обычным GROUP BY."""
    pois = Base.metadata.tables["pois"]
    city_cells = Base.metadata.tables["city_cells"]

    assert isinstance(pois.c.h3_r9.type, BigInteger)
    assert isinstance(pois.c.h3_r8.type, BigInteger)
    assert isinstance(city_cells.c.h3_index.type, BigInteger)


def test_geometry_columns_use_geography() -> None:
    cities = Base.metadata.tables["cities"]
    pois = Base.metadata.tables["pois"]

    for column in (cities.c.boundary, cities.c.bbox, cities.c.center, pois.c.location):
        assert isinstance(column.type, Geography)
        assert column.type.srid == 4326

    # Пространственные индексы заданы явно (spatial_index=False) — иначе Alembic их не видит
    assert {index.name for index in cities.indexes} == {
        "ix_cities_bbox",
        "ix_cities_boundary",
        "ix_cities_center",
    }


def test_categories_osm_tags_are_jsonb() -> None:
    categories = Base.metadata.tables["categories"]

    assert isinstance(categories.c.osm_tags.type, JSONB)
    assert categories.c.slug.unique is True


def test_city_cells_primary_key_covers_resolution() -> None:
    city_cells = Base.metadata.tables["city_cells"]

    assert [column.name for column in city_cells.primary_key.columns] == [
        "city_id",
        "resolution",
        "h3_index",
    ]


def test_cell_stats_primary_key_covers_category() -> None:
    cell_stats = Base.metadata.tables["cell_stats"]

    assert [column.name for column in cell_stats.primary_key.columns] == [
        "city_id",
        "resolution",
        "h3_index",
        "category_id",
    ]
    assert "density" in cell_stats.c
    assert "has_address_ratio" in cell_stats.c
