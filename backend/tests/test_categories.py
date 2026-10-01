"""Тесты маппинга OSM-тегов на категории (основа разведки данных и импортёра)."""

from __future__ import annotations

from geopuls.categories import (
    COMPETITOR_CATEGORIES,
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


def test_competitor_categories_are_unique_and_rules_do_not_overlap() -> None:
    """Слаги уникальны, и ни одно правило второй волны не повторяет правило MVP или соседа."""
    slugs = [category.slug for category in COMPETITOR_CATEGORIES]

    assert len(slugs) == len(set(slugs))
    assert len(COMPETITOR_CATEGORIES) == 18, "восемь категорий MVP и десять второй волны"

    seen: set[tuple[tuple[str, str | None], ...]] = set()
    for category in COMPETITOR_CATEGORIES:
        for item in category.rules:
            assert item.pairs not in seen, f"правило {item.pairs} повторяется у {category.slug}"
            seen.add(item.pairs)


def test_match_categories_covers_wave_two_tags() -> None:
    assert match_categories({"amenity": "bank"}) == ("banks",)
    assert match_categories({"amenity": "atm"}) == ("banks",)
    assert match_categories({"amenity": "kindergarten"}) == ("education",)
    assert match_categories({"shop": "car_repair"}) == ("auto",)
    assert match_categories({"amenity": "car_wash"}) == ("auto",)
    assert match_categories({"shop": "clothes"}) == ("clothes",)
    assert match_categories({"amenity": "dentist"}) == ("medical",)
    assert match_categories({"shop": "alcohol"}) == ("alcohol",)
    assert match_categories({"shop": "hardware"}) == ("diy",)
    assert match_categories({"tourism": "hostel"}) == ("hotels",)
    assert match_categories({"amenity": "fuel"}) == ("fuel",)
    assert match_categories({"shop": "florist"}) == ("flowers",)


def test_medical_does_not_grab_any_healthcare_value() -> None:
    """`healthcare=yes` и служебные значения — не конкуренты: правило задано списком, а не звёздочкой."""
    assert match_categories({"healthcare": "yes"}) == ()
    assert match_categories({"healthcare": "laboratory"}) == ()
    assert match_categories({"healthcare": "clinic"}) == ("medical",)


def test_city_infrastructure_stays_out_of_competitors() -> None:
    """Правило отбора: скамейки, урны, площадки и светофоры — не конкуренты малому бизнесу."""
    for tags in (
        {"amenity": "bench"},
        {"amenity": "waste_basket"},
        {"leisure": "playground"},
        {"leisure": "pitch"},
        {"highway": "traffic_signals"},
        {"amenity": "drinking_water"},
    ):
        assert match_categories(tags) == (), f"{tags} не должны попадать в категории конкурентов"


def test_layer_topics_stay_out_of_competitors() -> None:
    """Второе правило: то, что измеряется слоем, не дублируется категорией конкурентов (ADR 0013)."""
    for tags in (
        {"highway": "bus_stop"},
        {"amenity": "parking", "parking": "surface"},
        {"building": "apartments"},
        {"landuse": "industrial"},
        {"highway": "footway"},
    ):
        assert match_categories(tags) == (), f"{tags} измеряются слоем, а не категорией конкурентов"
