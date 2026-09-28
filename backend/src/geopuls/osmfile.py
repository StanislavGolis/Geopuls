"""Работа с файлами OSM: метаданные выгрузки.

Дата данных (`osm_timestamp`) — обязательная часть продукта: она попадает в `import_runs`,
`data_versions` и в интерфейс («Данные OSM на <дата>»).
"""

from __future__ import annotations

from pathlib import Path

import osmium

#: Ключи заголовка PBF, где может лежать дата данных (порядок проверки).
TIMESTAMP_KEYS = ("osmosis_replication_timestamp", "timestamp")


def read_osm_timestamp(path: Path) -> str | None:
    """Прочитать дату данных из заголовка PBF, если она там записана."""
    try:
        header = osmium.io.Reader(str(path)).header()
        for key in TIMESTAMP_KEYS:
            value = header.get(key)
            if value:
                return str(value)
    except Exception:  # noqa: BLE001 — отсутствие заголовка не должно ломать импорт
        return None
    return None
