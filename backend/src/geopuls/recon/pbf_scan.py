"""Разведка покрытия OSM: сколько объектов даёт маппинг категорий в заданном bbox.

Этап 0.5 (см. docs/tz.md, раздел 11): до фиксации списка категорий MVP нужно понять,
что реально размечено в OSM по выбранным тегам. Скрипт читает PBF-выгрузку Geofabrik,
считает объекты по категориям, собирает частоты значений ключей POI (кандидаты на новые
категории) и индикаторы зрелости данных (наличие названия, адреса, бренда).

Запуск:
    uv run python -m geopuls.recon.pbf_scan \\
        --pbf data/raw/siberian-fed-district-260927.osm.pbf \\
        --name tomsk --bbox 56.30,84.70,56.65,85.30 \\
        --center 56.4847,84.9482 --center-radius-km 10 \\
        --out-json data/processed/tomsk-coverage.json \\
        --out-md docs/recon/tomsk-coverage.md
"""

from __future__ import annotations

import argparse
import json
import math
import time
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Self

import osmium

from geopuls.categories import COMPETITOR_CATEGORIES, EXPLORATION_KEYS, has_address, is_poi_candidate, match_categories
from geopuls.console import enable_utf8_console
from geopuls.osmfile import read_osm_timestamp

EARTH_RADIUS_KM = 6371.0088

#: Категория считается «тонкой», если объектов меньше этого порога — сигнал для решения по списку MVP.
THIN_CATEGORY_THRESHOLD = 30

#: Сколько значений ключа показывать в отчёте.
TOP_VALUES = 20


@dataclass(frozen=True, slots=True)
class BBox:
    """Прямоугольник в градусах: `min_lat,min_lon,max_lat,max_lon`."""

    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float

    def contains(self, lat: float, lon: float) -> bool:
        return self.min_lat <= lat <= self.max_lat and self.min_lon <= lon <= self.max_lon

    @classmethod
    def parse(cls, text: str) -> Self:
        parts = [float(value) for value in text.split(",")]
        if len(parts) != 4:
            raise ValueError("bbox задаётся как min_lat,min_lon,max_lat,max_lon")
        return cls(min_lat=parts[0], min_lon=parts[1], max_lat=parts[2], max_lon=parts[3])

    def as_list(self) -> list[float]:
        return [self.min_lat, self.min_lon, self.max_lat, self.max_lon]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Расстояние по большому кругу, км."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


@dataclass(slots=True)
class CategoryStats:
    """Счётчики по одной категории внутри bbox."""

    total: int = 0
    nodes: int = 0
    ways: int = 0
    named: int = 0
    with_address: int = 0
    with_brand: int = 0
    in_core: int = 0

    @property
    def named_share(self) -> float:
        return self.named / self.total if self.total else 0.0

    @property
    def address_share(self) -> float:
        return self.with_address / self.total if self.total else 0.0


class CoverageScanner(osmium.SimpleHandler):
    """Обходит PBF и считает покрытие категорий внутри bbox.

    Важно: при запуске нужен ``apply_file(..., locations=True)`` — иначе у ways нет координат
    узлов и полигональные POI (магазин в здании) не попадут в отчёт.

    Имена методов ``node``/``way``/``relation`` заданы pyosmium — это часть его API,
    поэтому правила pep8-naming в проекте не включены.
    """

    def __init__(self, bbox: BBox, center: tuple[float, float], radius_km: float) -> None:
        super().__init__()
        self.bbox = bbox
        self.center = center
        self.radius_km = radius_km
        self.stats: dict[str, CategoryStats] = {c.slug: CategoryStats() for c in COMPETITOR_CATEGORIES}
        self.key_values: dict[str, Counter[str]] = {key: Counter() for key in EXPLORATION_KEYS}
        self.objects_with_poi_keys = 0
        self.objects_matched = 0
        self.multi_category_objects = 0
        self.tagged_relations = 0

    def node(self, n: osmium.osm.Node) -> None:
        if not n.location.valid():
            return
        self._handle("node", {tag.k: tag.v for tag in n.tags}, n.location.lat, n.location.lon)

    def way(self, w: osmium.osm.Way) -> None:
        tags = {tag.k: tag.v for tag in w.tags}
        if not tags:
            return
        coords = [(node.location.lat, node.location.lon) for node in w.nodes if node.location.valid()]
        if not coords:
            return
        # Приблизительный центроид: для разведки покрытия точности достаточно
        lat = sum(coord[0] for coord in coords) / len(coords)
        lon = sum(coord[1] for coord in coords) / len(coords)
        self._handle("way", tags, lat, lon)

    def relation(self, r: osmium.osm.Relation) -> None:
        """Геометрия relations не нужна: считаем только факт тегированного POI-отношения.

        Полигональные POI-отношения (например, ТЦ с магазинами) в отчёт по bbox не попадают —
        это осознанное ограничение разведки, зафиксированное в отчёте.
        """
        if any(tag.k in EXPLORATION_KEYS for tag in r.tags):
            self.tagged_relations += 1

    def _handle(self, osm_type: str, tags: dict[str, str], lat: float, lon: float) -> None:
        if not self.bbox.contains(lat, lon):
            return
        if not is_poi_candidate(tags):
            return

        self.objects_with_poi_keys += 1
        for key in EXPLORATION_KEYS:
            if key in tags:
                self.key_values[key][tags[key]] += 1

        matched = match_categories(tags)
        if not matched:
            return

        self.objects_matched += 1
        if len(matched) > 1:
            self.multi_category_objects += 1

        in_core = haversine_km(lat, lon, self.center[0], self.center[1]) <= self.radius_km
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
            if tags.get("brand"):
                stats.with_brand += 1
            if in_core:
                stats.in_core += 1


@dataclass(slots=True)
class CoverageReport:
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
    objects_with_poi_keys: int
    objects_matched: int
    multi_category_objects: int
    tagged_relations: int
    categories: dict[str, dict[str, Any]]
    key_values: dict[str, dict[str, int]]

    @property
    def unmapped_share(self) -> float:
        if not self.objects_with_poi_keys:
            return 0.0
        return (self.objects_with_poi_keys - self.objects_matched) / self.objects_with_poi_keys

    def to_json(self) -> str:
        payload = asdict(self)
        payload["unmapped_share"] = round(self.unmapped_share, 4)
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def to_markdown(self) -> str:
        lines: list[str] = [
            f"# Покрытие OSM: {self.city}",
            "",
            "Отчёт сгенерирован скриптом `python -m geopuls.recon.pbf_scan` (Этап 0.5, см. `docs/tz.md`). "
            "Не редактируйте вручную — изменения потеряются при повторном запуске.",
            "",
            "| Параметр | Значение |",
            "|---|---|",
            f"| Файл выгрузки | `{Path(self.pbf_path).name}` ({self.pbf_size_mb} МБ) |",
            f"| Дата файла | {self.pbf_mtime} |",
            f"| Дата данных OSM | {self.osm_timestamp or 'в заголовке PBF не указана'} |",
            f"| BBox (min_lat, min_lon, max_lat, max_lon) | {', '.join(str(v) for v in self.bbox)} |",
            f"| Центр и радиус «ядра» | {self.center[0]}, {self.center[1]} — {self.center_radius_km} км |",
            f"| Время сканирования | {self.scan_seconds:.1f} с |",
            f"| Объектов с POI-тегами в bbox | {self.objects_with_poi_keys} |",
            f"| Из них в категориях MVP | {self.objects_matched} "
            f"(не попали в категории: {self.unmapped_share * 100:.1f}%) |",
            f"| Объектов сразу в нескольких категориях | {self.multi_category_objects} |",
            f"| POI-отношений (relations) по всему региону | {self.tagged_relations} |",
            "",
            "## Категории MVP",
            "",
            "| Категория | Всего | nodes | ways | С названием | С адресом | С брендом | В ядре | Оценка |",
            "|---|---|---|---|---|---|---|---|---|",
        ]

        for slug, stats in self.categories.items():
            total = int(stats["total"])
            verdict = "ok" if total >= THIN_CATEGORY_THRESHOLD else "мало данных"
            lines.append(
                f"| `{slug}` | {total} | {stats['nodes']} | {stats['ways']} | "
                f"{stats['named_share'] * 100:.0f}% | {stats['address_share'] * 100:.0f}% | "
                f"{stats['with_brand']} | {stats['in_core']} | {verdict} |"
            )

        lines += [
            "",
            f"Порог «мало данных» — менее {THIN_CATEGORY_THRESHOLD} объектов на категорию в bbox.",
            "",
            "## Частоты значений по ключам POI (кандидаты на новые категории, проверка маппинга)",
            "",
        ]

        for key, values in self.key_values.items():
            if not values:
                continue
            lines += [f"### `{key}`", "", "| Значение | Объектов |", "|---|---|"]
            for value, count in values.items():
                lines.append(f"| `{value}` | {count} |")
            lines.append("")

        lines += [
            "## Ограничения отчёта",
            "",
            "- Учитываются только объекты с тегами POI; объекты без таких тегов в знаменатель не попадают.",
            "- Полигональные POI-отношения (relations) в подсчёт по bbox не включены — только их общее "
            "число по региону.",
            "- Центроиды ways вычислены как среднее координат узлов: для оценки покрытия этого достаточно, "
            "в импортёре (Этап 2) будет использоваться `ST_PointOnSurface`.",
            "- Разведка отвечает на вопрос «сколько размечено в OSM», а не «сколько организаций есть в городе».",
            "",
        ]
        return "\n".join(lines)


def build_report(
    *,
    city: str,
    pbf: Path,
    bbox: BBox,
    center: tuple[float, float],
    radius_km: float,
    scanner: CoverageScanner,
    scan_seconds: float,
    top_values: int = TOP_VALUES,
) -> CoverageReport:
    """Собрать отчёт из результатов сканирования."""
    stat = pbf.stat()
    categories: dict[str, dict[str, Any]] = {}
    for slug, category_stats in scanner.stats.items():
        payload: dict[str, Any] = {
            field_name: getattr(category_stats, field_name)
            for field_name in ("total", "nodes", "ways", "named", "with_address", "with_brand", "in_core")
        }
        payload["named_share"] = round(category_stats.named_share, 4)
        payload["address_share"] = round(category_stats.address_share, 4)
        categories[slug] = payload

    key_values = {key: dict(counter.most_common(top_values)) for key, counter in scanner.key_values.items() if counter}

    return CoverageReport(
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
        objects_with_poi_keys=scanner.objects_with_poi_keys,
        objects_matched=scanner.objects_matched,
        multi_category_objects=scanner.multi_category_objects,
        tagged_relations=scanner.tagged_relations,
        categories=categories,
        key_values=key_values,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Разведка покрытия OSM по категориям MVP (Этап 0.5, см. docs/tz.md)")
    parser.add_argument("--pbf", required=True, type=Path, help="путь к файлу .osm.pbf")
    parser.add_argument("--city", required=True, help="название города/территории для отчёта")
    parser.add_argument("--bbox", required=True, help="min_lat,min_lon,max_lat,max_lon")
    parser.add_argument("--center", required=True, help="lat,lon центра города")
    parser.add_argument("--center-radius-km", type=float, default=10.0, dest="radius_km")
    parser.add_argument("--out-json", type=Path, default=None, help="куда сохранить JSON")
    parser.add_argument("--out-md", type=Path, default=None, help="куда сохранить markdown-отчёт")
    parser.add_argument("--top-values", type=int, default=TOP_VALUES, help="сколько значений ключа показывать")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    enable_utf8_console()
    args = parse_args(argv)
    if not args.pbf.exists():
        print(f"Файл не найден: {args.pbf}. См. tools/fetch-osm-extract.ps1 и data/README.md")
        return 2

    bbox = BBox.parse(args.bbox)
    center_values = [float(value) for value in args.center.split(",")]
    if len(center_values) != 2:
        raise SystemExit("--center задаётся как lat,lon")
    center = (center_values[0], center_values[1])

    scanner = CoverageScanner(bbox, center, args.radius_km)
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
        top_values=args.top_values,
    )

    if args.out_json:
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        args.out_json.write_text(report.to_json(), encoding="utf-8")
        print(f"JSON: {args.out_json}")
    if args.out_md:
        args.out_md.parent.mkdir(parents=True, exist_ok=True)
        args.out_md.write_text(report.to_markdown(), encoding="utf-8")
        print(f"Markdown: {args.out_md}")

    print(f"Сканирование: {scan_seconds:.1f} с; объектов с POI-тегами в bbox: {report.objects_with_poi_keys}")
    for slug, stats in report.categories.items():
        print(f"  {slug:<14} всего {stats['total']:>6}  в ядре {stats['in_core']:>6}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
