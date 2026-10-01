"""Каталог слоёв карты: теги, метрики и подписи (ADR 0013, Этапы 9–10).

Зачем отдельный модуль, а не константы в сиде: состав слоя нужно знать сразу в трёх местах —
разведке покрытия (`geopuls.recon.layers_scan`), сидированию справочников (`geopuls.seed`) и
агрегатору (какие метрики считать для слоя). Пока список жил в скрипте разведки, «что мерили» и «что
показываем» могли разойтись молча; теперь это один список, и расхождение видно сразу.

Состав и метрики зафиксированы разведкой `docs/recon/2026-09-29-tags-for-layers.md`: все шесть групп
обеспечены данными в Томске, поэтому новый слой — это данные (сид), а не изменения схемы.

Слоя «Конкуренты» здесь нет: он описан в `geopuls.categories` вместе со своими восемью категориями и
существовал до слоёв — смешивать два разных по смыслу источника в одном модуле значит терять ясность.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from geopuls.categories import COMPETITOR_CATEGORIES, Category, CategoryRule, rule


@dataclass(frozen=True, slots=True)
class LayerCategoryDef:
    """Вариант внутри слоя: набор тегов OSM и человеческое название."""

    slug: str
    name_ru: str
    rules: tuple[CategoryRule, ...]

    def matches(self, tags: Mapping[str, str]) -> bool:
        """Подходит ли объект под вариант: правила варианта объединяются через «или»."""
        return any(item.matches(tags) for item in self.rules)

    def as_osm_tags(self) -> list[dict[str, str | None]]:
        """Правила для `categories.osm_tags` (JSONB) — тем же форматом, что у категорий MVP."""
        return [{"key": key, "value": value} for item in self.rules for key, value in item.pairs]


@dataclass(frozen=True, slots=True)
class LayerDef:
    """Слой карты: что в него входит, чем измеряется и как выглядит на карте."""

    slug: str
    name_ru: str
    #: 'density' | 'area_share' | 'length' — смысл значения в `cell_metrics.value`
    metric_kind: str
    unit: str | None
    color: str
    sort_order: int
    categories: tuple[LayerCategoryDef, ...]
    can_be_base: bool = True
    scale: str = "quantile"
    #: Радиус дедупликации в метрах (None — не нужна). Одну остановку в OSM часто рисуют несколькими
    #: объектами (`highway=bus_stop` + `public_transport=platform` + `stop_position`), поэтому без
    #: склейки слой завышает число остановок. Склейка идёт в агрегаторе, а не в импорте: это правило
    #: отображения, и его можно поменять, не переимпортируя выгрузку.
    dedup_radius_m: float | None = None
    #: Теги, значения которых кладём в `extras` как справку (в метрике они не участвуют).
    extra_tags: tuple[str, ...] = ()

    @property
    def primary_category(self) -> LayerCategoryDef | None:
        """Единственный вариант слоя: если вариант один, в запросе его можно не указывать."""
        return self.categories[0] if len(self.categories) == 1 else None


#: Остановки и станции транспорта. 2 065 объектов в разведке, 98% с названием; метрика — плотность
#: (как у слоя конкурентов) плюс число объектов в `extras`.
TRANSPORT_STOPS = LayerDef(
    slug="transport_stops",
    name_ru="Транспорт: остановки и станции",
    metric_kind="density",
    unit="ост/км²",
    color="#0f766e",
    sort_order=20,
    dedup_radius_m=30.0,
    categories=(
        LayerCategoryDef(
            slug="transport_stops",
            name_ru="Остановки и станции",
            rules=(
                rule(("highway", "bus_stop")),
                rule(("public_transport", "platform")),
                rule(("public_transport", "stop_position")),
                rule(("railway", "station")),
                rule(("railway", "halt")),
                rule(("railway", "tram_stop")),
                rule(("railway", "subway_entrance")),
                rule(("amenity", "bus_station")),
                rule(("amenity", "ferry_terminal")),
            ),
        ),
    ),
)

#: Парковки. 2 464 объекта, 82% полигонов; `capacity` заполнен у 8%, поэтому метрика — доля площади
#: ячейки под парковками, а `capacity` остаётся справочным полем в `extras`.
PARKING = LayerDef(
    slug="parking",
    name_ru="Парковки",
    metric_kind="area_share",
    unit="%",
    color="#7c3aed",
    sort_order=30,
    extra_tags=("capacity",),
    categories=(
        LayerCategoryDef(
            slug="parking",
            name_ru="Парковки",
            rules=(
                rule(("amenity", "parking")),
                rule(("amenity", "parking_space")),
                rule(("amenity", "motorcycle_parking")),
                rule(("amenity", "bicycle_parking")),
            ),
        ),
    ),
)

#: Точки притяжения: торговые центры, вузы, больницы, театры, стадионы, вокзалы. 401 объект, 86% с
#: названием. Вокзал попадает и в транспорт, и сюда — в разведке это зафиксировано как осмысленное.
ANCHORS = LayerDef(
    slug="anchors",
    name_ru="Точки притяжения",
    metric_kind="density",
    unit="точек/км²",
    color="#b45309",
    sort_order=40,
    categories=(
        LayerCategoryDef(
            slug="anchors",
            name_ru="Точки притяжения",
            rules=(
                rule(("shop", "mall")),
                rule(("shop", "department_store")),
                rule(("amenity", "marketplace")),
                rule(("amenity", "university")),
                rule(("amenity", "college")),
                rule(("amenity", "hospital")),
                rule(("amenity", "theatre")),
                rule(("amenity", "cinema")),
                rule(("leisure", "sports_centre")),
                rule(("leisure", "stadium")),
                rule(("railway", "station")),
            ),
        ),
    ),
)

#: Жильё: полигоны домов и `landuse=residential`. 16 978 полигонов, 77% с адресом — покрытие лучше,
#: чем у растра GHSL, поэтому метрика — доля площади ячейки под жилой застройкой.
RESIDENTIAL = LayerDef(
    slug="residential",
    name_ru="Жилая застройка",
    metric_kind="area_share",
    unit="%",
    color="#15803d",
    sort_order=50,
    categories=(
        LayerCategoryDef(
            slug="residential",
            name_ru="Жилые дома и зоны",
            rules=(
                rule(("building", "residential")),
                rule(("building", "apartments")),
                rule(("building", "house")),
                rule(("building", "detached")),
                rule(("building", "semidetached_house")),
                rule(("building", "terrace")),
                rule(("building", "dormitory")),
                rule(("landuse", "residential")),
            ),
        ),
    ),
)

#: Рабочие зоны: промзоны, торговля, склады, офисы. 2 766 объектов, но офисов среди них около четырёхсот,
#: поэтому в названии слоя нет слова «офисы» — это «промзоны и торговля» (решение разведки).
WORKPLACES = LayerDef(
    slug="workplaces",
    name_ru="Рабочие зоны (промзоны и торговля)",
    metric_kind="area_share",
    unit="%",
    color="#a21caf",
    sort_order=60,
    categories=(
        LayerCategoryDef(
            slug="workplaces",
            name_ru="Промзоны, торговля, склады, офисы",
            rules=(
                rule(("office", None)),
                rule(("landuse", "commercial")),
                rule(("landuse", "industrial")),
                rule(("landuse", "retail")),
                rule(("building", "commercial")),
                rule(("building", "office")),
                rule(("building", "industrial")),
                rule(("building", "retail")),
                rule(("building", "warehouse")),
            ),
        ),
    ),
)

#: Пешеходные пути: 786 км путей в bbox. Количество объектов здесь обманчиво (это сегменты, а не места),
#: поэтому метрика — километры путей на ячейку.
PEDESTRIAN = LayerDef(
    slug="pedestrian",
    name_ru="Пешеходные зоны и пути",
    metric_kind="length",
    unit="км",
    color="#0369a1",
    sort_order=70,
    categories=(
        LayerCategoryDef(
            slug="pedestrian",
            name_ru="Пешеходные пути и зоны",
            rules=(
                rule(("highway", "pedestrian")),
                rule(("highway", "footway")),
                rule(("highway", "living_street")),
                rule(("place", "square")),
            ),
        ),
    ),
)

#: Слои Этапа 9 в порядке показа в панели (первым — транспорт: по нему данные зрелее всего).
LAYERS: tuple[LayerDef, ...] = (
    TRANSPORT_STOPS,
    PARKING,
    ANCHORS,
    RESIDENTIAL,
    WORKPLACES,
    PEDESTRIAN,
)

LAYERS_BY_SLUG: dict[str, LayerDef] = {layer.slug: layer for layer in LAYERS}

#: Все категории проекта: категории конкурентов (MVP и вторая волна) и по одной на каждый слой Этапа 9.
#: Импортёр и сид ходят сюда, а не в `MVP_CATEGORIES`: иначе новые категории и слои остались бы без данных.
ALL_CATEGORIES: tuple[Category | LayerCategoryDef, ...] = (
    *COMPETITOR_CATEGORIES,
    *(category for layer in LAYERS for category in layer.categories),
)

#: Метрики, которые считаются по геометрии объектов внутри ячейки (нужна площадь или длина, а не точка).
SPATIAL_METRICS: frozenset[str] = frozenset({"area_share", "length"})
