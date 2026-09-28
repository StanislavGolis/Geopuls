"""Тесты агрегации H3: юнит-часть (без БД) и интеграционная (на живой PostGIS)."""

from __future__ import annotations

import asyncio

import h3
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from conftest import DB_TESTS_ENABLED, MINI_PBF, TOMSK_SCOPE, tomsk_city_params
from geopuls.aggregate import (
    AggregateError,
    GridCell,
    aggregate_city,
    batch_rows,
    build_cell_stat_rows,
    build_counts,
    build_grid,
    compute_density_breaks,
    load_city,
)
from geopuls.db import session_scope
from geopuls.importers.poi import (
    deactivate_missing,
    fetch_watermark,
    iter_dump,
    load_category_ids,
    scan_pbf,
    start_import_run,
    upsert_records,
)
from geopuls.seed import seed_categories, seed_city

#: Небольшой квадрат вокруг центра Томска: ~0.05° по обеим осям (≈ 5.6 × 3.1 км).
SMALL_SQUARE = {
    "type": "Polygon",
    "coordinates": [
        [
            [84.93, 56.46],
            [84.98, 56.46],
            [84.98, 56.51],
            [84.93, 56.51],
            [84.93, 56.46],
        ]
    ],
}

# ── Юнит-тесты (без БД) ──────────────────────────────────────────────────────


def test_compute_density_breaks_uses_quantiles() -> None:
    breaks = compute_density_breaks([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0])

    assert breaks[0] == 0.0
    assert breaks == sorted(breaks)
    assert breaks[-1] == 8.0
    assert len(breaks) == 5


def test_compute_density_breaks_without_positive_values() -> None:
    assert compute_density_breaks([0.0, 0.0]) == [0.0, 0.0, 0.0, 0.0, 0.0]


def test_compute_density_breaks_with_single_value() -> None:
    breaks = compute_density_breaks([4.2, 0.0])

    assert breaks[0] == 0.0
    assert breaks[1:] == [4.2, 4.2, 4.2, 4.2]


def test_compute_density_breaks_even_scale_for_few_values() -> None:
    breaks = compute_density_breaks([2.0, 10.0])

    assert breaks[0] == 0.0
    assert breaks[-1] == pytest.approx(10.0, abs=1.0)
    assert len(breaks) == 5


def test_compute_density_breaks_falls_back_when_quantiles_repeat() -> None:
    """Дискретная плотность (1 объект ≈ 8.5 POI/км²) не должна давать пустые классы в легенде."""
    breaks = compute_density_breaks([8.5] * 20 + [17.1] * 10 + [76.9])

    assert len(set(breaks)) == len(breaks), "границы классов обязаны различаться"
    assert breaks[0] == 0.0
    assert breaks[-1] == pytest.approx(76.9, abs=0.1)


def test_build_grid_area_matches_polygon() -> None:
    """Сумма площадей ячеек должна совпадать с площадью полигона (проверка на квадрате)."""
    grid = build_grid(SMALL_SQUARE, (9,))

    # Площадь квадрата 0.05° × 0.05° на широте 56.48°: ~5.57 км × 3.08 км ≈ 17.2 км²
    expected_km2 = 5.57 * 3.08
    total = sum(cell.area_km2 for cell in grid[9])

    assert total == pytest.approx(expected_km2, rel=0.05)
    assert len(grid[9]) > 100


def test_build_grid_cell_fields() -> None:
    cell = build_grid(SMALL_SQUARE, (9,))[9][0]

    assert isinstance(cell, GridCell)
    assert cell.h3_index > 0
    assert 84.9 < cell.centroid_lon < 85.0
    assert 56.4 < cell.centroid_lat < 56.6
    assert 0.05 < cell.area_km2 < 0.13  # площадь ячейки res 9 — от 0.064 до 0.127 км²


def test_build_grid_adds_poi_cells_outside_polygon_cells() -> None:
    """Ячейка POI у границы попадает в сетку, даже если её центр за контуром города."""
    boundary_cell = h3.latlng_to_cell(56.46, 84.93, 9)
    outside = h3.grid_disk(boundary_cell, 2)

    grid_without = build_grid(SMALL_SQUARE, (9,))
    grid_with = build_grid(SMALL_SQUARE, (9,), extra_cells={9: outside})

    assert len(grid_with[9]) > len(grid_without[9])


def test_build_cell_stat_rows_include_empty_cells() -> None:
    grid = {9: build_grid(SMALL_SQUARE, (9,))[9][:5]}
    cell = grid[9][0].h3_index
    counts = {(9, cell, 7): (3, 2)}
    category_ids = {"cafe": 7, "bar": 8}

    rows = build_cell_stat_rows(grid, counts, category_ids, city_id=1)

    assert len(rows) == 5 * len(category_ids)
    cafe_row = next(row for row in rows if row["h3_index"] == cell and row["category_id"] == 7)
    empty_bar = next(row for row in rows if row["h3_index"] == cell and row["category_id"] == 8)
    assert cafe_row["poi_count"] == 3
    assert cafe_row["density"] == pytest.approx(3 / grid[9][0].area_km2)
    assert cafe_row["has_address_ratio"] == pytest.approx(2 / 3)
    assert empty_bar["poi_count"] == 0
    assert empty_bar["density"] == 0.0
    assert empty_bar["has_address_ratio"] is None


def test_batch_rows_splits_by_size() -> None:
    rows = [{"a": index} for index in range(10)]

    batches = list(batch_rows(rows, columns=1, size=3))

    assert [len(batch) for batch in batches] == [3, 3, 3, 1]


def test_batch_rows_shrinks_batch_for_wide_tables() -> None:
    """asyncpg отклоняет запросы с > 32 767 параметрами — батч должен ужиматься по числу колонок."""
    rows = [{"a": index} for index in range(10_000)]

    batches = list(batch_rows(rows, columns=7, size=5000))
    per_batch = 32_000 // 7

    assert len(batches[0]) == per_batch
    assert all(len(batch) <= per_batch for batch in batches)
    assert sum(len(batch) for batch in batches) == len(rows)


def test_build_counts_splits_by_resolution_and_category() -> None:
    cell9 = h3.str_to_int(h3.latlng_to_cell(56.48, 84.95, 9))
    cell8 = h3.str_to_int(h3.latlng_to_cell(56.48, 84.95, 8))
    rows = [(1, cell9, cell8, True, 7), (2, cell9, cell8, False, 7), (3, cell9, cell8, True, 8)]

    counts, extra = build_counts(rows, (9, 8))

    assert counts[(9, cell9, 7)] == (2, 1)
    assert counts[(8, cell8, 7)] == (2, 1)
    assert counts[(9, cell9, 8)] == (1, 1)
    assert extra[9] == {h3.int_to_str(cell9)}
    assert extra[8] == {h3.int_to_str(cell8)}


# ── Интеграционные тесты (нужна БД) ──────────────────────────────────────────


async def seed_city_and_pois(engine: AsyncEngine, tmp_path) -> None:  # type: ignore[no-untyped-def]
    """Сидирует Томск и импортирует 3 POI из мини-фикстуры."""
    dump = tmp_path / "dump.jsonl"
    scan_pbf(MINI_PBF, [TOMSK_SCOPE], dump_path=dump)

    async with session_scope(engine) as session:
        await seed_categories(session)
        await seed_city(session, tomsk_city_params())
        category_ids = await load_category_ids(session)
        await start_import_run(session, source="geofabrik", source_url=str(MINI_PBF))
        watermark = await fetch_watermark(session)
        await upsert_records(session, list(iter_dump(dump)), category_ids=category_ids, source="geofabrik")
        await deactivate_missing(session, source="geofabrik", watermark=watermark)


async def test_aggregate_city_builds_grid_and_stats(clean_engine: AsyncEngine, tmp_path) -> None:  # type: ignore[no-untyped-def]
    await seed_city_and_pois(clean_engine, tmp_path)

    async with session_scope(clean_engine) as session:
        result = await aggregate_city(session, "tomsk", (9, 8))

    assert result.cells_total[9] > 1000
    assert abs(result.area_deviation_percent) < 15.0, "сетка должна совпадать по площади с полигоном"
    assert result.poi_in_city == 3
    assert result.poi_in_grid == 3
    assert result.cells_non_empty[9] < result.cells_total[9], "большинство ячеек обязаны быть пустыми"
    assert set(result.density_breaks) >= {"cafe", "pharmacy", "grocery"}

    async with session_scope(clean_engine) as session:
        summary = (
            (
                await session.execute(
                    text(
                        "SELECT (SELECT count(*) FROM city_cells WHERE resolution = 9) AS cells, "
                        "(SELECT count(*) FROM cell_stats WHERE resolution = 9) AS stats, "
                        "(SELECT count(*) FROM cell_stats WHERE resolution = 9 AND poi_count = 0) AS empty, "
                        "(SELECT count(*) FROM cell_stats WHERE resolution = 9 AND poi_count > 0) AS filled, "
                        "(SELECT max(density) FROM cell_stats) AS max_density"
                    )
                )
            )
            .mappings()
            .one()
        )
        cafe = (
            (
                await session.execute(
                    text(
                        "SELECT cs.poi_count, cs.density, cs.has_address_ratio FROM cell_stats cs "
                        "JOIN categories c ON c.id = cs.category_id "
                        "JOIN pois p ON p.h3_r9 = cs.h3_index "
                        "WHERE c.slug = 'cafe' AND cs.resolution = 9 AND p.osm_id = 1"
                    )
                )
            )
            .mappings()
            .one()
        )

    assert summary["cells"] == result.cells_total[9]
    assert summary["stats"] == result.cells_total[9] * 8, "статистика пишется для всех категорий"
    assert summary["filled"] == 3
    assert summary["empty"] == summary["stats"] - summary["filled"]
    assert summary["max_density"] > 0
    assert cafe["poi_count"] == 1
    assert cafe["density"] > 0
    assert cafe["has_address_ratio"] == pytest.approx(1.0)


async def test_aggregate_is_idempotent(clean_engine: AsyncEngine, tmp_path) -> None:  # type: ignore[no-untyped-def]
    await seed_city_and_pois(clean_engine, tmp_path)

    async with session_scope(clean_engine) as session:
        first = await aggregate_city(session, "tomsk", (9,))
    async with session_scope(clean_engine) as session:
        second = await aggregate_city(session, "tomsk", (9,))

    assert first.cells_total[9] == second.cells_total[9]

    async with session_scope(clean_engine) as session:
        counts = (
            (
                await session.execute(
                    text(
                        "SELECT (SELECT count(*) FROM city_cells WHERE resolution = 9) AS cells, "
                        "(SELECT count(*) FROM cell_stats WHERE resolution = 9) AS stats"
                    )
                )
            )
            .mappings()
            .one()
        )

    assert counts["cells"] == first.cells_total[9], "повторная агрегация не должна дублировать ячейки"
    assert counts["stats"] == first.cells_total[9] * 8


async def test_aggregate_dry_run_writes_nothing(clean_engine: AsyncEngine, tmp_path) -> None:  # type: ignore[no-untyped-def]
    await seed_city_and_pois(clean_engine, tmp_path)

    async with session_scope(clean_engine) as session:
        result = await aggregate_city(session, "tomsk", (9,), dry_run=True)

    assert result.cells_total[9] > 0

    async with session_scope(clean_engine) as session:
        cells = (await session.execute(text("SELECT count(*) FROM city_cells"))).scalar_one()
        stats = (await session.execute(text("SELECT count(*) FROM cell_stats"))).scalar_one()

    assert cells == 0
    assert stats == 0


async def test_aggregate_ignores_pois_outside_polygon(clean_engine: AsyncEngine, tmp_path) -> None:  # type: ignore[no-untyped-def]
    await seed_city_and_pois(clean_engine, tmp_path)

    # POI в углу bbox города, но за пределами полигона
    corner_lat, corner_lon = 56.571, 84.828
    async with session_scope(clean_engine) as session:
        await session.execute(
            text(
                "INSERT INTO pois (osm_type, osm_id, name, location, h3_r9, h3_r8, tags, source, has_address) "
                "VALUES ('node', 999, 'Вне города', "
                "ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, :h3_r9, :h3_r8, "
                "CAST('{\"amenity\": \"cafe\"}' AS jsonb), 'manual', false)"
            ),
            {
                "lon": corner_lon,
                "lat": corner_lat,
                "h3_r9": h3.str_to_int(h3.latlng_to_cell(corner_lat, corner_lon, 9)),
                "h3_r8": h3.str_to_int(h3.latlng_to_cell(corner_lat, corner_lon, 8)),
            },
        )
        await session.execute(
            text(
                "INSERT INTO poi_categories (poi_id, category_id) "
                "SELECT p.id, c.id FROM pois p, categories c WHERE p.osm_id = 999 AND c.slug = 'cafe'"
            )
        )

    async with session_scope(clean_engine) as session:
        inside_corner = (
            await session.execute(
                text(
                    "SELECT count(*) FROM pois p WHERE p.osm_id = 999 AND ST_Contains("
                    "(SELECT boundary::geometry FROM cities WHERE slug = 'tomsk'), p.location::geometry)"
                )
            )
        ).scalar_one()
        inside_all = (
            await session.execute(
                text(
                    "SELECT count(DISTINCT p.id) FROM pois p JOIN poi_categories pc ON pc.poi_id = p.id "
                    "WHERE ST_Contains((SELECT boundary::geometry FROM cities WHERE slug = 'tomsk'), "
                    "p.location::geometry)"
                )
            )
        ).scalar_one()
        result = await aggregate_city(session, "tomsk", (9,))

    assert inside_corner == 0, "фикстура теста должна лежать вне полигона города"
    assert result.poi_in_city == inside_all == 3, "POI за границей города в статистику не попадает"


async def test_load_city_reports_unknown_slug(clean_engine: AsyncEngine) -> None:
    async with session_scope(clean_engine) as session:
        with pytest.raises(AggregateError, match="не найден"):
            await load_city(session, "nowhere")


@pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")
async def test_cli_reports_unknown_city(clean_engine: AsyncEngine, app_uses_test_db: str) -> None:
    """CLI возвращает код 2 для неизвестного города и не оставляет запуск в статусе running."""
    from geopuls.aggregate import main

    code = await asyncio.to_thread(main, ["--city", "nowhere"])

    assert code == 2

    async with session_scope(clean_engine) as session:
        runs = (await session.execute(text("SELECT status FROM import_runs"))).scalars().all()

    assert runs == ["failed"]
