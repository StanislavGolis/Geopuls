"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  type ErrorEvent,
  type GeoJSONSource,
} from "maplibre-gl";

import "maplibre-gl/dist/maplibre-gl.css";

import type { CellsResponse, CityMeta } from "@/lib/api";
import { heatColorExpression, resolutionForZoom } from "@/lib/heat";

export type MapViewProps = {
  city: CityMeta;
  /** Данные теплового слоя (null — ещё грузятся). */
  cells: CellsResponse | null;
  /** Карта сообщает наружу, какое разрешение соответствует текущему зуму. */
  onResolutionChange: (res: 8 | 9) => void;
  /** URL стиля подложки (см. docs/decisions/0002-basemap.md). */
  styleUrl: string;
};

const CELLS_SOURCE = "cells";
const CELLS_LAYER = "cells-fill";

export default function MapView({ city, cells, onResolutionChange, styleUrl }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  const resolveRef = useRef(onResolutionChange);

  resolveRef.current = onResolutionChange;

  const handleZoomEnd = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    resolveRef.current(resolutionForZoom(map.getZoom()));
  }, []);

  // Инициализация карты — один раз
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: styleUrl,
      center: [city.center.lon, city.center.lat],
      zoom: 12,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    // Подложка может быть недоступна: тепловой слой обязан это пережить
    map.on("error", (event: ErrorEvent) => {
      console.warn("Ошибка подложки карты:", event.error?.message);
    });

    map.on("load", () => {
      map.addSource(CELLS_SOURCE, { type: "geojson", data: emptyCollection(), promoteId: "h3" });
      map.addLayer({
        id: CELLS_LAYER,
        type: "fill",
        source: CELLS_SOURCE,
        paint: {
          "fill-color": heatColorExpression(null) as never,
          "fill-opacity": 0.75,
          "fill-outline-color": "rgba(255, 255, 255, 0.35)",
        },
      });
      map.on("mouseenter", CELLS_LAYER, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", CELLS_LAYER, () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("zoomend", handleZoomEnd);

      readyRef.current = true;
      handleZoomEnd();
    });

    return () => {
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, [styleUrl, handleZoomEnd, city.center.lat, city.center.lon]);

  // Смена города — центрируем карту по его границам, а не по одной точке
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const { min_lon, min_lat, max_lon, max_lat } = city.bbox;
    map.fitBounds(new LngLatBounds([min_lon, min_lat], [max_lon, max_lat]), {
      padding: 24,
      duration: 600,
    });
  }, [city]);

  // Обновление данных и раскраски теплового слоя
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    const source = map.getSource(CELLS_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;

    source.setData((cells ?? emptyCollection()) as unknown as GeoJSON.FeatureCollection);
    map.setPaintProperty(
      CELLS_LAYER,
      "fill-color",
      heatColorExpression(cells?.meta.density_breaks ?? null) as never,
    );
  }, [cells]);

  return <div className="map__canvas" ref={containerRef} />;
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}
