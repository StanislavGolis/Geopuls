"""Интеграционные тесты «что вокруг точки» (радиус, ST_DWithin) на живом PostGIS."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from conftest import DB_TESTS_ENABLED, prepare_test_city, resolve_test_database_url
from geopuls.config import get_settings
from geopuls.main import create_app

pytestmark = pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")

#: Координаты тестовой кофейни из мини-PBF (см. tests/fixtures/make_mini_pbf.py)
CAFE_LAT, CAFE_LON = 56.4847, 84.9482
#: Точка в стороне от тестового города: в радиусе не должно быть ничего
FAR_LAT, FAR_LON = 55.0, 82.0


@pytest.fixture
def client(tmp_path) -> TestClient:  # type: ignore[no-untyped-def]
    prepare_test_city(tmp_path)
    url = resolve_test_database_url()
    app = create_app(get_settings().model_copy(update={"database_url": url}))
    with TestClient(app) as test_client:
        yield test_client


def test_around_counts_competitors_at_point(client: TestClient) -> None:
    response = client.get(
        "/api/v1/around",
        params={"city": "tomsk", "lat": CAFE_LAT, "lon": CAFE_LON, "category": "cafe"},
    )

    assert response.status_code == 200
    body = response.json()

    assert body["type"] == "AroundPoint"
    assert body["point"] == {"lat": CAFE_LAT, "lon": CAFE_LON}
    assert body["meta"]["radius_m"] == 500
    assert body["meta"]["city"] == "tomsk"

    competitors = next(layer for layer in body["layers"] if layer["slug"] == "competitors")
    assert competitors["category"] == "cafe", "видно, чьи это конкуренты"
    assert competitors["objects"] == 1, "тестовая кофейня стоит в самой точке"
    # 0 м округляем только здесь: точка выбрана по координатам самой кофейни
    assert competitors["nearest_m"] == pytest.approx(0, abs=1)
    assert competitors["nearest_name"]


def test_around_lists_all_layers_even_empty(client: TestClient) -> None:
    """«Нет остановок в 500 м» — тоже ответ: слой не должен исчезать из списка."""
    response = client.get(
        "/api/v1/around",
        params={"city": "tomsk", "lat": FAR_LAT, "lon": FAR_LON, "category": "cafe"},
    )

    assert response.status_code == 200
    layers = response.json()["layers"]

    slugs = {layer["slug"] for layer in layers}
    assert {"competitors", "transport_stops", "anchors"} <= slugs

    competitors = next(layer for layer in layers if layer["slug"] == "competitors")
    assert competitors["objects"] == 0
    assert competitors["nearest_m"] is None
    assert competitors["nearest_name"] is None


def test_around_radius_narrows_result(client: TestClient) -> None:
    """В круге 100 м кофейня есть (она в центре), за городом — нет."""
    near = client.get(
        "/api/v1/around",
        params={"city": "tomsk", "lat": CAFE_LAT, "lon": CAFE_LON, "category": "cafe", "radius_m": 100},
    )
    far = client.get(
        "/api/v1/around",
        params={"city": "tomsk", "lat": FAR_LAT, "lon": FAR_LON, "category": "cafe", "radius_m": 100},
    )

    assert near.status_code == 200
    assert far.status_code == 200
    near_objects = next(layer["objects"] for layer in near.json()["layers"] if layer["slug"] == "competitors")
    far_objects = next(layer["objects"] for layer in far.json()["layers"] if layer["slug"] == "competitors")
    assert near_objects > far_objects
    assert far_objects == 0


def test_around_requires_category(client: TestClient) -> None:
    """Без категории непонятно, кого считать конкурентами: это ошибка запроса, а не пустой ответ."""
    response = client.get("/api/v1/around", params={"city": "tomsk", "lat": CAFE_LAT, "lon": CAFE_LON})

    assert response.status_code == 400
    assert "категори" in response.json()["detail"].lower()


def test_around_rejects_unknown_city_and_category(client: TestClient) -> None:
    unknown_city = client.get(
        "/api/v1/around",
        params={"city": "nowhere", "lat": CAFE_LAT, "lon": CAFE_LON, "category": "cafe"},
    )
    unknown_category = client.get(
        "/api/v1/around",
        params={"city": "tomsk", "lat": CAFE_LAT, "lon": CAFE_LON, "category": "ufo"},
    )

    assert unknown_city.status_code == 404
    assert unknown_category.status_code == 404


def test_around_rejects_out_of_range_input(client: TestClient) -> None:
    too_small = client.get(
        "/api/v1/around",
        params={"city": "tomsk", "lat": CAFE_LAT, "lon": CAFE_LON, "category": "cafe", "radius_m": 10},
    )
    bad_lat = client.get(
        "/api/v1/around",
        params={"city": "tomsk", "lat": 91, "lon": CAFE_LON, "category": "cafe"},
    )

    assert too_small.status_code == 422
    assert bad_lat.status_code == 422


def test_around_etag_returns_304(client: TestClient) -> None:
    params = {"city": "tomsk", "lat": CAFE_LAT, "lon": CAFE_LON, "category": "cafe"}
    first = client.get("/api/v1/around", params=params)
    etag = first.headers["etag"]

    second = client.get("/api/v1/around", params=params, headers={"If-None-Match": etag})

    assert first.status_code == 200
    assert second.status_code == 304


def test_around_sources_carry_licenses(client: TestClient) -> None:
    """Что вокруг точки — тоже данные OSM: источник и лицензия нужны для подписи на экране."""
    response = client.get(
        "/api/v1/around",
        params={"city": "tomsk", "lat": CAFE_LAT, "lon": CAFE_LON, "category": "cafe"},
    )

    sources = response.json()["sources"]

    assert sources, "у слоёв есть датасет, значит и источник"
    # Датасет один на несколько слоёв: в ответе он должен быть один раз, а не по разу на слой
    assert len({source["slug"] for source in sources}) == len(sources)
    assert all(source["license"] for source in sources)
    assert all(source["attribution_text"] for source in sources)
