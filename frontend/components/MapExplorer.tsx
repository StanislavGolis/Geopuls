"use client";

import { Share2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AroundPanel from "@/components/AroundPanel";
import CellWidgets from "@/components/CellWidgets";
import CityProfile from "@/components/CityProfile";
import ComparePanel from "@/components/ComparePanel";
import ExportMenu from "@/components/ExportMenu";
import LayerPanel from "@/components/LayerPanel";
import Legend from "@/components/Legend";
import MapSkeleton from "@/components/MapSkeleton";
import MapView, { type MapViewHandle, type ObjectLayer } from "@/components/MapView";
import ZonePanel, { type CellMetricView } from "@/components/ZonePanel";
import TabNav from "@/components/TabNav";
import {
  ApiError,
  type CategoryMeta,
  type CityMeta,
  type LayerGrid,
  type LayerMeta,
  type LayerObjectsResponse,
  fetchCategories,
  fetchCities,
  fetchLayerGrid,
  fetchLayerObjects,
  fetchLayers,
} from "@/lib/api";
import { DEFAULT_RADIUS_M } from "@/lib/around";
import { gridCacheKey, loadGrid, saveGrid } from "@/lib/cache";
import {
  buildExportFooter,
  buildGridCsv,
  canvasToPngWithFooter,
  downloadDataUrl,
  downloadText,
  exportFileName,
  type ExportContext,
  type ExportLayer,
} from "@/lib/export";
import { formatDataVersion } from "@/lib/format";
import { resolutionForZoom, resolutionOfCell } from "@/lib/heat";
import {
  COMPETITORS_SLUG,
  baseColumn,
  isPartiallyCovered,
  layerLegend,
  parseLayerRef,
  parseObjectLayers,
  resolveBaseLayer,
  serializeLayerList,
  serializeLayerRef,
  serializeObjectLayers,
  type LayerRef,
} from "@/lib/layers";
import { stopPanelClick } from "@/lib/panels";
import {
  DEFAULT_TAB,
  EMPTY_URL_STATE,
  MAX_COMPARE,
  buildSearch,
  parseCellList,
  type TabId,
  type UrlState,
} from "@/lib/urlState";
import { cellsOfClass } from "@/lib/widgets";

export type MapExplorerProps = {
  /** URL стиля подложки (значение из окружения, см. docs/decisions/0002-basemap.md). */
  styleUrl: string;
  /** Стартовое состояние из адресной строки (shareable URL, раздел 4.3 ТЗ). */
  initialState?: UrlState;
};

type Status = "loading" | "ready" | "empty" | "error";
type ShareStatus = "idle" | "copied" | "shared";

const DEFAULT_RES = resolutionForZoom(12);
/** Порог «мало данных» для честного предупреждения в легенде. */
const THIN_DATA_THRESHOLD = 30;
/** Цвет объектов слоя, если реестр не дал свой: нейтральный, чтобы не перепутать со слоем. */
const DEFAULT_OBJECT_COLOR = "#334155";
/** Сколько держать подсказку о ссылке, мс. */
const SHARE_HINT_MS = 3000;

/** Технические подробности ошибки показываем только вне продакшена (дизайн-спека §4.8). */
const SHOW_TECHNICAL_HINTS = process.env.NODE_ENV !== "production";

export default function MapExplorer({ styleUrl, initialState }: MapExplorerProps) {
  const initial = initialState ?? EMPTY_URL_STATE;

  const [cities, setCities] = useState<CityMeta[]>([]);
  const [categories, setCategories] = useState<CategoryMeta[]>([]);
  /** Реестр слоёв: из него строится панель и берутся источники с лицензиями (ADR 0013). */
  const [layers, setLayers] = useState<LayerMeta[]>([]);
  const [citySlug, setCitySlug] = useState<string | null>(initial.city);
  /** Вкладка-сцена: у каждой своя основа карты и своя панель данных (ADR 0016). */
  const [tab, setTab] = useState<TabId>(initial.tab ?? DEFAULT_TAB);
  /**
   * Категория конкурентов: живёт отдельно от вкладки, чтобы не сбрасывалась при переходах.
   *
   * Пользователь выбрал «аптеки», сходил на «Инфраструктуру» и вернулся — он должен увидеть аптеки,
   * а не категорию по умолчанию.
   */
  const [competitorCategory, setCompetitorCategory] = useState<string | null>(initial.category);
  /** Показатель карты во вкладке «Инфраструктура»: слой OSM, кроме конкурентов. */
  const [infraSlug, setInfraSlug] = useState<string | null>(() => {
    const ref = parseLayerRef(initial.base);
    return ref && ref.slug !== COMPETITORS_SLUG ? ref.slug : null;
  });
  /**
   * Слои, объекты которых подсвечены на карте (план §6).
   *
   * Включить можно сколько угодно: каждый слой рисуется своим цветом из реестра, а читаемость держит
   * зум. Числа по всем слоям живут в сводке по зоне и от этих тумблеров не зависят.
   */
  const [objectsSlugs, setObjectsSlugs] = useState<string[]>(() => parseObjectLayers(initial.objects));
  /** Объекты включённых слоёв по границам вида: у каждого слоя свой ответ и свой источник на карте. */
  const [objectsData, setObjectsData] = useState<Record<string, LayerObjectsResponse | null>>({});
  const [res, setRes] = useState<8 | 9>(initial.res ?? DEFAULT_RES);
  const [grid, setGrid] = useState<LayerGrid | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [offline, setOffline] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedCell, setSelectedCell] = useState<string | null>(initial.cell);
  const [view, setView] = useState<{ lat: number; lon: number; zoom: number; bbox: string } | null>(
    initial.zoom !== null && initial.center
      ? { lat: initial.center.lat, lon: initial.center.lon, zoom: initial.zoom, bbox: "" }
      : null,
  );
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  const [exporting, setExporting] = useState(false);
  /** Ячейки в сравнении: клик по карте добавляет и убирает их. Список живёт в ссылке. */
  const [compareRefs, setCompareRefs] = useState<string[]>(() => parseCellList(initial.compare));
  /** Режим сравнения: пока он включён, клик по гексу набирает зоны, а не открывает карточку объектов. */
  const [compareOpen, setCompareOpen] = useState(() => parseCellList(initial.compare).length > 0);
  /** Режим радиуса: клик по карте ставит точку, вокруг которой считаем «что рядом». */
  const [aroundOpen, setAroundOpen] = useState(initial.around !== null);
  /** Точка радиуса: живёт в ссылке (`around=lat,lon`), чтобы расчёт можно было переслать. */
  const [aroundPoint, setAroundPoint] = useState<{ lat: number; lon: number } | null>(initial.around);
  const [radiusM, setRadiusM] = useState<number>(initial.radius ?? DEFAULT_RADIUS_M);
  /**
   * Панель виджетов: открыта по умолчанию — это ответ на «где выбранного больше всего».
   * В ссылку не пишется: свёрнутость панели — оформление, а не данные.
   */
  const [widgetsOpen, setWidgetsOpen] = useState(true);
  /** Класс плотности, подсвеченный на карте контуром (`null` — не выбран). */
  const [classIndex, setClassIndex] = useState<number | null>(null);
  const mapRef = useRef<MapViewHandle | null>(null);
  /** Просьба подвести карту к выбранной зоне: ставится виджетом, снимается эффектом подведения. */
  const focusPendingRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const resRef = useRef(res);
  const citySelectRef = useRef<HTMLSelectElement | null>(null);

  /** Стартовый вид карты фиксируем на монтировании: дальше вид живёт внутри карты. */
  const initialView = useMemo(
    () =>
      initial.zoom !== null && initial.center
        ? { lat: initial.center.lat, lon: initial.center.lon, zoom: initial.zoom }
        : null,
    [initial.zoom, initial.center],
  );

  /**
   * Основа карты — производное от вкладки (ADR 0016).
   *
   * «Конкуренты», «Инструменты» и «Город» красят карту конкурентами: это главный ответ сервиса и
   * понятный фон для измерений. «Инфраструктура» красит выбранным слоем — иначе вкладка была бы пустой.
   */
  const baseRef = useMemo<LayerRef | null>(() => {
    if (layers.length === 0) return null;

    if (tab === "infrastructure") {
      const chosen =
        layers.find((item) => item.slug === infraSlug && item.can_be_base) ??
        layers.find((item) => item.can_be_base && item.slug !== COMPETITORS_SLUG);
      return chosen ? { slug: chosen.slug, category: chosen.categories[0] ?? null } : null;
    }

    const competitors = layers.find((item) => item.slug === COMPETITORS_SLUG);
    if (!competitors) return null;
    const category =
      competitorCategory && competitors.categories.includes(competitorCategory)
        ? competitorCategory
        : (competitors.categories[0] ?? null);
    return { slug: COMPETITORS_SLUG, category };
  }, [layers, tab, infraSlug, competitorCategory]);

  /** Ключи слоёв для запросов и ссылок: строка стабильна и годится как зависимость эффекта. */
  const baseKey = baseRef ? serializeLayerRef(baseRef) : null;
  /**
   * Наложения для ответа карты: все слои, кроме базового.
   *
   * Отдельного выбора «какие слои показать числами» больше нет: сводка по зоне показывает всё, что
   * известно про зону, а слои ответа — это её источник данных. Технический предел (6 наложений) не
   * мешает: реестр города — 7 слоёв, и базовым может быть любой из них.
   */
  const overlayRefs = useMemo<LayerRef[]>(() => {
    if (!baseRef) return [];
    return layers
      .filter((item) => item.slug !== baseRef.slug)
      .map((item) =>
        item.slug === COMPETITORS_SLUG
          ? { slug: item.slug, category: competitorCategory ?? item.categories[0] ?? null }
          : { slug: item.slug, category: null },
      );
  }, [layers, baseRef, competitorCategory]);
  const overlayKey = serializeLayerList(overlayRefs);
  /** Слои подсветки одной строкой: массив не годится как зависимость эффекта (новая ссылка каждый раз). */
  const objectsKey = serializeObjectLayers(objectsSlugs);

  // Справочники: города, категории и реестр слоёв
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loadedCities, loadedCategories, registry] = await Promise.all([
          fetchCities(),
          fetchCategories(),
          fetchLayers(),
        ]);
        if (cancelled) return;
        setCities(loadedCities);
        setCategories(loadedCategories);
        setLayers(registry.layers);
        setCitySlug((current) => current ?? loadedCities[0]?.slug ?? null);
        // Начальный выбор из ссылки: категория конкурентов или показатель инфраструктуры.
        // Вариант по умолчанию — категория с данными, а не первая в списке: пустая карта на первом
        // экране хуже честной подсказки о том, где данные есть
        const requested = resolveBaseLayer(
          registry.layers,
          { base: initial.base, category: initial.category },
          loadedCategories.find((item) => item.poi_count > 0)?.slug ?? null,
        );
        if (requested?.slug === COMPETITORS_SLUG) {
          setCompetitorCategory((current) => current ?? requested.category);
        } else if (requested) {
          setInfraSlug((current) => current ?? requested.slug);
        }
      } catch (exc) {
        if (cancelled) return;
        setError(asApiError(exc));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initial.base, initial.category]);

  // Данные карты: перезапрашиваем при смене города, набора слоёв, разрешения и по «Повторить»
  useEffect(() => {
    if (!citySlug || !baseKey) return;

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    setStatus("loading");
    const cacheKey = gridCacheKey(citySlug, baseKey, overlayKey, res);

    (async () => {
      try {
        const response = await fetchLayerGrid({
          city: citySlug,
          base: baseKey,
          overlays: overlayKey || undefined,
          res,
        });
        if (controller.signal.aborted) return;
        setGrid(response);
        setError(null);
        setOffline(false);
        // «Пусто» определяет базовый слой: именно он отвечает на вопрос «где нет бизнеса»
        setStatus((baseColumn(response)?.non_empty_count ?? 0) > 0 ? "ready" : "empty");
        // Последний успешный ответ пригодится, если пропадёт связь
        saveGrid(cacheKey, response);
      } catch (exc) {
        if (controller.signal.aborted) return;

        const apiError = asApiError(exc);
        const cached = apiError.isOffline ? loadGrid(cacheKey) : null;

        if (cached) {
          // Показываем последние загруженные данные и честный баннер вместо пустого экрана
          setGrid(cached);
          setError(apiError);
          setOffline(true);
          setStatus((baseColumn(cached)?.non_empty_count ?? 0) > 0 ? "ready" : "empty");
          return;
        }

        setError(apiError);
        setStatus("error");
      }
    })();

    return () => controller.abort();
  }, [citySlug, baseKey, overlayKey, res, reloadToken]);

  /**
   * Разрешение в состоянии держим в актуальном виде, но выбранную зону при его смене не сбрасываем.
   *
   * Раньше сбрасывали: запрос объектов шёл с «текущим» разрешением, и для ячейки прежней сетки он давал
   * 404. Теперь запрос идёт с разрешением самой ячейки (`resolutionOfCell`), а подведение карты к зоне из
   * виджета меняет зум и, значит, разрешение — сбрасывать выбор было бы неверно: человек только что
   * выбрал эту зону.
   */
  useEffect(() => {
    resRef.current = res;
  }, [res]);

  // Состояние интерфейса в адресной строке: ссылкой можно поделиться (replaceState — без спама истории)
  /**
   * Текущее состояние сцены в виде query-строки: одно и то же для адресной строки и для отчёта.
   *
   * Общая функция, а не два похожих блока: ссылка «Поделиться» и отчёт обязаны описывать одну сцену.
   */
  const buildCurrentSearch = useCallback(() => {
    if (!baseRef) return "";
    return buildSearch({
      city: citySlug,
      // Вкладка пишется, когда она не основная — ссылка открывает ту же сцену (ADR 0016)
      tab,
      // `category` — категория конкурентов: так ссылку читают клиенты, которые про слои ещё не знают,
      // и не ломаются уже разошедшиеся ссылки (см. lib/urlState.ts). Во вкладке «Инфраструктура»
      // категории нет: там показатель задаётся самим слоем
      category: tab === "infrastructure" ? null : competitorCategory,
      // Показатель инфраструктуры пишем без категории: у этих слоёв вариант один.
      // Если пользователь ещё не выбирал показатель, в ссылку идёт тот, которым карта уже покрашена:
      // ссылка должна описывать то, что на экране, а не то, что мы собирались показать
      base: tab === "infrastructure" ? (infraSlug ?? baseRef.slug) : serializeLayerRef(baseRef),
      cell: selectedCell,
      compare: compareRefs.join(",") || null,
      around: aroundPoint,
      radius: aroundPoint ? radiusM : null,
      objects: objectsKey || null,
      res,
      zoom: view?.zoom ?? null,
      center: view ? { lat: view.lat, lon: view.lon } : null,
    });
  }, [
    citySlug,
    tab,
    competitorCategory,
    infraSlug,
    baseRef,
    selectedCell,
    compareRefs,
    aroundPoint,
    radiusM,
    objectsKey,
    res,
    view,
  ]);

  // Состояние интерфейса в адресной строке: ссылкой можно поделиться (replaceState — без спама истории)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const search = buildCurrentSearch();
    if (!search) return;
    window.history.replaceState(null, "", `${window.location.pathname}?${search}`);
  }, [buildCurrentSearch]);

  const city = useMemo(() => cities.find((item) => item.slug === citySlug) ?? null, [cities, citySlug]);
  const categoryNames = useMemo(
    () => Object.fromEntries(categories.map((item) => [item.slug, item.name])) as Record<string, string>,
    [categories],
  );
  const baseLayer = useMemo(
    () => layers.find((item) => item.slug === baseRef?.slug) ?? null,
    [layers, baseRef],
  );
  const baseCategory = baseRef?.category ?? null;
  /** Варианты есть не у каждого слоя: чипы и селект категорий показываем только там, где они есть. */
  const competitorLayer = useMemo(
    () => layers.find((item) => item.slug === COMPETITORS_SLUG) ?? null,
    [layers],
  );
  /** Категории берём у слоя конкурентов: их выбирают и в «Конкурентах», и в «Инструментах». */
  const categoryOptions = competitorLayer?.categories ?? [];
  /** Категории показываем только те, что есть у базового слоя: чужие варианты на карте не значат ничего. */
  const visibleCategories = useMemo(
    () => categories.filter((item) => categoryOptions.includes(item.slug)),
    [categories, categoryOptions],
  );
  /** Показатели вкладки «Инфраструктура»: слои OSM, кроме конкурентов. */
  const infraLayers = useMemo(
    () => layers.filter((item) => item.slug !== COMPETITORS_SLUG && item.can_be_base),
    [layers],
  );
  const baseColumnData = useMemo(() => (grid ? baseColumn(grid) : null), [grid]);

  /**
   * Зоны подсвеченного класса: пересчитываются по требованию, а в состоянии живёт только номер класса.
   *
   * Хранить сами ячейки нельзя: класс — это сотни индексов, и они бы осели в состоянии и в ссылке.
   */
  const classCells = useMemo(() => {
    if (!grid || !baseColumnData || classIndex === null) return [];
    return cellsOfClass(grid, baseColumnData, classIndex);
  }, [grid, baseColumnData, classIndex]);

  /**
   * Клик по зоне в виджете: выбираем её и просим подвести карту.
   *
   * Подведение — не часть обработчика, а следствие выбора (см. эффект ниже): смена вида карты внутри
   * клика запускает каскад событий MapLibre прямо посреди обновления состояния React.
   */
  const handleZoneSelect = useCallback((h3: string) => {
    focusPendingRef.current = true;
    setSelectedCell(h3);
  }, []);

  /** Клик по классу: подсветка контуром; повторный клик снимает подсветку. */
  const handleClassSelect = useCallback((index: number | null) => {
    setClassIndex(index);
  }, []);

  /** Контуры зон одним списком: сравнение и класс плотности рисуются одним слоем (см. MapView). */
  const outlineCells = useMemo(() => [...compareRefs, ...classCells], [compareRefs, classCells]);

  /**
   * Объекты включённых слоёв — грузим по границам вида, каждому слою свой запрос.
   *
   * Границы обязательны (см. `api/objects.py`): в типичном виде карты это десятки килобайт, а слой
   * целиком — мегабайты. При движении карты запрос повторяем: `moveend` — это завершённое действие, а не
   * поток событий, поэтому отдельный debounce не нужен. Запросы идут параллельно: семь слоёв ждать по
   * очереди было бы обидно.
   */
  useEffect(() => {
    const slugs = parseObjectLayers(objectsKey);
    if (!citySlug || slugs.length === 0 || !view?.bbox) {
      setObjectsData({});
      return;
    }

    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        slugs.map(async (slug) => {
          try {
            const response = await fetchLayerObjects({
              city: citySlug,
              layer: slug,
              bbox: view.bbox,
              res,
            });
            return [slug, response] as const;
          } catch {
            // Объекты слоя — подсказка «где именно», а не данные: о проблеме скажет сводка по зоне
            return [slug, null] as const;
          }
        }),
      );
      if (!cancelled) setObjectsData(Object.fromEntries(entries));
    })();

    return () => {
      cancelled = true;
    };
  }, [citySlug, objectsKey, view?.bbox, res]);

  /**
   * Тумблер слоя: включить или выключить его объекты на карте.
   *
   * Ограничения «один слой за раз» больше нет: слоёв можно включить сколько угодно, у каждого свой
   * цвет из реестра, а разбираться в наплыве контуров помогает зум. Выбор зоны не сбрасываем: человек
   * может смотреть сводку по зоне и подбирать подсветку одновременно.
   */
  const toggleObjects = useCallback((slug: string) => {
    setObjectsSlugs((current) =>
      current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug],
    );
  }, []);

  /** Слои подсветки для карты: только те, чьи объекты уже загружены. */
  const objectLayers = useMemo<ObjectLayer[]>(
    () =>
      objectsSlugs.flatMap((slug) => {
        const data = objectsData[slug];
        if (!data) return [];
        const meta = layers.find((item) => item.slug === slug);
        return [{ slug, color: meta?.color ?? DEFAULT_OBJECT_COLOR, data }];
      }),
    [objectsSlugs, objectsData, layers],
  );

  // Смена слоя или города меняет шкалу классов: подсветка прежнего класса теряет смысл
  useEffect(() => {
    setClassIndex(null);
  }, [baseKey, citySlug]);

  /**
   * Подведение карты к зоне, выбранной в виджете.
   *
   * Отдельным эффектом, потому что смена вида карты — это следствие выбора, а не его часть: вызов
   * `fitBounds` внутри обработчика клика запускал события MapLibre посреди обновления состояния React,
   * и выбор зоны терялся (карта уезжала, карточка не открывалась).
   */
  useEffect(() => {
    if (!selectedCell || !focusPendingRef.current) return;
    focusPendingRef.current = false;
    mapRef.current?.focusCell(selectedCell);
  }, [selectedCell]);
  /**
   * Сводка по зоне: значения **всех** слоёв по выбранной ячейке.
   *
   * Слои не «включаются»: сводка показывает всё, что известно про зону, и умолчать о части данных
   * значило бы соврать. Считаем по индексу ячейки в уже загруженной сетке: отдельного запроса не нужно,
   * а «нет данных» (`null`) честно доезжает до интерфейса — ноль означал бы «здесь этого нет».
   */
  const cellMetrics = useMemo<CellMetricView[]>(() => {
    if (!grid || !selectedCell) return [];
    const index = grid.cells.h3.indexOf(selectedCell);
    if (index < 0) return [];

    return grid.layers.map((column) => ({
      slug: column.slug,
      name: column.name,
      unit: column.unit,
      metricKind: column.metric_kind,
      role: column.role,
      value: column.values[index] ?? null,
      covered: column.covered_count >= grid.meta.cell_count,
    }));
  }, [grid, selectedCell]);
  const exportContext = useMemo<ExportContext | null>(() => {
    if (!city || !grid) return null;

    const exportLayers: ExportLayer[] = grid.layers.map((column) => ({
      slug: column.slug,
      name: column.name,
      category: column.category,
      categoryName: column.category ? (categoryNames[column.category] ?? column.category) : null,
      role: column.role,
      unit: column.unit,
    }));

    return {
      cityName: city.name,
      res,
      layers: exportLayers,
      dataVersion: grid.meta.data_version ?? city.data_version,
    };
  }, [city, grid, categoryNames, res]);
  const dataVersion = grid?.meta.data_version ?? city?.data_version ?? null;

  const handleResolutionChange = useCallback((next: 8 | 9) => {
    setRes((current) => (current === next ? current : next));
  }, []);

  const handleViewChange = useCallback(
    (next: { lat: number; lon: number; zoom: number; bbox: string }) => {
      setView((current) =>
        current &&
        current.lat === next.lat &&
        current.lon === next.lon &&
        current.zoom === next.zoom &&
        current.bbox === next.bbox
          ? current
          : next,
      );
    },
    [],
  );

  /**
   * Клик по гексу: в режиме сравнения он набирает зоны, иначе открывает карточку объектов.
   *
   * Два разных действия по одному жесту сознательно не смешиваются: иначе клик по третьей зоне
   * затирал бы карточку, которую пользователь в это время читает.
   */
  const handleCellSelect = useCallback(
    (h3: string) => {
      // В режиме радиуса клик ставит точку (см. handlePointSelect): карточка здесь только мешала бы
      if (aroundOpen) return;
      if (!compareOpen) {
        setSelectedCell(h3);
        return;
      }
      setCompareRefs((current) =>
        current.includes(h3)
          ? current.filter((item) => item !== h3)
          : current.length >= MAX_COMPARE
            ? current
            : [...current, h3],
      );
    },
    [compareOpen, aroundOpen],
  );

  /**
   * Клик по карте в режиме радиуса: точка ставится там, куда попал пользователь.
   *
   * Координаты берём у карты, а не у центра гекса: круг должен обводить то место, о котором спросили,
   * иначе «в 200 м» будет означать «в 200 м от центра ячейки, а не от адреса».
   */
  const handlePointSelect = useCallback((point: { lat: number; lon: number }) => {
    setAroundPoint(point);
    setSelectedCell(null);
  }, []);

  /**
   * Выбор инструмента во вкладке «Инструменты».
   *
   * Оба инструмента забирают клик по карте, поэтому включён ровно один: иначе человек не угадает, что
   * сделает клик. Переход на сравнение убирает точку радиуса — круг, оставшийся «ни от чего», читался бы
   * как чужой расчёт.
   */
  const openTool = useCallback((tool: "radius" | "compare") => {
    setCompareOpen(tool === "compare");
    setAroundOpen(tool === "radius");
    if (tool === "compare") setAroundPoint(null);
  }, []);

  /**
   * Переход на вкладку: основа карты меняется, а выбор пользователя сохраняется.
   *
   * Категория конкурентов и показатель инфраструктуры живут отдельно от вкладки, поэтому «сходил и
   * вернулся» возвращает то же, что было. Режимы, которые перехватывают клик по карте, гасим: на другой
   * вкладке клик означает другое (карточку зоны), и «невидимый» режим сравнения там только мешал бы.
   */
  const handleTabChange = useCallback(
    (next: TabId) => {
      setTab(next);
      setSelectedCell(null);

      if (next !== "tools") {
        setCompareOpen(false);
        setAroundOpen(false);
        return;
      }
      // Возвращаемся в «Инструменты» — продолжаем то, что уже набрано
      setCompareOpen(compareRefs.length > 0);
      setAroundOpen(aroundPoint !== null);
    },
    [aroundPoint, compareRefs.length],
  );

  /** Смена категории конкурентов: карта перекрашивается, выбранная зона сбрасывается. */
  const selectCategory = useCallback((slug: string) => {
    setCompetitorCategory(slug);
    setSelectedCell(null);
  }, []);

  const reload = useCallback(() => {
    setError(null);
    setStatus("loading");
    setReloadToken((value) => value + 1);
  }, []);

  const handleShare = useCallback(async () => {
    const url = window.location.href;
    // Системное меню «поделиться» показываем только на тач-устройствах: на десктопе
    // оно открывает диалог ОС и мешает работать с картой
    const prefersNativeShare =
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;

    if (prefersNativeShare) {
      try {
        await navigator.share({ title: "ГЕОПУЛЬС — плотность организаций", url });
        setShareStatus("shared");
      } catch {
        // Пользователь закрыл системное меню — это не ошибка
        return;
      }
      window.setTimeout(() => setShareStatus("idle"), SHARE_HINT_MS);
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API недоступен");
      await navigator.clipboard.writeText(url);
      setShareStatus("copied");
    } catch {
      // Фолбэк для http/localhost и браузеров без Clipboard API: показываем ссылку для копирования
      window.prompt("Скопируйте ссылку", url);
      return;
    }
    window.setTimeout(() => setShareStatus("idle"), SHARE_HINT_MS);
  }, []);

  const handleExportPng = useCallback(async () => {
    const canvas = mapRef.current?.getCanvas();
    if (!canvas || !exportContext) return;

    setExporting(true);
    try {
      const png = await canvasToPngWithFooter(canvas, buildExportFooter(exportContext));
      downloadDataUrl(png, exportFileName(exportContext, "png"));
    } finally {
      setExporting(false);
    }
  }, [exportContext]);

  const handleExportCsv = useCallback(() => {
    if (!grid || !exportContext) return;
    downloadText(buildGridCsv(grid, exportContext), exportFileName(exportContext, "csv"));
  }, [grid, exportContext]);

  /**
   * Отчёт для печати в PDF: открываем отдельной вкладкой с тем же состоянием сцены.
   *
   * В новой вкладке, а не в текущей: карта с её зумом и выбранной зоной остаётся на месте — человек
   * вернётся к ней после печати.
   */
  const handleExportReport = useCallback(() => {
    const search = buildCurrentSearch();
    if (!search) return;
    window.open(`/report?${search}`, "_blank", "noopener");
  }, [buildCurrentSearch]);

  return (
    <>
      <header className="topbar">
        <span className="topbar__brand">ГЕОПУЛЬС</span>

        <label className="topbar__control topbar__control--city">
          <span className="topbar__label">Город</span>
          <select
            ref={citySelectRef}
            aria-label="Город"
            value={citySlug ?? ""}
            onChange={(event) => {
              setCitySlug(event.target.value);
              setSelectedCell(null);
            }}
          >
            {cities.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <span className="topbar__spacer" />

        <div className="topbar__actions">
          <button
            type="button"
            className="topbar__button"
            onClick={handleShare}
            data-testid="share"
            title="Скопировать ссылку на текущий вид"
          >
            <Share2 size={16} aria-hidden="true" />
            <span className="topbar__button-label">Поделиться</span>
          </button>

          <ExportMenu
            disabled={!grid}
            busy={exporting}
            onExportPng={handleExportPng}
            onExportCsv={handleExportCsv}
            onExportReport={handleExportReport}
          />
        </div>

        {shareStatus !== "idle" && (
          <span className="topbar__status" role="status" data-testid="share-status">
            {shareStatus === "copied" ? "ссылка скопирована" : "ссылка передана"}
          </span>
        )}
      </header>

      {/* Панель сцены: вкладки и то, чем управляет текущая вкладка (ADR 0016) */}
      <div className="scene-bar">
        <TabNav active={tab} onChange={handleTabChange} />

        {tab === "infrastructure" && (
          <label className="scene-bar__control">
            <span className="scene-bar__label">Показатель</span>
            <select
              aria-label="Показатель карты"
              // До первого выбора показываем тот слой, которым карта уже покрашена: селект и карта
              // должны говорить об одном
              value={infraSlug ?? baseRef?.slug ?? ""}
              onChange={(event) => setInfraSlug(event.target.value)}
              data-testid="infra-layer"
            >
              {infraLayers.map((layer) => (
                <option key={layer.slug} value={layer.slug}>
                  {layer.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Категорию выбирают в «Конкурентах» и в «Инструментах»: радиус считает конкурентов */}
        {tab !== "infrastructure" && tab !== "city" && visibleCategories.length > 0 && (
          <>
            <label className="scene-bar__control scene-bar__control--select">
              <span className="scene-bar__label">Категория</span>
              <select
                aria-label="Категория"
                value={competitorCategory ?? ""}
                onChange={(event) => selectCategory(event.target.value)}
              >
                {visibleCategories.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                    {item.poi_count === 0 ? " — нет данных" : ""}
                  </option>
                ))}
              </select>
            </label>

            {/* На мобильном категорию выбирают чипами: селект скрыт стилями, чипы — наоборот */}
            <div className="chips" role="group" aria-label="Категории">
              {visibleCategories.map((item) => (
                <button
                  key={item.slug}
                  type="button"
                  className={`chip${item.slug === competitorCategory ? " chip--active" : ""}`}
                  aria-pressed={item.slug === competitorCategory}
                  data-testid={`chip-${item.slug}`}
                  onClick={() => selectCategory(item.slug)}
                >
                  {item.name}
                  {item.poi_count === 0 ? " — нет данных" : ""}
                </button>
              ))}
            </div>
          </>
        )}

        {tab === "city" && <span className="scene-bar__note">Сводка по данным города</span>}

        {/* Сводка по зонам: у «Конкурентов» и «Инфраструктуры» она отвечает числами того же слоя */}
        {(tab === "competitors" || tab === "infrastructure") && (
          <button
            type="button"
            className={`scene-bar__button${widgetsOpen ? " scene-bar__button--active" : ""}`}
            aria-pressed={widgetsOpen}
            data-testid="toggle-widgets"
            title="Сводка по зонам: топ зон и распределение по классам плотности"
            onClick={() => setWidgetsOpen((value) => !value)}
          >
            Зоны
          </button>
        )}
      </div>

      <div className="map">
        {city ? (
          <MapView
            ref={mapRef}
            city={city}
            grid={grid}
            busy={status === "loading"}
            initialView={initialView}
            selectedCell={selectedCell}
            // Контуры: зоны сравнения и подсвеченный класс плотности — обе «вот эти зоны»
            outlineCells={outlineCells}
            // Круг радиуса: показывает, какие именно метры посчитала панель «что вокруг точки»
            around={aroundOpen && aroundPoint ? { ...aroundPoint, radiusM } : null}
            // Клик ставит точку только в режиме радиуса: в остальное время он открывает карточку
            onPointSelect={aroundOpen ? handlePointSelect : undefined}
            // Объекты включённых слоёв: у каждого свой цвет и свой источник (план §6)
            objectLayers={objectLayers}
            // Точки в ячейке — по той же категории, что и список объектов в панели
            category={baseCategory}
            onCellSelect={handleCellSelect}
            onResolutionChange={handleResolutionChange}
            onViewChange={handleViewChange}
            styleUrl={styleUrl}
          />
        ) : (
          <div className="map__placeholder" />
        )}

        {baseLayer && tab !== "city" && (
          <LayerPanel
            layers={layers}
            base={baseLayer}
            objectsSlugs={objectsSlugs}
            objectsData={objectsData}
            onToggleObjects={toggleObjects}
          />
        )}

        {baseLayer && tab !== "city" && (
          <Legend
            layer={baseColumnData ? layerLegend(baseColumnData) : null}
            res={res}
            thinDataThreshold={THIN_DATA_THRESHOLD}
            partialCoverage={
              baseColumnData ? isPartiallyCovered(baseColumnData, grid?.meta.cell_count ?? 0) : false
            }
          />
        )}

        {status === "loading" && <MapSkeleton />}

        {/* Сводка по зонам: топ зон и классы плотности — считается по уже загруженной сетке */}
        {widgetsOpen && grid && baseColumnData && (tab === "competitors" || tab === "infrastructure") && (
          <CellWidgets
            grid={grid}
            column={baseColumnData}
            selectedCell={selectedCell}
            activeClass={classIndex}
            onZoneSelect={handleZoneSelect}
            onClassSelect={handleClassSelect}
            onClose={() => setWidgetsOpen(false)}
          />
        )}

        {offline && (
          <div className="offline-banner" role="status" data-testid="offline">
            Нет связи с сервисом — показаны последние загруженные данные
          </div>
        )}

        {status === "empty" && (
          <div className="overlay" data-testid="empty">
            <div className="overlay__card">
              <strong>В этом городе нет размеченных объектов категории</strong>
              <p>
                Мы не показываем выдуманные данные: если в OpenStreetMap по городу объектов нет, карта
                пустая. Попробуйте другую категорию — например, «Продукты» или «Пункты выдачи».
              </p>
            </div>
          </div>
        )}

        {status === "error" && error && !offline && (
          <div className="overlay" data-testid="error">
            <div className="overlay__card overlay__card--error">
              {error.isDataMissing ? (
                <>
                  <strong>Данные для этого города ещё не собраны</strong>
                  <p>Мы работаем над этим. Пока можно выбрать другой город.</p>
                  <button
                    type="button"
                    className="overlay__button"
                    onClick={() => citySelectRef.current?.focus()}
                  >
                    Выбрать другой город
                  </button>
                </>
              ) : (
                <>
                  <strong>{error.title}</strong>
                  <p>{error.detail}</p>
                  {error.isOffline && <p>Проверьте соединение с интернетом и попробуйте снова.</p>}
                  {SHOW_TECHNICAL_HINTS && (
                    <p className="overlay__hint">
                      Технические подробности (только в dev): проверьте, что API отвечает, а данные
                      собраны — <code>geopuls.importers.poi</code>, <code>geopuls.aggregate</code>.
                    </p>
                  )}
                  <button type="button" className="overlay__button" onClick={reload}>
                    Повторить
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Сводка по зоне: числа всех слоёв и объекты выбранной категории. В «Инструментах» и «Городе»
            клик по карте значит другое, поэтому сводки там нет */}
        {citySlug && selectedCell && (tab === "competitors" || tab === "infrastructure") && (
          <ZonePanel
            city={citySlug}
            cell={selectedCell}
            // Разрешение берём у самой ячейки: состояние может опережать отрисованный слой при смене
            // разрешения по зуму, и тогда запрос со «своим» res давал 404 (см. resolutionOfCell)
            res={resolutionOfCell(selectedCell) ?? res}
            category={baseCategory}
            categoryNames={categoryNames}
            metrics={cellMetrics}
            baseBreaks={baseColumnData?.breaks ?? null}
            onClose={() => setSelectedCell(null)}
          />
        )}

        {tab === "city" && citySlug && (
          <CityProfile
            city={citySlug}
            cityName={city?.name}
            // Закрытие сводки — это переход на основную вкладку: сцена не «пустеет»
            onClose={() => handleTabChange(DEFAULT_TAB)}
          />
        )}

        {tab === "tools" && compareOpen && citySlug && (
          <ComparePanel
            city={citySlug}
            cells={compareRefs}
            // Разрешение берём у самой ячейки: состояние может опережать отрисованную сетку
            res={resolutionOfCell(compareRefs[0] ?? "") ?? res}
            onRemove={(h3) => setCompareRefs((current) => current.filter((item) => item !== h3))}
            onClear={() => setCompareRefs([])}
            onClose={() => setCompareOpen(false)}
          />
        )}

        {tab === "tools" && aroundOpen && citySlug && baseCategory && aroundPoint && (
          <AroundPanel
            city={citySlug}
            point={aroundPoint}
            radiusM={radiusM}
            category={baseCategory}
            categoryName={categoryNames[baseCategory] ?? baseCategory}
            onRadiusChange={setRadiusM}
            onClose={() => {
              setAroundOpen(false);
              setAroundPoint(null);
            }}
          />
        )}

        {tab === "tools" && aroundOpen && !aroundPoint && (
          <div className="around-hint" role="status" data-testid="around-hint" onClick={stopPanelClick}>
            Кликните по карте — поставлю точку и посчитаю, что попадает в {radiusM} м вокруг неё
          </div>
        )}

        {tab === "tools" && !aroundOpen && !compareOpen && (
          <div className="tools__menu" data-testid="tools-menu" onClick={stopPanelClick}>
            <p className="tools__title">Инструменты анализа</p>
            <button
              type="button"
              className="tools__button"
              data-testid="tool-radius"
              onClick={() => openTool("radius")}
            >
              Радиус вокруг точки
              <span>Сколько конкурентов и инфраструктуры в 500 м от адреса</span>
            </button>
            <button
              type="button"
              className="tools__button"
              data-testid="tool-compare"
              onClick={() => openTool("compare")}
            >
              Сравнение зон
              <span>Две–пять зон рядом: показатели слоёв и медиана города</span>
            </button>
          </div>
        )}

        {/* Постоянная строка: атрибуция и лицензии должны быть видны всегда (ADR 0002, спека §4.7) */}
        <p className="attribution-line" data-testid="attribution">
          Данные © OpenStreetMap contributors · выгрузка{" "}
          <span className="mono" data-testid="data-version">
            {formatDataVersion(dataVersion) ?? "—"}
          </span>{" "}
          · Подложка: OpenFreeMap © OpenMapTiles ·{" "}
          <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">
            Сообщить об ошибке
          </a>
        </p>

      </div>
    </>
  );
}

function asApiError(exc: unknown): ApiError {
  if (exc instanceof ApiError) return exc;
  return new ApiError(0, "Непредвиденная ошибка", exc instanceof Error ? exc.message : String(exc));
}

function initialDataLabel(status: Status): string {
  return status === "error" ? "данные недоступны" : "загружаем данные…";
}
