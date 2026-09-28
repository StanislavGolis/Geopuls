"""Обновление данных города одной командой: справочники → POI → агрегация.

Зачем отдельный CLI: критерий готовности MVP требует, чтобы импорт POI воспроизводился **одной
командой** и был идемпотентен (docs/tz.md, §11.1), а на VPS это же вызывается из cron/systemd-timer
(§9.2). Логику не дублируем — переиспользуем импортёр (`geopuls.importers.poi`) и агрегатор
(`geopuls.aggregate`).

Примеры:

    python -m geopuls.refresh --city tomsk --pbf data/raw/siberian-fed-district-260927.osm.pbf
    python -m geopuls.refresh --city tomsk --from-dump data/raw/....poi-candidates.jsonl
    python -m geopuls.refresh --city tomsk --skip-import        # только пересобрать агрегаты

Выход: 0 — данные обновлены; 2 — ошибка данных (города нет, нет категорий, нет файла).
Ненулевой код важен для cron: по нему отправляется уведомление об упавшем обновлении (§9.3).
"""

from __future__ import annotations

import argparse
import asyncio
import time
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from itertools import batched
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncEngine

from geopuls.aggregate import DEFAULT_RESOLUTIONS, AggregateError, aggregate_city
from geopuls.config import get_settings
from geopuls.console import enable_utf8_console
from geopuls.db import create_engine, session_scope
from geopuls.importers.poi import (
    ImportError_,
    PoiRecord,
    deactivate_missing,
    default_dump_path,
    fetch_watermark,
    finish_import_run,
    iter_dump,
    load_category_ids,
    load_city_scopes,
    publish_data_version,
    read_dump_meta,
    resolve_data_version,
    scan_pbf,
    start_import_run,
    upsert_records,
)
from geopuls.seed import seed_categories


@dataclass(slots=True)
class CityRefreshResult:
    """Что получилось по одному городу."""

    city_slug: str
    city_name: str
    categories: int = 0
    pois_upserted: int = 0
    pois_deactivated: int = 0
    poi_in_city: int = 0
    #: Ячеек в сетке города (res 9 + res 8).
    cells_total: int = 0
    #: Строк в `cell_stats` — ячейки × категории.
    stats_rows: int = 0
    data_version: str | None = None
    steps: list[str] = field(default_factory=list)
    seconds: float = 0.0

    def describe(self) -> str:
        lines = [f"Город: {self.city_name} ({self.city_slug})"]
        if self.categories:
            lines.append(f"Категории в справочнике: {self.categories}")
        if self.pois_upserted or self.pois_deactivated:
            lines.append(f"POI записано: {self.pois_upserted}, помечено неактивными: {self.pois_deactivated}")
        if self.poi_in_city:
            lines.append(
                f"В полигоне города: {self.poi_in_city} POI; "
                f"ячеек {self.cells_total}, строк статистики {self.stats_rows}"
            )
        if self.data_version:
            lines.append(f"Версия данных: {self.data_version}")
        lines.append(f"Шаги: {' → '.join(self.steps)}")
        lines.append(f"Время: {self.seconds:.1f} с")
        return "\n".join(lines)


def _iter_batches(path: Path, size: int) -> Iterator[tuple[PoiRecord, ...]]:
    yield from batched(iter_dump(path), size, strict=False)


async def refresh_city(
    engine: AsyncEngine,
    *,
    slug: str,
    pbf: Path | None = None,
    from_dump: Path | None = None,
    skip_import: bool = False,
    dry_run: bool = False,
    data_version: str | None = None,
    source: str = "geofabrik",
    batch_size: int = 5000,
    limit: int | None = None,
) -> CityRefreshResult:
    """Обновить данные одного города. Идемпотентно: повторный запуск даёт те же цифры."""
    started = time.perf_counter()
    result = CityRefreshResult(city_slug=slug, city_name=slug)

    # 1. Справочник категорий: обновляется по slug, поэтому повторный запуск безопасен
    async with session_scope(engine) as session:
        result.categories = len(await seed_categories(session))
    result.steps.append("справочники")

    dump_path: Path | None = from_dump
    osm_timestamp: str | None = None

    # 2. Импорт POI: скан выгрузки → запись в БД с мягким удалением
    if not skip_import:
        if pbf is None and from_dump is None:
            raise ImportError_("нужен --pbf (выгрузка OSM) или --from-dump (файл кандидатов)")
        if pbf is not None and not pbf.exists():
            raise ImportError_(f"файл выгрузки не найден: {pbf}")
        if from_dump is not None and not from_dump.exists():
            raise ImportError_(f"файл кандидатов не найден: {from_dump}")

        async with session_scope(engine) as session:
            scopes = await load_city_scopes(session, [slug])
            if not scopes:
                raise ImportError_(f"город '{slug}' не найден — сначала сид: python -m geopuls.seed --city {slug}")
            category_ids = await load_category_ids(session)
            if not category_ids:
                raise ImportError_("нет активных категорий — сначала сид: python -m geopuls.seed --skip-city")
            result.city_name = scopes[0].name
            run_id, _started_at = await start_import_run(session, source=source, source_url=str(pbf or from_dump))

        if pbf is not None:
            dump_path = default_dump_path(pbf)
            stats = scan_pbf(pbf, scopes, dump_path=dump_path, batch_size=batch_size, limit=limit)
            print(stats.describe())
            osm_timestamp = stats.osm_timestamp
        else:
            # Дата данных берётся из метаданных файла кандидатов, иначе версия стала бы датой импорта
            meta_timestamp = read_dump_meta(dump_path).get("osm_timestamp")  # type: ignore[arg-type]
            if meta_timestamp:
                osm_timestamp = str(meta_timestamp)

        version = resolve_data_version(data_version, osm_timestamp)
        result.data_version = version

        if dry_run:
            async with session_scope(engine) as session:
                await finish_import_run(session, run_id, status="dry-run")
            result.steps.append("импорт (dry-run)")
        else:
            try:
                async with session_scope(engine) as session:
                    watermark = await fetch_watermark(session)
                    for batch in _iter_batches(dump_path, batch_size):  # type: ignore[arg-type]
                        result.pois_upserted += await upsert_records(
                            session, batch, category_ids=category_ids, source=source
                        )
                    if limit is None:
                        result.pois_deactivated = await deactivate_missing(session, source=source, watermark=watermark)
                    await publish_data_version(session, version)
                    await finish_import_run(
                        session,
                        run_id,
                        status="ok",
                        osm_timestamp=osm_timestamp,
                        pois_upserted=result.pois_upserted,
                    )
            except Exception as exc:
                async with session_scope(engine) as session:
                    await finish_import_run(session, run_id, status="failed", error=f"{type(exc).__name__}: {exc}")
                raise
            result.steps.append("импорт POI")
    else:
        result.steps.append("импорт пропущен")

    # 3. Агрегация: полная пересборка сетки и статистики по городу
    settings = get_settings()
    async with session_scope(engine) as session:
        run_id, _started_at = await start_import_run(session, source="aggregate", source_url=None)
    async with session_scope(engine) as session:
        aggregate = await aggregate_city(
            session,
            slug,
            DEFAULT_RESOLUTIONS,
            dry_run=dry_run,
            legend_classes=settings.legend_classes,
        )
        result.city_name = aggregate.city_name
        result.poi_in_city = aggregate.poi_in_city
        result.cells_total = sum(aggregate.cells_total.values())
        result.stats_rows = result.cells_total * result.categories
        await finish_import_run(
            session,
            run_id,
            status="dry-run" if dry_run else "ok",
            pois_upserted=aggregate.poi_in_city,
            cells_written=result.cells_total,
        )
    print(aggregate.describe())
    result.steps.append("агрегация (dry-run)" if dry_run else "агрегация")

    result.seconds = round(time.perf_counter() - started, 1)
    return result


async def run(args: argparse.Namespace) -> int:
    engine = create_engine(get_settings())
    try:
        for slug in args.city:
            result = await refresh_city(
                engine,
                slug=slug,
                pbf=args.pbf,
                from_dump=args.from_dump,
                skip_import=args.skip_import,
                dry_run=args.dry_run,
                data_version=args.data_version,
                source=args.source,
                batch_size=args.batch_size,
                limit=args.limit,
            )
            print(result.describe())
        return 0
    finally:
        await engine.dispose()


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Обновление данных города одной командой")
    parser.add_argument("--city", action="append", required=True, help="slug города (можно повторять)")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--pbf", type=Path, help="выгрузка OSM (.osm.pbf)")
    source.add_argument("--from-dump", dest="from_dump", type=Path, help="готовый файл кандидатов (JSONL)")
    parser.add_argument("--skip-import", dest="skip_import", action="store_true", help="только пересобрать агрегаты")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true", help="посчитать без записи в БД")
    parser.add_argument("--data-version", dest="data_version", help="версия данных (по умолчанию дата выгрузки)")
    parser.add_argument("--source", default="geofabrik", help="метка источника данных")
    parser.add_argument("--batch-size", dest="batch_size", type=int, default=5000)
    parser.add_argument("--limit", type=int, default=None, help="ограничить число POI (отладка)")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    enable_utf8_console()
    args = parse_args(argv)
    try:
        return asyncio.run(run(args))
    except (ImportError_, AggregateError) as exc:
        print(f"Ошибка: {exc}")
        return 2
    except KeyboardInterrupt:
        print("Обновление прервано пользователем")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
