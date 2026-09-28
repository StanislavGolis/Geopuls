"""Тесты подготовки данных для сидирования (без БД)."""

from __future__ import annotations

import json
from pathlib import Path

from geopuls.categories import MVP_CATEGORIES
from geopuls.importers.boundary import load_boundary
from geopuls.seed import build_category_rows, build_city_params

FIXTURE = Path(__file__).parent / "fixtures" / "tomsk-boundary.json"


def test_category_rows_match_mvp_categories() -> None:
    rows = build_category_rows()

    assert [row["slug"] for row in rows] == [category.slug for category in MVP_CATEGORIES]
    assert [row["sort_order"] for row in rows] == list(range(len(rows)))
    assert len({row["slug"] for row in rows}) == len(rows)
    assert all(row["name_ru"] and row["color"] and row["osm_tags"] for row in rows)


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
