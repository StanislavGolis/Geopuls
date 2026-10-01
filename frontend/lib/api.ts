/**
 * Клиент API ГЕОПУЛЬС.
 *
 * Ошибки приходят в формате RFC 9457 (`application/problem+json`) — разбираем их в `ApiError`,
 * чтобы интерфейс мог показать понятное сообщение (в том числе «нет связи»).
 */

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

/**
 * База для запросов.
 *
 * Пустое значение `NEXT_PUBLIC_API_BASE_URL` означает «тот же origin»: так работает деплой,
 * где фронтенд и API отдаёт один reverse-proxy на одном домене (см. `infra/Caddyfile`).
 * Тогда домен не нужно встраивать в сборку — переезд на другой адрес не требует пересборки.
 */
function resolveBaseUrl(): string {
  if (API_BASE_URL) return API_BASE_URL;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export type ProblemDetails = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  errors?: { location: string; message: string }[];
};

export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly errors: { location: string; message: string }[];

  constructor(
    status: number,
    title: string,
    detail: string,
    errors: { location: string; message: string }[] = [],
  ) {
    super(`${title}: ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.errors = errors;
  }

  /** Данных ещё нет: не выполнен импорт или агрегация (бэкенд отдаёт 503). */
  get isDataMissing(): boolean {
    return this.status === 503;
  }

  /** Нет связи с API (сеть, DNS, CORS). */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

export type CityMeta = {
  slug: string;
  name: string;
  region: string | null;
  h3_res: number;
  area_km2: number;
  center: { lat: number; lon: number };
  bbox: { min_lat: number; min_lon: number; max_lat: number; max_lon: number };
  data_version: string | null;
  updated_at: string | null;
};

export type CategoryMeta = {
  slug: string;
  name: string;
  color: string;
  poi_count: number;
};

export type CellProperties = {
  h3: string;
  count: number;
  density: number;
  has_address_ratio: number | null;
};

export type CellFeature = {
  type: "Feature";
  id: string;
  properties: CellProperties;
  geometry: { type: "Polygon"; coordinates: number[][][] };
};

export type CellsMeta = {
  city: string;
  category: string;
  res: number;
  data_version: string | null;
  updated_at: string | null;
  cell_count: number;
  non_empty_count: number;
  poi_count: number;
  max_density: number;
  density_breaks: number[];
  bbox_filter: string | null;
};

export type CellsResponse = {
  type: "FeatureCollection";
  features: CellFeature[];
  meta: CellsMeta;
};

export type CellsQuery = {
  city: string;
  category: string;
  res: number;
  bbox?: string;
};

/**
 * Источник данных слоя: лицензия и атрибуция нужны и на экране, и в экспорте (ADR 0013).
 */
export type LayerSource = {
  slug: string;
  title: string;
  license: string | null;
  license_url: string | null;
  attribution_text: string | null;
  citation: string | null;
  source_url: string | null;
  data_version: string | null;
};

/** Слой в реестре: чем измеряется, в каких единицах и может ли красить карту. */
export type LayerMeta = {
  slug: string;
  name: string;
  kind: string;
  metric_kind: string;
  unit: string | null;
  scale: string;
  color: string;
  can_be_base: boolean;
  categories: string[];
  source: LayerSource | null;
};

export type LayersResponse = {
  layers: LayerMeta[];
  data_version: string | null;
};

/**
 * Колонка значений слоя: массив выровнен с `LayerGrid.cells.h3`.
 *
 * `values[i] === null` означает «у слоя нет значения для этой ячейки» (слой собран не по всей
 * сетке) — это не то же самое, что ноль («объектов нет»).
 */
export type MapLayerColumn = {
  slug: string;
  name: string;
  category: string | null;
  role: "base" | "overlay";
  metric_kind: string;
  unit: string | null;
  scale: string;
  color: string;
  values: (number | null)[];
  extras: Record<string, (number | null)[]>;
  covered_count: number;
  non_empty_count: number;
  total_value: number;
  max_value: number;
  breaks: number[];
  source: LayerSource | null;
};

/** Колоночный ответ карты: геометрия один раз, значения — колонками по слоям (ADR 0013). */
export type LayerGrid = {
  type: "LayerGrid";
  cells: { h3: string[]; geometry: number[][][] };
  layers: MapLayerColumn[];
  meta: {
    city: string;
    res: number;
    cell_count: number;
    base: string;
    overlays: string[];
    data_version: string | null;
    updated_at: string | null;
    bbox_filter: string | null;
    sources: LayerSource[];
  };
};

export type LayerGridQuery = {
  city: string;
  base: string;
  res: number;
  overlays?: string;
  bbox?: string;
};

export type PoiItem = {
  osm_type: string;
  osm_id: number;
  name: string | null;
  brand: string | null;
  address: string | null;
  categories: string[];
  lat: number;
  lon: number;
  /** Ссылка на объект в OpenStreetMap (данные ODbL — источник нужно показывать). */
  osm_url: string;
};

export type PoisMeta = {
  city: string;
  cell: string;
  res: number;
  category: string | null;
  total: number;
  returned: number;
  limit: number;
  offset: number;
  data_version: string | null;
};

export type PoisResponse = {
  items: PoiItem[];
  meta: PoisMeta;
};

export type PoisQuery = {
  city: string;
  cell: string;
  res: number;
  category?: string;
  limit?: number;
};

function buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(`${resolveBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function toApiError(response: Response): Promise<ApiError> {
  let problem: ProblemDetails = {};
  try {
    problem = (await response.json()) as ProblemDetails;
  } catch {
    problem = {};
  }
  return new ApiError(
    response.status,
    problem.title ?? "Ошибка запроса",
    problem.detail ?? response.statusText,
    problem.errors ?? [],
  );
}

export async function requestJson<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path, params), {
      ...init,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new ApiError(
      0,
      "Нет связи с сервисом",
      error instanceof Error ? error.message : "запрос не удался",
    );
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  return (await response.json()) as T;
}

export function fetchCities(): Promise<CityMeta[]> {
  return requestJson<CityMeta[]>("/api/v1/meta/cities");
}

export function fetchCategories(): Promise<CategoryMeta[]> {
  return requestJson<CategoryMeta[]>("/api/v1/meta/categories");
}

/** Охват сетки города: сколько ячеек и как они заполнены данными (профиль города). */
export type ProfileGrid = {
  res: number;
  cells: number;
  cells_non_empty: number;
  /** Доля пустых ячеек, %: «нет размеченных объектов» — это не «нет бизнеса». */
  empty_share: number;
  poi_count: number;
};

export type ProfileCategory = {
  slug: string;
  name: string;
  color: string;
  poi_count: number;
  share: number | null;
};

export type ProfileLayer = {
  slug: string;
  name: string;
  metric_kind: string;
  unit: string | null;
  color: string;
  covered_count: number;
  non_empty_count: number;
  max_value: number;
  /** Медиана по непустым ячейкам: сравнение зон идёт с ней, а не с «вердиктом» (ADR 0015). */
  median_value: number | null;
};

export type CityProfile = {
  type: "CityProfile";
  city: CityMeta;
  grid: ProfileGrid;
  categories: ProfileCategory[];
  layers: ProfileLayer[];
  sources: LayerSource[];
};

/** Значение одного слоя в профиле ячейки: единица измерения и вариант слоя (категория). */
export type CellMetric = {
  layer: string;
  layer_name: string;
  category: string | null;
  metric_kind: string;
  unit: string | null;
  value: number;
  extras: Record<string, unknown> | null;
};

export type CellProfile = {
  metrics: CellMetric[];
  meta: {
    city: string;
    cell: string;
    res: number;
    data_version: string | null;
    updated_at: string | null;
  };
};

/** Профиль ячейки: значения всех слоёв. Основа сравнения зон — каждая зона читается одним запросом. */
export function fetchCellProfile(query: { city: string; cell: string; res: number }): Promise<CellProfile> {
  const cell = encodeURIComponent(query.cell);
  const city = encodeURIComponent(query.city);
  return requestJson<CellProfile>(`/api/v1/cells/${cell}?city=${city}&res=${query.res}`);
}

/** Профиль города: сводка по данным одним запросом (числа считает бэкенд, интерфейс их не складывает). */
export function fetchCityProfile(slug: string): Promise<CityProfile> {
  return requestJson<CityProfile>(`/api/v1/meta/cities/${encodeURIComponent(slug)}/profile`);
}

/** Слой в радиусе: объекты и расстояние до ближайшего — то, что измеряется в круге, а не в гексе. */
export type AroundLayer = {
  slug: string;
  name: string;
  category: string | null;
  metric_kind: string;
  unit: string | null;
  objects: number;
  nearest_m: number | null;
  nearest_name: string | null;
};

export type AroundResponse = {
  type: "AroundPoint";
  point: { lat: number; lon: number };
  meta: {
    city: string;
    radius_m: number;
    category: string | null;
    data_version: string | null;
    updated_at: string | null;
  };
  layers: AroundLayer[];
  sources: LayerSource[];
};

export type AroundQuery = {
  city: string;
  lat: number;
  lon: number;
  category: string;
  radiusM: number;
};

/**
 * Что вокруг точки: конкуренты и инфраструктура в радиусе.
 *
 * Отдельно от сетки: круг 500 м не совпадает с границами гекса, поэтому его считает бэкенд
 * через `ST_DWithin` (ТЗ §3.2). Интерфейс числа не досчитывает — иначе «рядом 3 конкурента»
 * разошлось бы с тем, что показывает карта.
 */
export function fetchAround(query: AroundQuery): Promise<AroundResponse> {
  return requestJson<AroundResponse>("/api/v1/around", {
    city: query.city,
    lat: query.lat,
    lon: query.lon,
    category: query.category,
    radius_m: query.radiusM,
  });
}

/** Объект слоя геометрией: точка, линия или полигон — «проверить слой глазами» (план §6). */
export type LayerObjectFeature = {
  type: "Feature";
  geometry: { type: string; coordinates: unknown };
  properties: {
    osm: string;
    name: string | null;
    category: string;
    geom_type: string;
  };
};

export type LayerObjectsResponse = {
  type: "LayerObjects";
  features: LayerObjectFeature[];
  meta: {
    layer: string;
    layer_name: string;
    bbox: string;
    limit: number;
    total: number;
    returned: number;
    /** Показано меньше, чем есть в границах вида: интерфейс обязан об этом сказать. */
    truncated: boolean;
    data_version: string | null;
    updated_at: string | null;
  };
  sources: LayerSource[];
};

/**
 * Объекты слоя в границах вида карты.
 *
 * Границы обязательны: слой целиком — это мегабайты JSON (жильё 2.3 МБ, пешеходные пути 0.9 МБ), а в
 * типичном виде карты — десятки килобайт. Упрощение контуров делает бэкенд.
 */
export function fetchLayerObjects(query: {
  city: string;
  layer: string;
  bbox: string;
}): Promise<LayerObjectsResponse> {
  return requestJson<LayerObjectsResponse>(
    `/api/v1/layers/${encodeURIComponent(query.layer)}/objects`,
    { city: query.city, bbox: query.bbox },
  );
}

export function fetchCells(query: CellsQuery): Promise<CellsResponse> {
  return requestJson<CellsResponse>("/api/v1/cells", {
    city: query.city,
    category: query.category,
    res: query.res,
    bbox: query.bbox,
  });
}

/** Реестр слоёв: из него строится панель слоёв (что измеряет слой и может ли он красить карту). */
export function fetchLayers(city?: string): Promise<LayersResponse> {
  return requestJson<LayersResponse>("/api/v1/layers", { city });
}

/**
 * Колоночная карта: базовый слой плюс наложения одним запросом (ADR 0013).
 *
 * Один запрос вместо запроса на слой: геометрия сетки приходит один раз, а значения — колонками.
 */
export function fetchLayerGrid(query: LayerGridQuery): Promise<LayerGrid> {
  return requestJson<LayerGrid>("/api/v1/map", {
    city: query.city,
    base: query.base,
    res: query.res,
    overlays: query.overlays,
    bbox: query.bbox,
  });
}

export function fetchPois(query: PoisQuery): Promise<PoisResponse> {
  return requestJson<PoisResponse>("/api/v1/pois", {
    city: query.city,
    cell: query.cell,
    res: query.res,
    category: query.category,
    limit: query.limit,
  });
}
