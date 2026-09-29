"""Разведка покрытия OSM для слоёв карты (Этапы 9–10, обоснование — ADR 0013).

Что измеряем: сколько объектов даёт каждый будущий слой — транспорт, парковки, жильё, работа,
точки притяжения, пешеходные зоны — в заданном bbox, и насколько эти данные пригодны: доля названий
и адресов, площадь полигонов (жильё, промзоны, парковки), заполненность `capacity` у парковок и
`building:levels` у зданий, суммарная длина пешеходных путей.

Запуск:
    uv run python -m geopuls.recon.layers_scan \\
        --pbf data/raw/siberian-fed-district-260927.osm.pbf \\
        --city tomsk --bbox 56.30,84.70,56.65,85.30 \\
        --center 56.4847,84.9482 --center-radius-km 10 \\
        --out-json data/processed/tomsk-layer-tags.json \\
        --out-md docs/recon/tomsk-layer-tags.md

Почему отдельный модуль, а не расширение `pbf_scan`: у слоёв другая логика отбора (это не POI-теги,
а землепользование, здания и транспорт), другие метрики (площадь и длина, а не количество) и свой
отчёт. Общие части (`BBox`, расстояние по большому кругу) переиспользуются из `pbf_scan`.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import osmium

from geopuls.categories import CategoryRule, has_address, rule
from geopuls.console import enable_utf8_console
from geopuls.osmfile import read_osm_timestamp
from geopuls.recon.pbf_scan import EARTH_RADIUS_KM, BBox, haversine_km


@dataclass(frozen=True, slots=True)
class LayerGroup:
    """Группа тегов, соответствующая будущему слою карты (ADR 0013, реестр слоёв)."""

    slug: str
    name_ru: str
    #: Что измеряем как «объём» группы: количество объектов, площадь полигонов или длину линий.
    measure: str
    #: Альтернативные правила группы (объединяются через «или»).
    rules: tuple[CategoryRule, ...]


GROUPS: tuple[LayerGroup, ...] = (
    LayerGroup(
        "transport_stops",
        "Остановки и станции транспорта",
        "count",
        (
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
    LayerGroup(
        "parking",
        "Парковки",
        "area",
        (
            rule(("amenity", "parking")),
            rule(("amenity", "parking_space")),
            rule(("amenity", "motorcycle_parking")),
            rule(("amenity", "bicycle_parking")),
        ),
    ),
    LayerGroup(
        "residential",
        "Жилые зоны (дома и landuse)",
        "area",
        (
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
    LayerGroup(
        "workplaces",
        "Рабочие зоны (офисы, промзоны, торговля)",
        "area",
        (
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
    LayerGroup(
        "anchors",
        "Точки притяжения (ТЦ, вузы, больницы, вокзалы, рынки)",
        "count",
        (
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
            # Вокзал одновременно точка транспорта и точка притяжения: в отчёте он попадёт в обе
            # группы, и это видно в таблице пересечений
            rule(("railway", "station")),
        ),
    ),
    LayerGroup(
        "pedestrian",
        "Пешеходные зоны и пути",
        "length",
        (
            rule(("highway", "pedestrian")),
            rule(("highway", "footway")),
            rule(("highway", "living_street")),
            rule(("place", "square")),
        ),
    ),
)

GROUPS_BY_SLUG: dict[str, LayerGroup] = {group.slug: group for group in GROUPS}


def match_groups(tags: Mapping[str, str]) -> tuple[str, ...]:
    """Slug'и групп, под которые подходит объект (может быть несколько)."""
    return tuple(group.slug for group in GROUPS if any(item.matches(tags) for item in group.rules))


def polygon_area_km2(coords: Sequence[tuple[float, float]]) -> float:
    """Площадь сферического многоугольника в км² (формула Chamberlain и Duquette).

    ``coords`` — вершины ``(lat, lon)``; кольцо может быть замкнутым. Формула сферическая, поэтому на
    площадях до нескольких км² совпадает с расчётом h3 (проверяется тестом на ячейке res 9).
    """
    ring = list(coords)
    if len(ring) > 1 and ring[0] == ring[-1]:
        ring = ring[:-1]
    if len(ring) < 3:
        return 0.0

    total = 0.0
    for index, (lat1, lon1) in enumerate(ring):
        lat2, lon2 = ring[(index + 1) % len(ring)]
        total += math.radians(lon2 - lon1) * (2 + math.sin(math.radians(lat1)) + math.sin(math.radians(lat2)))
    return abs(total) * EARTH_RADIUS_KM**2 / 2


def path_length_km(coords: Sequence[tuple[float, float]]) -> float:
    """Длина линии по вершинам ``(lat, lon)`` в км."""
    return sum(
        haversine_km(coords[index][0], coords[index][1], coords[index + 1][0], coords[index + 1][1])
        for index in range(len(coords) - 1)
    )


@dataclass(slots=True)
class GroupStats:
    """Счётчики по одной группе тегов внутри bbox."""

    total: int = 0
    nodes: int = 0
    ways: int = 0
    relations: int = 0
    named: int = 0
    with_address: int = 0
    in_core: int = 0
    polygons: int = 0
    area_km2: float = 0.0
    length_km: float = 0.0
    with_capacity: int = 0
    with_levels: int = 0

    @property
    def named_share(self) -> float:
        return self.named / self.total if self.total else 0.0

    @property
    def address_share(self) -> float:
        return self.with_address / self.total if self.total else 0.0

    @property
    def levels_share(self) -> float:
        """Доля полигонов с этажностью — от них зависит оценка «сколько людей в доме»."""
        return self.with_levels / self.polygons if self.polygons else 0.0

    @property
    def capacity_share(self) -> float:
        return self.with_capacity / self.total if self.total else 0.0


@dataclass(slots=True)
class LayersReport:
    """Результат разведки: данные для JSON и markdown-отчёта."""

    city: str
    generated_at: str
    pbf_path: str
    pbf_size_mb: float
    pbf_mtime: str
    osm_timestamp: str | None
    bbox: list[float]
    center: list[float]
    center_radius_km: float
    scan_seconds: float
    objects_in_groups: int
    multi_group_objects: int
    overlaps: dict[str, int] = field(default_factory=dict)
    groups: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)

    def to_markdown(self) -> str:
        lines: list[str] = [
            f"# Покрытие OSM по слоям: {self.city}",
            "",
            "Отчёт сгенерирован скриптом `python -m geopuls.recon.layers_scan` (Этапы 9–10, обоснование —",
            "`docs/decisions/0013-map-layers.md`). Не редактируйте вручную: изменения потеряются при",
            "повторном запуске.",
            "",
            "| Параметр | Значение |",
            "|---|---|",
            f"| Файл выгрузки | `{Path(self.pbf_path).name}` ({self.pbf_size_mb} МБ) |",
            f"| Дата файла | {self.pbf_mtime} |",
            f"| Дата данных OSM | {self.osm_timestamp or 'не указана'} |",
            f"| BBox (min_lat, min_lon, max_lat, max_lon) | {', '.join(str(value) for value in self.bbox)} |",
            f"| Центр и радиус «ядра» | {self.center[0]}, {self.center[1]} — {self.center_radius_km} км |",
            f"| Время сканирования | {self.scan_seconds:.1f} с |",
            f"| Объектов в группах слоёв | {self.objects_in_groups} |",
            f"| Объектов сразу в нескольких группах | {self.multi_group_objects} |",
            "",
            "## Группы тегов",
            "",
            "| Группа | Всего | nodes | ways | relations | полигонов | площадь, км² | длина, км "
            "| с названием | с адресом | capacity | этажность | в ядре |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
        ]

        for group in GROUPS:
            stats = self.groups.get(group.slug)
            if not stats:
                continue
            lines.append(
                f"| `{group.slug}` | {stats['total']} | {stats['nodes']} | {stats['ways']} "
                f"| {stats['relations']} | {stats['polygons']} | {stats['area_km2']:.2f} "
                f"| {stats['length_km']:.1f} | {_percent(stats['named_share'])} "
                f"| {_percent(stats['address_share'])} | {_percent(stats['capacity_share'])} "
                f"| {_percent(stats['levels_share'])} | {stats['in_core']} |"
            )

        if self.overlaps:
            lines += ["", "## Пересечения групп (объект попал в несколько)", "", "| Группы | Объектов |", "|---|---|"]
            lines += [f"| {name} | {count} |" for name, count in list(self.overlaps.items())[:10]]

        lines += [
            "",
            "## Ограничения метода",
            "",
            "- Отбор идёт по **bbox**, а не по полигону города: пригороды и дачи попадают в числа, поэтому",
            "  для решений используется колонка «в ядре» (радиус вокруг центра города).",
            "- Площадь считаются только для **замкнутых** way (кольцо): у relations геометрия не строится,",
            "  поэтому мультиполигоны (редкое землепользование) в площадь не входят.",
            "- Центр way — среднее вершин, а не центр масс: для отбора по bbox этого достаточно, но",
            "  отдельные вытянутые объекты на границе могут считаться неточно.",
            "- Теги `building:levels` и `capacity` в OSM заполняются неравномерно; доли в таблице — это",
            "  оценка сверху того, насколько подробные данные доступны.",
        ]
        return "\n".join(lines) + "\n"


def _percent(share: float) -> str:
    return f"{round(share * 100)}%"


def build_report(
    *,
    city: str,
    pbf: Path,
    bbox: BBox,
    center: tuple[float, float],
    radius_km: float,
    scanner: LayersScanner,
    scan_seconds: float,
) -> LayersReport:
    """Собрать отчёт из результатов сканирования."""
    stat = pbf.stat()
    groups: dict[str, dict[str, Any]] = {}
    for slug, stats in scanner.stats.items():
        group = GROUPS_BY_SLUG[slug]
        payload: dict[str, Any] = {
            field_name: getattr(stats, field_name)
            for field_name in (
                "total",
                "nodes",
                "ways",
                "relations",
                "named",
                "with_address",
                "in_core",
                "polygons",
                "with_capacity",
                "with_levels",
            )
        }
        payload["name_ru"] = group.name_ru
        payload["measure"] = group.measure
        payload["area_km2"] = round(stats.area_km2, 3)
        payload["length_km"] = round(stats.length_km, 1)
        payload["named_share"] = round(stats.named_share, 4)
        payload["address_share"] = round(stats.address_share, 4)
        payload["levels_share"] = round(stats.levels_share, 4)
        payload["capacity_share"] = round(stats.capacity_share, 4)
        groups[slug] = payload

    return LayersReport(
        city=city,
        generated_at=datetime.now(UTC).isoformat(timespec="seconds"),
        pbf_path=str(pbf),
        pbf_size_mb=round(stat.st_size / 1024 / 1024, 1),
        pbf_mtime=datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(timespec="seconds"),
        osm_timestamp=read_osm_timestamp(pbf),
        bbox=bbox.as_list(),
        center=[center[0], center[1]],
        center_radius_km=radius_km,
        scan_seconds=round(scan_seconds, 1),
        objects_in_groups=scanner.objects_in_groups,
        multi_group_objects=scanner.multi_group_objects,
        overlaps=dict(scanner.overlaps.most_common(10)),
        groups=groups,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Разведка покрытия OSM по слоям карты (Этапы 9–10, см. docs/decisions/0013-map-layers.md)"
    )
    parser.add_argument("--pbf", required=True, type=Path, help="путь к файлу .osm.pbf")
    parser.add_argument("--city", required=True, help="название города/территории для отчёта")
    parser.add_argument("--bbox", required=True, help="min_lat,min_lon,max_lat,max_lon")
    parser.add_argument("--center", required=True, help="lat,lon центра города")
    parser.add_argument("--center-radius-km", type=float, default=10.0, dest="radius_km")
    parser.add_argument("--out-json", type=Path, default=None, help="куда сохранить JSON")
    parser.add_argument("--out-md", type=Path, default=None, help="куда сохранить markdown-отчёт")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    enable_utf8_console()
    args = parse_args(argv)
    if not args.pbf.exists():
        print(f"Файл не найден: {args.pbf}. См. tools/fetch-osm-extract.ps1 и data/README.md")
        return 2

    bbox = BBox.parse(args.bbox)
    center_parts = [float(value) for value in args.center.split(",")]
    if len(center_parts) != 2:
        raise SystemExit("--center задаётся как lat,lon")
    center = (center_parts[0], center_parts[1])

    scanner = LayersScanner(bbox, center, args.radius_km)
    started = time.perf_counter()
    scanner.apply_file(str(args.pbf), locations=True)
    scan_seconds = time.perf_counter() - started

    report = build_report(
        city=args.city,
        pbf=args.pbf,
        bbox=bbox,
        center=center,
        radius_km=args.radius_km,
        scanner=scanner,
        scan_seconds=scan_seconds,
    )

    if args.out_json:
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        args.out_json.write_text(report.to_json(), encoding="utf-8")
        print(f"JSON: {args.out_json}")
    if args.out_md:
        args.out_md.parent.mkdir(parents=True, exist_ok=True)
        args.out_md.write_text(report.to_markdown(), encoding="utf-8")
        print(f"Markdown: {args.out_md}")

    print(f"Сканирование: {scan_seconds:.1f} с; объектов в группах слоёв: {report.objects_in_groups}")
    for group in GROUPS:
        stats = report.groups[group.slug]
        print(
            f"  {group.slug:<16} всего {stats['total']:>6}  "
            f"полигонов {stats['polygons']:>6}  площадь {stats['area_km2']:>8.2f} км²  "
            f"длина {stats['length_km']:>8.1f} км  в ядре {stats['in_core']:>6}"
        )
    return 0


class LayersScanner(osmium.SimpleHandler):
    """Обходит PBF и считает объекты по группам слоёв внутри bbox.

    Нужен запуск с ``locations=True``: без координат узлов у ways не будет геометрии, а площадь
    полигонов (жильё, промзоны, парковки) — главная метрика этих групп.

    Имена методов ``node``/``way``/``relation`` заданы pyosmium, поэтому pep8-naming в проекте
    отключён (см. конфигурацию ruff).
    """

    def __init__(self, bbox: BBox, center: tuple[float, float], radius_km: float) -> None:
        super().__init__()
        self.bbox = bbox
        self.center = center
        self.radius_km = radius_km
        self.stats: dict[str, GroupStats] = {group.slug: GroupStats() for group in GROUPS}
        self.objects_in_groups = 0
        self.multi_group_objects = 0
        self.overlaps: Counter[str] = Counter()

    def node(self, n: osmium.osm.Node) -> None:
        if not n.location.valid():
            return
        self._handle("node", {tag.k: tag.v for tag in n.tags}, n.location.lat, n.location.lon)

    def way(self, w: osmium.osm.Way) -> None:
        tags = {tag.k: tag.v for tag in w.tags}
        if not tags:
            return
        # Точки (lat, lon) в порядке обхода: нужны и площадь кольца, и длина линии
        coords = [(node.location.lat, node.location.lon) for node in w.nodes if node.location.valid()]
        if not coords:
            return

        closed = len(coords) >= 4 and coords[0] == coords[-1]
        lat = sum(point[0] for point in coords) / len(coords)
        lon = sum(point[1] for point in coords) / len(coords)
        self._handle("way", tags, lat, lon, coords=coords, closed=closed)

    def relation(self, r: osmium.osm.Relation) -> None:
        """У relations геометрия не считается — считаем только факт и пишем это в ограничения.

        Полигональные отношения (землепользование, размеченное мультиполигоном) в площадь не попадают.
        Для оценки покрытия слоёв этим можно пренебречь, но в отчёте ограничение указано явно.
        """
        matched = match_groups({tag.k: tag.v for tag in r.tags})
        for slug in matched:
            self.stats[slug].relations += 1

    def _handle(
        self,
        osm_type: str,
        tags: Mapping[str, str],
        lat: float,
        lon: float,
        *,
        coords: Sequence[tuple[float, float]] | None = None,
        closed: bool = False,
    ) -> None:
        if not self.bbox.contains(lat, lon):
            return
        matched = match_groups(tags)
        if not matched:
            return

        self.objects_in_groups += 1
        if len(matched) > 1:
            self.multi_group_objects += 1
            self.overlaps["+".join(sorted(matched))] += 1

        in_core = haversine_km(lat, lon, self.center[0], self.center[1]) <= self.radius_km
        area = polygon_area_km2(coords) if closed and coords else 0.0
        length = path_length_km(coords) if coords and not closed else 0.0
        has_levels = "building:levels" in tags
        has_capacity = "capacity" in tags

        for slug in matched:
            stats = self.stats[slug]
            stats.total += 1
            if osm_type == "node":
                stats.nodes += 1
            elif osm_type == "way":
                stats.ways += 1
            if tags.get("name"):
                stats.named += 1
            if has_address(tags):
                stats.with_address += 1
            if in_core:
                stats.in_core += 1
            if closed:
                stats.polygons += 1
            stats.area_km2 += area
            stats.length_km += length
            if has_capacity:
                stats.with_capacity += 1
            if has_levels:
                stats.with_levels += 1


if __name__ == "__main__":
    raise SystemExit(main())
