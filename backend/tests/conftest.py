"""Общие фикстуры тестов.

Тесты, требующие живой PostGIS, включаются при ``GEOPULS_CI_DB=1`` (в CI создаётся отдельная
тестовая база и применяются миграции). Без этой переменной они помечаются пропущенными, а не падают.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from geopuls.aggregate import aggregate_city
from geopuls.config import get_settings
from geopuls.db import create_engine, session_scope
from geopuls.importers.boundary import load_boundary
from geopuls.importers.poi import (
    CityScope,
    deactivate_missing,
    fetch_watermark,
    finish_import_run,
    iter_dump,
    load_category_ids,
    scan_pbf,
    start_import_run,
    upsert_records,
)
from geopuls.seed import build_city_params, seed_categories, seed_city

DB_TESTS_ENABLED = os.getenv("GEOPULS_CI_DB") == "1"
FIXTURES_DIR = Path(__file__).parent / "fixtures"
TOMSK_BOUNDARY = FIXTURES_DIR / "tomsk-boundary.json"
MINI_PBF = FIXTURES_DIR / "mini-tomsk.osm.pbf"

TRUNCATE_ALL = (
    "TRUNCATE pois, poi_categories, cell_metrics, cell_stats, city_cells, import_runs, data_versions, "
    "layers, datasets, cities, categories RESTART IDENTITY CASCADE"
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


#: Bbox Томска для разведки и импорта (шире полигона города — объекты за границей отсеет агрегация)
TOMSK_SCOPE = CityScope(
    id=1,
    slug="tomsk",
    name="Томск",
    min_lat=56.379,
    min_lon=84.828,
    max_lat=56.571,
    max_lon=85.150,
)

#: Версия данных в тестах: фиксированная, чтобы ETag и meta были детерминированными
TEST_DATA_VERSION = "2026-09-27"


def prepare_test_city(tmp_path: Path, *, data_version: str = TEST_DATA_VERSION) -> None:
    """Синхронная подготовка тестовой БД: сид → импорт мини-PBF → агрегация.

    Нужна там, где тест синхронный (например, работа с ``TestClient``): внутри выполняется
    ``asyncio.run`` с собственным движком тестовой БД.
    """
    url = resolve_test_database_url()
    if url is None:
        pytest.skip("имя тестовой базы должно содержать 'test'")

    async def prepare() -> None:
        settings = get_settings().model_copy(update={"database_url": url})
        engine = create_engine(settings)
        try:
            async with session_scope(engine) as session:
                await session.execute(text(TRUNCATE_ALL))

            dump = tmp_path / "dump.jsonl"
            scan_pbf(MINI_PBF, [TOMSK_SCOPE], dump_path=dump)

            async with session_scope(engine) as session:
                await seed_categories(session)
                await seed_city(session, tomsk_city_params())
                category_ids = await load_category_ids(session)
                run_id, _started_at = await start_import_run(session, source="geofabrik", source_url=str(MINI_PBF))
                watermark = await fetch_watermark(session)
                records = list(iter_dump(dump))
                await upsert_records(session, records, category_ids=category_ids, source="geofabrik")
                await deactivate_missing(session, source="geofabrik", watermark=watermark)
                await finish_import_run(session, run_id, status="ok", osm_timestamp=None, pois_upserted=len(records))

            async with session_scope(engine) as session:
                agg_run_id, _started_at = await start_import_run(session, source="aggregate", source_url=None)

            async with session_scope(engine) as session:
                result = await aggregate_city(session, "tomsk", (9, 8))
                await finish_import_run(
                    session,
                    agg_run_id,
                    status="ok",
                    pois_upserted=result.poi_in_city,
                    cells_written=sum(result.cells_total.values()),
                )

            # Версия данных фиксируется в конце: она участвует в ETag и meta ответов
            async with session_scope(engine) as session:
                await session.execute(
                    text("INSERT INTO data_versions (version) VALUES (:version)"),
                    {"version": data_version},
                )
        finally:
            await engine.dispose()

    asyncio.run(prepare())
