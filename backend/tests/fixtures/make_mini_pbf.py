"""Помощник: генерация крошечной PBF-фикстуры для тестов импортёра.

Запуск (Windows: путь должен лежать на том же диске, что и TEMP — pyosmium пишет PBF
через временный файл и переименовывает его):

    uv run python backend/tests/fixtures/make_mini_pbf.py backend/tests/fixtures/mini-tomsk.osm.pbf

В фикстуре: кофейня и аптека в Томске (кофейня с адресом), кафе вне bbox и полигон-супермаркет
shop=supermarket (4 узла, brand) — этого достаточно, чтобы проверить фильтр по bbox, категории,
связь многие-ко-многим и признак адреса.
"""

from __future__ import annotations

import sys
from pathlib import Path

import osmium
import osmium.osm.mutable as mutable

TOMSK_LON, TOMSK_LAT = 84.9482, 56.4847


def build(path: str) -> None:
    writer = osmium.SimpleWriter(path)

    def add_node(node_id: int, tags: dict[str, str], lon: float, lat: float) -> None:
        writer.add_node(mutable.Node(id=node_id, tags=tags, location=osmium.osm.Location(lon, lat)))

    add_node(
        1,
        {"amenity": "cafe", "name": "Тестовая кофейня", "addr:street": "ул. Ленина", "addr:housenumber": "1"},
        TOMSK_LON,
        TOMSK_LAT,
    )
    add_node(2, {"amenity": "pharmacy", "name": "Тестовая аптека"}, TOMSK_LON + 0.01, TOMSK_LAT + 0.01)
    add_node(3, {"amenity": "cafe", "name": "Кафе вне города"}, 20.4522, 54.7104)

    square = [
        (TOMSK_LON + 0.002, TOMSK_LAT + 0.002),
        (TOMSK_LON + 0.004, TOMSK_LAT + 0.002),
        (TOMSK_LON + 0.004, TOMSK_LAT + 0.004),
        (TOMSK_LON + 0.002, TOMSK_LAT + 0.004),
    ]
    for offset, (lon, lat) in enumerate(square, start=4):
        add_node(offset, {}, lon, lat)

    writer.add_way(
        mutable.Way(
            id=100,
            tags={"shop": "supermarket", "name": "Тестовый супермаркет", "brand": "Тестовая сеть"},
            nodes=[4, 5, 6, 7, 4],
        )
    )
    writer.close()


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 1:
        print(__doc__)
        return 2
    target = Path(args[0])
    build(str(target))
    print(f"Готово: {target} ({target.stat().st_size} байт)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
