"""Общие фикстуры тестов.

Тесты, требующие живой PostGIS, включаются при ``GEOPULS_CI_DB=1`` (в CI поднят сервис PostGIS
и применены миграции). Без этой переменной они помечаются пропущенными, а не падают.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from geopuls.config import get_settings
from geopuls.db import create_engine, session_scope
from geopuls.importers.boundary import load_boundary
from geopuls.seed import build_city_params

DB_TESTS_ENABLED = os.getenv("GEOPULS_CI_DB") == "1"
FIXTURES_DIR = Path(__file__).parent / "fixtures"
TOMSK_BOUNDARY = FIXTURES_DIR / "tomsk-boundary.json"
MINI_PBF = FIXTURES_DIR / "mini-tomsk.osm.pbf"

TRUNCATE_ALL = (
    "TRUNCATE pois, poi_categories, cell_stats, city_cells, import_runs, data_versions, "
    "cities, categories RESTART IDENTITY CASCADE"
)


def resolve_test_database_url() -> str | None:
    """URL тестовой БД.

    Тесты чистят таблицы (`TRUNCATE`), поэтому рабочая БД для них недопустима:
    - берём ``GEOPULS_TEST_DATABASE_URL``, если он задан;
    - иначе добавляем суффикс ``_test`` к имени базы из настроек;
    - если имя базы не содержит ``test`` — возвращаем ``None`` (защита от сноса рабочей базы).
    """
    explicit = os.getenv("GEOPULS_TEST_DATABASE_URL")
    if explicit:
        return explicit if "test" in explicit.rsplit("/", 1)[-1] else None

    base_url = get_settings().database_url
    base_name = base_url.rsplit("/", 1)[-1]
    if "test" in base_name:
        return base_url
    return f"{base_url}_test"


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    if not DB_TESTS_ENABLED:
        pytest.skip("нужна тестовая БД (GEOPULS_CI_DB=1)")

    url = resolve_test_database_url()
    if url is None:
        pytest.skip("имя тестовой базы должно содержать 'test' (см. GEOPULS_TEST_DATABASE_URL)")

    settings = get_settings().model_copy(update={"database_url": url})
    created = create_engine(settings)
    try:
        async with created.connect() as connection:
            await connection.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 — тесты без БД должны пропускаться, а не падать
        await created.dispose()
        pytest.skip(f"тестовая БД недоступна ({url.rsplit('@', 1)[-1]}): {exc}. См. tools/init-test-db.ps1")

    try:
        yield created
    finally:
        await created.dispose()


@pytest.fixture
async def clean_engine(engine: AsyncEngine) -> AsyncIterator[AsyncEngine]:
    """Движок с пустыми таблицами: каждый тест начинает с чистого состояния."""
    if not DB_TESTS_ENABLED:
        pytest.skip("нужна тестовая БД (GEOPULS_CI_DB=1)")
    async with session_scope(engine) as session:
        await session.execute(text(TRUNCATE_ALL))
    yield engine


@pytest.fixture
def app_uses_test_db(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """Переключить настройки приложения на тестовую БД.

    Нужно для CLI-тестов: CLI создаёт движок сам через `get_settings()`, и без подмены он пошёл бы
    в рабочую базу.
    """
    url = resolve_test_database_url()
    if url is None:
        pytest.skip("имя тестовой базы должно содержать 'test'")
    monkeypatch.setenv("GEOPULS_DATABASE_URL", url)
    get_settings.cache_clear()
    yield url
    get_settings.cache_clear()


def tomsk_city_params() -> dict[str, Any]:
    """Параметры сида Томска из сохранённой фикстуры границы."""
    return build_city_params(
        slug="tomsk",
        name="Томск",
        region="Томская область",
        timezone="Asia/Tomsk",
        h3_res=9,
        boundary=load_boundary(TOMSK_BOUNDARY),
    )
