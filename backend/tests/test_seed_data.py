"""Тесты подготовки данных для сидирования (без БД)."""

from __future__ import annotations

import json
from pathlib import Path

from geopuls.categories import COMPETITOR_CATEGORIES
from geopuls.importers.boundary import load_boundary
from geopuls.layers_catalog import LAYERS_BY_SLUG
from geopuls.models.layers import METRIC_KINDS
from geopuls.seed import (
    COMPETITORS_LAYER,
    build_category_rows,
    build_city_params,
    build_dataset_rows,
    build_layer_rows,
    category_slugs_by_layer,
)

FIXTURE = Path(__file__).parent / "fixtures" / "tomsk-boundary.json"


def test_category_rows_cover_mvp_and_layer_catalog() -> None:
    """Категории конкурентов идут первыми, дальше — по одной на каждый слой каталога (Этап 9)."""
    rows = build_category_rows()
    slugs = [row["slug"] for row in rows]

    assert slugs[: len(COMPETITOR_CATEGORIES)] == [category.slug for category in COMPETITOR_CATEGORIES]
    assert set(slugs) == {category.slug for category in COMPETITOR_CATEGORIES} | set(LAYERS_BY_SLUG)
    assert [row["sort_order"] for row in rows] == list(range(len(rows)))
    assert len(set(slugs)) == len(rows)
    assert all(row["name_ru"] and row["color"] and row["osm_tags"] for row in rows)


def test_category_slugs_by_layer_matches_rows() -> None:
    """Каждая категория обязана получить слой: иначе её метрики некуда положить."""
    mapping = category_slugs_by_layer()

    assert mapping[COMPETITORS_LAYER] == [category.slug for category in COMPETITOR_CATEGORIES]
    assert {slug for slugs in mapping.values() for slug in slugs} == {row["slug"] for row in build_category_rows()}
    assert set(mapping) == {COMPETITORS_LAYER, *LAYERS_BY_SLUG}


def test_dataset_rows_carry_license_and_attribution() -> None:
    """Без лицензии и атрибуции источник нельзя показывать в интерфейсе и экспорте (ADR 0013)."""
    rows = build_dataset_rows()

    assert {row["slug"] for row in rows} == {"osm"}
    assert all(row["license"] and row["license_url"] and row["attribution_text"] for row in rows)
    assert all("OpenStreetMap" in row["attribution_text"] for row in rows)


def test_layer_rows_declare_metric_and_dataset() -> None:
    """Слой обязан объявить метрику, единицу и источник: иначе значение нечем подписать."""
    rows = build_layer_rows({"osm": 7})
    competitors = next(row for row in rows if row["slug"] == COMPETITORS_LAYER)

    assert competitors["metric_kind"] in METRIC_KINDS
    assert competitors["unit"]
    assert competitors["dataset_id"] == 7
    assert competitors["can_be_base"] is True
    assert len({row["slug"] for row in rows}) == len(rows)


def test_restaurant_row_includes_fast_food() -> None:
    """Уточнение из разведки данных (Этап 0.5) должно попадать в БД."""
    row = next(row for row in build_category_rows() if row["slug"] == "restaurant")

    assert {"key": "amenity", "value": "fast_food"} in row["osm_tags"]


def test_fitness_row_uses_sports_hall() -> None:
    row = next(row for row in build_category_rows() if row["slug"] == "fitness")
    values = {(tag["key"], tag["value"]) for tag in row["osm_tags"]}

    assert ("leisure", "sports_hall") in values
    assert ("leisure", "sports_centre") not in values


def test_city_params_from_fixture() -> None:
    boundary = load_boundary(FIXTURE)

    params = build_city_params(
        slug="tomsk",
        name="Томск",
        region="Томская область",
        timezone="Asia/Tomsk",
        h3_res=9,
        boundary=boundary,
    )

    assert params["slug"] == "tomsk"
    assert params["osm_relation_id"] == 7261645
    assert params["boundary_source"] == "nominatim"
    assert params["timezone"] == "Asia/Tomsk"
    assert json.loads(params["geometry"])["type"] in {"Polygon", "MultiPolygon"}


def test_city_params_tolerate_boundary_without_relation_id() -> None:
    from geopuls.importers.boundary import CityBoundary

    boundary = CityBoundary(
        name="Без relation",
        display_name="",
        osm_type="",
        osm_id=0,
        license="",
        geometry={"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
    )

    params = build_city_params(
        slug="test",
        name="Тест",
        region=None,
        timezone=None,
        h3_res=9,
        boundary=boundary,
    )

    assert params["osm_relation_id"] is None
