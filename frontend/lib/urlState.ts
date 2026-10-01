import { DEFAULT_RADIUS_M, isValidRadius } from "@/lib/around";
import { COMPETITORS_SLUG, parseLayerRef } from "@/lib/layers";

/**
 * Состояние интерфейса в адресной строке (shareable URL, раздел 4.3 ТЗ).
 *
 * Правила:
 * - в URL попадают только значимые значения: пустые и «как по умолчанию» параметры опускаются;
 * - всё, что пришло из адресной строки, валидируется: мусор игнорируется, а не роняет карту;
 * - `res` — производное от `zoom` (сетку выбирает зум), при загрузке приоритет у `zoom`.
 */

export type UrlState = {
  city: string | null;
  /** Вариант базового слоя: в ссылке повторяется как `category` (совместимость со старыми ссылками). */
  category: string | null;
  /** Базовый слой (красит карту): `slug` или `slug:category` (ADR 0013). */
  base: string | null;
  /** Наложения через запятую: не больше двух (ADR 0013). */
  overlays: string | null;
  /** H3-индекс выбранной ячейки. */
  cell: string | null;
  /** Ячейки в сравнении через запятую (2–5): сравнением делятся так же, как видом карты. */
  compare: string | null;
  /**
   * Вкладка-сцена (ADR 0016). `null` — не задана явно: тогда она выводится из состояния
   * (`inferTab`), чтобы ссылки, разошедшиеся по людям, продолжали открывать то же самое.
   */
  tab: TabId | null;
  /** Точка, вокруг которой считаем радиус (`around=lat,lon`). */
  around: { lat: number; lon: number } | null;
  /** Радиус в метрах: значим только вместе с точкой. */
  radius: number | null;
  /**
   * Слой, объекты которого подсвечены на карте (`objects=<slug>`).
   *
   * Один слой за раз: пять заливок и контуров друг поверх друга нечитаемы (план §6). Остальные
   * включённые слои продолжают давать числа в карточке ячейки.
   */
  objects: string | null;
  res: 8 | 9 | null;
  zoom: number | null;
  center: { lat: number; lon: number } | null;
};

const H3_PATTERN = /^[0-9a-f]{15}$/i;
const MIN_ZOOM = 1;
const MAX_ZOOM = 22;

export const EMPTY_URL_STATE: UrlState = {
  city: null,
  category: null,
  base: null,
  overlays: null,
  cell: null,
  compare: null,
  tab: null,
  around: null,
  radius: null,
  objects: null,
  res: null,
  zoom: null,
  center: null,
};

/** Вкладки-сцены: у каждой своя основа карты и своя панель данных (ADR 0016). */
export const TAB_IDS = ["competitors", "infrastructure", "tools", "city"] as const;

export type TabId = (typeof TAB_IDS)[number];

/** Основная вкладка: она же состояние по умолчанию, поэтому в ссылке не пишется. */
export const DEFAULT_TAB: TabId = "competitors";

export function parseTab(value: string | null | undefined): TabId | null {
  const trimmed = value?.trim() ?? "";
  return (TAB_IDS as readonly string[]).includes(trimmed) ? (trimmed as TabId) : null;
}

/**
 * Какая вкладка соответствует состоянию, если `tab` в ссылке не задан.
 *
 * Нужно для совместимости: ссылки, разошедшиеся до вкладок (`profile=1`, `compare=…`, `around=…`,
 * `base=residential`), обязаны открывать то же, что открывали раньше.
 */
export function inferTab(state: {
  base?: string | null;
  compare?: string | null;
  around?: { lat: number; lon: number } | null;
  objects?: string | null;
  profile?: boolean;
}): TabId {
  if (state.profile) return "city";
  if (state.compare || state.around) return "tools";
  // Подсветка объектов слоя — это про инфраструктуру, даже если базовым слоем остались конкуренты
  if (state.objects) return "infrastructure";
  const baseSlug = parseLayerRef(state.base ?? null)?.slug ?? null;
  if (baseSlug && baseSlug !== COMPETITORS_SLUG) return "infrastructure";
  return DEFAULT_TAB;
}

/** Сколько ячеек можно сравнивать одновременно: больше — уже не таблица, а стена цифр. */
export const MAX_COMPARE = 5;
/** Сколько ячеек нужно, чтобы сравнение имело смысл. */
export const MIN_COMPARE = 2;

/**
 * Разобрать список ячеек сравнения: валидные H3, без повторов, не больше ``MAX_COMPARE``.
 *
 * Мусор игнорируется, а не роняет интерфейс: ссылку мог испортить мессенджер, а не автор.
 */
export function parseCellList(value: string | null | undefined): string[] {
  const parts = (value ?? "").split(",");
  const cells: string[] = [];
  for (const part of parts) {
    const cell = parseH3Cell(part);
    if (cell && !cells.includes(cell)) cells.push(cell);
    if (cells.length >= MAX_COMPARE) break;
  }
  return cells;
}

export function parseH3Cell(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return H3_PATTERN.test(trimmed) ? trimmed : null;
}

export function parseZoom(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_ZOOM || parsed > MAX_ZOOM) return null;
  return parsed;
}

export function parseCenter(value: string | null | undefined): { lat: number; lon: number } | null {
  const parts = (value ?? "").split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export function parseResolution(value: string | null | undefined): 8 | 9 | null {
  if (value === "8") return 8;
  if (value === "9") return 9;
  return null;
}

/** Радиус из ссылки: принимаем только значения из списка, остальное игнорируем как мусор. */
export function parseRadius(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return isValidRadius(parsed) ? parsed : null;
}

function parseString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Разобрать состояние из query-строки (`?city=…`) или из объекта searchParams Next. */
export function parseUrlState(source: string | Record<string, string | string[] | undefined>): UrlState {
  const params = new Map<string, string>();
  if (typeof source === "string") {
    for (const [key, value] of new URLSearchParams(source.startsWith("?") ? source.slice(1) : source)) {
      params.set(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(source)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string") params.set(key, first);
    }
  }

  const city = parseString(params.get("city"));
  const category = parseString(params.get("category"));
  // Базовый слой и наложения — «слои» (ADR 0013). `category` остаётся ради старых ссылок: те, что
  // уже разошлись по людям, должны продолжать открывать ту же карту.
  const base = parseString(params.get("base"));
  const overlays = parseString(params.get("overlays"));
  const cell = parseH3Cell(params.get("cell"));
  const zoom = parseZoom(params.get("zoom"));
  const res = zoom !== null ? resolutionFromZoom(zoom) : parseResolution(params.get("res"));
  const compare = parseCellList(params.get("compare"));
  // Точка и радиус: радиус без точки бессмысленен, поэтому без `around` он игнорируется
  const around = parseCenter(params.get("around"));
  const radius = around ? parseRadius(params.get("radius")) : null;

  return {
    city,
    category,
    base,
    overlays,
    cell,
    compare: compare.length > 0 ? compare.join(",") : null,
    // Вкладка: явный `tab`, иначе выводим из состояния — старые ссылки без него работают
    tab:
      parseTab(params.get("tab")) ??
      inferTab({
        base,
        compare: compare.length > 0 ? compare.join(",") : null,
        around,
        objects: parseString(params.get("objects")),
        // До вкладок профиль был отдельным экраном: ссылки с `profile=1` открывают вкладку «Город»
        profile: params.get("profile") === "1",
      }),
    around,
    radius,
    objects: parseString(params.get("objects")),
    res,
    zoom,
    // Центр имеет смысл только вместе с зумом: иначе карта остаётся привязана к границам города
    center: zoom !== null ? parseCenter(params.get("center")) : null,
  };
}

/** Кодирование значения для ссылки: запятая и двоеточие остаются читаемыми (`base=competitors:cafe`). */
function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%(2C|3A)/gi, (match) => decodeURIComponent(match));
}

/** Собрать query-строку без незначимых параметров (порядок стабилен — удобно для тестов). */
export function buildSearch(state: Partial<UrlState>): string {
  const parts: string[] = [];
  const push = (key: string, value: string) => parts.push(`${key}=${encodeValue(value)}`);

  const city = parseString(state.city);
  const category = parseString(state.category);
  const base = parseString(state.base);
  const overlays = parseString(state.overlays);
  const cell = parseH3Cell(state.cell);
  const compare = parseCellList(state.compare);

  // Вкладка пишется, только когда она не основная: основная — это состояние по умолчанию
  const tab = parseTab(state.tab);
  if (city) push("city", city);
  if (tab && tab !== DEFAULT_TAB) push("tab", tab);
  // `category` идёт рядом с `base` осознанно: так ссылка читается и старыми клиентами, и новыми
  // (вызывающий код передаёт `category` только для слоя, у которого есть категории)
  if (category) push("category", category);
  if (base) push("base", base);
  if (overlays) push("overlays", overlays);
  if (cell) push("cell", cell);
  if (compare.length > 0) push("compare", compare.join(","));
  // Точка радиуса и его значение: радиус по умолчанию не пишем, чтобы ссылка оставалась короткой
  if (state.around) {
    push("around", `${state.around.lat.toFixed(5)},${state.around.lon.toFixed(5)}`);
    if (state.radius && state.radius !== DEFAULT_RADIUS_M) push("radius", String(state.radius));
  }
  // Подсветка объектов слоя: один слой за раз (план §6)
  if (state.objects) push("objects", String(state.objects));
  if (typeof state.res === "number") push("res", String(state.res));
  if (typeof state.zoom === "number" && Number.isFinite(state.zoom)) {
    push("zoom", state.zoom.toFixed(2));
    if (state.center) {
      push("center", `${state.center.lat.toFixed(5)},${state.center.lon.toFixed(5)}`);
    }
  }

  return parts.join("&");
}

/** Разрешение сетки, соответствующее зуму: дублирует правило карты как чистая функция. */
export function resolutionFromZoom(zoom: number, detailZoom = 12): 8 | 9 {
  return zoom >= detailZoom ? 9 : 8;
}
