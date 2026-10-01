import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Report from "./Report";
import { ApiError, type LayerGrid, type LayerMeta } from "@/lib/api";
import { EMPTY_URL_STATE } from "@/lib/urlState";

// Карта тянет WebGL — в jsdom подменяем её заглушкой: отчёт проверяем по документу, а не по тайлам.
// Идентификатор отличается от контейнера `.report__map`: иначе в разметке два элемента с одним тестом
vi.mock("./MapView", () => ({
  default: ({ grid }: { grid: LayerGrid | null }) => (
    <div data-testid="report-map-stub">cells={grid?.cells.h3.length ?? 0}</div>
  ),
}));

const CITY = {
  slug: "tomsk",
  name: "Томск",
  region: "Томская область",
  h3_res: 9,
  area_km2: 176.8,
  center: { lat: 56.4736, lon: 85.024 },
  bbox: { min_lat: 56.379, min_lon: 84.828, max_lat: 56.571, max_lon: 85.15 },
  data_version: "2026-09-27",
  updated_at: "2026-09-28T12:39:25Z",
};

const LAYERS: LayerMeta[] = [
  {
    slug: "competitors",
    name: "Конкуренты (объекты по категориям)",
    kind: "osm",
    metric_kind: "density",
    unit: "POI/км²",
    scale: "quantile",
    color: "#1f6fb2",
    can_be_base: true,
    categories: ["cafe"],
    source: null,
  },
];

const GRID = {
  type: "LayerGrid",
  cells: { h3: ["890b80db643ffff", "890b80db64bffff"], geometry: [] },
  layers: [
    {
      slug: "competitors",
      name: "Конкуренты (объекты по категориям)",
      category: "cafe",
      role: "base",
      metric_kind: "density",
      unit: "POI/км²",
      scale: "quantile",
      color: "#1f6fb2",
      values: [17.1, 4.2],
      extras: { count: [12, 3] },
      covered_count: 2,
      non_empty_count: 2,
      total_value: 21.3,
      max_value: 17.1,
      breaks: [0, 5, 20],
      source: null,
    },
  ],
  meta: {
    city: "tomsk",
    res: 9,
    cell_count: 2,
    base: "competitors:cafe",
    overlays: [],
    data_version: "2026-09-27",
    updated_at: null,
    bbox_filter: null,
    sources: [],
  },
} as unknown as LayerGrid;

const CITY_PROFILE = {
  type: "CityProfile" as const,
  city: CITY,
  grid: { res: 9, cells: 1538, cells_non_empty: 341, empty_share: 77.8, poi_count: 2100 },
  categories: [{ slug: "cafe", name: "Кофейни и кафе", color: "#1f6fb2", poi_count: 271, share: 12.9 }],
  layers: [
    {
      slug: "competitors",
      name: "Конкуренты (объекты по категориям)",
      metric_kind: "density",
      unit: "POI/км²",
      color: "#1f6fb2",
      covered_count: 1538,
      non_empty_count: 341,
      max_value: 51.25,
      median_value: 8.4,
    },
  ],
  sources: [],
};

const apiMock = {
  fetchCities: vi.fn(),
  fetchCategories: vi.fn(),
  fetchLayers: vi.fn(),
  fetchLayerGrid: vi.fn(),
  fetchCityProfile: vi.fn(),
  fetchCellProfile: vi.fn(),
  fetchAround: vi.fn(),
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchCities: () => apiMock.fetchCities(),
    fetchCategories: () => apiMock.fetchCategories(),
    fetchLayers: () => apiMock.fetchLayers(),
    fetchLayerGrid: (query: unknown) => apiMock.fetchLayerGrid(query),
    fetchCityProfile: (slug: string) => apiMock.fetchCityProfile(slug),
    fetchCellProfile: (query: unknown) => apiMock.fetchCellProfile(query),
    fetchAround: (query: unknown) => apiMock.fetchAround(query),
  };
});

/** Отчёт с состоянием сцены: по умолчанию — «Конкуренты» с категорией кафе. */
function renderReport(state: Partial<typeof EMPTY_URL_STATE> = {}) {
  return render(
    <Report
      state={{ ...EMPTY_URL_STATE, city: "tomsk", tab: "competitors", ...state }}
      styleUrl="style.json"
    />,
  );
}

describe("Report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.fetchCities.mockResolvedValue([CITY]);
    apiMock.fetchCategories.mockResolvedValue([
      { slug: "cafe", name: "Кофейни и кафе", color: "#1f6fb2", poi_count: 271 },
    ]);
    apiMock.fetchLayers.mockResolvedValue({ layers: LAYERS, sources: [] });
    apiMock.fetchLayerGrid.mockResolvedValue(GRID);
    apiMock.fetchCityProfile.mockResolvedValue(CITY_PROFILE);
    apiMock.fetchCellProfile.mockResolvedValue({
      metrics: [
        {
          layer: "competitors",
          layer_name: "Конкуренты (объекты по категориям)",
          category: "cafe",
          metric_kind: "density",
          unit: "POI/км²",
          value: 17.1,
          extras: { count: 12 },
        },
      ],
      meta: {
        city: "tomsk",
        cell: "890b80db643ffff",
        res: 9,
        data_version: "2026-09-27",
        updated_at: null,
      },
    });
    apiMock.fetchAround.mockResolvedValue({
      type: "AroundPoint",
      point: { lat: 56.4847, lon: 84.9482 },
      meta: { city: "tomsk", radius_m: 300, category: "cafe", data_version: "2026-09-27", updated_at: null },
      layers: [
        {
          slug: "competitors",
          name: "Конкуренты (объекты по категориям)",
          category: "cafe",
          metric_kind: "density",
          unit: "POI/км²",
          objects: 8,
          nearest_m: 105.1,
          nearest_name: "Baba Roma",
        },
      ],
      sources: [],
    });
  });

  it("печатает сцену «Конкуренты» как документ: карта, легенда, таблицы", async () => {
    renderReport();

    expect((await screen.findByTestId("report-title")).textContent).toBe(
      "Конкуренты: Кофейни и кафе",
    );
    expect(screen.getByTestId("report-map")).toBeTruthy();
    expect(screen.getByTestId("report-map-stub")).toBeTruthy();
    expect(screen.getByTestId("report-legend")).toBeTruthy();
    // Топ зон и классы — теми же числами, что на экране
    expect(screen.getByTestId("report-zones").textContent).toContain("890b80db643ffff");
    expect(screen.getByTestId("report-zones").textContent).toContain("12");
    expect(screen.getByTestId("report-classes").textContent).toContain("пусто");
  });

  it("несёт атрибуцию, дату выгрузки и оговорку «не прогноз» (ADR 0015)", async () => {
    renderReport();

    const disclaimer = await screen.findByTestId("report-disclaimer");

    expect(disclaimer.textContent).toContain("наблюдения");
    expect(document.body.textContent).toContain("OpenStreetMap");
    expect(document.body.textContent).toContain("ODbL");
    expect(document.body.textContent).toContain("2026-09-27");
    expect(document.body.textContent).not.toContain("перегрев");
  });

  it("для инструмента «Радиус» печатает таблицу «что вокруг точки»", async () => {
    renderReport({ tab: "tools", around: { lat: 56.4847, lon: 84.9482 }, radius: 300, category: "cafe" });

    const table = await screen.findByTestId("report-around");

    expect(table.textContent).toContain("Baba Roma");
    expect(table.textContent).toContain("105 м");
    expect(screen.getByTestId("report-title").textContent).toContain("радиус 300 м");
  });

  it("для сравнения зон печатает таблицу с медианой города", async () => {
    renderReport({
      tab: "tools",
      compare: "890b80db643ffff,890b80db64bffff",
      category: "cafe",
    });

    const table = await screen.findByTestId("report-compare");

    expect(table.textContent).toContain("Медиана города");
    expect(table.textContent).toContain("8.4");
    expect(table.textContent).toContain("17.1");
  });

  it("для «Города» печатает профиль: охват, категории, слои", async () => {
    renderReport({ tab: "city" });

    expect((await screen.findByTestId("report-city")).textContent).toContain("176.8");
    expect(screen.getByTestId("report-categories").textContent).toContain("Кофейни и кафе");
    expect(screen.getByTestId("report-city-layers").textContent).toContain("8.4");
  });

  it("показывает ошибку, а не пустой документ", async () => {
    apiMock.fetchCities.mockRejectedValue(new ApiError(503, "Сервис недоступен", "нет данных"));

    renderReport();

    const error = await screen.findByTestId("report-error");
    expect(error.textContent).toContain("Сервис недоступен");
  });
});
