"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { formatDistance, formatNearest } from "@/components/AroundPanel";
import MapView from "@/components/MapView";
import {
  ApiError,
  fetchAround,
  fetchCategories,
  fetchCellProfile,
  fetchCities,
  fetchCityProfile,
  fetchLayerGrid,
  fetchLayers,
  type AroundResponse,
  type CellProfile,
  type CityMeta,
  type CityProfile,
  type LayerGrid,
  type LayerMeta,
} from "@/lib/api";
import { buildCompareRows } from "@/lib/compare";
import { buildExportFooter, type ExportContext } from "@/lib/export";
import { legendItems } from "@/lib/heat";
import {
  COMPETITORS_SLUG,
  baseColumn,
  layerLegend,
  parseLayerRef,
  serializeLayerList,
  serializeLayerRef,
  type LayerRef,
} from "@/lib/layers";
import { reportFileName, reportHeading } from "@/lib/report";
import { buildSearch, type UrlState } from "@/lib/urlState";
import { classLabel, densityDistribution, topZones } from "@/lib/widgets";

export type ReportProps = {
  /** Состояние сцены из адресной строки: отчёт печатает ровно то, что было на экране. */
  state: UrlState;
  /** URL стиля подложки (см. docs/decisions/0002-basemap.md). */
  styleUrl: string;
};

type ReportData = {
  city: CityMeta;
  layers: LayerMeta[];
  categoryNames: Record<string, string>;
  grid: LayerGrid;
  cityProfile: CityProfile | null;
  cellProfiles: CellProfile[];
  around: AroundResponse | null;
};

/**
 * Отчёт: страница, которую печатают в PDF (этап 5 плана развития).
 *
 * Почему печать средствами браузера, а не серверный Playwright: Chromium в образе API — это +400 МБ и
 * отдельная точка отказа ради того же PDF, а диалог печати умеет «Сохранить как PDF» на всех платформах.
 * Отчёт показывает то, что было на экране (сцена из ADR 0016), и обязательно несёт атрибуцию, дату
 * выгрузки и оговорку «это наблюдения, а не прогноз» (ADR 0015).
 */
export default function Report({ state, styleUrl }: ReportProps) {
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // Слой, которым покрашена карта: в «Инфраструктуре» это выбранный показатель, иначе конкуренты
  const baseRef = useMemo<LayerRef | null>(() => {
    const requested = parseLayerRef(state.base);
    if (state.tab === "infrastructure") {
      return requested && requested.slug !== COMPETITORS_SLUG ? { slug: requested.slug, category: null } : null;
    }
    return { slug: COMPETITORS_SLUG, category: state.category };
  }, [state.base, state.category, state.tab]);

  useEffect(() => {
    if (!state.city) return;
    let cancelled = false;

    (async () => {
      try {
        const [cities, categories, registry] = await Promise.all([
          fetchCities(),
          fetchCategories(),
          fetchLayers(),
        ]);
        const city = cities.find((item) => item.slug === state.city);
        if (!city) throw new ApiError(404, "Город не найден", `Города ${state.city} нет в списке`);

        const resolved = baseRef ?? { slug: COMPETITORS_SLUG, category: state.category };
        const base = resolved.category ? serializeLayerRef(resolved) : resolved.slug;
        const res = state.res ?? 9;

        // Наложения — все слои города, кроме базового: сводка по зоне в отчёте показывает числа по всем
        // слоям, и выборочного «что показать» больше нет (см. §4.11 дизайн-спеки)
        const overlays = serializeLayerList(
          registry.layers
            .filter((layer) => layer.slug !== resolved.slug)
            .map((layer) =>
              layer.slug === COMPETITORS_SLUG
                ? { slug: layer.slug, category: resolved.category ?? layer.categories[0] ?? null }
                : { slug: layer.slug, category: null },
            ),
        );

        const [grid, cityProfile] = await Promise.all([
          fetchLayerGrid({ city: city.slug, base, res, overlays: overlays || undefined }),
          fetchCityProfile(city.slug),
        ]);

        const cells = state.compare ? state.compare.split(",").filter(Boolean) : [];
        const cellProfiles = await Promise.all(
          cells.map((cell) => fetchCellProfile({ city: city.slug, cell, res })),
        );

        const around =
          state.around && state.category
            ? await fetchAround({
                city: city.slug,
                lat: state.around.lat,
                lon: state.around.lon,
                category: state.category,
                radiusM: state.radius ?? 500,
              })
            : null;

        if (cancelled) return;
        setData({
          city,
          layers: registry.layers,
          categoryNames: Object.fromEntries(categories.map((item) => [item.slug, item.name])),
          grid,
          cityProfile,
          cellProfiles,
          around,
        });
      } catch (exc) {
        if (cancelled) return;
        setError(
          exc instanceof ApiError
            ? exc
            : new ApiError(0, "Непредвиденная ошибка", exc instanceof Error ? exc.message : String(exc)),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    state.city,
    state.tab,
    state.category,
    state.base,
    state.res,
    state.compare,
    state.around,
    state.radius,
    baseRef,
  ]);

  return (
    <main className="report" data-testid="report">
      {error && (
        <div className="report__error" data-testid="report-error">
          <strong>{error.title}</strong>
          <p>{error.detail}</p>
          <Link className="report__link" href="/">
            Вернуться на карту
          </Link>
        </div>
      )}

      {!error && !data && <p className="report__loading">Готовим отчёт…</p>}

      {data && <ReportDocument data={data} state={state} styleUrl={styleUrl} />}
    </main>
  );
}

function ReportDocument({
  data,
  state,
  styleUrl,
}: {
  data: ReportData;
  state: UrlState;
  styleUrl: string;
}) {
  const { city, grid, cityProfile, cellProfiles, around, categoryNames } = data;
  const column = baseColumn(grid);
  const baseMeta = data.layers.find((item) => item.slug === column?.slug) ?? null;
  const subject = column?.category
    ? (categoryNames[column.category] ?? column.category)
    : (baseMeta?.name ?? null);

  const heading = reportHeading({
    cityName: city.name,
    tab: state.tab ?? "competitors",
    subject,
    dataVersion: city.data_version,
    compareCount: cellProfiles.length,
    point: state.around,
    radiusM: state.radius,
  });

  const zones = column ? topZones(grid, column) : [];
  const distribution = column ? densityDistribution(grid, column) : null;
  const legend = column ? layerLegend(column) : null;
  const legendRows = legendItems(legend?.breaks ?? null);

  const cells = state.compare ? state.compare.split(",").filter(Boolean) : [];
  const profiles = Object.fromEntries(
    cells.map((cell, index) => [cell, cellProfiles[index] as CellProfile]),
  );
  const compareRows = buildCompareRows(cells, profiles, cityProfile);

  const exportContext: ExportContext = {
    cityName: city.name,
    res: grid.meta.res,
    layers: grid.layers.map((item) => ({
      slug: item.slug,
      name: item.name,
      category: item.category,
      categoryName: item.category ? (categoryNames[item.category] ?? item.category) : null,
      role: item.role,
      unit: item.unit,
    })),
    dataVersion: grid.meta.data_version ?? city.data_version,
  };

  /** Печать: имя файла браузер берёт из заголовка документа, поэтому подставляем его перед печатью. */
  const handlePrint = () => {
    if (typeof document !== "undefined") {
      document.title = reportFileName(city.name, heading.scene, city.data_version);
    }
    window.print();
  };

  const noop = () => {};

  return (
    <>
      <header className="report__head">
        <p className="report__brand">ГЕОПУЛЬС</p>
        <h1 className="report__title" data-testid="report-title">
          {heading.title}
        </h1>
        <p className="report__subtitle" data-testid="report-subtitle">
          {heading.subtitle}
        </p>
        {/* Кнопки печати и возврата — часть экрана, а не документа: в PDF они не попадают */}
        <div className="report__actions">
          <button type="button" className="report__print" data-testid="report-print" onClick={handlePrint}>
            Скачать PDF
          </button>
          <span className="report__hint">
            В диалоге печати выберите «Сохранить как PDF»: разметка и атрибуция уже готовы
          </span>
          <a className="report__link" href={`/?${buildStateSearch(state)}`}>
            Вернуться на карту
          </a>
        </div>
      </header>

      <section className="report__section">
        <h2 className="report__section-title">Карта</h2>
        <div className="report__map" data-testid="report-map">
          <MapView
            city={city}
            grid={grid}
            initialView={null}
            selectedCell={null}
            outlineCells={cells}
            around={state.around ? { ...state.around, radiusM: state.radius ?? 500 } : null}
            category={column?.category ?? null}
            onCellSelect={noop}
            onResolutionChange={noop}
            onViewChange={noop}
            styleUrl={styleUrl}
          />
        </div>

        {legendRows.length > 1 && (
          <ul className="report__legend" data-testid="report-legend">
            <li className="report__legend-caption">
              {legend?.name}: плотность и шкала классов
            </li>
            {legendRows.map((item) => (
              <li className="report__legend-row" key={item.label}>
                <span className="report__swatch" style={{ background: item.color }} aria-hidden="true" />
                <span className="mono">{item.label}</span>
                {item.note && <span className="report__legend-note">{item.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {(state.tab ?? "competitors") !== "tools" && (state.tab ?? "competitors") !== "city" && (
        <>
          <section className="report__section">
            <h2 className="report__section-title">Охват данных</h2>
            <table className="report__table" data-testid="report-coverage">
              <tbody>
                <tr>
                  <th>Ячеек в сетке</th>
                  <td className="mono">{grid.meta.cell_count}</td>
                </tr>
                <tr>
                  <th>Непустых ячеек</th>
                  <td className="mono">{column?.non_empty_count ?? 0}</td>
                </tr>
                <tr>
                  <th>Разрешение сетки</th>
                  <td className="mono">H3 res {grid.meta.res}</td>
                </tr>
                <tr>
                  <th>Максимум в слое</th>
                  <td className="mono">{formatValue(column?.max_value ?? null, column?.unit ?? null)}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="report__section">
            <h2 className="report__section-title">Топ зон</h2>
            {zones.length === 0 ? (
              <p className="report__note">Зон со значением больше нуля в этой сетке нет.</p>
            ) : (
              <table className="report__table" data-testid="report-zones">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Зона (H3)</th>
                    <th>Значение</th>
                    <th>Объектов</th>
                  </tr>
                </thead>
                <tbody>
                  {zones.map((zone, index) => (
                    <tr key={zone.h3}>
                      <td className="mono">{index + 1}</td>
                      <td className="mono">{zone.h3}</td>
                      <td className="mono">{formatValue(zone.value, column?.unit ?? null)}</td>
                      <td className="mono">{zone.count ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="report__section">
            <h2 className="report__section-title">Классы плотности</h2>
            <table className="report__table" data-testid="report-classes">
              <thead>
                <tr>
                  <th>Класс</th>
                  <th>Зон</th>
                </tr>
              </thead>
              <tbody>
                {(distribution?.classes ?? []).map((item, index) => (
                  <tr key={item.index}>
                    <td className="mono">
                      {classLabel(item, index === (distribution?.classes.length ?? 0) - 1)}
                    </td>
                    <td className="mono">{item.count}</td>
                  </tr>
                ))}
                <tr>
                  <td>пусто (0)</td>
                  <td className="mono">{distribution?.empty ?? 0}</td>
                </tr>
                {(distribution?.unknown ?? 0) > 0 && (
                  <tr>
                    <td>нет данных</td>
                    <td className="mono">{distribution?.unknown}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}

      {state.tab === "tools" && around && (
        <section className="report__section">
          <h2 className="report__section-title">Что вокруг точки: радиус {around.meta.radius_m} м</h2>
          <table className="report__table" data-testid="report-around">
            <thead>
              <tr>
                <th>Показатель</th>
                <th>В радиусе</th>
                <th>Ближайший</th>
              </tr>
            </thead>
            <tbody>
              {around.layers.map((layer) => (
                <tr key={layer.slug}>
                  <th>{layer.name}</th>
                  <td className="mono">
                    {layer.objects === 0 ? "нет в радиусе" : `${layer.objects} объектов`}
                  </td>
                  <td className="mono">{formatNearest(layer)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="report__note">
            Точка {around.point.lat.toFixed(5)}, {around.point.lon.toFixed(5)} ·{" "}
            {formatDistance(around.meta.radius_m)}
          </p>
        </section>
      )}

      {state.tab === "tools" && !around && compareRows.length > 0 && (
        <section className="report__section">
          <h2 className="report__section-title">Сравнение зон</h2>
          <table className="report__table" data-testid="report-compare">
            <thead>
              <tr>
                <th>Показатель</th>
                {cells.map((cell) => (
                  <th className="mono" key={cell}>
                    {cell}
                  </th>
                ))}
                <th>Медиана города</th>
              </tr>
            </thead>
            <tbody>
              {compareRows.map((row) => (
                <tr key={row.key}>
                  <th>
                    {row.title}
                    {row.unitLabel && <span className="report__unit">{row.unitLabel}</span>}
                  </th>
                  {row.values.map((value, index) => (
                    <td className="mono" key={`${row.key}-${cells[index]}`}>
                      {formatLayerNumber(value)}
                    </td>
                  ))}
                  <td className="mono">
                    {formatLayerNumber(
                      cityProfile?.layers.find((layer) => layer.slug === row.key)?.median_value ?? null,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="report__note">
            Сравнение с медианой города — наблюдение: вывод о зоне делает человек (ADR 0015).
          </p>
        </section>
      )}

      {state.tab === "city" && cityProfile && (
        <>
          <section className="report__section">
            <h2 className="report__section-title">Охват данных</h2>
            <table className="report__table" data-testid="report-city">
              <tbody>
                <tr>
                  <th>Площадь</th>
                  <td className="mono">{cityProfile.city.area_km2} км²</td>
                </tr>
                <tr>
                  <th>Ячеек в сетке</th>
                  <td className="mono">{cityProfile.grid.cells}</td>
                </tr>
                <tr>
                  <th>Непустых ячеек</th>
                  <td className="mono">
                    {cityProfile.grid.cells_non_empty} ({cityProfile.grid.empty_share}% пустых)
                  </td>
                </tr>
                <tr>
                  <th>Объектов размечено</th>
                  <td className="mono">{cityProfile.grid.poi_count}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="report__section">
            <h2 className="report__section-title">Категории</h2>
            <table className="report__table" data-testid="report-categories">
              <thead>
                <tr>
                  <th>Категория</th>
                  <th>Объектов</th>
                  <th>Доля</th>
                </tr>
              </thead>
              <tbody>
                {cityProfile.categories.map((category) => (
                  <tr key={category.slug}>
                    <th>{category.name}</th>
                    <td className="mono">{category.poi_count}</td>
                    <td className="mono">{category.share === null ? "—" : `${category.share}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="report__section">
            <h2 className="report__section-title">Слои</h2>
            <table className="report__table" data-testid="report-city-layers">
              <thead>
                <tr>
                  <th>Слой</th>
                  <th>Метрика</th>
                  <th>Непустых</th>
                  <th>Медиана</th>
                </tr>
              </thead>
              <tbody>
                {cityProfile.layers.map((layer) => (
                  <tr key={layer.slug}>
                    <th>{layer.name}</th>
                    <td className="mono">{layer.unit ?? layer.metric_kind}</td>
                    <td className="mono">{layer.non_empty_count}</td>
                    <td className="mono">{formatLayerNumber(layer.median_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <footer className="report__footer">
        {buildExportFooter(exportContext).map((line) => (
          <p className="report__footer-line" key={line}>
            {line}
          </p>
        ))}
        <p className="report__disclaimer" data-testid="report-disclaimer">
          Это наблюдения по данным OpenStreetMap, а не прогноз и не рекомендация: «пустая зона» не значит,
          что бизнеса там нет, а решение о точке принимает человек (ADR 0015).
        </p>
      </footer>
    </>
  );
}

/** Значение с единицей измерения или словами «нет данных»: ноль и «нет данных» — разные вещи. */
function formatValue(value: number | null, unit: string | null): string {
  if (value === null) return "нет данных";
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return unit ? `${text} ${unit}` : text;
}

/** Число без единицы: в таблицах единица указана в названии строки. */
function formatLayerNumber(value: number | null): string {
  if (value === null) return "нет данных";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Ссылка назад на карту: с тем же состоянием сцены, чтобы вернуться туда же. */
function buildStateSearch(state: UrlState): string {
  return buildSearch({
    city: state.city,
    tab: state.tab,
    category: state.category,
    base: state.base,
    cell: state.cell,
    // Подсветку объектов слоёв ссылка тоже несёт: из отчёта можно вернуться к той же карте
    objects: state.objects,
    compare: state.compare,
    around: state.around,
    radius: state.radius,
    res: state.res,
    zoom: state.zoom,
    center: state.center,
  });
}
