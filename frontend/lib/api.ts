/**
 * Клиент API ГЕОПУЛЬС.
 *
 * Ошибки приходят в формате RFC 9457 (`application/problem+json`) — разбираем их в `ApiError`,
 * чтобы интерфейс мог показать понятное сообщение (в том числе «нет связи»).
 */

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

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

function buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(`${API_BASE_URL}${path}`);
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

export function fetchCells(query: CellsQuery): Promise<CellsResponse> {
  return requestJson<CellsResponse>("/api/v1/cells", {
    city: query.city,
    category: query.category,
    res: query.res,
    bbox: query.bbox,
  });
}
