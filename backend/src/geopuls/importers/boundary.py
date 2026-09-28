"""Получение границы города из OSM через Nominatim.

Нужна для сидирования `cities`: по полигону города строятся H3-ячейки (Этап 3) и клип POI.

Важно:
- Nominatim — публичный сервис: обязателен идентифицирующий User-Agent и не более 1 запроса
  в секунду (политика использования). Граница города запрашивается один раз и кэшируется в файл.
- Ответ сохраняется вместе с лицензией ODbL и идентификатором relation — это происхождение
  данных, оно попадает в `cities.boundary_source` / `cities.osm_relation_id`.

Запуск:
    uv run python -m geopuls.importers.boundary --city "Томск" --out data/raw/tomsk-boundary.json
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search"
#: Требование политики Nominatim: понятный User-Agent с контактом.
USER_AGENT = "Geopuls/0.1 (city boundary import; contact: stanislav.golis@yandex.ru)"
#: Таймаут одного запроса, секунды.
REQUEST_TIMEOUT = 30.0
#: Разрешённые типы геометрии: город может быть одним полигоном или мультиполигоном.
ALLOWED_GEOMETRY_TYPES = {"Polygon", "MultiPolygon"}


class BoundaryError(RuntimeError):
    """Не удалось получить или разобрать границу города."""


@dataclass(slots=True)
class CityBoundary:
    """Граница города с происхождением данных."""

    name: str
    display_name: str
    osm_type: str
    osm_id: int
    license: str
    geometry: dict[str, Any]

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "osm_type": self.osm_type,
            "osm_id": self.osm_id,
            "license": self.license,
            "geometry": self.geometry,
        }

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> CityBoundary:
        """Разобрать наш формат, ответ Nominatim (FeatureCollection) или просто GeoJSON Feature."""
        if payload.get("type") == "FeatureCollection":
            features = payload.get("features") or []
            if not features:
                raise BoundaryError("в ответе Nominatim нет объектов")
            feature = features[0]
            properties = feature.get("properties") or {}
            return cls.from_json(
                {
                    "name": properties.get("name") or properties.get("display_name", ""),
                    "display_name": properties.get("display_name", ""),
                    "osm_type": properties.get("osm_type", ""),
                    "osm_id": int(properties.get("osm_id") or 0),
                    "license": payload.get("licence") or payload.get("license") or "",
                    "geometry": feature.get("geometry") or {},
                }
            )

        if payload.get("type") == "Feature":
            properties = payload.get("properties") or {}
            return cls.from_json(
                {
                    "name": properties.get("name") or properties.get("display_name", ""),
                    "display_name": properties.get("display_name", ""),
                    "osm_type": properties.get("osm_type", ""),
                    "osm_id": int(properties.get("osm_id") or 0),
                    "license": payload.get("license") or payload.get("licence") or "",
                    "geometry": payload.get("geometry") or {},
                }
            )

        geometry = payload.get("geometry") or {}
        geometry_type = geometry.get("type")
        if geometry_type not in ALLOWED_GEOMETRY_TYPES:
            raise BoundaryError(f"неожиданный тип геометрии: {geometry_type!r}")
        if not geometry.get("coordinates"):
            raise BoundaryError("в геометрии нет координат")

        return cls(
            name=str(payload.get("name") or ""),
            display_name=str(payload.get("display_name") or ""),
            osm_type=str(payload.get("osm_type") or ""),
            osm_id=int(payload.get("osm_id") or 0),
            license=str(payload.get("license") or ""),
            geometry=geometry,
        )


def fetch_boundary(city: str, *, client: httpx.Client | None = None) -> CityBoundary:
    """Запросить границу города у Nominatim (один запрос)."""
    params = {
        "q": city,
        "format": "geojson",
        "polygon_geojson": 1,
        "limit": 1,
        "addressdetails": 1,
    }
    own_client = client is None
    client = client or httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT)
    try:
        response = client.get(NOMINATIM_SEARCH_URL, params=params)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise BoundaryError(f"Nominatim недоступен: {exc}") from exc
    finally:
        if own_client:
            client.close()

    return CityBoundary.from_json(response.json())


def save_boundary(boundary: CityBoundary, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(boundary.to_json(), ensure_ascii=False, indent=2), encoding="utf-8")


def load_boundary(path: Path) -> CityBoundary:
    if not path.exists():
        raise BoundaryError(
            f"Файл границы не найден: {path}. Получите его командой: "
            f'uv run python -m geopuls.importers.boundary --city "Томск" --out {path}'
        )
    return CityBoundary.from_json(json.loads(path.read_text(encoding="utf-8")))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Получить границу города из OSM (Nominatim)")
    parser.add_argument("--city", required=True, help="название города для поиска")
    parser.add_argument("--out", required=True, type=Path, help="куда сохранить JSON")
    parser.add_argument("--force", action="store_true", help="перезапросить, даже если файл есть")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.out.exists() and not args.force:
        boundary = load_boundary(args.out)
        print(f"Файл уже есть: {args.out} ({boundary.display_name})")
        return 0

    boundary = fetch_boundary(args.city)
    save_boundary(boundary, args.out)
    print(f"Сохранено: {args.out}")
    print(f"  {boundary.display_name}")
    print(f"  OSM: {boundary.osm_type}/{boundary.osm_id}, тип геометрии: {boundary.geometry.get('type')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
