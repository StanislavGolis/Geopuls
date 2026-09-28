/**
 * Цветовая шкала и классы легенды тепловой карты.
 *
 * Границы классов приходят с бэкенда (`meta.density_breaks`, квантильная шкала): фронтенд только
 * раскрашивает, чтобы шкала совпадала с PNG- и PDF-представлениями
 * (см. docs/decisions/0006-h3-aggregation.md и 0007-api-contract.md).
 */

/** Пять цветов: нулевой класс + четыре класса плотности (от «мало» к «много»). */
export const HEAT_COLORS = ["#e8eef2", "#cfe3f7", "#98c7ea", "#5ba3d5", "#1f6fb2"] as const;

/** Цвет ячеек без размеченных объектов — «пустые зоны», главный ответ сервиса. */
export const ZERO_COLOR = HEAT_COLORS[0];

/** Зум, с которого показываем детальную сетку (res 9); ниже — обзорную (res 8). */
export const DETAIL_ZOOM = 12;

export type LegendItem = {
  color: string;
  label: string;
  /** Нижняя граница класса (POI/км²), null для нулевого класса. */
  from: number | null;
  /** Верхняя граница класса, null для последнего (открытого) класса. */
  to: number | null;
};

export function formatDensity(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Классы легенды по границам `density_breaks` = `[0, b1, b2, b3, max]`.
 *
 * Если данных о границах нет (слой ещё не загружен), возвращаем только нулевой класс —
 * легенда остаётся честной и не показывает выдуманную шкалу.
 */
export function legendItems(breaks: number[] | null | undefined): LegendItem[] {
  const zero: LegendItem = {
    color: ZERO_COLOR,
    label: "0 — нет размеченных объектов",
    from: null,
    to: null,
  };

  if (!breaks || breaks.length < HEAT_COLORS.length) {
    return [zero];
  }

  const [, first, second, third, last] = breaks;

  return [
    zero,
    {
      color: HEAT_COLORS[1],
      label: `до ${formatDensity(first)}`,
      from: 0,
      to: first,
    },
    {
      color: HEAT_COLORS[2],
      label: `${formatDensity(first)} – ${formatDensity(second)}`,
      from: first,
      to: second,
    },
    {
      color: HEAT_COLORS[3],
      label: `${formatDensity(second)} – ${formatDensity(third)}`,
      from: second,
      to: third,
    },
    {
      color: HEAT_COLORS[4],
      label: `более ${formatDensity(third)}`,
      from: third,
      to: last,
    },
  ];
}

/**
 * Выражение раскраски для MapLibre: нулевой класс — отдельный цвет, остальные — ступени
 * по плотности. Возвращается структура вида
 * `["case", ["==", ["get","count"], 0], ZERO, ["step", ["get","density"], …]]`.
 */
export function heatColorExpression(breaks: number[] | null | undefined): unknown {
  const safeBreaks =
    breaks && breaks.length >= HEAT_COLORS.length
      ? breaks
      : [0, 0, 0, 0, 0];

  return [
    "case",
    ["==", ["get", "count"], 0],
    ZERO_COLOR,
    [
      "step",
      ["get", "density"],
      HEAT_COLORS[1],
      safeBreaks[1],
      HEAT_COLORS[2],
      safeBreaks[2],
      HEAT_COLORS[3],
      safeBreaks[3],
      HEAT_COLORS[4],
    ],
  ];
}

/** Разрешение H3 по зуму карты: обзор города — 8, улицы — 9 (раздел 4.3 ТЗ). */
export function resolutionForZoom(zoom: number): 8 | 9 {
  return zoom >= DETAIL_ZOOM ? 9 : 8;
}
