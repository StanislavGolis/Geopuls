"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type ErrorEvent,
  type GeoJSONSource,
  type StyleSpecification,
} from "maplibre-gl";

import type { CellsResponse, CityMeta } from "@/lib/api";
import { heatColorExpression, resolutionForZoom } from "@/lib/heat";

/**
 * URL воркера MapLibre. Файлы кладутся в `public/` скриптом `scripts/copy-maplibre-worker.mjs`
 * (запускается перед dev и build).
 *
 * Без этого Turbopack-сборка Next не может определить URL воркера: MapLibre пишет
 * «Worker failed to load», тайлы и GeoJSON не парсятся, карта остаётся пустой.
 * Имя файла зависит от сборки: dev-версия MapLibre тянет свой shared-модуль.
 */
const WORKER_URL =
  process.env.NODE_ENV === "production"
    ? "/maplibre-gl-worker.mjs"
    : "/maplibre-gl-worker-dev.mjs";

setWorkerUrl(WORKER_URL);

/**
 * Отдавать ли наружу ссылку на карту (`window.__geopulsMap`) — нужна E2E-тестам и диагностике.
 * В продакшене доступна только при явном `?debug=1`.
 *
 * Флаг вычисляется один раз при загрузке модуля: приложение переписывает адресную строку
 * (`history.replaceState`) под своё состояние, поэтому читать URL позже нельзя — параметр `debug`
 * к тому моменту уже убран.
 */
const DEBUG_MAP_REQUESTED =
  process.env.NODE_ENV !== "production" ||
  (typeof window !== "undefined" && window.location.search.includes("debug"));

export type MapViewHandle = {
  /** Канвас карты — нужен для экспорта текущего вида в PNG. */
  getCanvas: () => HTMLCanvasElement | null;
};

export type MapViewProps = {
  city: CityMeta;
  /** Данные теплового слоя (null — ещё грузятся). */
  cells: CellsResponse | null;
  /** Карта сообщает наружу, какое разрешение соответствует текущему зуму. */
  onResolutionChange: (res: 8 | 9) => void;
  /** Клик по ячейке: наружу уходит H3-индекс (список объектов открывает контейнер). */
  onCellSelect: (h3: string) => void;
  /** Текущий вид карты: попадает в адресную строку для shareable URL. */
  onViewChange: (view: { lat: number; lon: number; zoom: number }) => void;
  /** Выбранная ячейка — подсвечиваем контуром. */
  selectedCell?: string | null;
  /** Стартовый вид из URL: если задан, вместо границ города показываем его. */
  initialView?: { lat: number; lon: number; zoom: number } | null;
  /** URL стиля подложки (см. docs/decisions/0002-basemap.md). */
  styleUrl: string;
  ref?: Ref<MapViewHandle>;
};

const CELLS_SOURCE = "cells";
const CELLS_LAYER = "cells-fill";
const SELECTED_SOURCE = "cells-selected";
const SELECTED_LAYER = "cells-selected-outline";

/** Сколько ждать стиль подложки перед переходом на минимальный локальный стиль. */
const STYLE_TIMEOUT_MS = 8000;

/**
 * Минимальный стиль без внешних источников: нужен, чтобы тепловой слой рисовался,
 * даже если стиль подложки недоступен (иначе событие `load` не наступает и карта пустая).
 */
export const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  name: "ГЕОПУЛЬС — только тепловой слой",
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#eef2f6" },
    },
  ],
};

/** Проверка поддержки WebGL2: без него MapLibre не может отрисовать карту. */
export function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export default function MapView({
  city,
  cells,
  onResolutionChange,
  onCellSelect,
  onViewChange,
  selectedCell = null,
  initialView = null,
  styleUrl,
  ref,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const latestCellsRef = useRef<CellsResponse | null>(cells);
  const resolveRef = useRef(onResolutionChange);
  const selectRef = useRef(onCellSelect);
  const viewRef = useRef(onViewChange);
  const selectedRef = useRef(selectedCell);

  const [webglMissing, setWebglMissing] = useState(false);
  const [basemapWarning, setBasemapWarning] = useState<string | null>(null);

  latestCellsRef.current = cells;
  resolveRef.current = onResolutionChange;
  selectRef.current = onCellSelect;
  viewRef.current = onViewChange;
  selectedRef.current = selectedCell;

  useImperativeHandle(ref, () => ({ getCanvas: () => mapRef.current?.getCanvas() ?? null }), []);

  /** Данные теплового слоя (в том числе после смены стиля подложки). */
  const applyCells = useCallback((map: MapLibreMap) => {
    const source = map.getSource(CELLS_SOURCE) as GeoJSONSource | undefined;
    source?.setData((latestCellsRef.current ?? emptyCollection()) as unknown as GeoJSON.FeatureCollection);
  }, []);

  /** Контур выбранной ячейки: показываем ровно ту ячейку, для которой открыт список объектов. */
  const applySelected = useCallback((map: MapLibreMap, h3: string | null) => {
    const source = map.getSource(SELECTED_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const feature = h3 ? latestCellsRef.current?.features.find((item) => item.properties.h3 === h3) : undefined;
    source.setData(
      feature
        ? ({ type: "FeatureCollection", features: [feature] } as unknown as GeoJSON.FeatureCollection)
        : emptyCollection(),
    );
  }, []);

  const reportView = useCallback((map: MapLibreMap) => {
    const center = map.getCenter();
    viewRef.current({ lat: center.lat, lon: center.lng, zoom: map.getZoom() });
  }, []);

  const handleZoomEnd = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    resolveRef.current(resolutionForZoom(map.getZoom()));
    reportView(map);
  }, [reportView]);

  /** Добавить (или восстановить после смены стиля) тепловой слой и слой подсветки. */
  const ensureHeatLayer = useCallback(
    (map: MapLibreMap) => {
      if (map.getSource(CELLS_SOURCE)) return;

      map.addSource(CELLS_SOURCE, { type: "geojson", data: emptyCollection(), promoteId: "h3" });
      map.addLayer({
        id: CELLS_LAYER,
        type: "fill",
        source: CELLS_SOURCE,
        paint: {
          "fill-color": heatColorExpression(
            latestCellsRef.current?.meta.density_breaks ?? null,
          ) as never,
          "fill-opacity": 0.75,
          "fill-outline-color": "rgba(255, 255, 255, 0.35)",
        },
      });

      map.addSource(SELECTED_SOURCE, { type: "geojson", data: emptyCollection() });
      map.addLayer({
        id: SELECTED_LAYER,
        type: "line",
        source: SELECTED_SOURCE,
        paint: { "line-color": "#0f172a", "line-width": 2.5 },
      });

      map.on("mouseenter", CELLS_LAYER, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", CELLS_LAYER, () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("click", CELLS_LAYER, (event) => {
        const feature = event.features?.[0];
        const h3 = (feature?.id ?? (feature?.properties as { h3?: string } | undefined)?.h3) as
          | string
          | undefined;
        if (h3) selectRef.current(h3);
      });

      applyCells(map);
    },
    [applyCells],
  );

  // Инициализация карты — один раз
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    if (!supportsWebGL2()) {
      setWebglMissing(true);
      return;
    }

    const map = new MapLibreMap({
      container: containerRef.current,
      style: styleUrl,
      center: initialView ? [initialView.lon, initialView.lat] : [city.center.lon, city.center.lat],
      zoom: initialView?.zoom ?? 12,
      attributionControl: { compact: true },
      // Канвас читается для экспорта PNG: без этого буфер WebGL уже очищен и снимок пустой
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    // Отладочная ссылка на карту: нужна E2E-тестам и ручной диагностике (см. DEBUG_MAP_REQUESTED)
    if (DEBUG_MAP_REQUESTED) {
      (window as unknown as { __geopulsMap?: MapLibreMap }).__geopulsMap = map;
    }

    // Размер контейнера меняется после раскладки (заголовок, дисклеймер, футер) — без этого
    // канвас остаётся того размера, каким был при создании карты, и карта занимает часть области.
    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    let styleReady = false;
    const fallbackTimer = window.setTimeout(() => {
      if (!styleReady && mapRef.current) {
        setBasemapWarning(
          "Подложка карты не загрузилась — показан только тепловой слой. Проверьте доступ к тайлам.",
        );
        map.setStyle(FALLBACK_STYLE);
      }
    }, STYLE_TIMEOUT_MS);

    // Слой добавляем по `style.load`, а не по `load`: `load` не наступает, пока не загрузятся
    // тайлы подложки, поэтому при недоступной подложке карта оставалась пустой.
    map.on("style.load", () => {
      styleReady = true;
      window.clearTimeout(fallbackTimer);
      ensureHeatLayer(map);
      applySelected(map, selectedRef.current);
      map.resize();
      handleZoomEnd();
    });

    map.on("zoomend", handleZoomEnd);
    map.on("moveend", () => reportView(map));

    map.on("error", (event: ErrorEvent) => {
      const status = (event.error as { status?: number } | undefined)?.status;
      const sourceId = (event as unknown as { sourceId?: string }).sourceId;
      if (typeof status === "number" && status >= 400 && sourceId) {
        setBasemapWarning("Тайлы подложки недоступны — тепловой слой продолжает работать.");
        return;
      }
      console.warn("Ошибка карты:", event.error?.message);
    });

    return () => {
      window.clearTimeout(fallbackTimer);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [
    styleUrl,
    handleZoomEnd,
    ensureHeatLayer,
    applySelected,
    reportView,
    city.center.lat,
    city.center.lon,
    initialView?.lat,
    initialView?.lon,
    initialView?.zoom,
  ]);

  // Смена города — центрируем карту по его границам, а не по одной точке.
  // Если в URL задан вид (`zoom`/`center`), показываем именно его: ссылкой делятся, чтобы
  // человек увидел тот же кадр.
  const fittedCityRef = useRef<string | null>(initialView ? city.slug : null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedCityRef.current === city.slug) return;
    fittedCityRef.current = city.slug;

    const { min_lon, min_lat, max_lon, max_lat } = city.bbox;
    map.fitBounds(new LngLatBounds([min_lon, min_lat], [max_lon, max_lat]), {
      padding: 24,
      duration: 600,
    });
  }, [city]);

  // Обновление данных и раскраски теплового слоя
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource(CELLS_SOURCE)) return;

    applyCells(map);
    map.setPaintProperty(
      CELLS_LAYER,
      "fill-color",
      heatColorExpression(cells?.meta.density_breaks ?? null) as never,
    );
    applySelected(map, selectedCell);
  }, [cells, selectedCell, applyCells, applySelected]);

  // Подсветка выбранной ячейки
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    applySelected(map, selectedCell);
  }, [selectedCell, applySelected]);

  if (webglMissing) {
    return (
      <div className="map__canvas" data-testid="webgl-missing">
        <div className="overlay">
          <div className="overlay__card overlay__card--error">
            <strong>Браузер не может отрисовать карту</strong>
            <p>
              Нужна поддержка WebGL2. Включите аппаратное ускорение в настройках браузера
              (Chrome: «Настройки → Система → Использовать аппаратное ускорение»), затем обновите страницу.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="map__canvas" ref={containerRef}>
      {basemapWarning && (
        <div className="map__banner" data-testid="basemap-warning">
          {basemapWarning}
        </div>
      )}
    </div>
  );
}
