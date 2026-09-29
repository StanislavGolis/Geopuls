"""Импорт POI из выгрузки OSM (PBF).

Два этапа, которые можно запускать отдельно:

1. **Сканирование PBF** → файл-кандидатов (JSON Lines). Объекты отбираются по объединению
   bbox всех активных городов, поэтому один проход обслуживает все города и добавление
   следующего города не увеличивает время импорта на порядок.
2. **Запись в БД**: батчевый upsert в `pois` и `poi_categories`, мягкое удаление исчезнувших
   объектов, фиксация `import_runs` и новой `data_versions`.

Файл-кандидатов играет роль «вырезки» из ТЗ (раздел 11): повторные импорты и пересборка
сетки читают его за секунды вместо 28-минутного прохода по региональному PBF.

Запуск:
    uv run python -m geopuls.importers.poi --pbf data/raw/siberian-fed-district-260927.osm.pbf
    uv run python -m geopuls.importers.poi --pbf ... --dry-run          # только сканирование и отчёт
    uv run python -m geopuls.importers.poi --from-dump data/processed/poi-candidates-....jsonl
    uv run python -m geopuls.importers.poi --pbf ... --limit 2000       # быстрая проверка

Ограничения текущей версии (зафиксированы в ТЗ, раздел 11):
- POI-отношения (relations) не импортируются — их единицы, обработка после MVP;
- дубликаты (одинаковое название в пределах ~30 м) не помечаются флагом — отдельная задача.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections import Counter
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from itertools import batched
from pathlib import Path
from typing import Any

import h3
import osmium
from sqlalchemy import bindparam, func, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from geopuls.categories import (
    ADDRESS_HOUSENUMBER,
    ADDRESS_STREET,
    has_address,
    match_categories,
)
from geopuls.config import get_settings
from geopuls.console import enable_utf8_console
from geopuls.db import create_engine, session_scope
from geopuls.layers_catalog import ALL_CATEGORIES
from geopuls.models import Poi, PoiCategory
from geopuls.osmfile import read_osm_timestamp

#: Разрешения H3, которые считаются при импорте (детальный и обзорный слои карты).
H3_RESOLUTIONS = (9, 8)
#: Размер батча записи в БД.
DEFAULT_BATCH_SIZE = 5000
#: Имя файла-кандидатов по умолчанию (рядом с PBF, без расширения).
DUMP_SUFFIX = ".poi-candidates.jsonl"
#: Первая строка файла-кандидатов — метаданные выгрузки (дата данных OSM и источник).
META_LINE_PREFIX = '{"_meta":'


class ImportError_(RuntimeError):
    """Ошибка импорта: нечего импортировать или источник недоступен."""


class ScanLimitReached(Exception):
    """Внутренний сигнал: достигнут лимит объектов (--limit)."""


@dataclass(frozen=True, slots=True)
class CityScope:
    """Bbox города для отбора объектов из выгрузки."""

    id: int
    slug: str
    name: str
    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float

    def contains(self, lat: float, lon: float) -> bool:
        return self.min_lat <= lat <= self.max_lat and self.min_lon <= lon <= self.max_lon


@dataclass(slots=True)
class PoiRecord:
    """Кандидат на запись в `pois`: одна строка файла-кандидатов."""

    osm_type: str
    osm_id: int
    name: str | None
    brand: str | None
    addr_street: str | None
    addr_housenumber: str | None
    lon: float
    lat: float
    h3_r9: int
    h3_r8: int
    tags: dict[str, str]
    category_slugs: tuple[str, ...]
    #: Геометрия way в WKT (линия или полигон) для метрик площади и длины (Этап 9). У node — None.
    geometry_wkt: str | None = None

    def as_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, line: str) -> PoiRecord:
        payload = json.loads(line)
        payload["category_slugs"] = tuple(payload["category_slugs"])
        # Дампы, снятые до Этапа 9, поля не содержат: читаем их без геометрии, а не падаем
        payload.setdefault("geometry_wkt", None)
        return cls(**payload)

    def as_row(self, *, source: str) -> dict[str, Any]:
        """Строка для вставки в `pois` (координаты и геометрия передаются как WKT для PostGIS)."""
        return {
            "osm_type": self.osm_type,
            "osm_id": self.osm_id,
            "name": self.name,
            "brand": self.brand,
            "addr_street": self.addr_street,
            "addr_housenumber": self.addr_housenumber,
            "location": f"SRID=4326;POINT({self.lon} {self.lat})",
            "geometry": f"SRID=4326;{self.geometry_wkt}" if self.geometry_wkt else None,
            "h3_r9": self.h3_r9,
            "h3_r8": self.h3_r8,
            "tags": self.tags,
            "has_address": has_address(self.tags),
            "source": source,
        }


def _mean_point(coords: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """Среднее координат узлов — запасной вариант для незамкнутых way."""
    lon = sum(coord[0] for coord in coords) / len(coords)
    lat = sum(coord[1] for coord in coords) / len(coords)
    return lon, lat


def _polygon_centroid(coords: Sequence[tuple[float, float]]) -> tuple[float, float] | None:
    """Центроид замкнутого контура (формула шнуровки). None — если площадь нулевая."""
    ring = list(coords)
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    if len(ring) < 3:
        return None

    double_area = 0.0
    lon_sum = 0.0
    lat_sum = 0.0
    for index, (lon_a, lat_a) in enumerate(ring):
        lon_b, lat_b = ring[(index + 1) % len(ring)]
        cross = lon_a * lat_b - lon_b * lat_a
        double_area += cross
        lon_sum += (lon_a + lon_b) * cross
        lat_sum += (lat_a + lat_b) * cross

    if abs(double_area) < 1e-12:
        return None
    return lon_sum / (3 * double_area), lat_sum / (3 * double_area)


def way_point(coords: Sequence[tuple[float, float]], *, closed: bool) -> tuple[float, float] | None:
    """Точка для way: центроид полигона для замкнутых, иначе среднее узлов.

    В ТЗ (раздел 2.2) для полигонов указан `ST_PointOnSurface`; здесь считается центроид —
    для квадратных зданий это практически то же, для сложных форм точка может оказаться вне
    контура. Для тепловой карты (точка попадает в H3-ячейку) разница несущественна.
    """
    if not coords:
        return None
    if closed:
        centroid = _polygon_centroid(coords)
        if centroid is not None:
            return centroid
    return _mean_point(coords)


def way_geometry_wkt(coords: Sequence[tuple[float, float]], *, closed: bool) -> str | None:
    """Геометрия way в WKT: полигон для замкнутых, линия для остальных (None — если точек мало).

    Нужна метрикам площади и длины (Этап 9): по одной точке нельзя посчитать ни долю площади ячейки
    под застройкой, ни километры пешеходных путей. Координаты — ``(lon, lat)``, как отдаёт osmium.
    """
    if len(coords) < 2:
        return None

    points = list(coords)
    if closed and points[0] != points[-1]:
        points.append(points[0])

    body = ", ".join(f"{lon:.7f} {lat:.7f}" for lon, lat in points)
    if closed and len(points) >= 4:
        return f"POLYGON(({body}))"
    return f"LINESTRING({body})"


def build_poi_record(
    osm_type: str,
    osm_id: int,
    tags: dict[str, str],
    lon: float,
    lat: float,
    geometry_wkt: str | None = None,
) -> PoiRecord | None:
    """Собрать запись POI. None — если объект не относится ни к одной категории проекта."""
    # Категории всех слоёв, а не только конкуренты: слои Этапа 9 наполняются этим же импортом
    category_slugs = match_categories(tags, ALL_CATEGORIES)
    if not category_slugs:
        return None

    cells = {resolution: h3.latlng_to_cell(lat, lon, resolution) for resolution in H3_RESOLUTIONS}

    return PoiRecord(
        osm_type=osm_type,
        osm_id=osm_id,
        name=tags.get("name") or None,
        brand=tags.get("brand") or None,
        addr_street=tags.get(ADDRESS_STREET) or None,
        addr_housenumber=tags.get(ADDRESS_HOUSENUMBER) or None,
        lon=lon,
        lat=lat,
        h3_r9=h3.str_to_int(cells[9]),
        h3_r8=h3.str_to_int(cells[8]),
        tags=tags,
        category_slugs=category_slugs,
        geometry_wkt=geometry_wkt,
    )


@dataclass(slots=True)
class ScanStats:
    """Итоги сканирования выгрузки."""

    pbf: str
    pbf_size_mb: float
    osm_timestamp: str | None
    seconds: float
    tagged: int = 0
    in_scope: int = 0
    outside_scope: int = 0
    without_category: int = 0
    nodes: int = 0
    ways: int = 0
    records: int = 0
    limit_reached: bool = False
    categories: dict[str, int] = field(default_factory=dict)

    def describe(self) -> str:
        categories = ", ".join(f"{slug}={count}" for slug, count in sorted(self.categories.items()))
        suffix = " (достигнут --limit)" if self.limit_reached else ""
        return (
            f"PBF: {Path(self.pbf).name} ({self.pbf_size_mb} МБ), "
            f"дата данных: {self.osm_timestamp or 'не указана'}\n"
            f"Время сканирования: {self.seconds:.1f} с{suffix}\n"
            f"Объектов с тегами: {self.tagged}; в bbox городов: {self.in_scope} "
            f"(вне bbox: {self.outside_scope}); без категории MVP: {self.without_category}\n"
            f"Записей POI: {self.records} (узлов {self.nodes}, полигонов {self.ways})\n"
            f"По категориям: {categories}"
        )


class PoiScanner(osmium.SimpleHandler):
    """Отбирает POI внутри bbox городов и отдаёт их батчами.

    Имена методов ``node``/``way`` заданы pyosmium — см. `recon/pbf_scan.py`.
    """

    def __init__(
        self,
        scopes: Sequence[CityScope],
        *,
        on_batch: Callable[[list[PoiRecord]], None],
        batch_size: int = DEFAULT_BATCH_SIZE,
        limit: int | None = None,
    ) -> None:
        super().__init__()
        self.scopes = scopes
        self.on_batch = on_batch
        self.batch_size = batch_size
        self.limit = limit
        self.buffer: list[PoiRecord] = []
        self.stats = ScanStats(pbf="", pbf_size_mb=0.0, osm_timestamp=None, seconds=0.0)
        self.category_counts: Counter[str] = Counter()

    def node(self, n: osmium.osm.Node) -> None:
        if not n.location.valid():
            return
        self._handle("node", n.id, {tag.k: tag.v for tag in n.tags}, n.location.lon, n.location.lat)

    def way(self, w: osmium.osm.Way) -> None:
        tags = {tag.k: tag.v for tag in w.tags}
        if not tags:
            return
        coords = [(node.location.lon, node.location.lat) for node in w.nodes if node.location.valid()]
        closed = w.is_closed()
        point = way_point(coords, closed=closed)
        if point is None:
            return
        # Геометрия нужна метрикам площади и длины: точка её не заменяет
        self._handle(
            "way",
            w.id,
            tags,
            point[0],
            point[1],
            geometry_wkt=way_geometry_wkt(coords, closed=closed),
        )

    def flush(self, *, check_limit: bool = True) -> None:
        if not self.buffer:
            return
        batch, self.buffer = self.buffer, []
        self.stats.records += len(batch)
        self.on_batch(batch)
        if check_limit and self.limit is not None and self.stats.records >= self.limit:
            raise ScanLimitReached

    def _in_scope(self, lat: float, lon: float) -> bool:
        return any(scope.contains(lat, lon) for scope in self.scopes)

    def _handle(
        self,
        osm_type: str,
        osm_id: int,
        tags: dict[str, str],
        lon: float,
        lat: float,
        *,
        geometry_wkt: str | None = None,
    ) -> None:
        if not tags:
            return
        self.stats.tagged += 1
        if not self._in_scope(lat, lon):
            self.stats.outside_scope += 1
            return

        self.stats.in_scope += 1
        record = build_poi_record(osm_type, osm_id, tags, lon, lat, geometry_wkt)
        if record is None:
            self.stats.without_category += 1
            return

        if osm_type == "node":
            self.stats.nodes += 1
        else:
            self.stats.ways += 1
        for slug in record.category_slugs:
            self.category_counts[slug] += 1

        self.buffer.append(record)
        reached_limit = self.limit is not None and (self.stats.records + len(self.buffer)) >= self.limit
        if reached_limit or len(self.buffer) >= self.batch_size:
            self.flush()


def default_dump_path(pbf: Path) -> Path:
    """Путь файла-кандидатов по умолчанию: рядом с выгрузкой, без расширения .osm.pbf."""
    name = pbf.name
    base = name[: -len(".osm.pbf")] if name.endswith(".osm.pbf") else pbf.stem
    return pbf.with_name(f"{base}{DUMP_SUFFIX}")


def scan_pbf(
    pbf: Path,
    scopes: Sequence[CityScope],
    *,
    dump_path: Path | None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    limit: int | None = None,
) -> ScanStats:
    """Один проход по выгрузке: POI внутри bbox городов → файл-кандидатов (JSONL)."""
    if not pbf.exists():
        raise ImportError_(f"Файл выгрузки не найден: {pbf}. См. tools/fetch-osm-extract.ps1 и data/README.md")

    started = time.perf_counter()
    # Дата данных читается из заголовка до сканирования: она нужна и в отчёте, и в первой строке
    # файла-кандидатов, чтобы `--from-dump` не терял версию данных.
    osm_timestamp = read_osm_timestamp(pbf)

    stream = None
    if dump_path is not None:
        dump_path.parent.mkdir(parents=True, exist_ok=True)
        stream = dump_path.open("w", encoding="utf-8")
        meta = {
            "_meta": {
                "pbf": str(pbf),
                "pbf_size_mb": round(pbf.stat().st_size / 1024 / 1024, 1),
                "osm_timestamp": osm_timestamp,
                "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            }
        }
        stream.write(json.dumps(meta, ensure_ascii=False) + "\n")

    def on_batch(records: list[PoiRecord]) -> None:
        if stream is not None:
            stream.writelines(record.as_json() + "\n" for record in records)

    scanner = PoiScanner(scopes, on_batch=on_batch, batch_size=batch_size, limit=limit)
    try:
        try:
            scanner.apply_file(str(pbf), locations=True)
        except ScanLimitReached:
            scanner.stats.limit_reached = True
        else:
            scanner.flush(check_limit=False)
    finally:
        if stream is not None:
            stream.close()

    stats = scanner.stats
    stats.pbf = str(pbf)
    stats.pbf_size_mb = round(pbf.stat().st_size / 1024 / 1024, 1)
    stats.osm_timestamp = osm_timestamp
    stats.seconds = round(time.perf_counter() - started, 1)
    stats.categories = dict(scanner.category_counts.most_common())
    return stats


def read_dump_meta(path: Path) -> dict[str, Any]:
    """Метаданные файла-кандидатов (дата данных OSM, исходный PBF). Пустой словарь, если нет."""
    with path.open("r", encoding="utf-8") as stream:
        first_line = stream.readline().strip()
    if not first_line.startswith(META_LINE_PREFIX):
        return {}
    try:
        return dict(json.loads(first_line).get("_meta") or {})
    except json.JSONDecodeError:
        return {}


def iter_dump(path: Path) -> Iterator[PoiRecord]:
    """Потоковое чтение файла-кандидатов (строка метаданных пропускается)."""
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if not line or line.startswith(META_LINE_PREFIX):
                continue
            yield PoiRecord.from_json(line)


async def load_city_scopes(session: AsyncSession, slugs: Sequence[str] | None = None) -> list[CityScope]:
    """Города, для которых импортируем: активные, с заданным bbox."""
    query = (
        "SELECT id, slug, name, "
        "ST_YMin(bbox::geometry) AS min_lat, ST_XMin(bbox::geometry) AS min_lon, "
        "ST_YMax(bbox::geometry) AS max_lat, ST_XMax(bbox::geometry) AS max_lon "
        "FROM cities WHERE is_active AND bbox IS NOT NULL"
    )
    params: dict[str, Any] = {}
    if slugs:
        query += " AND slug IN :slugs"
        statement = text(query + " ORDER BY slug").bindparams(bindparam("slugs", expanding=True))
        params["slugs"] = list(slugs)
    else:
        statement = text(query + " ORDER BY slug")

    rows = (await session.execute(statement, params)).mappings().all()
    return [
        CityScope(
            id=row["id"],
            slug=row["slug"],
            name=row["name"],
            min_lat=float(row["min_lat"]),
            min_lon=float(row["min_lon"]),
            max_lat=float(row["max_lat"]),
            max_lon=float(row["max_lon"]),
        )
        for row in rows
    ]


async def load_category_ids(session: AsyncSession) -> dict[str, int]:
    rows = (await session.execute(text("SELECT slug, id FROM categories WHERE is_active"))).all()
    return dict(rows)


async def fetch_watermark(session: AsyncSession) -> datetime:
    """Водяной знак для мягкого удаления: время БД на начало транзакции импорта.

    Важно: значение берётся из Postgres (`clock_timestamp`), а не из Python, и запрашивается
    до первой вставки. Все записи, обновлённые в этом же импорте, получают строго большее
    время (тоже `clock_timestamp`), поэтому «устаревшими» считаются только те объекты,
    которых не было в выгрузке.
    """
    value = (await session.execute(text("SELECT clock_timestamp()"))).scalar_one()
    return value


async def upsert_records(
    session: AsyncSession,
    records: Sequence[PoiRecord],
    *,
    category_ids: dict[str, int],
    source: str,
) -> int:
    """Батчевый upsert POI и связей с категориями. Возвращает число обработанных записей."""
    if not records:
        return 0

    table = Poi.__table__
    statement = pg_insert(table).values(
        [{**record.as_row(source=source), "updated_at": func.clock_timestamp()} for record in records]
    )
    update_columns = {
        column.name: statement.excluded[column.name]
        for column in table.c
        if column.name not in {"id", "osm_type", "osm_id"}
    }
    update_columns["updated_at"] = func.clock_timestamp()
    statement = statement.on_conflict_do_update(
        index_elements=[table.c.osm_type, table.c.osm_id],
        set_=update_columns,
    ).returning(table.c.id, table.c.osm_type, table.c.osm_id)

    rows = (await session.execute(statement)).all()
    poi_ids = {(row.osm_type, row.osm_id): row.id for row in rows}

    links = [
        {"poi_id": poi_ids[(record.osm_type, record.osm_id)], "category_id": category_ids[slug]}
        for record in records
        for slug in record.category_slugs
        if slug in category_ids
    ]
    if links:
        await session.execute(pg_insert(PoiCategory.__table__).values(links).on_conflict_do_nothing())
    return len(rows)


async def deactivate_missing(session: AsyncSession, *, source: str, watermark: datetime) -> int:
    """Мягкое удаление: объекты, не встреченные в этой выгрузке, помечаются `is_active = false`."""
    result = await session.execute(
        text(
            "UPDATE pois SET is_active = false, updated_at = clock_timestamp() "
            "WHERE is_active AND source = :source AND updated_at < :watermark"
        ),
        {"source": source, "watermark": watermark},
    )
    return result.rowcount or 0


async def start_import_run(session: AsyncSession, *, source: str, source_url: str | None) -> tuple[int, datetime]:
    """Зафиксировать начало импорта. Возвращает id запуска и время старта."""
    started_at = datetime.now(UTC)
    result = await session.execute(
        text(
            "INSERT INTO import_runs (source, source_url, started_at, status) "
            "VALUES (:source, :source_url, :started_at, 'running') RETURNING id"
        ),
        {"source": source, "source_url": source_url, "started_at": started_at},
    )
    return result.scalar_one(), started_at


async def finish_import_run(
    session: AsyncSession,
    run_id: int,
    *,
    status: str,
    osm_timestamp: str | None = None,
    pois_upserted: int = 0,
    cells_written: int = 0,
    error: str | None = None,
) -> None:
    timestamp = datetime.fromisoformat(osm_timestamp.replace("Z", "+00:00")) if osm_timestamp else None
    await session.execute(
        text(
            "UPDATE import_runs SET finished_at = now(), status = :status, osm_timestamp = :osm_timestamp, "
            "pois_upserted = :pois_upserted, cells_written = :cells_written, error = :error WHERE id = :id"
        ),
        {
            "id": run_id,
            "status": status,
            "osm_timestamp": timestamp,
            "pois_upserted": pois_upserted,
            "cells_written": cells_written,
            "error": error,
        },
    )


async def publish_data_version(session: AsyncSession, version: str) -> None:
    """Отметить версию данных: используется в API-ответах, кэше и интерфейсе."""
    await session.execute(
        text("INSERT INTO data_versions (version) VALUES (:version) ON CONFLICT (version) DO NOTHING"),
        {"version": version},
    )


def resolve_data_version(explicit: str | None, osm_timestamp: str | None) -> str:
    """Версия данных: явное значение, иначе дата из PBF, иначе сегодняшняя дата."""
    if explicit:
        return explicit
    if osm_timestamp:
        return osm_timestamp[:10]
    return datetime.now(UTC).date().isoformat()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Импорт POI из выгрузки OSM (PBF)")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--pbf", type=Path, help="файл выгрузки .osm.pbf")
    source.add_argument("--from-dump", dest="from_dump", type=Path, help="готовый файл-кандидатов (JSONL)")
    parser.add_argument("--dump", type=Path, default=None, help="куда писать кандидатов (по умолчанию рядом с PBF)")
    parser.add_argument("--city", action="append", help="slug города (можно повторять); по умолчанию все активные")
    parser.add_argument("--source", default="geofabrik", help="метка источника данных")
    parser.add_argument("--batch-size", dest="batch_size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--limit", type=int, default=None, help="остановиться после N записей (быстрая проверка)")
    parser.add_argument("--dry-run", action="store_true", help="только сканирование и отчёт, без записи данных")
    parser.add_argument(
        "--data-version", dest="data_version", default=None, help="версия данных (по умолчанию дата из PBF)"
    )
    return parser.parse_args(argv)


async def run(args: argparse.Namespace) -> int:
    engine = create_engine(get_settings())
    try:
        async with session_scope(engine) as session:
            scopes = await load_city_scopes(session, args.city)
            if not scopes:
                print("Нет активных городов с bbox. Сначала: uv run python -m geopuls.seed --city ...")
                return 1
            category_ids = await load_category_ids(session)
            if not category_ids:
                print("Нет активных категорий. Сначала: uv run python -m geopuls.seed --skip-city")
                return 1
            run_id, _run_started_at = await start_import_run(
                session, source=args.source, source_url=str(args.pbf or args.from_dump)
            )

        print(f"Города: {', '.join(scope.name for scope in scopes)}")
        print(f"Категорий: {len(category_ids)} ({', '.join(sorted(category_ids))})")

        osm_timestamp: str | None = None
        if args.pbf:
            dump_path = args.dump or default_dump_path(args.pbf)
            try:
                stats = scan_pbf(args.pbf, scopes, dump_path=dump_path, batch_size=args.batch_size, limit=args.limit)
            except Exception as exc:
                async with session_scope(engine) as session:
                    await finish_import_run(session, run_id, status="failed", error=f"{type(exc).__name__}: {exc}")
                raise
            print(stats.describe())
            print(f"Файл-кандидатов: {dump_path}")
            osm_timestamp = stats.osm_timestamp
            if args.dry_run:
                async with session_scope(engine) as session:
                    await finish_import_run(session, run_id, status="dry-run")
                return 0
        else:
            dump_path = args.from_dump
            # Дата данных берётся из метаданных файла-кандидатов, иначе «версия данных» стала бы
            # датой импорта, а не датой выгрузки OSM.
            meta_timestamp = read_dump_meta(dump_path).get("osm_timestamp")
            if meta_timestamp:
                osm_timestamp = str(meta_timestamp)

        imported = 0
        deactivated = 0
        try:
            async with session_scope(engine) as session:
                # Водяной знак берётся до первой вставки: см. deactivate_missing
                watermark = await fetch_watermark(session)
                for batch in batched(iter_dump(dump_path), args.batch_size, strict=False):
                    imported += await upsert_records(session, batch, category_ids=category_ids, source=args.source)
                if args.limit is None:
                    deactivated = await deactivate_missing(session, source=args.source, watermark=watermark)
                else:
                    print("Мягкое удаление пропущено: импорт ограничен --limit (режим отладки)")
                await publish_data_version(session, resolve_data_version(args.data_version, osm_timestamp))
                await finish_import_run(
                    session, run_id, status="ok", osm_timestamp=osm_timestamp, pois_upserted=imported
                )
        except Exception as exc:
            async with session_scope(engine) as session:
                await finish_import_run(session, run_id, status="failed", error=f"{type(exc).__name__}: {exc}")
            raise

        print(f"Обработано POI: {imported}; помечено неактивными: {deactivated}")
        print(f"Версия данных: {resolve_data_version(args.data_version, osm_timestamp)}")
        async with session_scope(engine) as session:
            summary = (
                (
                    await session.execute(
                        text(
                            "SELECT count(*) FILTER (WHERE is_active) AS active, "
                            "count(*) FILTER (WHERE NOT is_active) AS inactive FROM pois"
                        )
                    )
                )
                .mappings()
                .one()
            )
        print(f"В БД: активных {summary['active']}, неактивных {summary['inactive']}")
        return 0
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    enable_utf8_console()
    args = parse_args(argv)
    try:
        return asyncio.run(run(args))
    except ImportError_ as exc:
        print(f"Ошибка: {exc}")
        return 2
    except KeyboardInterrupt:
        print("Импорт прерван пользователем")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
