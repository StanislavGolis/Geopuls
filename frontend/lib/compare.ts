/**
 * Строки таблицы «зона против зоны»: одна логика на экран и на отчёт.
 *
 * Вынесено из `ComparePanel`, потому что тем же набором строк пользуется PDF-отчёт: если бы отчёт считал
 * свои строки, таблица на экране и таблица в документе однажды разошлись бы.
 */

import type { CellProfile, CityProfile } from "@/lib/api";
import { metricLabel } from "@/lib/layers";

/** Строка таблицы: показатель и значения по зонам (null — «нет данных», а не ноль). */
export type CompareRow = {
  key: string;
  title: string;
  unitLabel: string;
  values: (number | null)[];
};

/**
 * Собрать строки таблицы: одна строка на слой, плюс число объектов выбранной категории.
 *
 * Строки берутся из значений слоёв «как есть»: единицы измерения разные (плотность, доля площади,
 * километры), поэтому складывать их в один балл нельзя — это и было бы тем самым «вердиктом».
 */
export function buildCompareRows(
  cells: string[],
  profiles: Record<string, CellProfile>,
  cityProfile: CityProfile | null,
): CompareRow[] {
  const rows: CompareRow[] = [];
  const first = profiles[cells[0] as string];

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
      unitLabel: countMetric.unit ? "шт" : "",
      values: countValues,
    });
  }

  const layerMeta = new Map((cityProfile?.layers ?? []).map((layer) => [layer.slug, layer]));

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
