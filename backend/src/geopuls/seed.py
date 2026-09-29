"""Сидирование справочников: категории POI и города.

Идемпотентно: повторный запуск обновляет записи по `slug`, а не создаёт дубликаты.

Запуск (категории + город Томск):
    uv run python -m geopuls.seed \\
        --city tomsk --city-name "Томск" --region "Томская область" \\
        --timezone Asia/Tomsk --boundary-file data/raw/tomsk-boundary.json

Только категории:
    uv run python -m geopuls.seed --skip-city
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlalchemy.sql import func

from geopuls.categories import MVP_CATEGORIES
from geopuls.config import get_settings
from geopuls.console import enable_utf8_console
from geopuls.db import create_engine, session_scope
from geopuls.importers.boundary import CityBoundary, load_boundary
from geopuls.layers_catalog import LAYERS
from geopuls.models import Category, Dataset, Layer

#: Слой, в который попадают сегодняшние категории POI (ADR 0013).
COMPETITORS_LAYER = "competitors"


def build_category_rows() -> list[dict[str, Any]]:
    """Категории: восемь категорий конкурентов и по одной на каждый слой из каталога.

    Категория — это вариант внутри слоя, а её `osm_tags` — данные, а не код: новый слой из OSM
    добавляется сидом (ADR 0013). Принадлежность категории к слою проставляет `seed_categories`.
    """
    rows: list[dict[str, Any]] = [
        {
            "slug": category.slug,
            "name_ru": category.name_ru,
            "osm_tags": category.as_osm_tags(),
            "color": category.color,
            "sort_order": index,
        }
        for index, category in enumerate(MVP_CATEGORIES)
    ]

    offset = len(rows)
    for layer in LAYERS:
        for index, category in enumerate(layer.categories):
            rows.append(
                {
                    "slug": category.slug,
                    "name_ru": category.name_ru,
                    "osm_tags": category.as_osm_tags(),
                    "color": layer.color,
                    "sort_order": offset + index,
                }
            )
        offset += len(layer.categories)
    return rows


def category_slugs_by_layer() -> dict[str, list[str]]:
    """Какие категории принадлежат какому слою: по этому списку проставляется `categories.layer_id`."""
    mapping: dict[str, list[str]] = {COMPETITORS_LAYER: [category.slug for category in MVP_CATEGORIES]}
    for layer in LAYERS:
        mapping[layer.slug] = [category.slug for category in layer.categories]
    return mapping


def build_city_params(
    *,
    slug: str,
    name: str,
    region: str | None,
    timezone: str | None,
    h3_res: int,
    boundary: CityBoundary,
) -> dict[str, Any]:
    """Параметры запроса на вставку города: геометрия передаётся как GeoJSON."""
    return {
        "slug": slug,
        "name": name,
        "region": region,
        "timezone": timezone,
        "h3_res": h3_res,
        "osm_relation_id": boundary.osm_id or None,
        "geometry": json.dumps(boundary.geometry, ensure_ascii=False),
        "boundary_source": "nominatim",
    }


def build_dataset_rows() -> list[dict[str, Any]]:
    """Источники данных: лицензия и атрибуция нужны и в интерфейсе, и в экспорте (ADR 0013)."""
    return [
        {
            "slug": "osm",
            "title": "OpenStreetMap (Geofabrik)",
            "license": "ODbL 1.0",
            "license_url": "https://opendatacommons.org/licenses/odbl/1-0/",
            "attribution_text": "© OpenStreetMap contributors",
            "source_url": "https://download.geofabrik.de/russia/siberian-fed-district-latest.osm.pbf",
        }
    ]


def build_layer_rows(dataset_ids: dict[str, Any]) -> list[dict[str, Any]]:
    """Слои карты: «Конкуренты» и слои OSM из каталога (Этапы 8–9).

    Состав слоёв и их метрики живут в `geopuls.layers_catalog` — оттуда же их берёт агрегатор.
    Здесь только приведение к строкам таблицы `layers`.
    """
    osm_dataset = dataset_ids.get("osm")
    rows: list[dict[str, Any]] = [
        {
            "slug": COMPETITORS_LAYER,
            "name_ru": "Конкуренты (объекты по категориям)",
            "kind": "osm",
            "metric_kind": "density",
            "unit": "POI/км²",
            "scale": "quantile",
            "color": "#1f6fb2",
            "can_be_base": True,
            "dataset_id": osm_dataset,
            "sort_order": 10,
        }
    ]
    rows.extend(
        {
            "slug": layer.slug,
            "name_ru": layer.name_ru,
            "kind": "osm",
            "metric_kind": layer.metric_kind,
            "unit": layer.unit,
            "scale": layer.scale,
            "color": layer.color,
            "can_be_base": layer.can_be_base,
            "dataset_id": osm_dataset,
            "sort_order": layer.sort_order,
        }
        for layer in LAYERS
    )
    return rows


async def seed_datasets(session: AsyncSession) -> dict[str, int]:
    """Записать источники данных. Возвращает slug → id."""
    rows = build_dataset_rows()
    table = Dataset.__table__
    statement = pg_insert(table).values(rows)
    statement = statement.on_conflict_do_update(
        index_elements=[table.c.slug],
        set_={
            "title": statement.excluded.title,
            "license": statement.excluded.license,
            "license_url": statement.excluded.license_url,
            "attribution_text": statement.excluded.attribution_text,
            "source_url": statement.excluded.source_url,
            "updated_at": func.now(),
        },
    )
    await session.execute(statement)
    result = await session.execute(select(table.c.slug, table.c.id))
    return dict(result.all())


async def seed_layers(session: AsyncSession, dataset_ids: dict[str, int]) -> list[str]:
    """Записать слои карты. Возвращает список slug'ов."""
    rows = build_layer_rows(dataset_ids)
    table = Layer.__table__
    statement = pg_insert(table).values(rows)
    statement = statement.on_conflict_do_update(
        index_elements=[table.c.slug],
        set_={
            "name_ru": statement.excluded.name_ru,
            "kind": statement.excluded.kind,
            "metric_kind": statement.excluded.metric_kind,
            "unit": statement.excluded.unit,
            "scale": statement.excluded.scale,
            "color": statement.excluded.color,
            "can_be_base": statement.excluded.can_be_base,
            "dataset_id": statement.excluded.dataset_id,
            "sort_order": statement.excluded.sort_order,
            "is_active": True,
        },
    )
    await session.execute(statement)
    return [row["slug"] for row in rows]


async def seed_categories(session: AsyncSession) -> list[str]:
    """Записать справочники: источники, слои и категории MVP.

    Порядок обязателен: категория ссылается на слой, слой — на источник. Повторный запуск
    безопасен (вставка или обновление по `slug`), а принадлежность категории к слою проставляется
    по каталогу: категория без слоя не должна «повисать» вне слоёв.
    """
    dataset_ids = await seed_datasets(session)
    await seed_layers(session, dataset_ids)
    rows = build_category_rows()
    table = Category.__table__
    statement = pg_insert(table).values(rows)
    statement = statement.on_conflict_do_update(
        index_elements=[table.c.slug],
        set_={
            "name_ru": statement.excluded.name_ru,
            "osm_tags": statement.excluded.osm_tags,
            "color": statement.excluded.color,
            "sort_order": statement.excluded.sort_order,
            "is_active": True,
        },
    )
    await session.execute(statement)
    for layer_slug, slugs in category_slugs_by_layer().items():
        await session.execute(
            text(
                "UPDATE categories SET layer_id = (SELECT id FROM layers WHERE slug = :layer) "
                "WHERE slug = ANY(CAST(:slugs AS text[]))"
            ),
            {"layer": layer_slug, "slugs": slugs},
        )
    return [row["slug"] for row in rows]


async def seed_city(session: AsyncSession, params: dict[str, Any]) -> dict[str, Any]:
    """Записать город вместе с полигоном, bbox и центроидом. Возвращает контрольные числа.

    Геометрию считает PostGIS: GeoJSON → MULTIPOLYGON, `ST_Envelope` → bbox,
    `ST_PointOnSurface` → центр внутри полигона (в отличие от центроида).
    """
    statement = text(
        """
        INSERT INTO cities (
            slug, name, region, osm_relation_id, boundary, bbox, center,
            h3_res, timezone, boundary_source, updated_at
        )
        VALUES (
            :slug, :name, :region, :osm_relation_id,
            ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(:geometry), 4326))::geography,
            ST_Envelope(ST_SetSRID(ST_GeomFromGeoJSON(:geometry), 4326))::geography,
            ST_PointOnSurface(ST_SetSRID(ST_GeomFromGeoJSON(:geometry), 4326))::geography,
            :h3_res, :timezone, :boundary_source, now()
        )
        ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name,
            region = EXCLUDED.region,
            osm_relation_id = EXCLUDED.osm_relation_id,
            boundary = EXCLUDED.boundary,
            bbox = EXCLUDED.bbox,
            center = EXCLUDED.center,
            h3_res = EXCLUDED.h3_res,
            timezone = EXCLUDED.timezone,
            boundary_source = EXCLUDED.boundary_source,
            updated_at = now()
        RETURNING id, ST_Area(boundary) / 1000000 AS area_km2
        """
    )
    result = await session.execute(statement, params)
    row = result.mappings().one()
    return {"city_id": row["id"], "area_km2": round(float(row["area_km2"]), 1)}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Сидирование категорий и городов ГЕОПУЛЬС")
    parser.add_argument("--city", default=None, help="slug города (например, tomsk)")
    parser.add_argument("--city-name", dest="city_name", default=None, help="название города")
    parser.add_argument("--region", default=None, help="регион")
    parser.add_argument("--timezone", default=None, help="часовой пояс (например, Asia/Tomsk)")
    parser.add_argument("--h3-res", dest="h3_res", type=int, default=9)
    parser.add_argument("--boundary-file", dest="boundary_file", type=Path, default=None)
    parser.add_argument("--skip-city", action="store_true", help="сидировать только категории")
    return parser.parse_args(argv)


async def run(args: argparse.Namespace, engine: AsyncEngine) -> int:
    async with session_scope(engine) as session:
        slugs = await seed_categories(session)
        print(f"Категории: {len(slugs)} — {', '.join(slugs)}")

        if args.skip_city:
            return 0

        if not args.city or not args.city_name:
            print("Город не сидирован: нужны --city и --city-name (или используйте --skip-city)")
            return 0

        if not args.boundary_file:
            print("Город не сидирован: не задан --boundary-file")
            return 1

        boundary = load_boundary(args.boundary_file)
        params = build_city_params(
            slug=args.city,
            name=args.city_name,
            region=args.region,
            timezone=args.timezone,
            h3_res=args.h3_res,
            boundary=boundary,
        )
        result = await seed_city(session, params)
        print(
            f"Город: {args.city_name} (id={result['city_id']}, площадь {result['area_km2']} км², "
            f"источник границы: {params['boundary_source']}, relation {params['osm_relation_id']})"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    enable_utf8_console()
    args = parse_args(argv)
    engine = create_engine(get_settings())

    async def _run() -> int:
        try:
            return await run(args, engine)
        finally:
            await engine.dispose()

    return asyncio.run(_run())


if __name__ == "__main__":
    raise SystemExit(main())
