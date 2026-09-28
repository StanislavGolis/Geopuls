"""Тесты разбора границы города (без сети: используется сохранённый ответ Nominatim)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from geopuls.importers.boundary import BoundaryError, CityBoundary

FIXTURE = Path(__file__).parent / "fixtures" / "tomsk-boundary.json"


def test_parse_nominatim_feature_collection() -> None:
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    boundary = CityBoundary.from_json(payload)

    assert boundary.osm_type == "relation"
    assert boundary.osm_id == 7261645
    assert "Томск" in boundary.display_name
    assert boundary.geometry["type"] in {"Polygon", "MultiPolygon"}
    assert boundary.geometry["coordinates"]
    # Атрибуция ODbL должна сохраняться вместе с данными
    assert "OpenStreetMap" in boundary.license


def test_roundtrip_our_envelope() -> None:
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    boundary = CityBoundary.from_json(payload)

    assert CityBoundary.from_json(boundary.to_json()) == boundary


def test_parse_plain_geojson_feature() -> None:
    payload = {
        "type": "Feature",
        "properties": {"name": "Тестовый город", "osm_type": "relation", "osm_id": 42},
        "geometry": {"type": "Polygon", "coordinates": [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]]},
    }

    boundary = CityBoundary.from_json(payload)

    assert boundary.name == "Тестовый город"
    assert boundary.osm_id == 42


def test_rejects_non_polygon_geometry() -> None:
    payload = {"name": "Точка", "geometry": {"type": "Point", "coordinates": [84.9, 56.4]}}

    with pytest.raises(BoundaryError, match="тип геометрии"):
        CityBoundary.from_json(payload)


def test_rejects_empty_feature_collection() -> None:
    with pytest.raises(BoundaryError, match="нет объектов"):
        CityBoundary.from_json({"type": "FeatureCollection", "features": []})


def test_rejects_geometry_without_coordinates() -> None:
    payload = {"name": "Пустой", "geometry": {"type": "Polygon", "coordinates": []}}

    with pytest.raises(BoundaryError, match="нет координат"):
        CityBoundary.from_json(payload)


def test_load_boundary_reports_missing_file(tmp_path: Path) -> None:
    from geopuls.importers.boundary import load_boundary

    with pytest.raises(BoundaryError, match="не найден"):
        load_boundary(tmp_path / "absent.json")
