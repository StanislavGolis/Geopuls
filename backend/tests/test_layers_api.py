"""Интеграционные тесты API слоёв: реестр, значения слоя и профиль ячейки (ADR 0013)."""

from __future__ import annotations

import h3
import pytest
from fastapi.testclient import TestClient

from conftest import DB_TESTS_ENABLED, TEST_DATA_VERSION, prepare_test_city, resolve_test_database_url
from geopuls.config import get_settings
from geopuls.main import create_app

pytestmark = pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")

#: Координаты тестовой кофейни из мини-PBF
CAFE_CELL = h3.latlng_to_cell(56.4847, 84.9482, 9)
NOWHERE_CELL = h3.latlng_to_cell(55.0, 82.0, 9)


@pytest.fixture
def client(tmp_path) -> TestClient:  # type: ignore[no-untyped-def]
    prepare_test_city(tmp_path)
    url = resolve_test_database_url()
    app = create_app(get_settings().model_copy(update={"database_url": url}))
    with TestClient(app) as test_client:
        yield test_client


def test_layers_registry_describes_metric_source_and_categories(client: TestClient) -> None:
    response = client.get("/api/v1/layers", params={"city": "tomsk"})

    assert response.status_code == 200
    body = response.json()
    competitors = body["layers"][0]

    assert competitors["slug"] == "competitors"
    assert competitors["kind"] == "osm"
    assert competitors["metric_kind"] == "density"
    assert competitors["unit"] == "POI/км²"
    assert competitors["can_be_base"] is True
    assert len(competitors["categories"]) == 18
    assert "cafe" in competitors["categories"]
    # Категории второй волны видны тем же ответом: интерфейс строит выбор из реестра, а не из списка в коде
    assert {"banks", "education", "medical", "fuel"} <= set(competitors["categories"])
    # Источник с лицензией и атрибуцией: без них слой нельзя показывать пользователю
    assert competitors["source"]["slug"] == "osm"
    assert "OpenStreetMap" in competitors["source"]["attribution_text"]
    assert competitors["source"]["license"] == "ODbL 1.0"
    assert body["data_version"] == TEST_DATA_VERSION


def test_layers_registry_404_for_unknown_city(client: TestClient) -> None:
    assert client.get("/api/v1/layers", params={"city": "nowhere"}).status_code == 404


def test_layer_cells_requires_category_for_layer_with_variants(client: TestClient) -> None:
    """Слой конкурентов состоит из категорий: без них на ячейку пришлось бы 8 значений."""
    response = client.get("/api/v1/layers/competitors/cells", params={"city": "tomsk"})

    assert response.status_code == 400
    assert "category" in response.json()["detail"]


def test_layer_cells_returns_values_empty_cells_and_breaks(client: TestClient) -> None:
    response = client.get("/api/v1/layers/competitors/cells", params={"city": "tomsk", "category": "cafe"})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=3600"
    assert response.headers["etag"].startswith('"')

    body = response.json()
    meta = body["meta"]
    assert body["type"] == "FeatureCollection"
    assert meta["layer"] == "competitors"
    assert meta["metric_kind"] == "density"
    assert meta["category"] == "cafe"
    assert meta["cell_count"] > 1000
    assert meta["non_empty_count"] >= 1
    assert meta["max_value"] > 0
    assert len(meta["breaks"]) == 5, "0 + 4 класса легенды по умолчанию"
    assert meta["sources"][0]["slug"] == "osm"
    assert meta["data_version"] == TEST_DATA_VERSION

    dense = [item for item in body["features"] if item["properties"]["value"] > 0]
    assert dense, "в тестовых данных должна быть минимум одна непустая ячейка"
    # Дополнительные показатели разворачиваются в свойствах ячейки: счётчик объектов и адреса
    assert dense[0]["properties"]["value_kind"] == "density"
    assert dense[0]["properties"]["count"] >= 1
    assert meta["non_empty_count"] == len(dense)
    assert any(item["properties"]["value"] == 0 for item in body["features"]), "пустые ячейки нужны"


def test_layer_cells_supports_conditional_request(client: TestClient) -> None:
    params = {"city": "tomsk", "category": "cafe"}
    first = client.get("/api/v1/layers/competitors/cells", params=params)
    etag = first.headers["etag"]

    again = client.get("/api/v1/layers/competitors/cells", params=params, headers={"If-None-Match": etag})

    assert again.status_code == 304
    assert again.content == b""


def test_layer_cells_404_for_category_from_other_layer(client: TestClient) -> None:
    response = client.get("/api/v1/layers/competitors/cells", params={"city": "tomsk", "category": "no-such-category"})

    assert response.status_code == 404


def test_layer_cells_404_for_unknown_layer(client: TestClient) -> None:
    response = client.get("/api/v1/layers/population/cells", params={"city": "tomsk", "category": "cafe"})

    assert response.status_code == 404
    assert "Слой" in response.json()["detail"]


def test_layer_cells_matches_legacy_cells_endpoint(client: TestClient) -> None:
    """Регрессия этапа: слой «Конкуренты» обязан отдавать те же числа, что старый `/cells`.

    Это проверка главного требования Этапа 8: продукт работает как раньше, но на новой схеме.
    """
    params = {"city": "tomsk", "category": "cafe"}
    legacy = client.get("/api/v1/cells", params=params).json()
    layer = client.get("/api/v1/layers/competitors/cells", params=params).json()

    assert layer["meta"]["cell_count"] == legacy["meta"]["cell_count"]
    assert layer["meta"]["non_empty_count"] == legacy["meta"]["non_empty_count"]
    assert round(layer["meta"]["max_value"], 2) == legacy["meta"]["max_density"]
    assert layer["meta"]["breaks"] == legacy["meta"]["density_breaks"]

    legacy_values = {item["id"]: item["properties"]["density"] for item in legacy["features"]}
    layer_values = {item["id"]: round(item["properties"]["value"], 2) for item in layer["features"]}
    assert layer_values == legacy_values
    assert all(item["properties"]["count"] >= 0 for item in layer["features"])


def test_cell_profile_lists_metrics_of_all_layers(client: TestClient) -> None:
    response = client.get(f"/api/v1/cells/{CAFE_CELL}", params={"city": "tomsk"})

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["cell"] == CAFE_CELL
    assert body["meta"]["data_version"] == TEST_DATA_VERSION

    by_category = {item["category"]: item for item in body["metrics"] if item["layer"] == "competitors"}
    assert by_category["cafe"]["value"] > 0
    assert by_category["cafe"]["extras"]["count"] >= 1
    assert by_category["bar"]["value"] == 0
    assert by_category["cafe"]["unit"] == "POI/км²"


def test_cell_profile_404_outside_city_grid(client: TestClient) -> None:
    response = client.get(f"/api/v1/cells/{NOWHERE_CELL}", params={"city": "tomsk"})

    assert response.status_code == 404
    assert "вне сетки" in response.json()["detail"]


def test_cell_profile_400_for_invalid_index(client: TestClient) -> None:
    response = client.get("/api/v1/cells/not-an-h3-index", params={"city": "tomsk"})

    assert response.status_code == 400
    assert "H3" in response.json()["detail"]
