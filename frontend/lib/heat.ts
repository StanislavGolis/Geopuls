/**
 * Цветовая шкала и классы легенды тепловой карты.
 *
 * Границы классов приходят с бэкенда (`meta.density_breaks` = `[0, b1 … bN, max]`), здесь только
 * цвета и подписи: шкала должна совпадать в web, PNG и PDF (ADR 0006, ADR 0008).
 *
 * Палитра — YlOrRd (дизайн-спека §2.5). Число классов не константа: для `N` классов берём `N`
 * цветов из рэмпа, поэтому переход с 4 на 5–6 классов не требует правок раскраски.
 */

/** Шесть ступеней рэмпа YlOrRd: от «мало» к «много». */
export const HEAT_RAMP = [
  "#FEF3C7",
  "#FDE68A",
  "#FCD34D",
  "#F59E0B",
  "#EA580C",
  "#B91C1C",
] as const;

/**
 * Какие ступени рэмпа брать для разного числа классов (согласовано с дизайн-спекой §2.5).
 * Крайние ступени оставляем для больших шкал — 4 класса начинаются со светло-жёлтого.
 */
const RAMP_INDEX_BY_CLASSES: Record<number, number[]> = {
  1: [3],
  2: [1, 4],
  3: [1, 3, 5],
  4: [0, 2, 3, 4],
  5: [0, 1, 2, 3, 5],
  6: [0, 1, 2, 3, 4, 5],
};

/** Индексы цветов рэмпа для заданного числа классов (для нестандартного — равномерно). */
export function rampIndexes(classes: number): number[] {
  const known = RAMP_INDEX_BY_CLASSES[classes];
  if (known) return known;

  const count = Math.max(1, Math.min(HEAT_RAMP.length, Math.trunc(classes) || 1));
  if (count === 1) return [Math.floor(HEAT_RAMP.length / 2)];

  return Array.from({ length: count }, (_, index) =>
    Math.round((index * (HEAT_RAMP.length - 1)) / (count - 1)),
  );
}

/** Цвета классов плотности для `classes` классов. */
export function heatColors(classes: number): string[] {
  return rampIndexes(classes).map((index) => HEAT_RAMP[index]);
}

/** Цвет ячеек без размеченных объектов — «пустые зоны», главный ответ сервиса. */
export const ZERO_COLOR = "#E6EAEF";

/**
 * Обводка пустых ячеек. Именно она (а не заливка) несёт смысл: заливка почти не отличается от
 * светлой подложки (контраст ≈1.1), обводка даёт ≈3.3:1 — см. дизайн-спеку §2.5.
 */
export const EMPTY_CELL_STROKE = "#7C8794";

/** Обводка выбранной ячейки — совпадает с `--accent` дизайн-спеки. */
export const SELECTED_CELL_COLOR = "#2563EB";

/** Прозрачность непустых ячеек: подложка должна читаться сквозь тепловой слой. */
export const FILLED_CELL_OPACITY = 0.75;

/** Зум, с которого показываем детальную сетку (res 9); ниже — обзорную (res 8). */
export const DETAIL_ZOOM = 12;

export type LegendItem = {
  color: string;
  /** Числовой диапазон плотности (POI/км²). */
  label: string;
  /** Словесная пометка класса («пусто», «высокая») или null. */
  note: string | null;
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
 * Классы легенды по границам `density_breaks` = `[0, b1 … bN, max]`: нулевой класс плюс `N`
 * классов плотности.
 *
 * Если данных о границах нет (слой ещё не загружен), возвращаем только нулевой класс —
 * легенда остаётся честной и не показывает выдуманную шкалу.
 */
export function legendItems(breaks: number[] | null | undefined): LegendItem[] {
  const zero: LegendItem = {
    color: ZERO_COLOR,
    label: "0",
    note: "пусто",
    from: null,
    to: null,
  };

  if (!breaks || breaks.length < 2) {
    return [zero];
  }

  const classes = breaks.length - 1;

  return [
    zero,
    ...heatColors(classes).map((color, index): LegendItem => {
      const from = breaks[index];
      const to = breaks[index + 1];
      const isLast = index === classes - 1;

      let label: string;
      if (index === 0) {
        label = `до ${formatDensity(to)}`;
      } else if (isLast) {
        label = `более ${formatDensity(from)}`;
      } else {
        label = `${formatDensity(from)} – ${formatDensity(to)}`;
      }

      return { color, label, note: isLast ? "высокая" : null, from, to };
    }),
  ];
}

/**
 * Выражение раскраски для MapLibre: нулевой класс — отдельный цвет, остальные — ступени
 * по плотности. Возвращается структура вида
 * `["case", ["==", ["get","count"], 0], ZERO, ["step", ["get","density"], c0, b1, c1, …]]`.
 *
 * Порядок элементов `step` важен: сначала цвет самого нижнего класса, затем пары
 * «граница — цвет» для остальных классов.
 */
export function heatColorExpression(breaks: number[] | null | undefined): unknown {
  if (!breaks || breaks.length < 2) {
    return ZERO_COLOR;
  }

  const colors = heatColors(breaks.length - 1);
  const step: unknown[] = ["step", ["get", "density"], colors[0]];
  for (let index = 1; index < colors.length; index += 1) {
    step.push(breaks[index], colors[index]);
  }

  return ["case", ["==", ["get", "count"], 0], ZERO_COLOR, step];
}

/** Прозрачность ячеек: пустые — самостоятельный класс, поэтому рисуются плотно. */
export function heatFillOpacityExpression(): unknown {
  return ["case", ["==", ["get", "count"], 0], 1, FILLED_CELL_OPACITY];
}

/** Цвет контура: у пустых — свой (смысловой), у непустых — мягкий белый. */
export function heatOutlineColorExpression(): unknown {
  return [
    "case",
    ["==", ["get", "count"], 0],
    EMPTY_CELL_STROKE,
    "rgba(255, 255, 255, 0.45)",
  ];
}

/** Разрешение H3 по зуму карты: обзор города — 8, улицы — 9 (раздел 4.3 ТЗ). */
export function resolutionForZoom(zoom: number): 8 | 9 {
  return zoom >= DETAIL_ZOOM ? 9 : 8;
}
