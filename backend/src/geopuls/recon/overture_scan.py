"""Разведка Overture Maps: что даёт источник по нашему городу и чего в нём нет.

Зачем отдельная разведка: Overture в ТЗ заложен «резервом по POI (фаза 2)», и до решения его
надо измерить так же, как измеряли OSM на Этапе 0.5 — числами по нашему городу, а не по
обещаниям каталога. Скрипт отвечает на три вопроса:

1. Сколько объектов Overture в границах города и какого качества (имя, адрес, бренд, точность,
   свежесть, источники и их лицензии).
2. Сколько объектов попадает в **наши** категории и сколько из них мы не видим в OSM
   (совпадением считаем объект той же категории в пределах ``MATCH_DEG`` — тот же порог, что
   в дедупликации остановок, ±30 м).
3. Что дают не-POI темы: ``infrastructure`` (остановки и прочее) и ``buildings``.

Зависимость только одна — DuckDB (читает geoparquet и считает пространственные предикаты):

    cd backend
    uv run --with duckdb python -m geopuls.recon.overture_scan \\
        --places ../data/raw/overture/places-tomsk-2026-09-23.1.geoparquet \\
        --infrastructure ../data/raw/overture/infrastructure-tomsk-2026-09-23.1.geoparquet \\
        --boundary ../data/raw/tomsk-boundary.json \\
        --our-pois ../data/processed/our-pois.csv \\
        --out-json ../docs/recon/tomsk-overture.json \\
        --out-md ../docs/recon/tomsk-overture.md

Наши POI выгружаются из БД отдельным шагом (``data/processed/export-our-pois.sql``): категории —
строками, координаты — ``lat,lon``. Так скрипт не зависит от PostGIS-типов, на которых спотыкается
чтение Postgres через DuckDB.

Почему релиз зафиксирован: Overture обновляется ежемесячно, а числа разведки должны быть
воспроизводимы. Версия релиза видна в имени файла среза, и она же попадает в отчёт.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

#: Совпадением «тот же объект» считаем расстояние по обеим осям меньше этого значения в градусах.
#: 0.0003° — это ±33 м по широте и ±18 м по долготе на широте Томска, то есть тот же порядок, что
#: ±30 м в дедупликации остановок (`layers_catalog.DEDUP_RADIUS_M`). Порог нужен, чтобы не считать
#: «новым» объект, который в OSM уже есть, но стоит на пару метров иначе.
MATCH_DEG = 0.0003

#: Наши категории (backend/src/geopuls/categories.py) → значения таксономии Overture.
#: Сопоставление сделано вручную по фактическому списку значений в Томске: Overture размечает
#: заведения детальнее (`pizza_restaurant`), поэтому часть значений входит в нашу категорию.
OURS: dict[str, tuple[str, ...]] = {
    "cafe": ("cafe", "coffee_shop"),
    "restaurant": ("restaurant", "fast_food_restaurant"),
    "bar": ("bar", "pub", "beer_bar", "wine_bar", "cocktail_bar", "hookah_bar", "gastropub"),
    "pharmacy": ("pharmacy", "drugstore"),
    "beauty": ("beauty_salon", "barber", "hair_salon", "nail_salon", "tanning_salon", "hair_removal"),
    "fitness": ("gym", "sport_or_fitness_facility"),
    "grocery": ("grocery_store", "convenience_store", "organic_grocery_store", "supermarket"),
    # Пункты выдачи: в Overture это почти не размечено — сюда попадают почта и пункты отправки,
    # что не то же самое, что `shop=outpost` в OSM. Строка оставлена честно, чтобы это было видно.
    "pickup_point": ("post_office", "shipping_center", "parcel_locker"),
}

#: Транзитные классы в base/infrastructure, которые соответствуют нашему слою transport_stops.
TRANSIT_CLASSES = ("stop_position", "bus_stop", "railway_station", "railway_halt", "tram_stop", "subway_entrance")


@dataclass(slots=True)
class Section:
    """Раздел отчёта: заголовок, строки-факты и таблицы."""

    title: str
    facts: dict[str, Any] = field(default_factory=dict)
    tables: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


def connect():
    """Подключение DuckDB с пространственным расширением."""
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    return con


def boundary_geojson(path: Path) -> str:
    """Геометрия города одной строкой GeoJSON: из FeatureCollection берём первую фичу."""
    body = json.loads(path.read_text(encoding="utf-8"))
    geometry = body["features"][0]["geometry"] if body.get("type") == "FeatureCollection" else body["geometry"]
    return json.dumps(geometry)


def rows_to_dicts(rows: list[tuple[Any, ...]], keys: list[str]) -> list[dict[str, Any]]:
    return [dict(zip(keys, row, strict=False)) for row in rows]


def count(con, sql: str) -> int:
    return int(con.execute(sql).fetchone()[0])


def scan_places(con, places: Path, boundary: Path, center: tuple[float, float], radius_km: float) -> Section:
    """Тема places: объём, качество, категории, источники и свежесть."""
    con.execute("CREATE OR REPLACE TABLE city AS SELECT ST_GeomFromGeoJSON(?) AS geom", [boundary_geojson(boundary)])

    # Радиус «ядра» в градусах: грубая оценка по широте (0.009° на километр) — этого достаточно,
    # чтобы отсечь пригороды; та же роль, что у колонки «в ядре» в разведке OSM.
    core_deg = radius_km * 0.009
    source = f"read_parquet('{places.as_posix()}')"

    con.execute(
        f"CREATE OR REPLACE TABLE places_city AS SELECT p.* FROM {source} p, city c WHERE ST_Within(p.geometry, c.geom)"
    )

    quality = con.execute("""
        SELECT
            round(100.0 * count(*) FILTER (WHERE names.primary IS NOT NULL) / count(*), 1),
            round(100.0 * count(*) FILTER (WHERE addresses[1].freeform IS NOT NULL
                                             OR addresses[1].locality IS NOT NULL
                                             OR addresses[1].postcode IS NOT NULL) / count(*), 1),
            round(100.0 * count(*) FILTER (WHERE brand.names.primary IS NOT NULL) / count(*), 1),
            round(avg(confidence), 3)
        FROM places_city
    """).fetchone()
    freshness = con.execute("""
        SELECT min(s.update_time), max(s.update_time)
        FROM (SELECT unnest(sources) AS s FROM places_city)
    """).fetchone()

    facts = {
        "релиз Overture": places.stem.replace("places-tomsk-", ""),
        "всего в bbox": count(con, f"SELECT count(*) FROM {source}"),
        "в границах города": count(con, "SELECT count(*) FROM places_city"),
        "радиус ядра, км": radius_km,
        "в ядре": count(
            con,
            f"""SELECT count(*) FROM places_city
                WHERE ST_Distance(geometry, ST_Point({center[1]}, {center[0]})) <= {core_deg}""",
        ),
        "с названием, %": quality[0],
        "с адресом, %": quality[1],
        "с брендом, %": quality[2],
        "средняя confidence": quality[3],
        "заполненный operating_status": count(
            con, "SELECT count(*) FROM places_city WHERE operating_status IS NOT NULL"
        ),
        "источник обновлялся с": freshness[0],
        "источник обновлялся по": freshness[1],
    }

    tables = {
        "basic_category (топ-25)": rows_to_dicts(
            con.execute("""
                SELECT coalesce(basic_category, '—') AS category, count(*) AS places
                FROM places_city GROUP BY 1 ORDER BY 2 DESC LIMIT 25
            """).fetchall(),
            ["category", "places"],
        ),
        "taxonomy.primary (топ-30)": rows_to_dicts(
            con.execute("""
                SELECT coalesce(taxonomy.primary, '—') AS category, count(*) AS places
                FROM places_city GROUP BY 1 ORDER BY 2 DESC LIMIT 30
            """).fetchall(),
            ["category", "places"],
        ),
        "источники и лицензии": rows_to_dicts(
            con.execute("""
                SELECT s.dataset AS dataset, s.license AS license, count(*) AS records
                FROM (SELECT unnest(sources) AS s FROM places_city) GROUP BY 1, 2 ORDER BY 3 DESC
            """).fetchall(),
            ["dataset", "license", "records"],
        ),
        "confidence": rows_to_dicts(
            con.execute("""
                SELECT CASE
                           WHEN confidence < 0.25 THEN '0.00–0.25'
                           WHEN confidence < 0.50 THEN '0.25–0.50'
                           WHEN confidence < 0.75 THEN '0.50–0.75'
                           ELSE '0.75–1.00'
                       END AS bucket,
                       count(*) AS places
                FROM places_city GROUP BY 1 ORDER BY 1
            """).fetchall(),
            ["bucket", "places"],
        ),
    }
    return Section("Overture places", facts, tables)


def scan_infrastructure(con, infrastructure: Path, center: tuple[float, float], radius_km: float) -> Section:
    """Тема base/infrastructure: что в ней есть и из какого источника взяты данные."""
    source = f"read_parquet('{infrastructure.as_posix()}')"
    core_deg = radius_km * 0.009
    transit = ", ".join(f"'{value}'" for value in TRANSIT_CLASSES)
    facts = {
        "всего в bbox": count(con, f"SELECT count(*) FROM {source}"),
        "в ядре": count(
            con,
            f"""SELECT count(*) FROM {source}
                WHERE ST_Distance(geometry, ST_Point({center[1]}, {center[0]})) <= {core_deg}""",
        ),
        "транзит (классы остановок)": count(con, f"SELECT count(*) FROM {source} WHERE class IN ({transit})"),
    }
    tables = {
        "class (топ-20)": rows_to_dicts(
            con.execute(f"""
                SELECT coalesce(class, '—') AS class, count(*) AS features
                FROM {source} GROUP BY 1 ORDER BY 2 DESC LIMIT 20
            """).fetchall(),
            ["class", "features"],
        ),
        "источники и лицензии": rows_to_dicts(
            con.execute(f"""
                SELECT s.dataset AS dataset, s.license AS license, count(*) AS records
                FROM (SELECT unnest(sources) AS s FROM {source}) GROUP BY 1, 2 ORDER BY 3 DESC
            """).fetchall(),
            ["dataset", "license", "records"],
        ),
    }
    return Section("Overture base/infrastructure", facts, tables)


def scan_comparison(con, our_pois: Path) -> Section:
    """Сравнение с нашим OSM-импортом по нашим категориям.

    «Нет у нас» — объект Overture, для которого в пределах ``MATCH_DEG`` нет нашего объекта той же
    категории. Это оценка снизу того, что даёт источник: часть объектов может быть у нас не размечена
    вовсе, а часть — стоять дальше порога и потому считаться новым.
    """
    con.execute(
        """
        CREATE OR REPLACE TABLE our_pois AS
        SELECT category, ST_Point(CAST(lon AS DOUBLE), CAST(lat AS DOUBLE)) AS geom
        FROM read_csv_auto(?)
        """,
        [our_pois.as_posix()],
    )

    rows: list[dict[str, Any]] = []
    for category, values in OURS.items():
        placeholders = ", ".join(f"'{value}'" for value in values)
        overture, ours, only_overture = con.execute(f"""
            WITH ov AS (SELECT geometry AS geom FROM places_city WHERE taxonomy.primary IN ({placeholders})),
                 us AS (SELECT geom FROM our_pois WHERE category = '{category}')
            SELECT (SELECT count(*) FROM ov),
                   (SELECT count(*) FROM us),
                   (SELECT count(*) FROM ov o WHERE NOT EXISTS (
                       SELECT 1 FROM us u
                       WHERE abs(ST_X(u.geom) - ST_X(o.geom)) < {MATCH_DEG}
                         AND abs(ST_Y(u.geom) - ST_Y(o.geom)) < {MATCH_DEG}
                   ))
        """).fetchone()
        rows.append(
            {
                "категория": category,
                "Overture": int(overture),
                "наши (OSM)": int(ours),
                "нет у нас": int(only_overture),
                "доля новых, %": round(100.0 * only_overture / overture, 1) if overture else None,
                "значения Overture": ", ".join(values),
            }
        )
    return Section("Сопоставление с нашими категориями (в границах города)", {}, {"категории": rows})


def scan_buildings(con, buildings: Path, boundary: Path) -> Section | None:
    """Тема buildings: объём и суммарная площадь (если срез снят)."""
    if not buildings.exists() or buildings.stat().st_size == 0:
        return None
    con.execute("CREATE OR REPLACE TABLE city_b AS SELECT ST_GeomFromGeoJSON(?) AS geom", [boundary_geojson(boundary)])
    source = f"read_parquet('{buildings.as_posix()}')"
    con.execute(
        f"CREATE OR REPLACE TABLE buildings_city AS "
        f"SELECT b.* FROM {source} b, city_b c WHERE ST_Within(b.geometry, c.geom)"
    )
    area_km2 = con.execute("""
        SELECT coalesce(sum(ST_Area(ST_Transform(geometry, 'EPSG:4326', 'EPSG:32645'))), 0) / 1000000.0
        FROM buildings_city
    """).fetchone()[0]
    facts = {
        "всего в bbox": count(con, f"SELECT count(*) FROM {source}"),
        "в границах города": count(con, "SELECT count(*) FROM buildings_city"),
        # Площадь нужна в метрах: геометрия хранится в градусах, поэтому проекция UTM 45N (зона Томска)
        "площадь в границах города, км²": round(float(area_km2), 1),
    }
    tables = {
        "источники и лицензии": rows_to_dicts(
            con.execute("""
                SELECT s.dataset AS dataset, s.license AS license, count(*) AS records
                FROM (SELECT unnest(sources) AS s FROM buildings_city) GROUP BY 1, 2 ORDER BY 3 DESC
            """).fetchall(),
            ["dataset", "license", "records"],
        ),
    }
    return Section("Overture buildings", facts, tables)


def report_to_json(sections: list[Section], meta: dict[str, Any]) -> str:
    body = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        **meta,
        "sections": [
            {"title": section.title, "facts": section.facts, "tables": section.tables} for section in sections
        ],
    }
    return json.dumps(body, ensure_ascii=False, indent=2)


def report_to_markdown(sections: list[Section], meta: dict[str, Any]) -> str:
    lines = [
        "# Overture Maps по Томску: что измерили (разведка)",
        "",
        f"Сгенерировано: {datetime.now(UTC).isoformat(timespec='seconds')}. Машиночитаемый вариант — рядом, в `.json`.",
        "",
        "| Параметр | Значение |",
        "|---|---|",
    ]
    lines += [f"| {key} | {value} |" for key, value in meta.items()]
    for section in sections:
        lines += ["", f"## {section.title}", ""]
        if section.facts:
            lines += ["| Показатель | Значение |", "|---|---|"]
            lines += [f"| {key} | {value} |" for key, value in section.facts.items()]
        for name, rows in section.tables.items():
            if not rows:
                continue
            lines += ["", f"### {name}", ""]
            columns = list(rows[0].keys())
            lines.append("| " + " | ".join(columns) + " |")
            lines.append("|" + "---|" * len(columns))
            for row in rows:
                lines.append("| " + " | ".join(str(row.get(column, "")) for column in columns) + " |")
    lines.append("")
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Разведка Overture Maps по нашему городу (см. docs/recon)")
    parser.add_argument("--places", required=True, type=Path, help="geoparquet-срез темы places")
    parser.add_argument("--infrastructure", type=Path, default=None, help="срез base/infrastructure")
    parser.add_argument("--buildings", type=Path, default=None, help="срез buildings (если снят)")
    parser.add_argument("--boundary", required=True, type=Path, help="GeoJSON с границей города")
    parser.add_argument("--our-pois", required=True, type=Path, help="CSV наших POI: category,lat,lon")
    parser.add_argument("--city", default="tomsk")
    parser.add_argument("--center", default="56.4847,84.9482", help="lat,lon центра города")
    parser.add_argument("--radius-km", type=float, default=10.0, dest="radius_km")
    parser.add_argument("--out-json", type=Path, default=None)
    parser.add_argument("--out-md", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    lat, lon = (float(value) for value in args.center.split(","))
    center = (lat, lon)

    con = connect()
    sections = [
        scan_places(con, args.places, args.boundary, center, args.radius_km),
        scan_comparison(con, args.our_pois),
    ]
    if args.infrastructure:
        sections.append(scan_infrastructure(con, args.infrastructure, center, args.radius_km))
    if args.buildings:
        buildings_section = scan_buildings(con, args.buildings, args.boundary)
        if buildings_section:
            sections.append(buildings_section)

    meta = {
        "город": args.city,
        "центр": f"{lat}, {lon}",
        "порог совпадения, °": MATCH_DEG,
        "данные": "Overture Maps (публичный релиз), срезы сняты по bbox города",
    }

    if args.out_json:
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        args.out_json.write_text(report_to_json(sections, meta), encoding="utf-8")
        print(f"JSON: {args.out_json}")
    if args.out_md:
        args.out_md.parent.mkdir(parents=True, exist_ok=True)
        args.out_md.write_text(report_to_markdown(sections, meta), encoding="utf-8")
        print(f"Markdown: {args.out_md}")

    for section in sections:
        print(f"{section.title}: {section.facts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
