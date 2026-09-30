"""Интеграционные тесты профиля города (живой PostGIS).

Профиль — это сводка, которую менеджер показывает руководству, поэтому проверяем не только форму
ответа, но и согласованность чисел с остальными эндпоинтами: если профиль и карта разойдутся, доверия
к цифрам не будет ни к одному.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from conftest import (
    DB_TESTS_ENABLED,
    TEST_DATA_VERSION,
    prepare_test_city,
    resolve_test_database_url,
)
from geopuls.config import get_settings
from geopuls.main import create_app

pytestmark = pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")


@pytest.fixture
def client(tmp_path) -> TestClient:  # type: ignore[no-untyped-def]
    prepare_test_city(tmp_path)
    url = resolve_test_database_url()
    app = create_app(get_settings().model_copy(update={"database_url": url}))
    with TestClient(app) as test_client:
        yield test_client


def test_profile_returns_city_grid_categories_and_layers(client: TestClient) -> None:
    """Профиль отдаёт город, охват сетки, категории конкурентов, все слои и источники."""
    response = client.get("/api/v1/meta/cities/tomsk/profile")

    assert response.status_code == 200
    body = response.json()

    assert body["type"] == "CityProfile"
    assert body["city"]["slug"] == "tomsk"
    assert body["city"]["data_version"] == TEST_DATA_VERSION
    assert body["city"]["area_km2"] > 0

    grid = body["grid"]
    assert grid["cells"] > 0
    assert 0 <= grid["cells_non_empty"] <= grid["cells"]
    assert 0 <= grid["empty_share"] <= 100

    # Категории профиля — только базовый слой, и их сумма равна общему числу объектов
    assert body["categories"], "у базового слоя должны быть категории"
    assert sum(item["poi_count"] for item in body["categories"]) == grid["poi_count"]
    assert all(0 <= item["share"] <= 100 for item in body["categories"])

    # Слои: показываем все из реестра, даже те, у которых в этой сетке нет метрик
    registry = client.get("/api/v1/layers", params={"city": "tomsk"}).json()["layers"]
    assert {row["slug"] for row in body["layers"]} == {row["slug"] for row in registry}
    assert body["sources"], "источники нужны для атрибуции в интерфейсе и экспорте"


def test_profile_numbers_match_map_endpoints(client: TestClient) -> None:
    """Числа профиля совпадают с числами карты: у интерфейса один источник правды."""
    profile = client.get("/api/v1/meta/cities/tomsk/profile").json()
    cells = client.get("/api/v1/cells", params={"city": "tomsk", "category": "cafe", "res": 9}).json()

    assert profile["grid"]["cells"] == cells["meta"]["cell_count"]
    cafe = next(row for row in profile["categories"] if row["slug"] == "cafe")
    assert cafe["poi_count"] == cells["meta"]["poi_count"]


def test_profile_layer_coverage_matches_layer_endpoint(client: TestClient) -> None:
    """Покрытие слоя в профиле — то же, что в ответе по слою (иначе легенда врёт)."""
    profile = client.get("/api/v1/meta/cities/tomsk/profile").json()
    competitors = next(row for row in profile["layers"] if row["slug"] == "competitors")

    layer = client.get(
        "/api/v1/layers/competitors/cells",
        params={"city": "tomsk", "category": "cafe", "res": 9},
    ).json()

    assert competitors["covered_count"] == layer["meta"]["cell_count"]
    assert competitors["non_empty_count"] >= layer["meta"]["non_empty_count"]
    assert competitors["max_value"] >= layer["meta"]["max_value"]


def test_profile_supports_conditional_request(client: TestClient) -> None:
    """ETag: повторный запрос по неизменным данным отдаёт 304 и не считает агрегаты заново."""
    first = client.get("/api/v1/meta/cities/tomsk/profile")

    assert first.headers["cache-control"] == "public, max-age=3600"
    etag = first.headers["etag"]

    second = client.get("/api/v1/meta/cities/tomsk/profile", headers={"If-None-Match": etag})

    assert second.status_code == 304


def test_profile_404_for_unknown_city(client: TestClient) -> None:
    response = client.get("/api/v1/meta/cities/nowhere/profile")

    assert response.status_code == 404
    assert "не найден" in response.json()["detail"]
