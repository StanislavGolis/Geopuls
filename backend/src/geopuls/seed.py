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

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from geopuls.categories import MVP_CATEGORIES
from geopuls.config import get_settings
from geopuls.db import create_engine, session_scope
from geopuls.importers.boundary import CityBoundary, load_boundary
from geopuls.models import Category


def build_category_rows() -> list[dict[str, Any]]:
    """Строки для вставки в `categories` из утверждённого маппинга (см. docs/recon/)."""
    return [
        {
            "slug": category.slug,
            "name_ru": category.name_ru,
            "osm_tags": category.as_osm_tags(),
            "color": category.color,
            "sort_order": index,
        }
        for index, category in enumerate(MVP_CATEGORIES)
    ]


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


async def seed_categories(session: AsyncSession) -> list[str]:
    """Записать категории MVP: вставка или обновление по `slug`."""
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
