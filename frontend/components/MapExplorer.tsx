"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Legend from "@/components/Legend";
import MapView, { type MapViewHandle } from "@/components/MapView";
import PoiPanel from "@/components/PoiPanel";
import {
  ApiError,
  type CategoryMeta,
  type CellsResponse,
  type CityMeta,
  fetchCategories,
  fetchCells,
  fetchCities,
} from "@/lib/api";
import {
  buildCellsCsv,
  buildExportFooter,
  canvasToPngWithFooter,
  downloadDataUrl,
  downloadText,
  exportFileName,
  type ExportContext,
} from "@/lib/export";
import { resolutionForZoom } from "@/lib/heat";
import { EMPTY_URL_STATE, buildSearch, type UrlState } from "@/lib/urlState";

export type MapExplorerProps = {
  /** URL стиля подложки (значение из окружения, см. docs/decisions/0002-basemap.md). */
  styleUrl: string;
  /** Стартовое состояние из адресной строки (shareable URL, раздел 4.3 ТЗ). */
  initialState?: UrlState;
};

type Status = "loading" | "ready" | "empty" | "error";
type ShareStatus = "idle" | "copied" | "failed";

const DEFAULT_RES = resolutionForZoom(12);
/** Порог «мало данных» для честного предупреждения в легенде. */
const THIN_DATA_THRESHOLD = 30;
/** Сколько держать подсказку о ссылке, мс. */
const SHARE_HINT_MS = 3000;

export default function MapExplorer({ styleUrl, initialState }: MapExplorerProps) {
  const initial = initialState ?? EMPTY_URL_STATE;

  const [cities, setCities] = useState<CityMeta[]>([]);
  const [categories, setCategories] = useState<CategoryMeta[]>([]);
  const [citySlug, setCitySlug] = useState<string | null>(initial.city);
  const [categorySlug, setCategorySlug] = useState<string | null>(initial.category);
  const [res, setRes] = useState<8 | 9>(initial.res ?? DEFAULT_RES);
  const [cells, setCells] = useState<CellsResponse | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedCell, setSelectedCell] = useState<string | null>(initial.cell);
  const [view, setView] = useState<{ lat: number; lon: number; zoom: number } | null>(
    initial.zoom !== null && initial.center
      ? { lat: initial.center.lat, lon: initial.center.lon, zoom: initial.zoom }
      : null,
  );
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  const [exporting, setExporting] = useState(false);

  const mapRef = useRef<MapViewHandle | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const resRef = useRef(res);

  /** Стартовый вид карты фиксируем на монтировании: дальше вид живёт внутри карты. */
  const initialView = useMemo(
    () =>
      initial.zoom !== null && initial.center
        ? { lat: initial.center.lat, lon: initial.center.lon, zoom: initial.zoom }
        : null,
    [initial.zoom, initial.center],
  );

  // Справочники: города и категории
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loadedCities, loadedCategories] = await Promise.all([fetchCities(), fetchCategories()]);
        if (cancelled) return;
        setCities(loadedCities);
        setCategories(loadedCategories);
        setCitySlug((current) => current ?? loadedCities[0]?.slug ?? null);
        setCategorySlug((current) => {
          if (current) return current;
          // По умолчанию — категория, где есть данные, а не первая в списке
          return (
            loadedCategories.find((item) => item.poi_count > 0)?.slug ?? loadedCategories[0]?.slug ?? null
          );
        });
      } catch (exc) {
        if (cancelled) return;
        setError(asApiError(exc));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Данные теплового слоя: перезапрашиваем при смене города, категории, разрешения и по «Повторить»
  useEffect(() => {
    if (!citySlug || !categorySlug) return;

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    setStatus("loading");
    (async () => {
      try {
        const response = await fetchCells({ city: citySlug, category: categorySlug, res });
        if (controller.signal.aborted) return;
        setCells(response);
        setError(null);
        setStatus(response.meta.non_empty_count > 0 ? "ready" : "empty");
      } catch (exc) {
        if (controller.signal.aborted) return;
        setError(asApiError(exc));
        setStatus("error");
      }
    })();

    return () => controller.abort();
  }, [citySlug, categorySlug, res, reloadToken]);

  // Смена разрешения означает другую сетку: ячейку из прежней сетки больше не подсвечиваем
  useEffect(() => {
    if (resRef.current === res) return;
    resRef.current = res;
    setSelectedCell(null);
  }, [res]);

  // Состояние интерфейса в адресной строке: ссылкой можно поделиться (replaceState — без спама истории)
  useEffect(() => {
    if (!citySlug || !categorySlug || typeof window === "undefined") return;

    const search = buildSearch({
      city: citySlug,
      category: categorySlug,
      cell: selectedCell,
      res,
      zoom: view?.zoom ?? null,
      center: view ? { lat: view.lat, lon: view.lon } : null,
    });
    window.history.replaceState(null, "", `${window.location.pathname}?${search}`);
  }, [citySlug, categorySlug, selectedCell, res, view]);

  const city = useMemo(() => cities.find((item) => item.slug === citySlug) ?? null, [cities, citySlug]);
  const category = useMemo(
    () => categories.find((item) => item.slug === categorySlug) ?? null,
    [categories, categorySlug],
  );
  const categoryNames = useMemo(
    () => Object.fromEntries(categories.map((item) => [item.slug, item.name])) as Record<string, string>,
    [categories],
  );
  const exportContext = useMemo<ExportContext | null>(
    () =>
      city && category
        ? {
            cityName: city.name,
            categoryName: category.name,
            res,
            dataVersion: cells?.meta.data_version ?? city.data_version,
          }
        : null,
    [city, category, res, cells],
  );

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

  const handleCellSelect = useCallback((h3: string) => {
    setSelectedCell(h3);
  }, []);

  const reload = useCallback(() => {
    setError(null);
    setStatus("loading");
    setReloadToken((value) => value + 1);
  }, []);

  const handleShare = useCallback(async () => {
    const url = window.location.href;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API недоступен");
      await navigator.clipboard.writeText(url);
      setShareStatus("copied");
    } catch {
      // Фолбэк для http/localhost и браузеров без Clipboard API: показываем ссылку для копирования
      setShareStatus("failed");
      window.prompt("Скопируйте ссылку", url);
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
    if (!cells || !exportContext) return;
    downloadText(buildCellsCsv(cells), exportFileName(exportContext, "csv"));
  }, [cells, exportContext]);

  return (
    <>
      <header className="topbar">
        <span className="topbar__brand">ГЕОПУЛЬС</span>

        <label className="topbar__control">
          Город
          <select
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

        <label className="topbar__control">
          Категория
          <select
            aria-label="Категория"
            value={categorySlug ?? ""}
            onChange={(event) => {
              setCategorySlug(event.target.value);
              setSelectedCell(null);
            }}
          >
            {categories.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
                {item.poi_count === 0 ? " — нет данных" : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="topbar__actions">
          <button
            type="button"
            className="topbar__button"
            onClick={handleShare}
            data-testid="share"
            title="Скопировать ссылку на текущий вид"
          >
            Поделиться
          </button>
          <button
            type="button"
            className="topbar__button"
            onClick={handleExportPng}
            disabled={!cells || exporting}
            data-testid="export-png"
            title="Скачать PNG текущего вида"
          >
            {exporting ? "Готовим…" : "PNG"}
          </button>
          <button
            type="button"
            className="topbar__button"
            onClick={handleExportCsv}
            disabled={!cells}
            data-testid="export-csv"
            title="Скачать CSV ячеек: индекс H3, количество объектов, плотность"
          >
            CSV
          </button>
          {shareStatus !== "idle" && (
            <span className="topbar__meta" data-testid="share-status">
              {shareStatus === "copied" ? "ссылка скопирована" : "скопируйте ссылку из окна браузера"}
            </span>
          )}
        </div>

        <span className="topbar__spacer" />

        <span className="topbar__meta" data-testid="data-version">
          {cells?.meta.data_version
            ? `Данные OSM на ${cells.meta.data_version}`
            : initialDataLabel(status)}
        </span>
        <span className="topbar__meta" data-testid="resolution">
          сетка res {res}
        </span>
      </header>

      <div className="map">
        {city ? (
          <MapView
            ref={mapRef}
            city={city}
            cells={cells}
            initialView={initialView}
            selectedCell={selectedCell}
            onCellSelect={handleCellSelect}
            onResolutionChange={handleResolutionChange}
            onViewChange={handleViewChange}
            styleUrl={styleUrl}
          />
        ) : (
          <div className="map__placeholder" />
        )}

        {category && (
          <Legend
            breaks={cells?.meta.density_breaks ?? null}
            poiCount={cells?.meta.poi_count ?? category.poi_count}
            thinDataThreshold={THIN_DATA_THRESHOLD}
          />
        )}

        {status === "loading" && (
          <div className="overlay" data-testid="loading">
            <div className="overlay__card">Загружаем тепловую карту…</div>
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

        {status === "error" && error && (
          <div className="overlay" data-testid="error">
            <div className="overlay__card overlay__card--error">
              <strong>{error.title}</strong>
              <p>{error.detail}</p>
              {error.isOffline && <p>Проверьте соединение с интернетом и попробуйте снова.</p>}
              {error.isDataMissing && (
                <p>
                  Данные для города ещё не собраны: на сервере нужно выполнить импорт и агрегацию
                  (<code>geopuls.importers.poi</code>, <code>geopuls.aggregate</code>).
                </p>
              )}
              <button type="button" className="overlay__button" onClick={reload}>
                Повторить
              </button>
            </div>
          </div>
        )}

        {citySlug && selectedCell && (
          <PoiPanel
            city={citySlug}
            category={categorySlug}
            cell={selectedCell}
            res={res}
            categoryNames={categoryNames}
            onClose={() => setSelectedCell(null)}
          />
        )}
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
