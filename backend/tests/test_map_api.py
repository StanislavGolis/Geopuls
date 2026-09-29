"""Интеграционные тесты колоночного ответа карты (`GET /api/v1/map`, шаг 4 Этапа 8).

Проверяется главное обещание формата: геометрия передаётся один раз на весь набор слоёв, а значения
идут колонками, выровненными с `cells.h3`. Регрессия по числам сверяется со старым `/cells`: продукт
должен показывать то же самое, что и до перехода на слои.
"""

from __future__ import annotations

import asyncio
import gzip

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from conftest import DB_TESTS_ENABLED, TEST_DATA_VERSION, prepare_test_city, resolve_test_database_url
from geopuls.api.map import MAX_OVERLAYS
from geopuls.config import get_settings
from geopuls.db import create_engine, session_scope
from geopuls.layers_catalog import LAYERS_BY_SLUG
from geopuls.main import create_app

pytestmark = pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")

#: Базовый слой тестовой БД: слой конкурентов с категорией, по которой в фикстуре есть объекты
BASE = "competitors:cafe"


@pytest.fixture
def client(tmp_path) -> TestClient:  # type: ignore[no-untyped-def]
    prepare_test_city(tmp_path)
    url = resolve_test_database_url()
    app = create_app(get_settings().model_copy(update={"database_url": url}))
    with TestClient(app) as test_client:
        yield test_client


def add_layer(
    slug: str,
    *,
    metric_kind: str = "count",
    unit: str | None = "шт",
    can_be_base: bool = False,
    with_metrics: bool = True,
    value: float = 1.0,
) -> None:
    """Добавить синтетический слой: в тестовой БД реальный слой один, а правила набора — про несколько.

    Слои без метрик нужны отдельным случаем: колонка, которую ещё не собирали, должна приходить
    пустой (``null``), а не выдуманными нулями.
    """
    assert slug not in LAYERS_BY_SLUG, (
        f"{slug} — реальный слой из каталога: синтетическому слою нужен свой slug, иначе вставка конфликтует с сидом"
    )
    url = resolve_test_database_url()
    assert url is not None

    async def run() -> None:
        engine = create_engine(get_settings().model_copy(update={"database_url": url}))
        try:
            async with session_scope(engine) as session:
                layer_id = (
                    await session.execute(
                        text(
                            "INSERT INTO layers (slug, name_ru, kind, metric_kind, unit, scale, color, "
                            "can_be_base, sort_order, is_active, dataset_id) "
                            "VALUES (:slug, :name, 'osm', :metric_kind, :unit, 'linear', '#334155', "
                            ":can_be_base, 90, true, (SELECT id FROM datasets WHERE slug = 'osm')) "
                            "RETURNING id"
                        ),
                        {
                            "slug": slug,
                            "name": f"Слой {slug}",
                            "metric_kind": metric_kind,
                            "unit": unit,
                            "can_be_base": can_be_base,
                        },
                    )
                ).scalar_one()
                if not with_metrics:
                    return

                await session.execute(
                    text(
                        "INSERT INTO cell_metrics (city_id, layer_id, category_id, resolution, h3_index, "
                        "data_version, value, value_kind, extras) "
                        "SELECT cc.city_id, :layer_id, NULL, cc.resolution, cc.h3_index, :version, "
                        ":value, :metric_kind, '{}'::jsonb "
                        "FROM city_cells cc JOIN cities c ON c.id = cc.city_id "
                        "WHERE c.slug = 'tomsk' AND cc.resolution = 9"
                    ),
                    {
                        "layer_id": layer_id,
                        "version": TEST_DATA_VERSION,
                        "value": value,
                        "metric_kind": metric_kind,
                    },
                )
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_map_returns_columns_aligned_with_base_layer(client: TestClient) -> None:
    response = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=3600"
    body = response.json()

    assert body["type"] == "LayerGrid"
    cells = body["cells"]
    assert len(cells["h3"]) == body["meta"]["cell_count"] > 1000
    assert len(cells["geometry"]) == len(cells["h3"]), "геометрия идёт по одной записи на ячейку"

    column = body["layers"][0]
    assert column["slug"] == "competitors"
    assert column["category"] == "cafe"
    assert column["role"] == "base"
    assert column["metric_kind"] == "density"
    assert column["unit"] == "POI/км²"
    assert column["covered_count"] == body["meta"]["cell_count"]
    assert column["non_empty_count"] >= 1
    assert len(column["breaks"]) == 5, "0 + 4 класса легенды по умолчанию"
    assert column["source"]["slug"] == "osm"
    assert "OpenStreetMap" in column["source"]["attribution_text"]

    # Колонки выровнены с ячейками: без этого значения «поедут» на другую ячейку
    assert len(column["values"]) == len(cells["h3"])
    assert len(column["extras"]["count"]) == len(cells["h3"])

    assert body["meta"]["base"] == BASE
    assert body["meta"]["overlays"] == []
    assert body["meta"]["data_version"] == TEST_DATA_VERSION
    assert body["meta"]["sources"][0]["slug"] == "osm"


def test_map_values_match_legacy_cells_endpoint(client: TestClient) -> None:
    """Регрессия: колоночный формат обязан отдавать те же числа, что старый `/cells`."""
    legacy = client.get("/api/v1/cells", params={"city": "tomsk", "category": "cafe"}).json()
    body = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE}).json()

    column = body["layers"][0]
    values = dict(zip(body["cells"]["h3"], column["values"], strict=True))
    counts = dict(zip(body["cells"]["h3"], column["extras"]["count"], strict=True))

    assert {key: round(value, 2) for key, value in values.items()} == {
        item["id"]: item["properties"]["density"] for item in legacy["features"]
    }
    assert counts == {item["id"]: item["properties"]["count"] for item in legacy["features"]}
    assert body["meta"]["cell_count"] == legacy["meta"]["cell_count"]
    assert column["non_empty_count"] == legacy["meta"]["non_empty_count"]
    assert column["breaks"] == legacy["meta"]["density_breaks"]
    assert round(column["max_value"], 2) == legacy["meta"]["max_density"]


def test_map_geometry_is_not_duplicated_between_layers(client: TestClient) -> None:
    """Смысл колоночного формата: три слоя стоят почти столько же, сколько один.

    Проверяем не абсолютный размер, а то, что добавление слоя не тащит за собой геометрию: иначе
    формат теряет смысл, и карта из трёх слоёв станет втрое тяжелее.
    """
    add_layer("transport", metric_kind="count")
    add_layer("population", metric_kind="people_density", unit="чел/км²")

    single = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE}).content
    triple_response = client.get(
        "/api/v1/map", params={"city": "tomsk", "base": BASE, "overlays": "transport,population"}
    )
    triple = triple_response.content

    assert triple_response.status_code == 200
    # Замер на этой же сетке (1507 ячеек, как на проде): один слой — 281 КБ JSON / 51,3 КБ gzip,
    # три слоя — 294 КБ JSON / 51,6 КБ gzip. Третий слой стоит ~270 байт в gzip, а не ещё одну копию
    # геометрии: критерий ADR 0013 («три слоя ≤ ~100 КБ gzip») выполняется с запасом.
    assert len(triple) < len(single) * 1.3, "геометрия должна передаваться один раз на все слои"
    assert len(gzip.compress(triple, 6)) <= 100_000, "ADR 0013: три слоя укладываются в 100 КБ gzip"

    body = triple_response.json()
    assert [column["role"] for column in body["layers"]] == ["base", "overlay", "overlay"]
    assert body["meta"]["overlays"] == ["transport", "population"]
    assert len(body["meta"]["sources"]) == 1, "источник один, дубликаты в метаданных не нужны"


def test_map_marks_cells_without_values_as_unknown(client: TestClient) -> None:
    """Слой без собранных метрик отдаётся пустой колонкой: `null` честнее выдуманного нуля."""
    add_layer("population", with_metrics=False)

    body = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE, "overlays": "population"}).json()
    overlay = body["layers"][1]

    assert overlay["role"] == "overlay"
    assert overlay["covered_count"] == 0
    assert overlay["non_empty_count"] == 0
    assert set(overlay["values"]) == {None}
    assert len(overlay["values"]) == body["meta"]["cell_count"]


def test_map_rejects_too_many_overlays(client: TestClient) -> None:
    """Лимит слоёв в одном запросе технический: он держит размер ответа разумным."""
    for index in range(MAX_OVERLAYS + 1):
        add_layer(f"synthetic_{index}")

    response = client.get(
        "/api/v1/map",
        params={
            "city": "tomsk",
            "base": BASE,
            "overlays": ",".join(f"synthetic_{index}" for index in range(MAX_OVERLAYS + 1)),
        },
    )

    assert response.status_code == 400
    assert f"больше {MAX_OVERLAYS}" in response.json()["detail"]


def test_map_rejects_duplicate_overlay(client: TestClient) -> None:
    add_layer("transport")

    response = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE, "overlays": "transport,transport"})

    assert response.status_code == 400
    assert "дважды" in response.json()["detail"]


def test_map_rejects_base_layer_repeated_as_overlay(client: TestClient) -> None:
    response = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE, "overlays": "competitors:bar"})

    assert response.status_code == 400
    assert "наложение" in response.json()["detail"]


def test_map_rejects_layer_that_cannot_be_base(client: TestClient) -> None:
    add_layer("transport", can_be_base=False)

    response = client.get("/api/v1/map", params={"city": "tomsk", "base": "transport"})

    assert response.status_code == 400
    assert "красить" in response.json()["detail"]


def test_map_requires_category_for_layer_with_variants(client: TestClient) -> None:
    response = client.get("/api/v1/map", params={"city": "tomsk", "base": "competitors"})

    assert response.status_code == 400
    assert "category" in response.json()["detail"]


def test_map_400_for_broken_layer_reference(client: TestClient) -> None:
    response = client.get("/api/v1/map", params={"city": "tomsk", "base": "Competitors!"})

    assert response.status_code == 400
    assert "slug" in response.json()["detail"]


def test_map_404_for_unknown_city_layer_and_category(client: TestClient) -> None:
    assert client.get("/api/v1/map", params={"city": "nowhere", "base": BASE}).status_code == 404
    assert client.get("/api/v1/map", params={"city": "tomsk", "base": "nowhere"}).status_code == 404
    assert client.get("/api/v1/map", params={"city": "tomsk", "base": "competitors:nope"}).status_code == 404


def test_map_requires_base_layer(client: TestClient) -> None:
    """Без базового слоя карта не знает, что красить: параметр обязателен."""
    assert client.get("/api/v1/map", params={"city": "tomsk"}).status_code == 422


def test_map_etag_depends_on_layer_set(client: TestClient) -> None:
    add_layer("transport")
    params = {"city": "tomsk", "base": BASE}
    single = client.get("/api/v1/map", params=params)
    with_overlay = client.get("/api/v1/map", params={**params, "overlays": "transport"})

    again = client.get("/api/v1/map", params=params, headers={"If-None-Match": single.headers["etag"]})

    assert again.status_code == 304
    assert again.content == b""
    assert with_overlay.headers["etag"] != single.headers["etag"], "состав слоёв входит в ETag"


def test_map_bbox_filters_cells_and_columns(client: TestClient) -> None:
    bbox = "84.94,56.47,84.99,56.50"
    full = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE}).json()
    narrow = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE, "bbox": bbox}).json()

    assert 0 < narrow["meta"]["cell_count"] < full["meta"]["cell_count"]
    assert narrow["meta"]["bbox_filter"] == bbox
    assert len(narrow["cells"]["geometry"]) == narrow["meta"]["cell_count"]
    assert len(narrow["layers"][0]["values"]) == narrow["meta"]["cell_count"]


def test_map_switches_grid_resolution(client: TestClient) -> None:
    """res 8 — обзорная сетка: ячеек меньше, и колонка значений короче ровно на столько же."""
    detail = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE, "res": 9}).json()
    overview = client.get("/api/v1/map", params={"city": "tomsk", "base": BASE, "res": 8}).json()

    assert overview["meta"]["res"] == 8
    assert 0 < overview["meta"]["cell_count"] < detail["meta"]["cell_count"]
    assert len(overview["layers"][0]["values"]) == overview["meta"]["cell_count"]
