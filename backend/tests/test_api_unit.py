"""Юнит-тесты API: GeoJSON, ETag, формат ошибок (без БД)."""

from __future__ import annotations

import h3
import pytest
from fastapi.testclient import TestClient

from geopuls.api.geojson import cell_feature, cell_polygon, h3_text, make_etag, parse_bbox
from geopuls.api.problems import PROBLEM_CONTENT_TYPE
from geopuls.main import create_app

CELL = h3.latlng_to_cell(56.4847, 84.9482, 9)
CELL_INT = h3.str_to_int(CELL)


def test_cell_polygon_is_closed_ring_in_lon_lat_order() -> None:
    polygon = cell_polygon(CELL_INT)

    assert polygon["type"] == "Polygon"
    ring = polygon["coordinates"][0]
    assert len(ring) == 7, "шестиугольник + замыкающая точка"
    assert ring[0] == ring[-1], "кольцо GeoJSON обязано быть замкнутым"

    for lon, lat in ring:
        assert 84.9 < lon < 85.0, "первая координата — долгота"
        assert 56.4 < lat < 56.6, "вторая координата — широта (§4.2 ТЗ: порядок как в GeoJSON)"


def test_cell_polygon_rounds_coordinates() -> None:
    """Округление до 6 знаков: ячейка ~200 м, а размер ответа меньше."""
    ring = cell_polygon(CELL_INT)["coordinates"][0]

    for lon, lat in ring:
        assert round(lon, 6) == lon
        assert round(lat, 6) == lat


def test_cell_feature_uses_text_id() -> None:
    feature = cell_feature(CELL_INT, {"count": 3})

    assert feature["type"] == "Feature"
    assert feature["id"] == CELL, "id — текстовый H3-индекс, совместимый с h3-js"
    assert feature["properties"] == {"count": 3}


def test_h3_text_roundtrip() -> None:
    assert h3_text(h3.str_to_int(CELL)) == CELL


def test_make_etag_is_stable_and_content_dependent() -> None:
    first = make_etag("tomsk", "cafe", 9, "2026-09-27")
    second = make_etag("tomsk", "cafe", 9, "2026-09-27")

    assert first == second
    assert first.startswith('"') and first.endswith('"')
    assert make_etag("tomsk", "cafe", 9, "2026-09-28") != first
    assert make_etag("tomsk", "bar", 9, "2026-09-27") != first


def test_parse_bbox_accepts_valid_value() -> None:
    assert parse_bbox("84.9,56.4,85.1,56.6") == (84.9, 56.4, 85.1, 56.6)


@pytest.mark.parametrize(
    "value",
    ["84.9,56.4,85.1", "84.9,56.4,85.1,56.6,99", "a,b,c,d", "85.1,56.4,84.9,56.6"],
)
def test_parse_bbox_rejects_invalid_values(value: str) -> None:
    with pytest.raises(ValueError, match="bbox"):
        parse_bbox(value)


def make_client() -> TestClient:
    """Клиент без БД: проверяем разбор запросов и формат ошибок (движок не подключается)."""
    return TestClient(create_app())


def test_validation_error_is_problem_json() -> None:
    with make_client() as client:
        response = client.get("/api/v1/cells")

    assert response.status_code == 422
    assert response.headers["content-type"].startswith(PROBLEM_CONTENT_TYPE)
    body = response.json()
    assert body["title"] == "Ошибка валидации"
    assert body["status"] == 422
    assert body["instance"] == "/api/v1/cells"
    assert {error["location"] for error in body["errors"]} >= {"query.city", "query.category"}


def test_unknown_endpoint_is_problem_json() -> None:
    with make_client() as client:
        response = client.get("/api/v1/nope")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith(PROBLEM_CONTENT_TYPE)
    assert response.json()["status"] == 404


def test_healthz_still_works_without_database() -> None:
    with make_client() as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_openapi_documents_data_endpoints() -> None:
    with make_client() as client:
        schema = client.get("/openapi.json").json()

    paths = schema["paths"]
    assert {"/api/v1/cells", "/api/v1/pois", "/api/v1/meta/cities", "/api/v1/meta/categories"} <= set(paths)
    assert paths["/api/v1/cells"]["get"]["responses"]["404"]["description"].startswith("Город или категория")
