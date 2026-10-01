"""Тесты вспомогательных частей разведки покрытия (без чтения PBF)."""

from __future__ import annotations

import json

import pytest

from geopuls.recon.pbf_scan import (
    BBox,
    CategoryStats,
    CoverageReport,
    build_report,
    haversine_km,
)


def test_bbox_parse_and_contains() -> None:
    bbox = BBox.parse("56.30,84.70,56.65,85.30")

    assert bbox.contains(56.4847, 84.9482) is True
    assert bbox.contains(55.0, 84.9482) is False
    assert bbox.contains(56.4847, 86.0) is False
    assert bbox.as_list() == [56.30, 84.70, 56.65, 85.30]


def test_bbox_parse_rejects_wrong_arity() -> None:
    with pytest.raises(ValueError, match="min_lat"):
        BBox.parse("56.30,84.70,56.65")


def test_haversine_zero_distance() -> None:
    assert haversine_km(56.4847, 84.9482, 56.4847, 84.9482) == pytest.approx(0.0, abs=1e-9)


def test_haversine_one_degree_of_latitude() -> None:
    """Один градус широты — примерно 111 км (проверяем порядок величины)."""
    assert haversine_km(56.0, 84.0, 57.0, 84.0) == pytest.approx(111.2, abs=0.5)


def test_category_stats_shares() -> None:
    stats = CategoryStats(total=0)
    assert stats.named_share == 0.0
    assert stats.address_share == 0.0

    stats = CategoryStats(total=10, named=6, with_address=4)
    assert stats.named_share == pytest.approx(0.6)
    assert stats.address_share == pytest.approx(0.4)


def make_report(stats: dict[str, CategoryStats]) -> CoverageReport:
    """Отчёт с синтетическими данными — для проверки сериализации."""
    from geopuls.categories import COMPETITOR_CATEGORIES

    return CoverageReport(
        city="Тест",
        generated_at="2026-09-28T00:00:00+00:00",
        pbf_path="data/raw/test.osm.pbf",
        pbf_size_mb=1.0,
        pbf_mtime="2026-09-28T00:00:00+00:00",
        osm_timestamp="2026-09-27T20:23:36Z",
        bbox=[56.3, 84.7, 56.65, 85.3],
        center=[56.4847, 84.9482],
        center_radius_km=10.0,
        scan_seconds=1.5,
        objects_with_poi_keys=100,
        objects_matched=25,
        multi_category_objects=2,
        tagged_relations=7,
        categories={
            category.slug: {
                "total": stats.get(category.slug, CategoryStats()).total,
                "nodes": stats.get(category.slug, CategoryStats()).nodes,
                "ways": stats.get(category.slug, CategoryStats()).ways,
                "named": stats.get(category.slug, CategoryStats()).named,
                "with_address": stats.get(category.slug, CategoryStats()).with_address,
                "with_brand": stats.get(category.slug, CategoryStats()).with_brand,
                "in_core": stats.get(category.slug, CategoryStats()).in_core,
                "named_share": stats.get(category.slug, CategoryStats()).named_share,
                "address_share": stats.get(category.slug, CategoryStats()).address_share,
            }
            for category in COMPETITOR_CATEGORIES
        },
        key_values={"amenity": {"cafe": 20, "bench": 3}},
    )


def test_report_unmapped_share() -> None:
    report = make_report({})

    assert report.unmapped_share == pytest.approx(0.75)


def test_report_json_is_parseable_and_carries_data_version() -> None:
    report = make_report({"cafe": CategoryStats(total=12, nodes=10, ways=2, named=9, in_core=5)})
    payload = json.loads(report.to_json())

    assert payload["city"] == "Тест"
    assert payload["osm_timestamp"] == "2026-09-27T20:23:36Z"
    assert payload["categories"]["cafe"]["total"] == 12
    assert payload["unmapped_share"] == pytest.approx(0.75)


def test_report_markdown_has_tables_and_verdict() -> None:
    report = make_report({"cafe": CategoryStats(total=12)})
    markdown = report.to_markdown()

    assert "| Категория | Всего |" in markdown
    assert "| `cafe` | 12 |" in markdown
    assert "мало данных" in markdown  # 12 < порога THIN_CATEGORY_THRESHOLD
    assert "### `amenity`" in markdown
    assert "Порог «мало данных»" in markdown


def test_build_report_from_scanner_like_object(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """build_report должен считаться от любого объекта с полями сканера."""
    from geopuls.categories import COMPETITOR_CATEGORIES, EXPLORATION_KEYS

    pbf = tmp_path / "test.osm.pbf"
    pbf.write_bytes(b"not a real pbf")

    class StubScanner:
        def __init__(self) -> None:
            from collections import Counter as _Counter

            self.stats = {category.slug: CategoryStats(total=3, nodes=3) for category in COMPETITOR_CATEGORIES}
            self.key_values = {"amenity": _Counter({"cafe": 3})}
            self.objects_with_poi_keys = 10
            self.objects_matched = 3
            self.multi_category_objects = 0
            self.tagged_relations = 0

    report = build_report(
        city="Тест",
        pbf=pbf,
        bbox=BBox.parse("56.3,84.7,56.65,85.3"),
        center=(56.4847, 84.9482),
        radius_km=10.0,
        scanner=StubScanner(),  # type: ignore[arg-type]
        scan_seconds=0.1,
    )

    assert report.categories["cafe"]["total"] == 3
    assert report.osm_timestamp is None  # файл не PBF — заголовок читается без падения
    assert set(report.key_values) <= set(EXPLORATION_KEYS)
