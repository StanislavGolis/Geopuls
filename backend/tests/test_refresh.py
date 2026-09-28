"""Проверка команды обновления данных: одна команда, идемпотентность, версия данных.

Критерий готовности MVP: «Импорт POI воспроизводится одной командой и идемпотентен» (docs/tz.md, §11.1).
Тест гоняет полный цикл `geopuls.refresh` дважды на мини-выгрузке и сверяет цифры.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from conftest import DB_TESTS_ENABLED, MINI_PBF, TRUNCATE_ALL, resolve_test_database_url, tomsk_city_params
from geopuls.config import get_settings
from geopuls.db import create_engine, session_scope
from geopuls.refresh import refresh_city
from geopuls.seed import seed_categories, seed_city

pytestmark = pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")


def _fresh_test_engine() -> AsyncEngine:
    url = resolve_test_database_url()
    if url is None:
        pytest.skip("имя тестовой базы должно содержать 'test'")
    settings = get_settings().model_copy(update={"database_url": url})
    return create_engine(settings)


async def _prepare(engine: AsyncEngine) -> None:
    async with session_scope(engine) as session:
        await session.execute(text(TRUNCATE_ALL))
    async with session_scope(engine) as session:
        await seed_categories(session)
        await seed_city(session, tomsk_city_params())


async def _counts(engine: AsyncEngine) -> dict[str, int]:
    async with session_scope(engine) as session:
        rows = (
            (
                await session.execute(
                    text(
                        "SELECT "
                        "(SELECT count(*) FROM pois WHERE is_active) AS pois, "
                        "(SELECT count(*) FROM cell_stats) AS stats, "
                        "(SELECT count(*) FROM city_cells) AS cells, "
                        "(SELECT count(*) FROM data_versions) AS versions"
                    )
                )
            )
            .mappings()
            .one()
        )
    return {key: int(value) for key, value in rows.items()}


def test_refresh_loads_data_and_is_idempotent() -> None:
    """Первый запуск наполняет БД, второй — даёт те же цифры и ничего не удаляет."""

    async def scenario() -> tuple[object, object, dict[str, int]]:
        engine = _fresh_test_engine()
        try:
            await _prepare(engine)
            first = await refresh_city(engine, slug="tomsk", pbf=MINI_PBF)
            second = await refresh_city(engine, slug="tomsk", pbf=MINI_PBF)
            return first, second, await _counts(engine)
        finally:
            await engine.dispose()

    first, second, counts = asyncio.run(scenario())

    assert first.pois_upserted > 0, "импорт должен записать объекты"
    assert first.poi_in_city >= first.pois_upserted, "агрегация видит не меньше, чем импортировано"
    assert first.cells_total > 0, "агрегация должна собрать сетку города"
    assert first.stats_rows == first.cells_total * first.categories, "статистика пишется по всем категориям"
    assert first.data_version, "версия данных обязана публиковаться"

    # Идемпотентность: те же цифры, ничего не помечено неактивным
    assert second.pois_upserted == first.pois_upserted
    assert second.poi_in_city == first.poi_in_city
    assert second.cells_total == first.cells_total
    assert second.stats_rows == first.stats_rows
    assert second.pois_deactivated == 0
    assert counts["pois"] == first.pois_upserted
    assert counts["cells"] == first.cells_total
    assert counts["stats"] == first.stats_rows
    assert counts["versions"] >= 1


def test_refresh_requires_city_or_source() -> None:
    """Без города и без источника команда объясняет, чего не хватает, а не падает трейсбеком."""

    async def scenario() -> str:
        engine = _fresh_test_engine()
        try:
            await _prepare(engine)
            with pytest.raises(Exception) as error:
                await refresh_city(engine, slug="tomsk")
            return str(error.value)
        finally:
            await engine.dispose()

    message = asyncio.run(scenario())

    assert "нужен --pbf" in message
