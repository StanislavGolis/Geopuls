"""Тесты каталога слоёв: состав, метрики и совпадение с разведкой (Этап 9).

Главное, что здесь проверяется: «что мерили» и «что показываем» не могут разойтись молча. Разведка
(`geopuls.recon.layers_scan`) и рабочий каталог (`geopuls.layers_catalog`) держат теги в двух местах,
поэтому их совпадение — предмет теста, а не надежды.
"""

from __future__ import annotations

from geopuls.categories import COMPETITOR_CATEGORIES
from geopuls.layers_catalog import LAYERS, LAYERS_BY_SLUG, SPATIAL_METRICS
from geopuls.models.layers import METRIC_KINDS
from geopuls.recon.layers_scan import GROUPS_BY_SLUG
from geopuls.seed import build_category_rows, build_layer_rows, category_slugs_by_layer


def test_catalog_matches_recon_groups() -> None:
    """Теги слоя в каталоге обязаны совпадать с теми, что мерила разведка."""
    assert set(GROUPS_BY_SLUG) == set(LAYERS_BY_SLUG)

    for slug, layer in LAYERS_BY_SLUG.items():
        scan_rules = {(key, value) for item in GROUPS_BY_SLUG[slug].rules for key, value in item.pairs}
        catalog_rules = {
            (key, value) for category in layer.categories for item in category.rules for key, value in item.pairs
        }
        assert catalog_rules == scan_rules, f"правила слоя {slug} разошлись с разведкой"


def test_every_layer_declares_metric_unit_and_color() -> None:
    """Слой без единицы измерения или цвета нельзя ни подписать в легенде, ни нарисовать."""
    for layer in LAYERS:
        assert layer.metric_kind in METRIC_KINDS
        assert layer.unit, layer.slug
        assert layer.color.startswith("#"), layer.slug
        assert layer.categories, f"слой {layer.slug} нечем наполнить: маппинг тегов живёт в категории"


def test_layers_use_only_implemented_metrics() -> None:
    """Метрики площади и длины — новые механики: их список зафиксирован, чтобы не появились молча."""
    assert {layer.metric_kind for layer in LAYERS} == {"density", "area_share", "length"}
    assert {"area_share", "length"} == SPATIAL_METRICS


def test_only_transport_layer_deduplicates_stops() -> None:
    """Склейка остановок — свойство конкретного слоя, а не общая настройка агрегатора."""
    transport = LAYERS_BY_SLUG["transport_stops"]

    assert transport.dedup_radius_m == 30.0
    assert [layer.slug for layer in LAYERS if layer.dedup_radius_m] == ["transport_stops"]


def test_single_category_layer_needs_no_category_in_request() -> None:
    """У слоя с одним вариантом уточнять нечего: клиент не обязан знать slug категории."""
    for layer in LAYERS:
        assert layer.primary_category is not None, layer.slug
        assert layer.primary_category.slug == layer.slug


def test_layer_rows_and_categories_cover_catalog() -> None:
    layer_rows = build_layer_rows({"osm": 1})

    assert {row["slug"] for row in layer_rows} == {"competitors", *LAYERS_BY_SLUG}
    assert all(row["dataset_id"] == 1 for row in layer_rows)
    assert all(row["metric_kind"] in METRIC_KINDS for row in layer_rows)
    assert len({row["sort_order"] for row in layer_rows}) == len(layer_rows)

    mapping = category_slugs_by_layer()
    assert mapping["competitors"] == [category.slug for category in COMPETITOR_CATEGORIES]
    assert set(mapping) == {row["slug"] for row in layer_rows}
    assert {slug for slugs in mapping.values() for slug in slugs} == {row["slug"] for row in build_category_rows()}
