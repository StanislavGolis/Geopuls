"use client";

import { BarChart3, Crosshair, Scale, Share2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AroundPanel from "@/components/AroundPanel";
import CityProfile from "@/components/CityProfile";
import ComparePanel from "@/components/ComparePanel";
import ExportMenu from "@/components/ExportMenu";
import LayerPanel from "@/components/LayerPanel";
import Legend from "@/components/Legend";
import MapSkeleton from "@/components/MapSkeleton";
import MapView, { type MapViewHandle } from "@/components/MapView";
import PoiPanel, { type CellMetricView } from "@/components/PoiPanel";
import {
  ApiError,
  type CategoryMeta,
  type CityMeta,
  type LayerGrid,
  type LayerMeta,
  fetchCategories,
  fetchCities,
  fetchLayerGrid,
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
  baseColumn,
  isPartiallyCovered,
  layerLegend,
  parseLayerList,
  resolveBaseLayer,
  serializeLayerList,
  serializeLayerRef,
  type LayerRef,
} from "@/lib/layers";
import { EMPTY_URL_STATE, MAX_COMPARE, buildSearch, parseCellList, type UrlState } from "@/lib/urlState";

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
  /** Базовый слой — тот, что красит карту; вариант внутри слоя — его категория. */
  const [baseRef, setBaseRef] = useState<LayerRef | null>(null);
  /**
   * Дополнительные слои: их числа показываются в карточке выбранной ячейки.
   *
   * На карту они не рисуются — основа всегда одна (конкуренты), поэтому ограничение в два слоя больше
   * не нужно: оно защищало читаемость заливки, которой на карте нет. Слои задают дополнительную
   * информацию о том же гексе, а не вторую картинку поверх первой.
   */
  const [infoRefs, setInfoRefs] = useState<LayerRef[]>(() => parseLayerList(initial.overlays));
  const [res, setRes] = useState<8 | 9>(initial.res ?? DEFAULT_RES);
  const [grid, setGrid] = useState<LayerGrid | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [offline, setOffline] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedCell, setSelectedCell] = useState<string | null>(initial.cell);
  const [view, setView] = useState<{ lat: number; lon: number; zoom: number } | null>(
    initial.zoom !== null && initial.center
      ? { lat: initial.center.lat, lon: initial.center.lon, zoom: initial.zoom }
      : null,
  );
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  const [exporting, setExporting] = useState(false);
  /** Профиль города: сводка по данным. Открывается кнопкой и живёт в ссылке (`profile=1`). */
  const [profileOpen, setProfileOpen] = useState(initial.profile);
  /** Ячейки в сравнении: клик по карте добавляет и убирает их. Список живёт в ссылке. */
  const [compareRefs, setCompareRefs] = useState<string[]>(() => parseCellList(initial.compare));
  /** Режим сравнения: пока он включён, клик по гексу набирает зоны, а не открывает карточку объектов. */
  const [compareOpen, setCompareOpen] = useState(() => parseCellList(initial.compare).length > 0);
  /** Режим радиуса: клик по карте ставит точку, вокруг которой считаем «что рядом». */
  const [aroundOpen, setAroundOpen] = useState(initial.around !== null);
  /** Точка радиуса: живёт в ссылке (`around=lat,lon`), чтобы расчёт можно было переслать. */
  const [aroundPoint, setAroundPoint] = useState<{ lat: number; lon: number } | null>(initial.around);
  const [radiusM, setRadiusM] = useState<number>(initial.radius ?? DEFAULT_RADIUS_M);

  const mapRef = useRef<MapViewHandle | null>(null);
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

  /** Ключи слоёв для запросов и ссылок: строка стабильна и годится как зависимость эффекта. */
  const baseKey = baseRef ? serializeLayerRef(baseRef) : null;
  const infoLayersKey = serializeLayerList(infoRefs);

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
        // Базовый слой: из ссылки, из старого `category` или первый, которым можно красить карту.
        // Вариант по умолчанию — категория с данными, а не первая в списке: пустая карта на первом
        // экране хуже честной подсказки о том, где данные есть
        setBaseRef(
          (current) =>
            current ??
            resolveBaseLayer(
              registry.layers,
              { base: initial.base, category: initial.category },
              loadedCategories.find((item) => item.poi_count > 0)?.slug ?? null,
            ),
        );
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
    const cacheKey = gridCacheKey(citySlug, baseKey, infoLayersKey, res);

    (async () => {
      try {
        const response = await fetchLayerGrid({
          city: citySlug,
          base: baseKey,
          overlays: infoLayersKey || undefined,
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
  }, [citySlug, baseKey, infoLayersKey, res, reloadToken]);

  // Смена разрешения означает другую сетку: ячейку из прежней сетки больше не подсвечиваем
  useEffect(() => {
    if (resRef.current === res) return;
    resRef.current = res;
    setSelectedCell(null);
  }, [res]);

  // Состояние интерфейса в адресной строке: ссылкой можно поделиться (replaceState — без спама истории)
  useEffect(() => {
    if (!citySlug || !baseRef || typeof window === "undefined") return;

    const search = buildSearch({
      city: citySlug,
      // `category` дублирует вариант базового слоя: так ссылку читают клиенты, которые про слои ещё
      // не знают, и не ломаются уже разошедшиеся ссылки (см. lib/urlState.ts)
      category: baseRef.category,
      base: serializeLayerRef(baseRef),
      overlays: infoLayersKey || null,
      cell: selectedCell,
      compare: compareRefs.join(",") || null,
      around: aroundPoint,
      radius: aroundPoint ? radiusM : null,
      profile: profileOpen,
      res,
      zoom: view?.zoom ?? null,
      center: view ? { lat: view.lat, lon: view.lon } : null,
    });
    window.history.replaceState(null, "", `${window.location.pathname}?${search}`);
  }, [
    citySlug,
    baseRef,
    infoLayersKey,
    selectedCell,
    compareRefs,
    profileOpen,
    aroundPoint,
    radiusM,
    res,
    view,
  ]);

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
  const categoryOptions = baseLayer?.categories ?? [];
  /** Категории показываем только те, что есть у базового слоя: чужие варианты на карте не значат ничего. */
  const visibleCategories = useMemo(
    () => categories.filter((item) => categoryOptions.includes(item.slug)),
    [categories, categoryOptions],
  );
  const baseColumnData = useMemo(() => (grid ? baseColumn(grid) : null), [grid]);
  /**
   * Значения включённых слоёв для выбранной ячейки — их показывает карточка объекта.
   *
   * Считаем по индексу ячейки в уже загруженной сетке: отдельного запроса не нужно, а «нет данных»
   * (`null`) честно доезжает до интерфейса — ноль означал бы «здесь этого нет».
   */
  const cellMetrics = useMemo<CellMetricView[]>(() => {
    if (!grid || !selectedCell) return [];
    const index = grid.cells.h3.indexOf(selectedCell);
    if (index < 0) return [];

    return infoRefs.flatMap((ref) => {
      const column = grid.layers.find((item) => item.slug === ref.slug);
      if (!column) return [];
      return [
        {
          slug: column.slug,
          name: column.name,
          unit: column.unit,
          metricKind: column.metric_kind,
          value: column.values[index] ?? null,
        },
      ];
    });
  }, [grid, selectedCell, infoRefs]);
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

  const handleViewChange = useCallback((next: { lat: number; lon: number; zoom: number }) => {
    setView((current) =>
      current && current.lat === next.lat && current.lon === next.lon && current.zoom === next.zoom
        ? current
        : next,
    );
  }, []);

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
   * Режимы «Сравнить» и «Радиус» отвечают на разные вопросы, и оба забирают клик по карте: включёнными
   * одновременно они невозможны — человек не угадает, что сделает клик. Включение одного закрывает
   * другой вместе с его точкой: недосказанный расчёт лучше чужого круга на карте.
   */
  const toggleCompare = useCallback(() => {
    setCompareOpen((current) => !current);
    setAroundOpen(false);
    setAroundPoint(null);
  }, []);

  const toggleAround = useCallback(() => {
    setAroundOpen((current) => !current);
    setCompareOpen(false);
  }, []);

  /** Смена варианта базового слоя: слой остаётся, меняется категория внутри него. */
  const selectCategory = useCallback((slug: string) => {
    setBaseRef((current) => (current ? { ...current, category: slug } : current));
    setSelectedCell(null);
  }, []);

  /**
   * Включить или выключить дополнительный слой.
   *
   * Ограничения на число слоёв здесь нет: они не рисуются на карте, а добавляют числа в карточку
   * ячейки. Технический лимит запроса живёт на стороне API и говорит про размер ответа, а не про
   * читаемость картинки.
   */
  const toggleInfoLayer = useCallback((ref: LayerRef) => {
    setInfoRefs((current) =>
      current.some((item) => item.slug === ref.slug)
        ? current.filter((item) => item.slug !== ref.slug)
        : [...current, ref],
    );
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

        {categoryOptions.length > 0 && (
          <label className="topbar__control topbar__control--category">
            <span className="topbar__label">Категория</span>
            <select
              aria-label="Категория"
              value={baseCategory ?? ""}
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
        )}

        {/* На мобильном категорию выбирают чипами: селект скрыт стилями, чипы — наоборот */}
        {categoryOptions.length > 0 && (
          <div className="chips" role="group" aria-label="Категории">
            {visibleCategories.map((item) => (
              <button
                key={item.slug}
                type="button"
                className={`chip${item.slug === baseCategory ? " chip--active" : ""}`}
                aria-pressed={item.slug === baseCategory}
                data-testid={`chip-${item.slug}`}
                onClick={() => selectCategory(item.slug)}
              >
                {item.name}
                {item.poi_count === 0 ? " — нет данных" : ""}
              </button>
            ))}
          </div>
        )}

        <span className="topbar__spacer" />

        <div className="topbar__actions">
          <button
            type="button"
            className="topbar__button"
            onClick={toggleCompare}
            disabled={!citySlug}
            aria-pressed={compareOpen}
            data-testid="open-compare"
            title="Сравнить зоны: включается режим, клик по гексам набирает зоны"
          >
            <Scale size={16} aria-hidden="true" />
            <span className="topbar__button-label">Сравнить</span>
          </button>

          <button
            type="button"
            className="topbar__button"
            onClick={toggleAround}
            // Без категории радиус не посчитать: «конкуренты» без неё не определены (проверяет и API)
            disabled={!citySlug || !baseCategory}
            aria-pressed={aroundOpen}
            data-testid="open-around"
            title="Радиус: клик по карте ставит точку, вокруг неё считаются конкуренты и инфраструктура"
          >
            <Crosshair size={16} aria-hidden="true" />
            <span className="topbar__button-label">Радиус</span>
          </button>

          <button
            type="button"
            className="topbar__button"
            onClick={() => setProfileOpen(true)}
            disabled={!citySlug}
            data-testid="open-profile"
            title="Профиль города: сводка по данным"
          >
            <BarChart3 size={16} aria-hidden="true" />
            <span className="topbar__button-label">Профиль города</span>
          </button>

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
          />
        </div>

        {shareStatus !== "idle" && (
          <span className="topbar__status" role="status" data-testid="share-status">
            {shareStatus === "copied" ? "ссылка скопирована" : "ссылка передана"}
          </span>
        )}
      </header>

      <div className="map">
        {city ? (
          <MapView
            ref={mapRef}
            city={city}
            grid={grid}
            busy={status === "loading"}
            initialView={initialView}
            selectedCell={selectedCell}
            // Зоны сравнения подсвечиваем тем же контуром: карта и таблица говорят об одном
            compareCells={compareRefs}
            // Круг радиуса: показывает, какие именно метры посчитала панель «что вокруг точки»
            around={aroundOpen && aroundPoint ? { ...aroundPoint, radiusM } : null}
            // Клик ставит точку только в режиме радиуса: в остальное время он открывает карточку
            onPointSelect={aroundOpen ? handlePointSelect : undefined}
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

        {baseLayer && (
          <LayerPanel
            layers={layers}
            base={baseLayer}
            active={infoRefs}
            grid={grid}
            categoryName={baseCategory ? (categoryNames[baseCategory] ?? baseCategory) : null}
            onToggle={toggleInfoLayer}
          />
        )}

        {baseLayer && (
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

        {citySlug && selectedCell && (
          <PoiPanel
            city={citySlug}
            category={baseCategory}
            cell={selectedCell}
            // Разрешение берём у самой ячейки: состояние может опережать отрисованный слой при смене
            // разрешения по зуму, и тогда запрос со «своим» res давал 404 (см. resolutionOfCell)
            res={resolutionOfCell(selectedCell) ?? res}
            categoryNames={categoryNames}
            metrics={cellMetrics}
            onClose={() => setSelectedCell(null)}
          />
        )}

        {profileOpen && citySlug && (
          <CityProfile
            city={citySlug}
            cityName={city?.name}
            onClose={() => setProfileOpen(false)}
          />
        )}

        {compareOpen && citySlug && (
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

        {aroundOpen && citySlug && baseCategory && aroundPoint && (
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

        {aroundOpen && !aroundPoint && (
          <div className="around-hint" role="status" data-testid="around-hint">
            Кликните по карте — поставлю точку и посчитаю, что попадает в {radiusM} м вокруг неё
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
