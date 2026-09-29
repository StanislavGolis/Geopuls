/**
 * Слои карты: ссылки на слой, свойства ячеек и сборка GeoJSON для MapLibre (ADR 0013).
 *
 * Здесь только чистые функции: состояние карты и запросы живут в `MapExplorer`. Правило «один
 * базовый слой + не больше двух наложений» должно проверяться тестом без браузера, поэтому оно
 * живёт в этой паре функций, а не в JSX.
 */

import type { LayerGrid, LayerMeta, MapLayerColumn } from "@/lib/api";

/** Сколько наложений разрешено поверх базового слоя (ADR 0013) — то же число проверяет API. */
export const MAX_OVERLAYS = 2;

export type LayerRef = { slug: string; category: string | null };

/** Slug слоя и категории: латиница в нижнем регистре (как в справочниках и в API). */
const REF_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Разобрать ссылку на слой: `competitors:cafe` → `{ slug, category }`. */
export function parseLayerRef(value: string | null | undefined): LayerRef | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;

  const [slug, category, ...rest] = trimmed.split(":");
  if (rest.length > 0 || !REF_PATTERN.test(slug)) return null;
  if (category === undefined) return { slug, category: null };
  if (!REF_PATTERN.test(category)) return null;
  return { slug, category };
}

/** Собрать ссылку на слой для URL и запроса: `slug` или `slug:category`. */
export function serializeLayerRef(ref: LayerRef): string {
  return ref.category ? `${ref.slug}:${ref.category}` : ref.slug;
}

export function sameLayerRef(left: LayerRef, right: LayerRef): boolean {
  return left.slug === right.slug && left.category === right.category;
}

/**
 * Разобрать список наложений из URL: `population,transport:stop`.
 *
 * Мусор и повторы игнорируются, лишние наложения отбрасываются: ссылка может быть написана руками,
 * и она не должна ронять карту (тем же правилом живёт `parseUrlState`).
 */
export function parseLayerList(value: string | null | undefined): LayerRef[] {
  const refs: LayerRef[] = [];
  for (const part of (value ?? "").split(",")) {
    const ref = parseLayerRef(part);
    if (!ref) continue;
    if (refs.some((existing) => sameLayerRef(existing, ref))) continue;
    if (refs.length >= MAX_OVERLAYS) break;
    refs.push(ref);
  }
  return refs;
}

export function serializeLayerList(refs: LayerRef[]): string {
  return refs.slice(0, MAX_OVERLAYS).map(serializeLayerRef).join(",");
}

/** Свойства ячейки для MapLibre: значение базового слоя плюс значения наложений. */
export type CellProperties = {
  h3: string;
  /** Значение базового слоя — им красится заливка. */
  value: number;
  /** Число объектов базового слоя, если слой его отдаёт (подпись, экспорт). */
  count: number | null;
  [key: string]: number | string | null;
};

export type CellFeature = {
  type: "Feature";
  id: string;
  properties: CellProperties;
  geometry: { type: "Polygon"; coordinates: number[][][] };
};

export type CellFeatureCollection = {
  type: "FeatureCollection";
  features: CellFeature[];
};

/** Имя свойства для значений наложения: `layer_<slug>`. */
export function overlayProperty(slug: string): string {
  return `layer_${slug.replace(/[^a-z0-9]/gi, "_")}`;
}

/** Базовый слой ответа: тот, что красит карту. */
export function baseColumn(grid: LayerGrid): MapLayerColumn | null {
  return grid.layers.find((column) => column.role === "base") ?? null;
}

export function overlayColumns(grid: LayerGrid): MapLayerColumn[] {
  return grid.layers.filter((column) => column.role === "overlay");
}

/**
 * Ячейки в форме GeoJSON для MapLibre: одна коллекция на всю карту, значения слоёв — в свойствах.
 *
 * Один источник вместо источника на слой: наложения различаются раскраской, а не данными, и держать
 * три копии одной и той же геометрии в памяти карты незачем.
 */
export function buildCellFeatures(grid: LayerGrid, base: MapLayerColumn | null): CellFeatureCollection {
  const overlays = overlayColumns(grid);
  const counts = base?.extras.count ?? null;

  const features = grid.cells.h3.map((h3, index): CellFeature => {
    const properties: CellProperties = {
      h3,
      value: Number(base?.values[index] ?? 0),
      count: counts?.[index] ?? null,
    };
    for (const column of overlays) {
      properties[overlayProperty(column.slug)] = column.values[index] ?? null;
    }

    return {
      type: "Feature",
      id: h3,
      properties,
      geometry: { type: "Polygon", coordinates: [grid.cells.geometry[index] ?? []] },
    };
  });

  return { type: "FeatureCollection", features };
}

/** Слой собран не по всей сетке: об этом нужно сказать честно, а не показывать нули. */
export function isPartiallyCovered(column: MapLayerColumn, cellCount: number): boolean {
  return cellCount > 0 && column.covered_count < cellCount;
}

/** Подпись значения: «12.3 POI/км²», «240 шт», «нет данных». */
export function formatLayerValue(value: number | null, unit: string | null, digits = 1): string {
  if (value === null) return "нет данных";
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(digits);
  return unit ? `${text} ${unit}` : text;
}

/**
 * Словесное название типа метрики: в легенде нужен смысл, а не технический `metric_kind`.
 *
 * Названия нужны, чтобы шкалу нельзя было прочитать неверно: «Плотность, POI/км²» и «Доля площади, %»
 * — разные утверждения о мире, хотя оба рисуются лестницей классов.
 */
const METRIC_LABELS: Record<string, string> = {
  count: "Количество",
  density: "Плотность",
  area_share: "Доля площади",
  people: "Численность",
  people_density: "Плотность населения",
  ratio: "Отношение",
  length: "Длина",
  presence: "Наличие",
};

export function metricLabel(metricKind: string): string {
  return METRIC_LABELS[metricKind] ?? "Значение";
}

/** Сумма дополнительного показателя по колонке (например, числа объектов) или null, если его нет. */
export function sumExtras(column: MapLayerColumn, key: string): number | null {
  const values = column.extras[key];
  if (!values) return null;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** Всё, что легенде нужно знать о слое, — без привязки к устройству колонки. */
export type LayerLegend = {
  name: string;
  metricKind: string;
  unit: string | null;
  breaks: number[];
  /** Число объектов слоя, если он его отдаёт. */
  objectCount: number | null;
};

export function layerLegend(column: MapLayerColumn): LayerLegend {
  return {
    name: column.name,
    metricKind: column.metric_kind,
    unit: column.unit,
    breaks: column.breaks,
    objectCount: sumExtras(column, "count"),
  };
}

/**
 * Какой слой красить при загрузке страницы.
 *
 * Порядок разбора ссылки: явный `base` → старый `category` (ссылки, разошедшиеся до появления
 * слоёв, должны открывать ту же карту) → первый слой, которым можно красить карту. Вариант —
 * предпочтительная категория (та, где есть данные), иначе первый доступный.
 */
export function resolveBaseLayer(
  layers: LayerMeta[],
  requested: { base: string | null; category: string | null },
  preferredCategory?: string | null,
): LayerRef | null {
  const explicit = parseLayerRef(requested.base);
  const explicitOwner = explicit
    ? layers.find((layer) => layer.slug === explicit.slug && layer.can_be_base)
    : undefined;
  if (explicit && explicitOwner) {
    // Вариант проверяем по реестру: в ссылке он мог остаться от другого слоя
    if (explicit.category && !explicitOwner.categories.includes(explicit.category)) {
      return { slug: explicit.slug, category: explicitOwner.categories[0] ?? null };
    }
    if (!explicit.category && explicitOwner.categories.length > 0) {
      return { slug: explicit.slug, category: explicitOwner.categories[0] };
    }
    return explicit;
  }

  if (requested.category) {
    const owner = layers.find(
      (layer) => layer.can_be_base && layer.categories.includes(requested.category as string),
    );
    if (owner) return { slug: owner.slug, category: requested.category };
  }

  const fallback = layers.find((layer) => layer.can_be_base) ?? null;
  if (!fallback) return null;

  if (preferredCategory && fallback.categories.includes(preferredCategory)) {
    return { slug: fallback.slug, category: preferredCategory };
  }
  return { slug: fallback.slug, category: fallback.categories[0] ?? null };
}
