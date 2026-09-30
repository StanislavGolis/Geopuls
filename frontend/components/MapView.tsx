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

import type { CityMeta, LayerGrid } from "@/lib/api";
import { fetchPois, type PoiItem } from "@/lib/api";
import {
  SELECTED_CELL_COLOR,
  heatColorExpression,
  heatFillOpacityExpression,
  heatOutlineColorExpression,
  resolutionForZoom,
  resolutionOfCell,
} from "@/lib/heat";
import { baseColumn, buildCellFeatures, type CellFeatureCollection } from "@/lib/layers";

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
  /** Колоночный ответ карты: базовый слой (красит заливку) и наложения (ADR 0013). */
  grid: LayerGrid | null;
  /** Идёт загрузка: сообщаем скринридерам через `aria-busy`. */
  busy?: boolean;
  /** Карта сообщает наружу, какое разрешение соответствует текущему зуму. */
  onResolutionChange: (res: 8 | 9) => void;
  /** Клик по ячейке: наружу уходит H3-индекс (список объектов открывает контейнер). */
  onCellSelect: (h3: string) => void;
  /** Текущий вид карты: попадает в адресную строку для shareable URL. */
  onViewChange: (view: { lat: number; lon: number; zoom: number }) => void;
  /** Выбранная ячейка — подсвечиваем контуром. */
  selectedCell?: string | null;
  /** Ячейки сравнения: подсвечиваем все, чтобы видеть зоны на карте, а не только в таблице. */
  compareCells?: string[];
  /**
   * Категория выбранного слоя: точки в ячейке показываем только по ней.
   *
   * Без фильтра клик по гексу подсвечивал бы все размеченные объекты города сразу, и обещание
   * «конкуренты в этой ячейке» подменялось бы другим — «всё, что есть в OSM». Список объектов в
   * панели фильтруется этой же категорией: карта и список обязаны показывать одно и то же.
   */
  category?: string | null;
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
/** Точки объектов выбранной ячейки: «где именно стоят эти бизнесы» — ответ на клик по гексу. */
const POIS_SOURCE = "cell-pois";
const POIS_LAYER = "cell-pois-points";
/** Цвет точек совпадает с акцентом выбранной ячейки: видно, что они связаны. */
const POI_COLOR = "#1d4ed8";

/** Точки объектов ячейки в форме GeoJSON: координаты уже в порядке ``[lon, lat]``. */
function poiCollection(items: PoiItem[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: items.map((item) => ({
      type: "Feature",
      // `id` фичи здесь не задаём: MapLibre для GeoJSON приводит его к числу, и строковый ключ OSM
      // превратился бы в мусор. Идентификатор объекта живёт в свойствах — по нему и сопоставляем.
      properties: {
        name: item.name ?? "",
        osm: `${item.osm_type}-${item.osm_id}`,
        // Категории точки: видно, к чему относится объект (и это проверяется в E2E)
        categories: item.categories,
      },
      geometry: { type: "Point", coordinates: [item.lon, item.lat] },
    })),
  } as GeoJSON.FeatureCollection;
}

/** Сколько ждать стиль подложки перед переходом на минимальный локальный стиль. */
const STYLE_TIMEOUT_MS = 8000;

/** Сколько точек ячейки запрашивать для показа на карте: больше в один гекс не помещается. */
const POIS_LIMIT = 200;

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
  grid,
  busy = false,
  onResolutionChange,
  onCellSelect,
  onViewChange,
  selectedCell = null,
  compareCells = [],
  category = null,
  initialView = null,
  styleUrl,
  ref,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const latestGridRef = useRef<LayerGrid | null>(grid);
  const latestFeaturesRef = useRef<CellFeatureCollection>({ type: "FeatureCollection", features: [] });
  const resolveRef = useRef(onResolutionChange);
  const selectRef = useRef(onCellSelect);
  const viewRef = useRef(onViewChange);
  const selectedRef = useRef(selectedCell);

  const [webglMissing, setWebglMissing] = useState(false);
  const [basemapWarning, setBasemapWarning] = useState<string | null>(null);
  /** Точки объектов выбранной ячейки: где именно стоят бизнесы внутри гекса. */
  const [cellPois, setCellPois] = useState<PoiItem[]>([]);

  latestGridRef.current = grid;
  resolveRef.current = onResolutionChange;
  selectRef.current = onCellSelect;
  viewRef.current = onViewChange;
  selectedRef.current = selectedCell;

  useImperativeHandle(ref, () => ({ getCanvas: () => mapRef.current?.getCanvas() ?? null }), []);

  /**
   * Данные карты: заливка базового слоя, значения наложений, состав контурных слоёв.
   *
   * Ячейки собираются один раз и запоминаются: подсветка выбранной ячейки берёт геометрию отсюда, а
   * не из ответа API повторно.
   */
  const applyGrid = useCallback((map: MapLibreMap) => {
    const current = latestGridRef.current;
    const base = current ? baseColumn(current) : null;
    const features: CellFeatureCollection = current
      ? buildCellFeatures(current, base)
      : { type: "FeatureCollection", features: [] };
    latestFeaturesRef.current = features;

    (map.getSource(CELLS_SOURCE) as GeoJSONSource | undefined)?.setData(
      features as unknown as GeoJSON.FeatureCollection,
    );

    if (map.getLayer(CELLS_LAYER)) {
      map.setPaintProperty(
        CELLS_LAYER,
        "fill-color",
        heatColorExpression(base?.breaks ?? null) as never,
      );
      map.setPaintProperty(CELLS_LAYER, "fill-opacity", heatFillOpacityExpression() as never);
      map.setPaintProperty(CELLS_LAYER, "fill-outline-color", heatOutlineColorExpression() as never);
    }
  }, []);

  /**
   * Контур выбранных ячеек: одна ячейка — карточка объектов, несколько — сравнение зон.
   *
   * Оба случая рисуются одним слоем: так подсветка не спорит сама с собой, а пользователь видит
   * ровно то, о чём говорит панель.
   */
  const applySelected = useCallback((map: MapLibreMap, h3: string | null, compare: string[] = []) => {
    const source = map.getSource(SELECTED_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const wanted = new Set<string>(compare);
    if (h3) wanted.add(h3);
    const features = latestFeaturesRef.current.features.filter((item) =>
      wanted.has(String(item.properties.h3)),
    );
    source.setData({ type: "FeatureCollection", features } as unknown as GeoJSON.FeatureCollection);
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

  /** Добавить (или восстановить после смены стиля подложки) слои карты: заливку, подсветку, наложения. */
  const ensureLayers = useCallback(
    (map: MapLibreMap) => {
      if (map.getSource(CELLS_SOURCE)) return;

      map.addSource(CELLS_SOURCE, { type: "geojson", data: emptyCollection(), promoteId: "h3" });
      map.addLayer({
        id: CELLS_LAYER,
        type: "fill",
        source: CELLS_SOURCE,
        paint: {
          // Раскраска ставится вместе с данными (applyGrid): до них классов легенды нет
          "fill-color": heatColorExpression(null) as never,
          // Пустые ячейки — самостоятельный класс: рисуются почти прозрачно, смысл несёт обводка
          "fill-opacity": heatFillOpacityExpression() as never,
          "fill-outline-color": heatOutlineColorExpression() as never,
        },
      });

      map.addSource(SELECTED_SOURCE, { type: "geojson", data: emptyCollection() });
      map.addLayer({
        id: SELECTED_LAYER,
        type: "line",
        source: SELECTED_SOURCE,
        paint: { "line-color": SELECTED_CELL_COLOR, "line-width": 2 },
      });

      // Точки объектов ячейки: где именно стоят бизнесы — это ответ на клик по гексу
      map.addSource(POIS_SOURCE, { type: "geojson", data: emptyCollection() });
      map.addLayer({
        id: POIS_LAYER,
        type: "circle",
        source: POIS_SOURCE,
        paint: {
          "circle-radius": 4,
          "circle-color": POI_COLOR,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
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

      // Данные и раскраска: и при первой загрузке, и после смены стиля подложки
      applyGrid(map);
    },
    [applyGrid],
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
      // Атрибуция вынесена в постоянную строку над картой (дизайн-спека §4.7): компактный контрол
      // MapLibre прячет текст за иконкой, а отдельный футер конкурирует с легендой внизу экрана
      attributionControl: false,
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
      ensureLayers(map);
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
    ensureLayers,
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

  // Обновление данных: заливка базового слоя перекрашивается
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource(CELLS_SOURCE)) return;

    applyGrid(map);
    applySelected(map, selectedCell, compareCells);
  }, [grid, selectedCell, compareCells, applyGrid, applySelected]);

  /**
   * Точки объектов выбранной ячейки — только выбранной категории.
   *
   * Запрос делает карта, а список объектов — панель: каждый компонент запрашивает то, что показывает,
   * а ответ `/pois` кэшируется браузером, поэтому дублирование бесплатно. Фильтр по категории при
   * этом обязателен: без него карта подсвечивала бы все объекты гекса, а панель — только конкуренцию.
   * Ошибку здесь глушим осознанно: точки — подсказка «где именно», а не данные, и панель сообщит о
   * проблеме сама.
   */
  useEffect(() => {
    if (!selectedCell) {
      setCellPois([]);
      return;
    }

    let cancelled = false;
    const cellResolution = resolutionOfCell(selectedCell) ?? city.h3_res;
    (async () => {
      try {
        const response = await fetchPois({
          city: city.slug,
          cell: selectedCell,
          res: cellResolution,
          category: category ?? undefined,
          limit: POIS_LIMIT,
        });
        if (!cancelled) setCellPois(response.items);
      } catch {
        if (!cancelled) setCellPois([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [category, city.slug, city.h3_res, selectedCell]);

  // Точки на карте: держим слой поверх заливки и подсветки, чтобы гекс не прятал свои же объекты
  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource(POIS_SOURCE) as GeoJSONSource | undefined;
    if (!map || !source) return;

    source.setData(poiCollection(cellPois));
    if (map.getLayer(POIS_LAYER)) {
      map.moveLayer(POIS_LAYER);
    }
  }, [cellPois, grid]);

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
    <div className="map__canvas" ref={containerRef} aria-busy={busy}>
      {basemapWarning && (
        <div className="map__banner" data-testid="basemap-warning">
          {basemapWarning}
        </div>
      )}
    </div>
  );
}
