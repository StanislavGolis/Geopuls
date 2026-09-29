"""Интеграционные тесты схемы и сидирования на живой PostGIS.

Включаются только при ``GEOPULS_CI_DB=1``: в CI создаётся отдельная тестовая база и применяются
миграции (шаги workflow). Локально без БД тесты помечаются как пропущенные.

Фикстуры `engine` / `clean_engine` и параметры города берутся из `conftest.py` — они работают
только с базой, в имени которой есть `test`, чтобы тесты не могли очистить рабочую базу.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from conftest import tomsk_city_params
from geopuls.db import session_scope
from geopuls.layers_catalog import ALL_CATEGORIES
from geopuls.seed import seed_categories, seed_city

DB_TESTS_ENABLED = os.getenv("GEOPULS_CI_DB") == "1"

pytestmark = pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")

tomsk_params = tomsk_city_params


async def test_schema_present(clean_engine: AsyncEngine) -> None:
    async with session_scope(clean_engine) as session:
        tables = (
            await session.execute(
                text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
            )
        ).scalars()
    assert {"categories", "cities", "pois", "city_cells", "cell_stats", "import_runs"} <= set(tables)


async def test_seed_categories_is_idempotent(clean_engine: AsyncEngine) -> None:
    async with session_scope(clean_engine) as session:
        slugs = await seed_categories(session)
    # Сид записывает категории всех слоёв, а не только конкурентов: иначе слои Этапа 9 останутся без данных
    expected = {category.slug for category in ALL_CATEGORIES}
    assert len(slugs) == len(expected)

    # Повторный запуск не создаёт дубликатов, но обновляет данные
    async with session_scope(clean_engine) as session:
        await seed_categories(session)

    async with session_scope(clean_engine) as session:
        count = (await session.execute(text("SELECT count(*) FROM categories"))).scalar_one()
        fast_food = (
            await session.execute(
                text(
                    "SELECT count(*) FROM categories WHERE slug = 'restaurant' "
                    'AND osm_tags @> \'[{"key": "amenity", "value": "fast_food"}]\'::jsonb'
                )
            )
        ).scalar_one()

    assert count == len(expected)
    assert fast_food == 1


async def test_seed_city_stores_polygon_bbox_and_center(clean_engine: AsyncEngine) -> None:
    params = tomsk_params()

    async with session_scope(clean_engine) as session:
        result = await seed_city(session, params)
        await seed_city(session, params)  # идемпотентность: второго города быть не должно

    # Площадь городского округа Томска ≈ 300 км² — проверяем порядок величины
    assert 100 < result["area_km2"] < 500

    async with session_scope(clean_engine) as session:
        row = (
            (
                await session.execute(
                    text(
                        "SELECT count(*) AS cities, "
                        "min(ST_GeometryType(boundary::geometry)) AS geometry_type, "
                        "bool_and(ST_Contains(boundary::geometry, center::geometry)) AS center_inside, "
                        "bool_and(ST_Area(bbox) >= ST_Area(boundary)) AS bbox_covers, "
                        "min(osm_relation_id) AS relation_id, min(boundary_source) AS source "
                        "FROM cities WHERE slug = 'tomsk'"
                    )
                )
            )
            .mappings()
            .one()
        )

    assert row["cities"] == 1
    assert row["geometry_type"] == "ST_MultiPolygon"
    assert row["center_inside"] is True, "центр обязан лежать внутри полигона города"
    assert row["bbox_covers"] is True
    assert row["relation_id"] == 7261645
    assert row["source"] == "nominatim"


async def test_empty_cell_is_storable(clean_engine: AsyncEngine) -> None:
    """«Карта пустых зон»: ячейка без объектов хранится наравне с заполненной."""
    async with session_scope(clean_engine) as session:
        await seed_categories(session)
        city_id = (await seed_city(session, tomsk_params()))["city_id"]
        await session.execute(
            text(
                "INSERT INTO city_cells (city_id, resolution, h3_index, centroid, area_km2) "
                "VALUES (:city_id, 9, 623307810877882367, "
                "ST_SetSRID(ST_MakePoint(84.9482, 56.4847), 4326)::geography, 0.1053)"
            ),
            {"city_id": city_id},
        )
        await session.execute(
            text(
                "INSERT INTO cell_stats (city_id, resolution, h3_index, category_id, poi_count, density) "
                "SELECT :city_id, 9, 623307810877882367, id, 0, 0 FROM categories WHERE slug = 'cafe'"
            ),
            {"city_id": city_id},
        )

    async with session_scope(clean_engine) as session:
        zeros = (
            await session.execute(text("SELECT count(*) FROM cell_stats WHERE poi_count = 0 AND density = 0"))
        ).scalar_one()

    assert zeros == 1


async def test_poi_unique_constraint_and_category_link(clean_engine: AsyncEngine) -> None:
    insert_poi = text(
        "INSERT INTO pois (osm_type, osm_id, name, location, h3_r9, h3_r8, tags, source, has_address) "
        "VALUES (:osm_type, :osm_id, :name, ST_SetSRID(ST_MakePoint(84.9482, 56.4847), 4326)::geography, "
        ":h3_r9, :h3_r8, CAST(:tags AS jsonb), 'geofabrik', true) RETURNING id"
    )
    params = {
        "osm_type": "node",
        "osm_id": 12345,
        "name": "Тестовая кофейня",
        "h3_r9": 623307810877882367,
        "h3_r8": 613307810877882367,
        "tags": '{"amenity": "cafe", "addr:street": "ул. Ленина"}',
    }

    async with session_scope(clean_engine) as session:
        await seed_categories(session)
        poi_id = (await session.execute(insert_poi, params)).scalar_one()
        await session.execute(
            text(
                "INSERT INTO poi_categories (poi_id, category_id) "
                "SELECT :poi_id, id FROM categories WHERE slug = 'cafe'"
            ),
            {"poi_id": poi_id},
        )

    async with session_scope(clean_engine) as session:
        linked = (
            await session.execute(
                text(
                    "SELECT count(*) FROM poi_categories pc "
                    "JOIN categories c ON c.id = pc.category_id WHERE c.slug = 'cafe'"
                )
            )
        ).scalar_one()

    assert linked == 1

    with pytest.raises(IntegrityError):
        async with session_scope(clean_engine) as session:
            await session.execute(insert_poi, params)
