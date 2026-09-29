"""Тесты разведки покрытия OSM по слоям карты (`geopuls.recon.layers_scan`)."""

from __future__ import annotations

from datetime import UTC, datetime

import h3
import pytest

from geopuls.recon.layers_scan import (
    GROUPS,
    GROUPS_BY_SLUG,
    GroupStats,
    LayersReport,
    LayersScanner,
    match_groups,
    path_length_km,
    polygon_area_km2,
)
from geopuls.recon.pbf_scan import BBox


def test_groups_have_unique_slugs_and_rules() -> None:
    slugs = [group.slug for group in GROUPS]

    assert len(slugs) == len(set(slugs))
    assert all(group.rules for group in GROUPS)
    assert all(group.measure in {"count", "area", "length"} for group in GROUPS)


def test_polygon_area_matches_h3() -> None:
    """Площадь по формуле должна совпадать с площадью той же ячейки, посчитанной h3."""
    cell = "890b80db643ffff"
    boundary = h3.cell_to_boundary(cell)  # [(lat, lon), ...]
    expected = h3.cell_area(cell, "km^2")

    assert polygon_area_km2(boundary) == pytest.approx(expected, rel=0.01)


def test_polygon_area_ignores_unclosed_and_degenerate_rings() -> None:
    assert polygon_area_km2([(56.5, 85.0), (56.5, 85.01)]) == 0.0
    # Треугольник со сторонами 0.01° по широте (≈1.11 км) и 0.01° по долготе (≈0.61 км) — ≈0.34 км²
    ring = [(56.5, 85.0), (56.5, 85.01), (56.51, 85.01), (56.5, 85.0)]

    assert polygon_area_km2(ring) == pytest.approx(0.34, rel=0.05)


def test_path_length_counts_haversine() -> None:
    # 0.01° по широте — примерно 1.11 км
    assert path_length_km([(56.50, 85.0), (56.51, 85.0)]) == pytest.approx(1.11, rel=0.02)
    assert path_length_km([(56.50, 85.0)]) == 0.0


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        ({"highway": "bus_stop"}, ("transport_stops",)),
        ({"public_transport": "platform", "name": "Остановка"}, ("transport_stops",)),
        ({"amenity": "parking"}, ("parking",)),
        ({"building": "apartments"}, ("residential",)),
        ({"landuse": "residential"}, ("residential",)),
        ({"office": "company"}, ("workplaces",)),
        ({"landuse": "industrial"}, ("workplaces",)),
        ({"shop": "mall"}, ("anchors",)),
        ({"highway": "footway"}, ("pedestrian",)),
        ({"amenity": "cafe"}, ()),
        ({"building": "yes"}, ()),
    ],
)
def test_match_groups(tags: dict[str, str], expected: tuple[str, ...]) -> None:
    assert match_groups(tags) == expected


def test_station_belongs_to_two_groups() -> None:
    matched = match_groups({"railway": "station", "name": "Томск-1"})

    assert set(matched) == {"anchors", "transport_stops"}


def test_scanner_counts_polygons_and_lengths() -> None:
    """Проверяем счётчики на синтетических объектах: площадь кольца, длина линии, capacity."""
    bbox = BBox(min_lat=56.0, min_lon=84.0, max_lat=57.0, max_lon=86.0)
    scanner = LayersScanner(bbox, center=(56.5, 85.0), radius_km=10.0)

    # Здание жилое, замкнутое кольцо 0.01°×0.01° (≈0.68 км²), с этажностью
    building = [(56.50, 85.00), (56.50, 85.01), (56.51, 85.01), (56.51, 85.00), (56.50, 85.00)]
    scanner._handle(
        "way", {"building": "apartments", "building:levels": "5"}, 56.50, 85.005, coords=building, closed=True
    )
    # Парковка с числом мест
    scanner._handle("way", {"amenity": "parking", "capacity": "20"}, 56.50, 85.005, coords=building, closed=True)
    # Пешеходная дорожка — линия
    scanner._handle("way", {"highway": "footway"}, 56.50, 85.005, coords=[(56.50, 85.0), (56.51, 85.0)])
    # Остановка транспорта
    scanner._handle("node", {"highway": "bus_stop", "name": "Остановка"}, 56.50, 85.005)

    residential = scanner.stats["residential"]
    parking = scanner.stats["parking"]
    pedestrian = scanner.stats["pedestrian"]
    transport = scanner.stats["transport_stops"]

    assert residential.total == 1
    assert residential.polygons == 1
    assert residential.with_levels == 1
    assert residential.levels_share == 1.0
    assert residential.area_km2 == pytest.approx(0.68, rel=0.05)
    assert parking.with_capacity == 1
    assert pedestrian.length_km == pytest.approx(1.11, rel=0.02)
    assert transport.nodes == 1


def test_scanner_skips_objects_outside_bbox() -> None:
    bbox = BBox(min_lat=56.0, min_lon=84.0, max_lat=57.0, max_lon=86.0)
    scanner = LayersScanner(bbox, center=(56.5, 85.0), radius_km=10.0)

    scanner._handle("node", {"amenity": "parking"}, 60.0, 90.0)

    assert scanner.stats["parking"].total == 0
    assert scanner.objects_in_groups == 0


def test_report_markdown_lists_groups() -> None:
    stats = GroupStats(total=3, nodes=2, ways=1, named=3, with_address=1)
    report = LayersReport(
        city="tomsk",
        generated_at=datetime.now(UTC).isoformat(timespec="seconds"),
        pbf_path="data/raw/x.osm.pbf",
        pbf_size_mb=557.4,
        pbf_mtime="2026-09-28T10:57:34+00:00",
        osm_timestamp="2026-09-27T20:23:36Z",
        bbox=[56.3, 84.7, 56.65, 85.3],
        center=[56.4847, 84.9482],
        center_radius_km=10.0,
        scan_seconds=1.0,
        objects_in_groups=3,
        multi_group_objects=0,
        overlaps={},
        groups={
            slug: {
                "total": stats.total,
                "nodes": stats.nodes,
                "ways": stats.ways,
                "relations": 0,
                "named": stats.named,
                "with_address": stats.with_address,
                "in_core": stats.total,
                "polygons": 0,
                "with_capacity": 0,
                "with_levels": 0,
                "name_ru": GROUPS_BY_SLUG[slug].name_ru,
                "measure": GROUPS_BY_SLUG[slug].measure,
                "area_km2": 0.0,
                "length_km": 0.0,
                "named_share": 1.0,
                "address_share": 0.33,
                "levels_share": 0.0,
                "capacity_share": 0.0,
            }
            for slug in GROUPS_BY_SLUG
        },
    )

    markdown = report.to_markdown()

    assert "Покрытие OSM по слоям: tomsk" in markdown
    assert "`transport_stops`" in markdown
    assert "Ограничения метода" in markdown
