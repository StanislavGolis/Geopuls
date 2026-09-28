"""Тесты маппинга OSM-тегов на категории (основа разведки данных и импортёра)."""

from __future__ import annotations

from geopuls.categories import (
    MVP_CATEGORIES,
    CategoryRule,
    has_address,
    is_poi_candidate,
    match_categories,
    rule,
)


def test_rule_requires_all_pairs() -> None:
    fitness_rule = rule(("leisure", "sports_centre"), ("sport", "fitness"))

    assert fitness_rule.matches({"leisure": "sports_centre", "sport": "fitness"}) is True
    assert fitness_rule.matches({"leisure": "sports_centre"}) is False
    assert fitness_rule.matches({"leisure": "sports_centre", "sport": "swimming"}) is False


def test_rule_with_none_value_matches_any_value() -> None:
    any_amenity = CategoryRule(pairs=(("amenity", None),))

    assert any_amenity.matches({"amenity": "cafe"}) is True
    assert any_amenity.matches({"amenity": "pharmacy"}) is True
    assert any_amenity.matches({"shop": "beauty"}) is False


def test_match_categories_single() -> None:
    assert match_categories({"amenity": "cafe", "name": "Кофейня"}) == ("cafe",)


def test_match_categories_multiple() -> None:
    """Объект может попадать в несколько категорий: в OSM это норма."""
    matched = match_categories({"amenity": "cafe", "shop": "convenience"})

    assert set(matched) == {"cafe", "grocery"}


def test_match_categories_pickup_point_variants() -> None:
    assert "pickup_point" in match_categories({"shop": "outpost"})
    assert "pickup_point" in match_categories({"amenity": "parcel_locker"})
    assert match_categories({"shop": "kiosk"}) == ()


def test_match_categories_unknown_object() -> None:
    assert match_categories({"highway": "bus_stop"}) == ()


def test_is_poi_candidate() -> None:
    assert is_poi_candidate({"shop": "kiosk"}) is True
    assert is_poi_candidate({"highway": "bus_stop"}) is False


def test_has_address_requires_street_and_number() -> None:
    assert has_address({"addr:street": "ул. Ленина", "addr:housenumber": "10"}) is True
    assert has_address({"addr:street": "ул. Ленина"}) is False
    assert has_address({}) is False


def test_mvp_categories_are_unique_and_non_empty() -> None:
    slugs = [category.slug for category in MVP_CATEGORIES]

    assert len(slugs) == len(set(slugs))
    assert all(category.rules for category in MVP_CATEGORIES)
    assert all(category.as_osm_tags() for category in MVP_CATEGORIES)


def test_as_osm_tags_is_json_ready() -> None:
    cafe = next(category for category in MVP_CATEGORIES if category.slug == "cafe")

    assert cafe.as_osm_tags() == [{"key": "amenity", "value": "cafe"}]
