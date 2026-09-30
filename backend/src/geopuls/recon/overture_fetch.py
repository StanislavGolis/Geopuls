"""Выгрузка срезов Overture Maps по bbox города — первый шаг разведки (см. `overture_scan`).

Зачем отдельная команда: полный релиз темы — это файлы по 650–720 МБ и десятки гигабайт на тему,
а для разведки нужен только bbox города. DuckDB читает лишь нужные row groups (в Overture у каждой
темы есть колонка `bbox` со статистикой), поэтому срез снимается за минуты и дальше анализ идёт
по локальному файлу — без сети.

    cd backend
    uv run --with duckdb python -m geopuls.recon.overture_fetch --release 2026-09-23.1

Почему зеркало Azure, а не S3: с рабочих машин провайдер по-разному ломает доступ к S3 —
`overturemaps-us-west-2.s3.amazonaws.com` может не отвечать, а path-style адрес обрывает передачу
данных на чтении row groups (метаданные читаются, поэтому `count(*)` проходит). Зеркало Azure отдаёт
те же объекты: обе пробы по Томску дали одинаковые 3 951 place — это и есть перекрёстная проверка.

Срезы кладутся в `data/raw/overture/` и в git не попадают (`data/raw` под `.gitignore`): это данные,
а не код. Повторный запуск пропускает уже снятые срезы, но пустой файл готовым не считает — именно так
выглядел срез, загрузку которого прервали.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

#: Релиз по умолчанию — тот, на котором сделана разведка 30.09.2026.
DEFAULT_RELEASE = "2026-09-23.1"
#: bbox Томска с запасом (как в разведке OSM): min_lon, min_lat, max_lon, max_lat.
DEFAULT_BBOX = "84.70,56.30,85.30,56.65"
SLICES: dict[str, tuple[str, str]] = {
    "places": ("places", "place"),
    "infrastructure": ("base", "infrastructure"),
    "buildings": ("buildings", "building"),
}
#: Корень репозитория от этого файла: backend/src/geopuls/recon/overture_fetch.py
REPO_ROOT = Path(__file__).resolve().parents[4]


def fetch(release: str, bbox: tuple[float, float, float, float], out_dir: Path, only: list[str] | None) -> None:
    import duckdb

    xmin, ymin, xmax, ymax = bbox
    where = f"bbox.xmin BETWEEN {xmin} AND {xmax} AND bbox.ymin BETWEEN {ymin} AND {ymax}"

    con = duckdb.connect()
    con.execute("INSTALL azure; LOAD azure;")
    con.execute("CREATE SECRET (TYPE azure, PROVIDER config, ACCOUNT_NAME 'overturemapswestus2')")

    out_dir.mkdir(parents=True, exist_ok=True)
    for name, (theme, type_) in SLICES.items():
        if only and name not in only:
            continue

        target = out_dir / f"{name}-tomsk-{release}.geoparquet"
        if target.exists() and target.stat().st_size > 0:
            print(f"{name}: уже есть, пропускаю")
            continue

        source = f"az://release/{release}/theme={theme}/type={type_}/*.parquet"
        started = time.perf_counter()
        con.execute(f"COPY (SELECT * FROM read_parquet('{source}') WHERE {where}) TO '{target}' (FORMAT PARQUET)")
        rows = con.execute(f"SELECT count(*) FROM read_parquet('{target}')").fetchone()[0]
        size_mb = target.stat().st_size / 1024 / 1024
        print(f"{name}: {rows} объектов, {size_mb:.1f} МБ, {time.perf_counter() - started:.1f} с")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Выгрузка срезов Overture Maps по bbox города (разведка)")
    parser.add_argument("--release", default=DEFAULT_RELEASE, help="версия релиза Overture")
    parser.add_argument("--bbox", default=DEFAULT_BBOX, help="min_lon,min_lat,max_lon,max_lat")
    parser.add_argument("--out-dir", type=Path, default=REPO_ROOT / "data" / "raw" / "overture")
    parser.add_argument("--only", nargs="*", default=None, help="снять только эти темы (по умолчанию все)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    bbox = tuple(float(value) for value in args.bbox.split(","))  # type: ignore[assignment]
    if len(bbox) != 4:
        raise SystemExit("--bbox задаётся как min_lon,min_lat,max_lon,max_lat")
    fetch(args.release, bbox, args.out_dir, args.only)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
