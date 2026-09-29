"""Интеграционные тесты API на живом PostGIS (сид → импорт → агрегация → HTTP-запросы)."""

from __future__ import annotations

import gzip

import h3
import pytest
from fastapi.testclient import TestClient

from conftest import DB_TESTS_ENABLED, TEST_DATA_VERSION, prepare_test_city, resolve_test_database_url
from geopuls.config import get_settings
from geopuls.layers_catalog import ALL_CATEGORIES
from geopuls.main import create_app

pytestmark = pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")

#: Координаты тестовой кофейни из мини-PBF (см. tests/fixtures/make_mini_pbf.py)
CAFE_LAT, CAFE_LON = 56.4847, 84.9482
CAFE_CELL = h3.latlng_to_cell(CAFE_LAT, CAFE_LON, 9)
NOWHERE_CELL = h3.latlng_to_cell(55.0, 82.0, 9)


@pytest.fixture
def client(tmp_path) -> TestClient:  # type: ignore[no-untyped-def]
    prepare_test_city(tmp_path)
    url = resolve_test_database_url()
    app = create_app(get_settings().model_copy(update={"database_url": url}))
    with TestClient(app) as test_client:
        yield test_client


def test_meta_cities_returns_tomsk_with_version(client: TestClient) -> None:
    response = client.get("/api/v1/meta/cities")

    assert response.status_code == 200
    cities = response.json()
    assert len(cities) == 1

    tomsk = cities[0]
    assert tomsk["slug"] == "tomsk"
    assert tomsk["name"] == "Томск"
    assert 170 < tomsk["area_km2"] < 185
    assert tomsk["center"]["lat"] == pytest.approx(CAFE_LAT, abs=0.2)
    assert tomsk["bbox"]["min_lat"] < tomsk["bbox"]["max_lat"]
    assert tomsk["data_version"] == TEST_DATA_VERSION
    assert tomsk["updated_at"] is not None, "время обновления нужно для плашки «данные на …»"


def test_meta_categories_counts_pois(client: TestClient) -> None:
    response = client.get("/api/v1/meta/categories")

    assert response.status_code == 200
    categories = {item["slug"]: item for item in response.json()}

    # Эндпоинт отдаёт категории всех слоёв; видимые оставляет интерфейс (чипы строятся по базовому слою)
    assert len(categories) == len({category.slug for category in ALL_CATEGORIES})
    assert categories["cafe"]["poi_count"] == 1
    assert categories["bar"]["poi_count"] == 0
    assert categories["cafe"]["name"] == "Кофейни и кафе"


def test_cells_returns_geojson_with_empty_cells(client: TestClient) -> None:
    response = client.get("/api/v1/cells", params={"city": "tomsk", "category": "cafe"})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=3600"
    etag = response.headers["etag"]
    assert etag.startswith('"')

    body = response.json()
    assert body["type"] == "FeatureCollection"
    meta = body["meta"]
    assert meta["city"] == "tomsk"
    assert meta["category"] == "cafe"
    assert meta["res"] == 9
    assert meta["data_version"] == TEST_DATA_VERSION
    assert meta["cell_count"] > 1000
    assert meta["non_empty_count"] >= 1
    assert meta["cell_count"] > meta["non_empty_count"], "пустые ячейки обязаны присутствовать"
    assert meta["density_breaks"][0] == 0.0
    assert len(meta["density_breaks"]) == 5

    feature = next(item for item in body["features"] if item["id"] == CAFE_CELL)
    assert feature["properties"]["count"] == 1
    assert feature["properties"]["density"] > 0
    assert feature["geometry"]["type"] == "Polygon"

    # НФТ ТЗ (раздел 8): ответ по городу укладывается в 250 КБ gzip.
    # Геометрия H3 сжимается в разы (на Томске 485 КБ → 58 КБ), поэтому проверяем именно gzip.
    assert response.headers.get("content-encoding") == "gzip"
    assert len(gzip.compress(response.content)) < 250_000


def test_cells_supports_etag_revalidation(client: TestClient) -> None:
    first = client.get("/api/v1/cells", params={"city": "tomsk", "category": "cafe"})
    etag = first.headers["etag"]

    second = client.get("/api/v1/cells", params={"city": "tomsk", "category": "cafe"}, headers={"If-None-Match": etag})

    assert second.status_code == 304
    assert second.headers["etag"] == etag
    assert not second.content


def test_cells_bbox_filter_reduces_cells(client: TestClient) -> None:
    full = client.get("/api/v1/cells", params={"city": "tomsk", "category": "cafe"}).json()
    small = client.get(
        "/api/v1/cells",
        params={"city": "tomsk", "category": "cafe", "bbox": "84.94,56.48,84.96,56.49"},
    )

    assert small.status_code == 200
    body = small.json()

    assert 0 < body["meta"]["cell_count"] < full["meta"]["cell_count"]
    assert body["meta"]["bbox_filter"] == "84.94,56.48,84.96,56.49"
    assert len(body["features"]) == body["meta"]["cell_count"]


def test_cells_unknown_city_returns_problem(client: TestClient) -> None:
    response = client.get("/api/v1/cells", params={"city": "nowhere", "category": "cafe"})

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["title"] == "Не найдено"
    assert "nowhere" in body["detail"]
    assert body["instance"] == "/api/v1/cells"


def test_cells_unknown_category_returns_problem(client: TestClient) -> None:
    response = client.get("/api/v1/cells", params={"city": "tomsk", "category": "nowhere"})

    assert response.status_code == 404
    assert "nowhere" in response.json()["detail"]


def test_cells_rejects_unsupported_resolution(client: TestClient) -> None:
    response = client.get("/api/v1/cells", params={"city": "tomsk", "category": "cafe", "res": 7})

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")


def test_cells_invalid_bbox_returns_problem(client: TestClient) -> None:
    response = client.get("/api/v1/cells", params={"city": "tomsk", "category": "cafe", "bbox": "1,2,3"})

    assert response.status_code == 400
    assert response.json()["title"] == "Некорректный запрос"


def test_pois_returns_items_of_cell(client: TestClient) -> None:
    response = client.get("/api/v1/pois", params={"city": "tomsk", "cell": CAFE_CELL})

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["total"] == 1
    assert body["meta"]["returned"] == 1
    assert body["meta"]["data_version"] == TEST_DATA_VERSION

    item = body["items"][0]
    assert item["name"] == "Тестовая кофейня"
    assert item["address"] == "ул. Ленина, 1"
    assert item["categories"] == ["cafe"]
    assert item["osm_url"] == "https://www.openstreetmap.org/node/1"
    assert item["lat"] == pytest.approx(CAFE_LAT, abs=1e-6)


def test_pois_supports_etag_revalidation(client: TestClient) -> None:
    first = client.get("/api/v1/pois", params={"city": "tomsk", "cell": CAFE_CELL})
    assert first.headers["cache-control"] == "public, max-age=3600"

    second = client.get(
        "/api/v1/pois",
        params={"city": "tomsk", "cell": CAFE_CELL},
        headers={"If-None-Match": first.headers["etag"]},
    )

    assert second.status_code == 304


def test_pois_filters_by_category(client: TestClient) -> None:
    cafe = client.get("/api/v1/pois", params={"city": "tomsk", "cell": CAFE_CELL, "category": "cafe"}).json()
    bar = client.get("/api/v1/pois", params={"city": "tomsk", "cell": CAFE_CELL, "category": "bar"}).json()

    assert cafe["meta"]["total"] == 1
    assert bar["meta"]["total"] == 0


def test_pois_rejects_invalid_cell(client: TestClient) -> None:
    response = client.get("/api/v1/pois", params={"city": "tomsk", "cell": "не-индекс"})

    assert response.status_code == 400
    assert "H3-индекс" in response.json()["detail"]


def test_pois_reports_cell_outside_city_grid(client: TestClient) -> None:
    response = client.get("/api/v1/pois", params={"city": "tomsk", "cell": NOWHERE_CELL})

    assert response.status_code == 404
    assert "не входит в сетку" in response.json()["detail"]
