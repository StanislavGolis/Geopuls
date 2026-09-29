"""Агрегация POI по H3-сетке города.

Что делает (см. docs/tz.md, раздел 3 и docs/decisions/0006-h3-aggregation.md):

1. строит **полную** сетку города по полигону (`city_cells`) для res 8 и 9: ячейки, чей центр
   попадает в полигон, **плюс** ячейки всех POI внутри полигона — иначе объект у границы выпал бы
   из агрегата;
2. считает площадь каждой ячейки точно (`h3.cell_area`): площадь ячейки H3 различается до **1.99×**,
   поэтому плотность (POI/км²) считается по фактической площади, а не по средней;
3. формирует `cell_stats` — количество POI, плотность и доля адресов по каждой ячейке и категории,
   **включая пустые ячейки** (`poi_count = 0`): именно они и есть «карта пустых зон»;
4. считает границы классов легенды (`density_breaks`, квантильная шкала) — шкала должна считаться
   на бэкенде, чтобы web-, PNG- и PDF-представления совпадали;
5. пишет журнал в `import_runs` (`source = 'aggregate'`) и проверяет сходимость площадей.

Запуск:
    uv run python -m geopuls.aggregate --city tomsk
    uv run python -m geopuls.aggregate --city tomsk --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from collections import defaultdict
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import h3
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from geopuls.config import get_settings
from geopuls.console import enable_utf8_console
from geopuls.db import create_engine, session_scope
from geopuls.importers.poi import finish_import_run, load_category_ids, start_import_run
from geopuls.models import CellMetric, CellStat, CityCell
from geopuls.seed import COMPETITORS_LAYER

#: Разрешения, для которых строится сетка (детальный и обзорный слои карты).
DEFAULT_RESOLUTIONS = (9, 8)
#: Сколько классов (кроме нулевого) в легенде тепловой карты.
LEGEND_CLASSES = 4
#: Размер батча записи в БД (строк за один INSERT).
BATCH_SIZE = 5000
#: Предел протокола asyncpg на число параметров в одном запросе (защита от «самого большого» батча).
MAX_QUERY_PARAMS = 32_000
#: Допустимое расхождение суммы площадей ячеек с площадью полигона (граничные ячейки выходят за контур).
AREA_TOLERANCE_PERCENT = 15.0


@dataclass(frozen=True, slots=True)
class GridCell:
    """Ячейка сетки города."""

    h3_index: int
    centroid_lat: float
    centroid_lon: float
    area_km2: float


@dataclass(slots=True)
class AggregateResult:
    """Итоги агрегации для одного города."""

    city_slug: str
    city_name: str
    resolutions: tuple[int, ...]
    cells_total: dict[int, int] = field(default_factory=dict)
    cells_non_empty: dict[int, int] = field(default_factory=dict)
    cells_from_poi: dict[int, int] = field(default_factory=dict)
    poi_in_city: int = 0
    poi_in_grid: int = 0
    city_area_km2: float = 0.0
    grid_area_km2: dict[int, float] = field(default_factory=dict)
    density_breaks: dict[str, list[float]] = field(default_factory=dict)
    #: Сколько строк метрик записано в `cell_metrics` (слой «Конкуренты»)
    metrics_written: int = 0
    #: Версия данных, под которой записан снимок метрик
    data_version: str | None = None
    seconds: float = 0.0

    @property
    def area_deviation_percent(self) -> float:
        """Насколько сумма площадей ячеек res 9 отличается от площади города."""
        if not self.city_area_km2:
            return 0.0
        return (self.grid_area_km2.get(9, 0.0) / self.city_area_km2 - 1) * 100

    def describe(self) -> str:
        lines = [
            f"Город: {self.city_name} ({self.city_slug}), площадь {self.city_area_km2:.1f} км²",
            f"POI внутри полигона: {self.poi_in_city}, попало в сетку: {self.poi_in_grid}",
        ]
        for resolution in self.resolutions:
            lines.append(
                f"res {resolution}: ячеек {self.cells_total.get(resolution, 0)} "
                f"(непустых {self.cells_non_empty.get(resolution, 0)}, "
                f"добавлено из POI {self.cells_from_poi.get(resolution, 0)}), "
                f"сумма площадей {self.grid_area_km2.get(resolution, 0.0):.1f} км²"
            )
        lines.append(f"Расхождение площади с полигоном: {self.area_deviation_percent:+.1f}%")
        breaks = ", ".join(f"{slug}: {values}" for slug, values in sorted(self.density_breaks.items()))
        lines.append(f"Границы классов легенды (POI/км²): {breaks}")
        if self.metrics_written:
            lines.append(f"Метрики слоя «Конкуренты»: строк {self.metrics_written}, версия данных {self.data_version}")
        lines.append(f"Время агрегации: {self.seconds:.1f} с")
        return "\n".join(lines)


def compute_density_breaks(values: Sequence[float], classes: int = LEGEND_CLASSES) -> list[float]:
    """Границы классов легенды по квантилям положительных значений.

    Возвращает ``classes + 1`` чисел: ``[0, q1, q2, q3, max]`` — первая граница всегда 0
    (отдельный класс «нет объектов»). Если значений слишком мало для квантилей **или квантили
    совпали** (плотность в ячейках дискретна: один объект ≈ 8.5 POI/км²), шкала строится
    равномерно между минимумом и максимумом: легенда с двумя одинаковыми границами показывает
    пустой класс и путает пользователя.
    """
    positives = sorted(value for value in values if value > 0)
    if not positives:
        return [0.0] * (classes + 1)

    low, high = positives[0], positives[-1]
    if low == high:
        return [0.0, *[round(low, 1)] * classes]

    if len(positives) >= classes + 1:
        quantiles = statistics.quantiles(positives, n=classes, method="inclusive")
        breaks = [0.0, *[round(value, 1) for value in quantiles[: classes - 1]], round(high, 1)]
        if len(set(breaks)) == len(breaks):
            return breaks

    step = (high - low) / classes
    return [0.0, *[round(low + step * index, 1) for index in range(1, classes + 1)]]


def build_grid(
    geometry: dict[str, Any],
    resolutions: Iterable[int],
    *,
    extra_cells: dict[int, Iterable[int]] | None = None,
) -> dict[int, list[GridCell]]:
    """Построить полную сетку города для каждого разрешения.

    ``extra_cells`` — ячейки POI внутри полигона: добавляются к покрытию, чтобы объект у границы
    не потерялся из-за того, что центр его ячейки оказался за контуром города.
    """
    shape = h3.geo_to_h3shape(geometry)
    extra = {resolution: set(cells) for resolution, cells in (extra_cells or {}).items()}
    grid: dict[int, list[GridCell]] = {}

    for resolution in resolutions:
        cells = set(h3.polygon_to_cells(shape, resolution)) | extra.get(resolution, set())
        grid[resolution] = [_to_grid_cell(cell) for cell in sorted(cells)]
    return grid


def _to_grid_cell(h3_index: str) -> GridCell:
    lat, lon = h3.cell_to_latlng(h3_index)
    return GridCell(
        h3_index=h3.str_to_int(h3_index),
        centroid_lat=lat,
        centroid_lon=lon,
        area_km2=h3.cell_area(h3_index, "km^2"),
    )


def build_cell_stat_rows(
    grid: dict[int, list[GridCell]],
    counts: dict[tuple[int, int, int], tuple[int, int]],
    category_ids: dict[str, int],
    *,
    city_id: int,
) -> list[dict[str, Any]]:
    """Строки `cell_stats`: все ячейки × все категории, включая пустые (poi_count = 0).

    ``counts`` — ``(resolution, h3_index, category_id) → (количество POI, из них с адресом)``.
    """
    rows: list[dict[str, Any]] = []
    for resolution, cells in grid.items():
        for cell in cells:
            for category_id in category_ids.values():
                poi_count, with_address = counts.get((resolution, cell.h3_index, category_id), (0, 0))
                rows.append(
                    {
                        "city_id": city_id,
                        "resolution": resolution,
                        "h3_index": cell.h3_index,
                        "category_id": category_id,
                        "poi_count": poi_count,
                        "density": poi_count / cell.area_km2 if cell.area_km2 else 0.0,
                        "has_address_ratio": (with_address / poi_count) if poi_count else None,
                    }
                )
    return rows


@dataclass(frozen=True, slots=True)
class CityGridSource:
    """Данные города, нужные для построения сетки."""

    city_id: int
    slug: str
    name: str
    geometry: dict[str, Any]
    area_km2: float
    h3_res: int


class AggregateError(RuntimeError):
    """Агрегация невозможна: нет города или нет категорий."""


async def load_city(session: AsyncSession, slug: str) -> CityGridSource:
    """Загрузить город вместе с полигоном (GeoJSON) и площадью."""
    row = (
        (
            await session.execute(
                text(
                    "SELECT id, slug, name, ST_AsGeoJSON(boundary::geometry) AS geojson, "
                    "ST_Area(boundary) / 1000000 AS area_km2, h3_res "
                    "FROM cities WHERE slug = :slug AND is_active"
                ),
                {"slug": slug},
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise AggregateError(f"Город не найден или неактивен: {slug}. Сначала запустите сид города")
    if not row["geojson"]:
        raise AggregateError(f"У города {slug} не заполнен полигон — агрегация по bbox недопустима")
    return CityGridSource(
        city_id=row["id"],
        slug=row["slug"],
        name=row["name"],
        geometry=json.loads(row["geojson"]),
        area_km2=float(row["area_km2"]),
        h3_res=row["h3_res"],
    )


async def load_poi_rows(session: AsyncSession, city_id: int) -> list[tuple[int, int, int, bool, int]]:
    """POI внутри полигона города: ``(poi_id, h3_r9, h3_r8, has_address, category_id)``.

    Фильтр по полигону (`ST_Contains`), а не по bbox: bbox затягивает пригороды, и в тепловую
    карту попадали бы объекты за границей города.
    """
    result = await session.execute(
        text(
            "SELECT p.id, p.h3_r9, p.h3_r8, p.has_address, pc.category_id "
            "FROM pois p "
            "JOIN poi_categories pc ON pc.poi_id = p.id "
            "WHERE p.is_active "
            "AND ST_Contains((SELECT boundary::geometry FROM cities WHERE id = :city_id), p.location::geometry)"
        ),
        {"city_id": city_id},
    )
    return [(row[0], row[1], row[2], row[3], row[4]) for row in result.all()]


def build_counts(
    rows: Sequence[tuple[int, int, int, bool, int]],
    resolutions: Iterable[int],
) -> tuple[dict[tuple[int, int, int], tuple[int, int]], dict[int, set[int]]]:
    """Агрегировать строки POI.

    Возвращает ``counts`` — ``(resolution, h3_index, category_id) → (всего, с адресом)``
    и ``extra_cells`` — ячейки POI по разрешениям (в виде H3-строк для `build_grid`).
    """
    counts: dict[tuple[int, int, int], tuple[int, int]] = defaultdict(lambda: (0, 0))
    extra_cells: dict[int, set[int]] = {resolution: set() for resolution in resolutions}

    for _poi_id, h3_r9, h3_r8, has_address, category_id in rows:
        cells = {9: h3_r9, 8: h3_r8}
        for resolution in extra_cells:
            cell = cells.get(resolution)
            if cell is None:
                continue
            extra_cells[resolution].add(h3.int_to_str(cell))
            total, with_address = counts[(resolution, cell, category_id)]
            counts[(resolution, cell, category_id)] = (total + 1, with_address + (1 if has_address else 0))
    return dict(counts), extra_cells


def batch_rows(
    rows: Sequence[dict[str, Any]],
    *,
    columns: int,
    size: int = BATCH_SIZE,
) -> Iterator[list[dict[str, Any]]]:
    """Нарезать строки на батчи с учётом лимита параметров запроса.

    asyncpg отклоняет запросы с более чем 32 767 параметрами, поэтому размер батча считается
    по числу колонок: иначе «щедрый» батч из 5 000 строк на таблице с 7 колонками падает.
    """
    per_batch = max(1, min(size, MAX_QUERY_PARAMS // max(columns, 1)))
    for index in range(0, len(rows), per_batch):
        yield list(rows[index : index + per_batch])


async def replace_city_grid(
    session: AsyncSession,
    city_id: int,
    grid: dict[int, list[GridCell]],
) -> int:
    """Полностью переписать сетку города для указанных разрешений. Возвращает число ячеек."""
    written = 0
    columns = len(CityCell.__table__.columns)
    for resolution, cells in grid.items():
        await session.execute(
            text("DELETE FROM city_cells WHERE city_id = :city_id AND resolution = :resolution"),
            {"city_id": city_id, "resolution": resolution},
        )
        rows = [
            {
                "city_id": city_id,
                "resolution": resolution,
                "h3_index": cell.h3_index,
                "centroid": f"SRID=4326;POINT({cell.centroid_lon} {cell.centroid_lat})",
                "area_km2": cell.area_km2,
            }
            for cell in cells
        ]
        for batch in batch_rows(rows, columns=columns):
            await session.execute(pg_insert(CityCell.__table__).values(batch))
            written += len(batch)
    return written


def build_cell_metric_rows(
    stat_rows: Sequence[dict[str, Any]],
    *,
    layer_id: int,
    dataset_id: int | None,
    data_version: str,
) -> list[dict[str, Any]]:
    """Строки `cell_metrics` по статистике POI (слой «Конкуренты»).

    Значение метрики слоя — плотность, число объектов и доля адресов уезжают в ``extras``:
    они нужны подписям и панели ячейки, но не участвуют в раскраске.
    """
    rows: list[dict[str, Any]] = []
    for row in stat_rows:
        extras: dict[str, Any] = {"count": row["poi_count"]}
        if row["has_address_ratio"] is not None:
            extras["has_address_ratio"] = round(float(row["has_address_ratio"]), 3)
        rows.append(
            {
                "city_id": row["city_id"],
                "layer_id": layer_id,
                "category_id": row["category_id"],
                "resolution": row["resolution"],
                "h3_index": row["h3_index"],
                "data_version": data_version,
                "value": round(float(row["density"]), 4),
                "value_kind": "density",
                "extras": extras,
                "dataset_id": dataset_id,
            }
        )
    return rows


async def load_layer_identity(session: AsyncSession, slug: str = COMPETITORS_LAYER) -> tuple[int, int | None]:
    """Идентификаторы слоя и его источника: без них метрику некуда записать."""
    row = (
        (await session.execute(text("SELECT id, dataset_id FROM layers WHERE slug = :slug"), {"slug": slug}))
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise AggregateError(f"Слой '{slug}' не найден — сначала сид справочников: python -m geopuls.seed --skip-city")
    return int(row["id"]), int(row["dataset_id"]) if row["dataset_id"] is not None else None


async def load_current_data_version(session: AsyncSession) -> str:
    """Версия данных для метрик: дата выгрузки, опубликованная импортёром."""
    version = (await session.execute(text("SELECT max(version) FROM data_versions"))).scalar()
    return str(version) if version else "unknown"


async def replace_cell_metrics(
    session: AsyncSession,
    *,
    city_id: int,
    layer_id: int,
    resolutions: Iterable[int],
    data_version: str,
    rows: Sequence[dict[str, Any]],
) -> int:
    """Переписать снимок метрик слоя за указанную версию данных.

    Удаляем только строки той же версии: снимки прошлых выгрузок остаются — из них складывается
    динамика («открылось/закрылось»), которую нельзя восстановить задним числом.
    """
    for resolution in resolutions:
        await session.execute(
            text(
                "DELETE FROM cell_metrics WHERE city_id = :city_id AND layer_id = :layer_id "
                "AND resolution = :resolution AND data_version = :data_version"
            ),
            {
                "city_id": city_id,
                "layer_id": layer_id,
                "resolution": resolution,
                "data_version": data_version,
            },
        )
    written = 0
    # Вычисляемые колонки (category_key) в INSERT не передаём: их считает база
    columns = len([column for column in CellMetric.__table__.columns if column.computed is None])
    for batch in batch_rows(rows, columns=columns):
        await session.execute(pg_insert(CellMetric.__table__).values(batch))
        written += len(batch)
    return written


async def replace_cell_stats(
    session: AsyncSession,
    city_id: int,
    resolutions: Iterable[int],
    rows: Sequence[dict[str, Any]],
) -> int:
    """Полностью переписать статистику города для указанных разрешений."""
    for resolution in resolutions:
        await session.execute(
            text("DELETE FROM cell_stats WHERE city_id = :city_id AND resolution = :resolution"),
            {"city_id": city_id, "resolution": resolution},
        )
    written = 0
    columns = len(CellStat.__table__.columns)
    for batch in batch_rows(rows, columns=columns):
        await session.execute(pg_insert(CellStat.__table__).values(batch))
        written += len(batch)
    return written


def compute_breaks_by_category(
    rows: Sequence[dict[str, Any]],
    category_ids: dict[str, int],
    resolution: int = 9,
    classes: int = LEGEND_CLASSES,
) -> dict[str, list[float]]:
    """Границы классов легенды по каждой категории (детальный слой)."""
    slug_of = {category_id: slug for slug, category_id in category_ids.items()}
    densities: dict[int, list[float]] = defaultdict(list)
    for row in rows:
        if row["resolution"] == resolution and row["poi_count"] > 0:
            densities[row["category_id"]].append(float(row["density"]))
    return {
        slug_of[category_id]: compute_density_breaks(values, classes=classes)
        for category_id, values in densities.items()
    }


async def aggregate_city(
    session: AsyncSession,
    slug: str,
    resolutions: Sequence[int],
    *,
    dry_run: bool = False,
    legend_classes: int = LEGEND_CLASSES,
) -> AggregateResult:
    """Собрать сетку и статистику города. При ``dry_run`` в БД ничего не пишется."""
    started = time.perf_counter()
    city = await load_city(session, slug)
    category_ids = await load_category_ids(session)
    if not category_ids:
        raise AggregateError("Нет активных категорий — сначала выполните сид: python -m geopuls.seed --skip-city")

    poi_rows = await load_poi_rows(session, city.city_id)
    counts, extra_cells = build_counts(poi_rows, resolutions)
    grid = build_grid(city.geometry, resolutions, extra_cells=extra_cells)
    stat_rows = build_cell_stat_rows(grid, counts, category_ids, city_id=city.city_id)

    shape = h3.geo_to_h3shape(city.geometry)
    result = AggregateResult(
        city_slug=city.slug,
        city_name=city.name,
        resolutions=tuple(resolutions),
    )
    result.poi_in_city = len({row[0] for row in poi_rows})
    # Ячейки POI добавляются в сетку принудительно, поэтому в неё попадают все объекты города
    result.poi_in_grid = result.poi_in_city
    result.city_area_km2 = city.area_km2

    for resolution, cells in grid.items():
        polygon_cells = {h3.str_to_int(cell) for cell in h3.polygon_to_cells(shape, resolution)}
        extra_ints = {h3.str_to_int(cell) for cell in extra_cells.get(resolution, set())}
        result.cells_total[resolution] = len(cells)
        result.cells_from_poi[resolution] = len(extra_ints - polygon_cells)
        result.grid_area_km2[resolution] = sum(cell.area_km2 for cell in cells)
        result.cells_non_empty[resolution] = len(
            {row["h3_index"] for row in stat_rows if row["resolution"] == resolution and row["poi_count"] > 0}
        )

    result.density_breaks = compute_breaks_by_category(stat_rows, category_ids, classes=legend_classes)
    result.data_version = await load_current_data_version(session)
    result.seconds = round(time.perf_counter() - started, 1)

    if not dry_run:
        # Слой «Конкуренты» — единственный слой на Этапе 8; метрики пишем в новую таблицу,
        # cell_stats оставляем заполненной как совместимый путь чтения (ADR 0013)
        layer_id, dataset_id = await load_layer_identity(session)
        metric_rows = build_cell_metric_rows(
            stat_rows,
            layer_id=layer_id,
            dataset_id=dataset_id,
            data_version=result.data_version,
        )
        await replace_city_grid(session, city.city_id, grid)
        await replace_cell_stats(session, city.city_id, resolutions, stat_rows)
        result.metrics_written = await replace_cell_metrics(
            session,
            city_id=city.city_id,
            layer_id=layer_id,
            resolutions=resolutions,
            data_version=result.data_version,
            rows=metric_rows,
        )
        # Источник помнит версию данных, которая сейчас видна на карте (ТЗ §2.3): по ней API
        # выбирает снимок метрик без дорогих подзапросов на каждую ячейку
        if dataset_id is not None:
            await session.execute(
                text("UPDATE datasets SET data_version = :version, updated_at = now() WHERE id = :dataset_id"),
                {"version": result.data_version, "dataset_id": dataset_id},
            )

    return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Агрегация POI по H3-сетке города")
    parser.add_argument("--city", action="append", required=True, help="slug города (можно повторять)")
    parser.add_argument(
        "--res",
        action="append",
        type=int,
        dest="resolutions",
        default=None,
        help=f"разрешения H3 (по умолчанию {', '.join(str(value) for value in DEFAULT_RESOLUTIONS)})",
    )
    parser.add_argument("--dry-run", action="store_true", help="посчитать без записи в БД")
    parser.add_argument("--strict", action="store_true", help="превышение допуска по площади считать ошибкой (код 3)")
    return parser.parse_args(argv)


async def run(args: argparse.Namespace) -> int:
    resolutions = tuple(args.resolutions) if args.resolutions else DEFAULT_RESOLUTIONS
    settings = get_settings()
    engine = create_engine(settings)
    exit_code = 0
    try:
        for slug in args.city:
            async with session_scope(engine) as session:
                run_id, _started_at = await start_import_run(session, source="aggregate", source_url=None)
            try:
                async with session_scope(engine) as session:
                    result = await aggregate_city(
                        session,
                        slug,
                        resolutions,
                        dry_run=args.dry_run,
                        legend_classes=settings.legend_classes,
                    )
                    await finish_import_run(
                        session,
                        run_id,
                        status="dry-run" if args.dry_run else "ok",
                        pois_upserted=result.poi_in_city,
                        cells_written=sum(result.cells_total.values()),
                    )
            except Exception as exc:
                async with session_scope(engine) as session:
                    await finish_import_run(session, run_id, status="failed", error=f"{type(exc).__name__}: {exc}")
                raise

            print(result.describe())
            if abs(result.area_deviation_percent) > AREA_TOLERANCE_PERCENT:
                print(
                    f"ВНИМАНИЕ: сумма площадей ячеек отличается от площади города на "
                    f"{result.area_deviation_percent:+.1f}% (допуск ±{AREA_TOLERANCE_PERCENT}%). "
                    "Проверьте полигон города."
                )
                if args.strict:
                    exit_code = 3
        return exit_code
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    enable_utf8_console()
    args = parse_args(argv)
    try:
        return asyncio.run(run(args))
    except AggregateError as exc:
        print(f"Ошибка: {exc}")
        return 2
    except KeyboardInterrupt:
        print("Агрегация прервана пользователем")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
