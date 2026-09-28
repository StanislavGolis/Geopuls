"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  NavigationControl,
  type ErrorEvent,
  type MapLayerMouseEvent,
} from "maplibre-gl";
import { cellToBoundary, gridDisk, latLngToCell } from "h3-js";

import "maplibre-gl/dist/maplibre-gl.css";

/** Центр Томска (Этап 0: единственный город MVP). */
const TOMSK: [number, number] = [84.9482, 56.4847];
const H3_RESOLUTION = 9;
const DEMO_RINGS = 7;

/** Границы классов легенды в POI / км². В демо значения синтетические. */
export const DENSITY_BREAKS = [0, 20, 60, 120] as const;
const COLORS = ["#e8eef2", "#cfe3f7", "#98c7ea", "#5ba3d5", "#1f6fb2"] as const;

/** Детерминированный «псевдослучайный» вес ячейки — только для демо-данных Этапа 0. */
function demoWeight(cell: string): number {
  let hash = 0;
  for (let index = 0; index < cell.length; index += 1) {
    hash = (hash * 31 + cell.charCodeAt(index)) % 100_000;
  }
  return (hash % 220) / 10;
}

function hexFeature(cell: string, value: number): GeoJSON.Feature<GeoJSON.Polygon> {
  const ring = cellToBoundary(cell, true).map(([lng, lat]) => [lng, lat] as [number, number]);
  ring.push(ring[0]);

  return {
    type: "Feature",
    id: cell,
    properties: { h3: cell, value: Number(value.toFixed(1)) },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

export type MapViewProps = {
  /** URL стиля подложки (по умолчанию OpenFreeMap — см. docs/decisions/0002-basemap.md). */
  styleUrl: string;
};

export default function MapView({ styleUrl }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [selected, setSelected] = useState<{ h3: string; value: number } | null>(null);
  const [cellCount, setCellCount] = useState(0);
  const [basemapError, setBasemapError] = useState<string | null>(null);

  const handleCellClick = useCallback((event: MapLayerMouseEvent) => {
    const map = mapRef.current;
    if (!map) return;

    const features = map.queryRenderedFeatures(event.point, { layers: ["cells-fill"] });
    const properties = features[0]?.properties as { h3?: string; value?: number } | undefined;
    if (properties?.h3) {
      setSelected({ h3: properties.h3, value: Number(properties.value ?? 0) });
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const origin = latLngToCell(TOMSK[1], TOMSK[0], H3_RESOLUTION);
    const cells = gridDisk(origin, DEMO_RINGS);
    const collection: GeoJSON.FeatureCollection<GeoJSON.Polygon> = {
      type: "FeatureCollection",
      features: cells.map((cell) => hexFeature(cell, demoWeight(cell))),
    };

    const map = new MapLibreMap({
      container: containerRef.current,
      style: styleUrl,
      center: TOMSK,
      zoom: 12,
      attributionControl: { compact: false },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    // Подложка может быть недоступна: карта и тепловой слой обязаны это пережить
    map.on("error", (event: ErrorEvent) => {
      setBasemapError(event.error?.message ?? "не удалось загрузить тайлы подложки");
    });

    map.on("load", () => {
      map.addSource("cells", { type: "geojson", data: collection });
      map.addLayer({
        id: "cells-fill",
        type: "fill",
        source: "cells",
        paint: {
          "fill-color": [
            "interpolate",
            ["linear"],
            ["get", "value"],
            DENSITY_BREAKS[0],
            COLORS[0],
            DENSITY_BREAKS[1],
            COLORS[1],
            DENSITY_BREAKS[2],
            COLORS[2],
            DENSITY_BREAKS[3],
            COLORS[3],
            DENSITY_BREAKS[3] * 2,
            COLORS[4],
          ],
          "fill-opacity": 0.72,
          "fill-outline-color": "rgba(255, 255, 255, 0.55)",
        },
      });
      map.on("click", "cells-fill", handleCellClick);
      map.on("mouseenter", "cells-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "cells-fill", () => {
        map.getCanvas().style.cursor = "";
      });
      setCellCount(cells.length);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [styleUrl, handleCellClick]);

  return (
    <>
      <div className="legend">
        <div className="legend__title">Плотность объектов, POI / км²</div>
        <ul className="legend__list">
          {COLORS.map((color, index) => (
            <li className="legend__item" key={color}>
              <span className="legend__swatch" style={{ background: color }} />
              <span>
                {index === 0 && `${DENSITY_BREAKS[0]} — нет размеченных объектов`}
                {index === 1 && `1 – ${DENSITY_BREAKS[1]}`}
                {index === 2 && `${DENSITY_BREAKS[1] + 1} – ${DENSITY_BREAKS[2]}`}
                {index === 3 && `${DENSITY_BREAKS[2] + 1} – ${DENSITY_BREAKS[3]}`}
                {index === 4 && `более ${DENSITY_BREAKS[3]}`}
              </span>
            </li>
          ))}
        </ul>
        <div className="legend__note">
          Только объекты, размеченные в OpenStreetMap. Полнота зависит от активности сообщества и не равна
          реальному числу организаций.
        </div>
      </div>

      <div className="map">
        <div className="map__canvas" ref={containerRef} />
      </div>

      <div className="poipanel">
        {selected ? (
          <>
            <div className="poipanel__title">
              Ячейка H3 {selected.h3} · res {H3_RESOLUTION}
            </div>
            <div>Плотность (демо): {selected.value} POI / км²</div>
            <div className="poipanel__hint">
              Список организаций внутри ячейки появится на Этапе 4 (эндпоинт <code>/api/v1/pois</code>).
            </div>
          </>
        ) : (
          <div className="poipanel__empty">
            Нажмите на ячейку — здесь появится список организаций. Сейчас показаны демо-данные: {cellCount}{" "}
            ячеек вокруг Томска.
          </div>
        )}
        {basemapError && <div className="poipanel__hint">Подложка недоступна: {basemapError}</div>}
      </div>
    </>
  );
}

