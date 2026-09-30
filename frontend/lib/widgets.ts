/**
 * Виджеты по зонам: топ зон и распределение по классам плотности.
 *
 * Считаются по уже загруженной сетке. Почему на клиенте, а не отдельным эндпоинтом: колоночный ответ
 * `/map` уже здесь, и «топ зон» — это сортировка по колонке; серверный эндпоинт означал бы второй источник
 * правды о тех же числах и второй повод им разойтись (ADR 0016, правило «виджет не обещает невидимого»).
 */

import type { LayerGrid, MapLayerColumn } from "@/lib/api";

/** Зона в списке «где выбранного больше всего». */
export type ZoneRow = {
  h3: string;
  /** Значение метрики слоя: то же, чем покрашена карта. */
  value: number;
  /** Сколько объектов в зоне (`extras.count`), если слой их считает. */
  count: number | null;
};

/** Класс плотности: границы, размер и индекс для подсветки. */
export type DensityClass = {
  index: number;
  from: number;
  to: number;
  count: number;
};

export type DensityDistribution = {
  classes: DensityClass[];
  /** Зоны со значением 0: «здесь нет размеченных объектов» — это не то же, что «нет данных». */
  empty: number;
  /** Зоны, которых слой не покрывает (`null`): «нет данных» — не ноль. */
  unknown: number;
  total: number;
};

/**
 * Топ зон по значению слоя.
 *
 * Пустые зоны и зоны без данных в список не попадают: «где больше всего» не должен начинаться с нулей.
 */
export function topZones(grid: LayerGrid, column: MapLayerColumn, limit = 5): ZoneRow[] {
  const counts = column.extras.count ?? [];
  const rows: ZoneRow[] = [];

  for (let index = 0; index < grid.cells.h3.length; index += 1) {
    const value = column.values[index] ?? null;
    if (value === null || value <= 0) continue;
    rows.push({
      h3: grid.cells.h3[index] as string,
      value,
      count: counts[index] ?? null,
    });
  }

  // Сортировка стабильна (ES2019): при равных значениях порядок остаётся порядком сетки
  return rows.sort((left, right) => right.value - left.value).slice(0, Math.max(limit, 0));
}

/**
 * Номер класса для значения: последний класс включает верхнюю границу.
 *
 * Пустое значение и `null` сюда не приходят: это разные состояния, и считает их `densityDistribution`.
 */
export function classIndexOf(value: number, breaks: number[]): number {
  for (let index = 1; index < breaks.length - 1; index += 1) {
    if (value < (breaks[index] as number)) return index - 1;
  }
  return Math.max(breaks.length - 2, 0);
}

/** Распределение зон по классам плотности: сколько зон в каждом классе, сколько пусто и без данных. */
export function densityDistribution(grid: LayerGrid, column: MapLayerColumn): DensityDistribution {
  const breaks = column.breaks ?? [];
  const classes: DensityClass[] = [];
  for (let index = 1; index < breaks.length; index += 1) {
    classes.push({
      index: index - 1,
      from: breaks[index - 1] as number,
      to: breaks[index] as number,
      count: 0,
    });
  }

  let empty = 0;
  let unknown = 0;
  for (const value of column.values) {
    if (value === null) {
      unknown += 1;
      continue;
    }
    if (value <= 0) {
      empty += 1;
      continue;
    }
    const bucket = classes[classIndexOf(value, breaks)];
    if (bucket) bucket.count += 1;
  }

  return { classes, empty, unknown, total: grid.cells.h3.length };
}

/**
 * Подпись класса плотности — тот же формат, что в легенде: «до 3.4», «3.4 – 15.3», «более 15.3».
 *
 * Одинаковые подписи в легенде и в виджете нужны затем, чтобы класс на карте и строка в списке читались
 * как один и тот же класс, а не как два похожих числа.
 */
export function classLabel(item: DensityClass, isLast: boolean, digits = 1): string {
  const format = (value: number) =>
    Number.isInteger(value) ? String(value) : value.toFixed(digits);
  if (item.index === 0) return `до ${format(item.to)}`;
  if (isLast) return `более ${format(item.from)}`;
  return `${format(item.from)} – ${format(item.to)}`;
}

/**
 * Зоны выбранного класса — для подсветки контуром на карте.
 *
 * Номер класса, а не список ячеек: состояние хранит одно число, а ячейки пересчитываются по требованию —
 * иначе в ссылке и в состоянии оказался бы список из сотен индексов.
 */
export function cellsOfClass(grid: LayerGrid, column: MapLayerColumn, classIndex: number): string[] {
  const breaks = column.breaks ?? [];
  const cells: string[] = [];

  for (let index = 0; index < grid.cells.h3.length; index += 1) {
    const value = column.values[index] ?? null;
    if (value === null || value <= 0) continue;
    if (classIndexOf(value, breaks) !== classIndex) continue;
    cells.push(grid.cells.h3[index] as string);
  }

  return cells;
}
