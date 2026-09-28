"""Тесты импортёра POI: юнит-часть (без БД) и интеграционная (на живой PostGIS)."""

from __future__ import annotations

import asyncio

import h3
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from conftest import DB_TESTS_ENABLED, MINI_PBF, TOMSK_SCOPE, tomsk_city_params
from geopuls.db import session_scope
from geopuls.importers.poi import (
    ImportError_,
    PoiRecord,
    build_poi_record,
    default_dump_path,
    iter_dump,
    read_dump_meta,
    resolve_data_version,
    scan_pbf,
    way_point,
)
from geopuls.seed import seed_categories, seed_city

# ── Юнит-тесты (без БД) ──────────────────────────────────────────────────────


def test_build_poi_record_matches_categories() -> None:
    record = build_poi_record("node", 1, {"amenity": "cafe", "name": "Кофейня"}, 84.9482, 56.4847)

    assert record is not None
    assert record.category_slugs == ("cafe",)
    assert record.name == "Кофейня"


def test_build_poi_record_returns_none_for_non_poi() -> None:
    assert build_poi_record("node", 2, {"highway": "bus_stop"}, 84.9482, 56.4847) is None
    assert build_poi_record("node", 3, {}, 84.9482, 56.4847) is None


def test_build_poi_record_computes_both_h3_resolutions() -> None:
    lon, lat = 84.9482, 56.4847
    record = build_poi_record("node", 4, {"shop": "supermarket"}, lon, lat)

    assert record is not None
    assert record.h3_r9 == h3.str_to_int(h3.latlng_to_cell(lat, lon, 9))
    assert record.h3_r8 == h3.str_to_int(h3.latlng_to_cell(lat, lon, 8))
    assert record.h3_r9 != record.h3_r8


def test_build_poi_record_extracts_address_and_brand() -> None:
    tags = {"amenity": "cafe", "brand": "Сеть", "addr:street": "ул. Ленина", "addr:housenumber": "1"}
    record = build_poi_record("node", 5, tags, 84.9482, 56.4847)

    assert record is not None
    row = record.as_row(source="geofabrik")
    assert row["brand"] == "Сеть"
    assert row["addr_street"] == "ул. Ленина"
    assert row["addr_housenumber"] == "1"
    assert row["has_address"] is True
    assert row["location"] == "SRID=4326;POINT(84.9482 56.4847)"


def test_build_poi_record_without_address_sets_flag_false() -> None:
    record = build_poi_record("node", 6, {"amenity": "pharmacy"}, 84.9482, 56.4847)

    assert record is not None
    assert record.as_row(source="geofabrik")["has_address"] is False


def test_way_point_for_closed_way_uses_polygon_centroid() -> None:
    square = [(84.95, 56.48), (84.97, 56.48), (84.97, 56.50), (84.95, 56.50), (84.95, 56.48)]

    assert way_point(square, closed=True) == pytest.approx((84.96, 56.49))


def test_way_point_for_open_way_uses_mean() -> None:
    line = [(84.95, 56.48), (84.97, 56.50)]

    assert way_point(line, closed=False) == pytest.approx((84.96, 56.49))


def test_way_point_returns_none_without_coordinates() -> None:
    assert way_point([], closed=True) is None


def test_default_dump_path_is_next_to_pbf() -> None:
    path = default_dump_path(MINI_PBF)

    assert path.parent == MINI_PBF.parent
    assert path.name == "mini-tomsk.poi-candidates.jsonl"


def test_resolve_data_version() -> None:
    assert resolve_data_version("2026-01-01", "2026-09-27T20:23:36Z") == "2026-01-01"
    assert resolve_data_version(None, "2026-09-27T20:23:36Z") == "2026-09-27"
    assert len(resolve_data_version(None, None)) == 10  # сегодняшняя дата в ISO


def test_record_json_roundtrip() -> None:
    record = build_poi_record("way", 100, {"shop": "grocery"}, 84.95, 56.48)
    assert record is not None

    restored = PoiRecord.from_json(record.as_json())

    assert restored == record
    assert restored.category_slugs == ("grocery",)


def test_scan_pbf_on_mini_fixture(tmp_path) -> None:  # type: ignore[no-untyped-def]
    dump = tmp_path / "dump.jsonl"

    stats = scan_pbf(MINI_PBF, [TOMSK_SCOPE], dump_path=dump, batch_size=2)

    assert stats.records == 3  # кофейня, аптека и полигон-супермаркет внутри bbox
    assert stats.nodes == 2
    assert stats.ways == 1
    assert stats.outside_scope == 1  # кафе вне bbox
    assert stats.categories == {"cafe": 1, "pharmacy": 1, "grocery": 1}
    assert stats.limit_reached is False
    assert dump.exists()

    records = list(iter_dump(dump))
    assert len(records) == 3
    assert {record.osm_id for record in records} == {1, 2, 100}


def test_scan_pbf_honours_limit(tmp_path) -> None:  # type: ignore[no-untyped-def]
    stats = scan_pbf(MINI_PBF, [TOMSK_SCOPE], dump_path=tmp_path / "dump.jsonl", limit=1)

    assert stats.limit_reached is True
    assert stats.records == 1


def test_scan_pbf_can_work_without_dump_file() -> None:
    stats = scan_pbf(MINI_PBF, [TOMSK_SCOPE], dump_path=None)

    assert stats.records == 3


def test_scan_pbf_reports_missing_file(tmp_path) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(ImportError_, match="не найден"):
        scan_pbf(tmp_path / "absent.osm.pbf", [TOMSK_SCOPE], dump_path=None)


def test_dump_stores_metadata_and_iter_skips_it(tmp_path) -> None:  # type: ignore[no-untyped-def]
    dump = tmp_path / "dump.jsonl"
    scan_pbf(MINI_PBF, [TOMSK_SCOPE], dump_path=dump)

    meta = read_dump_meta(dump)

    assert meta["pbf"].endswith("mini-tomsk.osm.pbf")
    assert "osm_timestamp" in meta  # дата данных нужна, чтобы --from-dump не терял версию
    assert len(list(iter_dump(dump))) == 3  # строка метаданных не считается POI


def test_read_dump_meta_on_file_without_meta(tmp_path) -> None:  # type: ignore[no-untyped-def]
    plain = tmp_path / "plain.jsonl"
    plain.write_text('{"osm_type": "node"}\n', encoding="utf-8")

    assert read_dump_meta(plain) == {}


# ── Интеграционные тесты (нужна БД) ──────────────────────────────────────────


async def test_import_from_dump_end_to_end(clean_engine: AsyncEngine, tmp_path) -> None:  # type: ignore[no-untyped-def]
    from geopuls.importers.poi import (
        deactivate_missing,
        fetch_watermark,
        finish_import_run,
        load_category_ids,
        publish_data_version,
        start_import_run,
        upsert_records,
    )

    dump = tmp_path / "dump.jsonl"
    stats = scan_pbf(MINI_PBF, [TOMSK_SCOPE], dump_path=dump)
    assert stats.records == 3

    async with session_scope(clean_engine) as session:
        await seed_categories(session)
        await seed_city(session, tomsk_city_params())
        category_ids = await load_category_ids(session)
        run_id, _run_started_at = await start_import_run(session, source="geofabrik", source_url=str(MINI_PBF))
        watermark = await fetch_watermark(session)
        imported = await upsert_records(session, list(iter_dump(dump)), category_ids=category_ids, source="geofabrik")
        deactivated = await deactivate_missing(session, source="geofabrik", watermark=watermark)
        await publish_data_version(session, "2026-09-27")
        await finish_import_run(session, run_id, status="ok", osm_timestamp=None, pois_upserted=imported)

    assert imported == 3
    assert deactivated == 0

    async with session_scope(clean_engine) as session:
        row = (
            (
                await session.execute(
                    text(
                        "SELECT count(*) AS total, count(*) FILTER (WHERE is_active) AS active, "
                        "count(*) FILTER (WHERE has_address) AS with_address, "
                        "count(DISTINCT h3_r9) AS cells FROM pois"
                    )
                )
            )
            .mappings()
            .one()
        )
        linked = (
            (
                await session.execute(
                    text(
                        "SELECT c.slug FROM poi_categories pc "
                        "JOIN categories c ON c.id = pc.category_id ORDER BY c.slug"
                    )
                )
            )
            .scalars()
            .all()
        )
        runs = (await session.execute(text("SELECT status, source FROM import_runs"))).all()
        versions = (await session.execute(text("SELECT version FROM data_versions"))).scalars().all()

    assert row["total"] == 3
    assert row["active"] == 3
    assert row["with_address"] == 1  # адрес есть только у тестовой кофейни
    assert row["cells"] == 3  # три объекта в трёх разных ячейках
    assert linked == ["cafe", "grocery", "pharmacy"]
    assert runs == [("ok", "geofabrik")]
    assert versions == ["2026-09-27"]


async def test_second_import_is_idempotent_and_soft_deletes(clean_engine: AsyncEngine, tmp_path) -> None:  # type: ignore[no-untyped-def]
    from geopuls.importers.poi import (
        deactivate_missing,
        fetch_watermark,
        load_category_ids,
        start_import_run,
        upsert_records,
    )

    dump = tmp_path / "dump.jsonl"
    scan_pbf(MINI_PBF, [TOMSK_SCOPE], dump_path=dump)

    async with session_scope(clean_engine) as session:
        await seed_categories(session)
        category_ids = await load_category_ids(session)

    async def import_records(records: list[PoiRecord]) -> None:
        async with session_scope(clean_engine) as session:
            await start_import_run(session, source="geofabrik", source_url=str(dump))
            watermark = await fetch_watermark(session)
            await upsert_records(session, records, category_ids=category_ids, source="geofabrik")
            await deactivate_missing(session, source="geofabrik", watermark=watermark)

    records = list(iter_dump(dump))
    await import_records(records)
    await import_records(records)  # повторный импорт той же выгрузки

    async with session_scope(clean_engine) as session:
        total = (await session.execute(text("SELECT count(*) FROM pois"))).scalar_one()
        active = (await session.execute(text("SELECT count(*) FROM pois WHERE is_active"))).scalar_one()
    assert total == 3, "повторный импорт не должен дублировать POI"
    assert active == 3

    # Объект исчез из выгрузки → мягкое удаление, запись остаётся в таблице
    await import_records([record for record in records if record.osm_id != 2])

    async with session_scope(clean_engine) as session:
        row = (
            (
                await session.execute(
                    text(
                        "SELECT count(*) FILTER (WHERE is_active) AS active, "
                        "count(*) FILTER (WHERE NOT is_active) AS inactive FROM pois"
                    )
                )
            )
            .mappings()
            .one()
        )
    assert row["active"] == 2
    assert row["inactive"] == 1


@pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")
async def test_cli_reports_missing_pbf(
    clean_engine: AsyncEngine,
    tmp_path,  # type: ignore[no-untyped-def]
    app_uses_test_db: str,
) -> None:
    """CLI сообщает об отсутствующей выгрузке кодом 2 и фиксирует неудачный прогон."""
    from geopuls.importers.poi import main

    async with session_scope(clean_engine) as session:
        await seed_categories(session)
        await seed_city(session, tomsk_city_params())

    code = await asyncio.to_thread(main, ["--pbf", str(tmp_path / "absent.osm.pbf")])

    assert code == 2
    assert app_uses_test_db  # CLI работал с тестовой базой

    async with session_scope(clean_engine) as session:
        runs = (await session.execute(text("SELECT status, error FROM import_runs"))).all()

    assert len(runs) == 1
    assert runs[0].status == "failed"
    assert "не найден" in (runs[0].error or "")
