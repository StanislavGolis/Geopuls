"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  type CellProfile,
  type CityProfile,
  fetchCellProfile,
  fetchCityProfile,
} from "@/lib/api";
import { formatLayerValue, metricLabel } from "@/lib/layers";

export type ComparePanelProps = {
  city: string;
  /** Ячейки сравнения: панель показывает их рядом, поэтому минимум две. */
  cells: string[];
  res: number;
  onRemove: (h3: string) => void;
  onClear: () => void;
  onClose: () => void;
};

/** Строка таблицы: показатель и значения по зонам. */
type Row = {
  key: string;
  title: string;
  unitLabel: string;
  values: (number | null)[];
};

/**
 * Сравнение зон: несколько гексов рядом, как таблица для отчёта.
 *
 * Как читается: строки — показатели слоёв, колонки — выбранные зоны. У каждой цифры есть единица
 * измерения, отсутствие данных показывается словами «нет данных», а не нулём. Выводов «перегрев/мало»
 * нет: сравнение с медианой города читает человек (ADR 0015).
 */
export default function ComparePanel({
  city,
  cells,
  res,
  onRemove,
  onClear,
  onClose,
}: ComparePanelProps) {
  const [profiles, setProfiles] = useState<Record<string, CellProfile>>({});
  const [cityProfile, setCityProfile] = useState<CityProfile | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const cellsKey = cells.join(",");

  useEffect(() => {
    let cancelled = false;
    setError(null);

    (async () => {
      try {
        const [cityData, ...zoneProfiles] = await Promise.all([
          fetchCityProfile(city),
          ...cells.map((cell) => fetchCellProfile({ city, cell, res })),
        ]);
        if (cancelled) return;
        setCityProfile(cityData);
        setProfiles(
          Object.fromEntries(cells.map((cell, index) => [cell, zoneProfiles[index] as CellProfile])),
        );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cellsKey покрывает состав набора
  }, [city, cellsKey, res, reloadToken]);

  // Esc закрывает панель: это модальное окно поверх карты
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const retry = useCallback(() => setReloadToken((value) => value + 1), []);
  const rows = buildRows(cells, profiles, cityProfile);

  return (
    <div
      className="compare"
      role="dialog"
      aria-modal="true"
      aria-label="Сравнение зон"
      data-testid="compare-panel"
    >
      <div className="compare__card">
        <header className="compare__head">
          <div>
            <h2 className="compare__title">Сравнение зон</h2>
            <p className="compare__subtitle">
              Кликните по гексу на карте, чтобы добавить или убрать зону (до пяти)
            </p>
          </div>
          <div className="compare__actions">
            <button type="button" className="compare__button" onClick={onClear} data-testid="compare-clear">
              Очистить
            </button>
            <button
              type="button"
              className="compare__close"
              onClick={onClose}
              aria-label="Закрыть сравнение зон"
              data-testid="compare-close"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        {error && (
          <div className="compare__error" data-testid="compare-error">
            <strong>{error.title}</strong>
            <p>{error.detail}</p>
            <button type="button" className="overlay__button" onClick={retry}>
              Повторить
            </button>
          </div>
        )}

        {!error && cells.length < 2 && (
          <p className="compare__note" data-testid="compare-hint">
            Выберите хотя бы две зоны — тогда появится таблица. Данные одной зоны уже есть в её карточке.
          </p>
        )}

        {!error && cells.length >= 2 && (
          <div className="compare__scroll">
            <table className="compare__table" data-testid="compare-table">
              <thead>
                <tr>
                  <th className="compare__th">Показатель</th>
                  {cells.map((cell) => (
                    <th className="compare__th" key={cell}>
                      <span className="mono compare__cell">{cell}</span>
                      <button
                        type="button"
                        className="compare__remove"
                        onClick={() => onRemove(cell)}
                        aria-label={`Убрать зону ${cell}`}
                        data-testid={`compare-remove-${cell}`}
                      >
                        убрать
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr className="compare__row" key={row.key}>
                    <th className="compare__row-title">
                      {row.title}
                      {row.unitLabel && <span className="compare__row-unit">{row.unitLabel}</span>}
                    </th>
                    {row.values.map((value, index) => (
                      <td className="compare__value" key={`${row.key}-${cells[index]}`}>
                        {formatLayerValue(value, null)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="compare__footer-note">
          Наблюдения по данным: «нет данных» — это не ноль, а решение о зоне принимает человек (ADR 0015).
        </p>
      </div>
    </div>
  );
}

/**
 * Собрать строки таблицы: одна строка на слой, плюс число объектов выбранной категории.
 *
 * Строки берутся из значений слоёв «как есть»: единицы измерения разные (плотность, доля площади,
 * километры), поэтому складывать их в один балл нельзя — это и было бы тем самым «вердиктом».
 */
function buildRows(
  cells: string[],
  profiles: Record<string, CellProfile>,
  cityProfile: CityProfile | null,
): Row[] {
  const rows: Row[] = [];
  const first = profiles[cells[0]];

  const countMetric = first?.metrics.find((metric) => metric.layer === "competitors");
  const countValues = cells.map((cell) => {
    const metric = profiles[cell]?.metrics.find((item) => item.layer === "competitors");
    const count = metric?.extras?.count;
    return typeof count === "number" ? count : (metric?.value ?? null);
  });
  if (countMetric) {
    rows.push({
      key: "objects",
      title: `${countMetric.layer_name} — объектов`,
      unitLabel: countMetric.unit ? `шт` : "",
      values: countValues,
    });
  }

  const layerMeta = new Map(
    (cityProfile?.layers ?? []).map((layer) => [layer.slug, layer]),
  );

  for (const metric of first?.metrics ?? []) {
    // Базовый слой тоже в таблице: плотность конкурентов — то, с чем сравнивают зоны в первую очередь
    const meta = layerMeta.get(metric.layer);
    rows.push({
      key: metric.layer,
      title: meta?.name ?? metric.layer_name,
      unitLabel: `${metricLabel(metric.metric_kind)}${metric.unit ? `, ${metric.unit}` : ""}`,
      values: cells.map((cell) => {
        const value = profiles[cell]?.metrics.find((item) => item.layer === metric.layer)?.value;
        return typeof value === "number" ? value : null;
      }),
    });
  }

  return rows;
}