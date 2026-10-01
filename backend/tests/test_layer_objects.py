"""Интеграционные тесты «объекты слоя геометрией» (подсветка дополнительных слоёв, план §6)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from conftest import DB_TESTS_ENABLED, prepare_test_city, resolve_test_database_url
from geopuls.config import get_settings
from geopuls.main import create_app

pytestmark = pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")

#: Координаты тестовой кофейни из мини-PBF (см. tests/fixtures/make_mini_pbf.py)
CAFE_LAT, CAFE_LON = 56.4847, 84.9482
#: Окно вокруг тестового города: bbox задаётся как min_lon,min_lat,max_lon,max_lat
CITY_BBOX = "84.82,56.37,85.16,56.58"


@pytest.fixture
def client(tmp_path) -> TestClient:  # type: ignore[no-untyped-def]
    prepare_test_city(tmp_path)
    url = resolve_test_database_url()
    app = create_app(get_settings().model_copy(update={"database_url": url}))
    with TestClient(app) as test_client:
        yield test_client


def test_layer_objects_returns_features_with_geometry(client: TestClient) -> None:
    response = client.get(
        "/api/v1/layers/transport_stops/objects",
        params={"city": "tomsk", "bbox": CITY_BBOX},
    )

    assert response.status_code == 200
    body = response.json()

    assert body["type"] == "LayerObjects"
    assert body["meta"]["layer"] == "transport_stops"
    assert body["meta"]["layer_name"]
    assert body["meta"]["bbox"] == CITY_BBOX
    # «Показано N из M»: интерфейс обязан знать, видит ли он слой целиком
    assert body["meta"]["returned"] == len(body["features"])
    assert body["meta"]["total"] >= body["meta"]["returned"]
    assert body["meta"]["truncated"] is False
    assert body["meta"]["data_version"] == "2026-09-27"

    if body["features"]:
        feature = body["features"][0]
        assert feature["type"] == "Feature"
        assert feature["geometry"]["type"] in {"Point", "LineString", "Polygon", "MultiPolygon"}
        assert feature["properties"]["osm"].startswith(("node/", "way/", "relation/"))
        assert feature["properties"]["category"] == "transport_stops"
        assert feature["properties"]["geom_type"]


def test_layer_objects_outside_city_are_empty_but_valid(client: TestClient) -> None:
    """Пустой ответ — тоже ответ: окно может не содержать объектов слоя."""
    response = client.get(
        "/api/v1/layers/transport_stops/objects",
        params={"city": "tomsk", "bbox": "10.0,10.0,10.1,10.1"},
    )

    assert response.status_code == 200
    body = response.json()

    assert body["features"] == []
    assert body["meta"]["total"] == 0
    assert body["meta"]["truncated"] is False


def test_layer_objects_limit_is_honest_about_truncation(client: TestClient) -> None:
    """Если объектов больше лимита — сообщаем, а не молча обрезаем."""
    response = client.get(
        "/api/v1/layers/pedestrian/objects",
        params={"city": "tomsk", "bbox": CITY_BBOX, "limit": 1},
    )

    assert response.status_code == 200
    body = response.json()

    assert body["meta"]["limit"] == 1
    assert len(body["features"]) <= 1
    if body["meta"]["total"] > 1:
        assert body["meta"]["truncated"] is True


def test_layer_objects_require_bbox(client: TestClient) -> None:
    response = client.get("/api/v1/layers/parking/objects", params={"city": "tomsk"})

    assert response.status_code == 422


def test_layer_objects_reject_broken_bbox(client: TestClient) -> None:
    response = client.get(
        "/api/v1/layers/parking/objects",
        params={"city": "tomsk", "bbox": "84.9,56.4"},
    )

    assert response.status_code == 400


def test_layer_objects_reject_unknown_layer_and_city(client: TestClient) -> None:
    unknown_layer = client.get(
        "/api/v1/layers/ufo/objects",
        params={"city": "tomsk", "bbox": CITY_BBOX},
    )
    unknown_city = client.get(
        "/api/v1/layers/parking/objects",
        params={"city": "nowhere", "bbox": CITY_BBOX},
    )

    assert unknown_layer.status_code == 404
    assert unknown_city.status_code == 404


def test_layer_objects_etag_returns_304(client: TestClient) -> None:
    params = {"city": "tomsk", "bbox": CITY_BBOX}
    first = client.get("/api/v1/layers/parking/objects", params=params)
    etag = first.headers["etag"]

    second = client.get("/api/v1/layers/parking/objects", params=params, headers={"If-None-Match": etag})

    assert first.status_code == 200
    assert second.status_code == 304


def test_layer_objects_carry_source_license(client: TestClient) -> None:
    """Объекты слоя — данные OSM: лицензия и атрибуция нужны для подписи на карте."""
    response = client.get(
        "/api/v1/layers/parking/objects",
        params={"city": "tomsk", "bbox": CITY_BBOX},
    )

    sources = response.json()["sources"]

    assert sources
    assert sources[0]["license"]
    assert sources[0]["attribution_text"]
