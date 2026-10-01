"""Интеграционные тесты «объекты слоя геометрией» (подсветка дополнительных слоёв, план §6)."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from conftest import DB_TESTS_ENABLED, prepare_test_city, resolve_test_database_url
from geopuls.config import get_settings
from geopuls.db import create_engine, session_scope
from geopuls.main import create_app

pytestmark = pytest.mark.skipif(not DB_TESTS_ENABLED, reason="нужна тестовая БД (GEOPULS_CI_DB=1)")

#: Координаты тестовой кофейни из мини-PBF (см. tests/fixtures/make_mini_pbf.py)
CAFE_LAT, CAFE_LON = 56.4847, 84.9482
#: Окно вокруг тестового города: bbox задаётся как min_lon,min_lat,max_lon,max_lat
CITY_BBOX = "84.82,56.37,85.16,56.58"


def insert_layer_poi(
    *,
    osm_id: int,
    category: str,
    latitude: float,
    longitude: float,
    on_grid: bool = True,
    polygon: str | None = None,
) -> int:
    """Добавить объект слоя руками: сетку и границы вида иначе не проверить.

    ``on_grid=False`` ставит заведомо «не нашу» ячейку (0) — так выглядит объект из OSM за пределами
    сетки города: он не должен появляться на карте, потому что в числах слоя его нет. ``polygon`` —
    геометрия-контур, чтобы проверить дорисовку целого объекта у края вида.
    """
    url = resolve_test_database_url()
    assert url is not None

    async def insert() -> int:
        engine = create_engine(get_settings().model_copy(update={"database_url": url}))
        try:
            async with session_scope(engine) as session:
                cell = "(SELECT h3_r9 FROM pois ORDER BY id LIMIT 1)" if on_grid else "0"
                cell8 = "(SELECT h3_r8 FROM pois ORDER BY id LIMIT 1)" if on_grid else "0"
                geometry = (f"ST_GeogFromText('SRID=4326;{polygon}')" if polygon else "NULL") + "::geography"
                poi_id = (
                    await session.execute(
                        text(
                            "INSERT INTO pois (osm_type, osm_id, location, geometry, h3_r9, h3_r8, tags, source) "
                            f"VALUES ('way', :osm_id, ST_GeogFromText(:point), {geometry}, "
                            f"  {cell}, {cell8}, '{{}}'::jsonb, 'geofabrik') RETURNING id"
                        ),
                        {
                            "osm_id": osm_id,
                            "point": f"SRID=4326;POINT({longitude} {latitude})",
                        },
                    )
                ).scalar_one()
                await session.execute(
                    text(
                        "INSERT INTO poi_categories (poi_id, category_id) "
                        "SELECT :poi_id, id FROM categories WHERE slug = :category"
                    ),
                    {"poi_id": poi_id, "category": category},
                )
                return int(poi_id)
        finally:
            await engine.dispose()

    return asyncio.run(insert())


@pytest.fixture
def client(tmp_path) -> TestClient:  # type: ignore[no-untyped-def]
    prepare_test_city(tmp_path)
    url = resolve_test_database_url()
    app = create_app(get_settings().model_copy(update={"database_url": url}))
    with TestClient(app) as test_client:
        yield test_client


def test_layer_objects_returns_features_with_geometry(client: TestClient) -> None:
    response = client.get(
        "/api/v1/layers/competitors/objects",
        params={"city": "tomsk", "bbox": CITY_BBOX},
    )

    assert response.status_code == 200
    body = response.json()

    assert body["type"] == "LayerObjects"
    assert body["meta"]["layer"] == "competitors"
    assert body["meta"]["layer_name"]
    assert body["meta"]["bbox"] == CITY_BBOX
    # Сетка города — часть ответа: по ней отобраны объекты, и без неё фильтр необъясним
    assert body["meta"]["res"] == 9
    # «Показано N из M»: интерфейс обязан знать, видит ли он слой целиком
    assert body["meta"]["returned"] == len(body["features"])
    assert body["meta"]["total"] >= body["meta"]["returned"]
    assert body["meta"]["truncated"] is False
    assert body["meta"]["data_version"] == "2026-09-27"

    # Мини-выгрузка содержит три объекта конкурентов: их геометрия — часть контракта ответа
    assert body["features"]
    feature = body["features"][0]
    assert feature["type"] == "Feature"
    assert feature["geometry"]["type"] in {"Point", "LineString", "Polygon", "MultiPolygon"}
    assert feature["properties"]["osm"].startswith(("node/", "way/", "relation/"))
    assert feature["properties"]["category"] in {"cafe", "grocery", "pharmacy"}
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
        "/api/v1/layers/competitors/objects",
        params={"city": "tomsk", "bbox": CITY_BBOX, "limit": 1},
    )

    assert response.status_code == 200
    body = response.json()

    assert body["meta"]["limit"] == 1
    assert len(body["features"]) == 1
    assert body["meta"]["total"] == 3
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


def test_layer_objects_skip_objects_outside_city_grid(client: TestClient) -> None:
    """Объект вне сетки города не рисуется: слой измеряется по гексам, и в числах его нет.

    Так выглядит всё, что нашлось в OSM за границей города: показать это на карте значило бы рассказать
    о данных, которых нет в агрегатах.
    """
    params = {"city": "tomsk", "bbox": CITY_BBOX}
    before = client.get("/api/v1/layers/competitors/objects", params=params).json()

    insert_layer_poi(
        osm_id=999_777,
        category="cafe",
        latitude=CAFE_LAT,
        longitude=CAFE_LON,
        on_grid=False,
    )

    after = client.get("/api/v1/layers/competitors/objects", params=params).json()
    osm_keys = {feature["properties"]["osm"] for feature in after["features"]}

    assert after["meta"]["total"] == before["meta"]["total"]
    assert "way/999777" not in osm_keys


def test_layer_objects_return_whole_object_touching_view(client: TestClient) -> None:
    """Объект, задевший вид краем, приходит целиком: обрезанный контур читать нельзя.

    Полигон стоит вокруг тестовой кофейни, а окно запроса сдвинуто восточнее: точка объекта в него не
    попадает, а контур — да. Отбор идёт по геометрии, поэтому объект возвращается целиком, вместе с
    координатами за левой границей окна.
    """
    insert_layer_poi(
        osm_id=999_778,
        category="cafe",
        latitude=CAFE_LAT,
        longitude=CAFE_LON,
        polygon="POLYGON((84.9478 56.4845, 84.9486 56.4845, 84.9486 56.4849, 84.9478 56.4849, 84.9478 56.4845))",
    )
    narrow = "84.9484,56.4846,84.9500,56.4850"

    body = client.get(
        "/api/v1/layers/competitors/objects",
        params={"city": "tomsk", "bbox": narrow},
    ).json()

    feature = next(
        (item for item in body["features"] if item["properties"]["osm"] == "way/999778"),
        None,
    )

    assert feature is not None
    assert feature["geometry"]["type"] == "Polygon"
    longitudes = [point[0] for point in feature["geometry"]["coordinates"][0]]
    assert min(longitudes) < 84.9484


def test_layer_objects_report_grid_resolution(client: TestClient) -> None:
    """Разрешение сетки — часть ответа: от него зависит, что именно показано на карте.

    На обоих разрешениях сетка города построена, поэтому одни и те же объекты попадают в отбор.
    """
    for res in (9, 8):
        body = client.get(
            "/api/v1/layers/competitors/objects",
            params={"city": "tomsk", "bbox": CITY_BBOX, "res": res},
        ).json()

        assert body["meta"]["res"] == res
        assert body["meta"]["returned"] == 3
