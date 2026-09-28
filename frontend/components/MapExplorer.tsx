"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Legend from "@/components/Legend";
import MapView from "@/components/MapView";
import {
  ApiError,
  type CategoryMeta,
  type CellsResponse,
  type CityMeta,
  fetchCategories,
  fetchCells,
  fetchCities,
} from "@/lib/api";
import { resolutionForZoom } from "@/lib/heat";

export type MapExplorerProps = {
  /** URL стиля подложки (значение из окружения, см. docs/decisions/0002-basemap.md). */
  styleUrl: string;
  /** Стартовые значения из query-параметров (shareable URL, раздел 4.3 ТЗ). */
  initialCity?: string;
  initialCategory?: string;
};

type Status = "loading" | "ready" | "empty" | "error";

const DEFAULT_RES = resolutionForZoom(12);
/** Порог «мало данных» для честного предупреждения в легенде. */
const THIN_DATA_THRESHOLD = 30;

export default function MapExplorer({ styleUrl, initialCity, initialCategory }: MapExplorerProps) {
  const [cities, setCities] = useState<CityMeta[]>([]);
  const [categories, setCategories] = useState<CategoryMeta[]>([]);
  const [citySlug, setCitySlug] = useState<string | null>(initialCity ?? null);
  const [categorySlug, setCategorySlug] = useState<string | null>(initialCategory ?? null);
  const [res, setRes] = useState<8 | 9>(DEFAULT_RES);
  const [cells, setCells] = useState<CellsResponse | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const requestRef = useRef<AbortController | null>(null);

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

  const city = useMemo(() => cities.find((item) => item.slug === citySlug) ?? null, [cities, citySlug]);
  const category = useMemo(
    () => categories.find((item) => item.slug === categorySlug) ?? null,
    [categories, categorySlug],
  );

  const handleResolutionChange = useCallback((next: 8 | 9) => {
    setRes((current) => (current === next ? current : next));
  }, []);

  const reload = useCallback(() => {
    setError(null);
    setStatus("loading");
    setReloadToken((value) => value + 1);
  }, []);

  return (
    <>
      <header className="topbar">
        <span className="topbar__brand">ГЕОПУЛЬС</span>

        <label className="topbar__control">
          Город
          <select
            aria-label="Город"
            value={citySlug ?? ""}
            onChange={(event) => setCitySlug(event.target.value)}
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
            onChange={(event) => setCategorySlug(event.target.value)}
          >
            {categories.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
                {item.poi_count === 0 ? " — нет данных" : ""}
              </option>
            ))}
          </select>
        </label>

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
            city={city}
            cells={cells}
            onResolutionChange={handleResolutionChange}
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
