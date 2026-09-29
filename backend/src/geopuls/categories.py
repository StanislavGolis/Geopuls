"""Категории POI и маппинг OSM-тегов.

Маппинг — это данные, а не код: те же описания используются разведкой покрытия
(Этап 0.5), импортёром POI (Этап 2) и сидированием справочника `categories` в БД (Этап 1).
См. docs/tz.md, раздел 2.2.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Protocol

#: Ключи OSM, по которым мы смотрим адрес объекта.
ADDRESS_STREET = "addr:street"
ADDRESS_HOUSENUMBER = "addr:housenumber"

#: Ключи, по которым ищем POI при разведке покрытия (в порядке приоритета).
EXPLORATION_KEYS: tuple[str, ...] = (
    "amenity",
    "shop",
    "leisure",
    "office",
    "craft",
    "tourism",
    "healthcare",
    "club",
    "sport",
)


@dataclass(frozen=True, slots=True)
class CategoryRule:
    """Условие соответствия: все пары ``key=value`` должны присутствовать в тегах.

    ``value=None`` означает «ключ есть с любым значением».
    """

    pairs: tuple[tuple[str, str | None], ...]

    def matches(self, tags: Mapping[str, str]) -> bool:
        for key, value in self.pairs:
            if key not in tags:
                return False
            if value is not None and tags[key] != value:
                return False
        return True


@dataclass(frozen=True, slots=True)
class Category:
    """Категория MVP: набор альтернативных правил (правила объединяются через «или»)."""

    slug: str
    name_ru: str
    color: str
    rules: tuple[CategoryRule, ...]

    def matches(self, tags: Mapping[str, str]) -> bool:
        return any(rule.matches(tags) for rule in self.rules)

    def as_osm_tags(self) -> list[dict[str, str | None]]:
        """Представление правил для хранения в `categories.osm_tags` (JSONB)."""
        return [{"key": key, "value": value} for rule in self.rules for key, value in rule.pairs]


def rule(*pairs: tuple[str, str | None]) -> CategoryRule:
    """Короткая запись правила: ``rule(("amenity", "cafe"))``."""
    return CategoryRule(pairs=tuple(pairs))


#: Черновой список категорий MVP (утверждается по итогам разведки данных, Этап 0.5).
MVP_CATEGORIES: tuple[Category, ...] = (
    Category(
        slug="cafe",
        name_ru="Кофейни и кафе",
        color="#1f6fb2",
        rules=(rule(("amenity", "cafe")),),
    ),
    Category(
        slug="restaurant",
        name_ru="Рестораны и фастфуд",
        color="#1f6fb2",
        # fast_food добавлен по итогам разведки (Этап 0.5): 171 объект против 87 у restaurant.
        # Значения одного ключа взаимоисключающие, поэтому категория не даёт двойного учёта.
        rules=(rule(("amenity", "restaurant")), rule(("amenity", "fast_food"))),
    ),
    Category(
        slug="bar",
        name_ru="Бары и пабы",
        color="#1f6fb2",
        rules=(rule(("amenity", "bar")), rule(("amenity", "pub"))),
    ),
    Category(
        slug="pharmacy",
        name_ru="Аптеки",
        color="#1f6fb2",
        rules=(rule(("amenity", "pharmacy")),),
    ),
    Category(
        slug="beauty",
        name_ru="Салоны красоты и парикмахерские",
        color="#1f6fb2",
        rules=(rule(("shop", "beauty")), rule(("shop", "hairdresser"))),
    ),
    Category(
        slug="fitness",
        name_ru="Фитнес и спортзалы",
        color="#1f6fb2",
        # По итогам разведки (Этап 0.5): правило leisure=sports_centre + sport=fitness дало 0 объектов
        # в Томске, вместо него добавлен leisure=sports_hall (13). Уличные leisure=fitness_station (63)
        # осознанно не включаются — это не коммерческие объекты.
        rules=(rule(("leisure", "fitness_centre")), rule(("leisure", "sports_hall"))),
    ),
    Category(
        slug="grocery",
        name_ru="Продукты",
        color="#1f6fb2",
        rules=(
            rule(("shop", "supermarket")),
            rule(("shop", "convenience")),
            rule(("shop", "grocery")),
        ),
    ),
    Category(
        slug="pickup_point",
        name_ru="Пункты выдачи заказов",
        color="#1f6fb2",
        rules=(rule(("shop", "outpost")), rule(("amenity", "parcel_locker"))),
    ),
)


class CategoryLike(Protocol):
    """Что импортёру нужно от категории: slug для записи и правило для проверки тегов.

    Протокол, а не базовый класс: категории MVP (`Category`) и варианты слоёв из каталога
    (`geopuls.layers_catalog.LayerCategoryDef`) — разные типы, но импортёр и сид работают с обоими.
    """

    slug: str

    def matches(self, tags: Mapping[str, str]) -> bool: ...


def match_categories(tags: Mapping[str, str], categories: Iterable[CategoryLike] = MVP_CATEGORIES) -> tuple[str, ...]:
    """Вернуть slug'и всех категорий, под которые подходит объект (может быть несколько)."""
    return tuple(category.slug for category in categories if category.matches(tags))


def is_poi_candidate(tags: Mapping[str, str]) -> bool:
    """Есть ли у объекта вообще тег-признак POI (используется для оценки «неразмеченного»)."""
    return any(key in tags for key in EXPLORATION_KEYS)


def has_address(tags: Mapping[str, str]) -> bool:
    """Заполнен ли адрес: нужен и street, и номер дома — это индикатор зрелости данных."""
    return bool(tags.get(ADDRESS_STREET)) and bool(tags.get(ADDRESS_HOUSENUMBER))
