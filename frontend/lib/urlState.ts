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
  res: null,
  zoom: null,
  center: null,
};

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

  return {
    city,
    category,
    base,
    overlays,
    cell,
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

  if (city) push("city", city);
  // `category` идёт рядом с `base` осознанно: так ссылка читается и старыми клиентами, и новыми
  // (вызывающий код передаёт `category` только для слоя, у которого есть категории)
  if (category) push("category", category);
  if (base) push("base", base);
  if (overlays) push("overlays", overlays);
  if (cell) push("cell", cell);
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
