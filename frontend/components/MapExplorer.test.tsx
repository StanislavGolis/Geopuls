import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MapExplorer from "./MapExplorer";
import { ApiError, type CategoryMeta, type CellsResponse, type CityMeta } from "@/lib/api";

// Карта тянет WebGL — в jsdom подменяем её заглушкой и проверяем передачу данных
vi.mock("./MapView", () => ({
  default: ({ cells }: { cells: CellsResponse | null }) => (
    <div data-testid="map">features={cells?.features.length ?? 0}</div>
  ),
}));

const apiMock = {
  fetchCities: vi.fn(),
  fetchCategories: vi.fn(),
  fetchCells: vi.fn(),
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchCities: () => apiMock.fetchCities(),
    fetchCategories: () => apiMock.fetchCategories(),
    fetchCells: (query: unknown) => apiMock.fetchCells(query),
  };
});

const CITY: CityMeta = {
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

const CATEGORIES: CategoryMeta[] = [
  { slug: "bar", name: "Бары и пабы", color: "#1f6fb2", poi_count: 0 },
  { slug: "cafe", name: "Кофейни и кафе", color: "#1f6fb2", poi_count: 248 },
];

const CELLS: CellsResponse = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "890b80db643ffff",
      properties: { h3: "890b80db643ffff", count: 2, density: 17.1, has_address_ratio: 0.5 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [85.02, 56.51],
            [85.03, 56.51],
            [85.03, 56.52],
            [85.02, 56.51],
          ],
        ],
      },
    },
  ],
  meta: {
    city: "tomsk",
    category: "cafe",
    res: 9,
    data_version: "2026-09-27",
    updated_at: "2026-09-28T12:39:25Z",
    cell_count: 1507,
    non_empty_count: 130,
    poi_count: 248,
    max_density: 76.9,
    density_breaks: [0, 25.6, 42.7, 59.8, 76.9],
    bbox_filter: null,
  },
};

beforeEach(() => {
  apiMock.fetchCities.mockResolvedValue([CITY]);
  apiMock.fetchCategories.mockResolvedValue(CATEGORIES);
  apiMock.fetchCells.mockResolvedValue(CELLS);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MapExplorer", () => {
  it("показывает данные, версию данных и разрешение сетки", async () => {
    render(<MapExplorer styleUrl="style.json" />);

    await waitFor(() => expect(apiMock.fetchCells).toHaveBeenCalled());

    const map = await screen.findByTestId("map");
    expect(map.textContent).toContain("features=1");
    expect(screen.getByTestId("data-version").textContent).toContain("Данные OSM на 2026-09-27");
    expect(screen.getByTestId("resolution").textContent).toContain("сетка res 9");
    expect(screen.getByText("25.6 – 42.7")).toBeTruthy();
  });

  it("по умолчанию выбирает категорию, по которой есть данные", async () => {
    render(<MapExplorer styleUrl="style.json" />);

    await waitFor(() => expect(apiMock.fetchCells).toHaveBeenCalled());

    expect(apiMock.fetchCells).toHaveBeenCalledWith(
      expect.objectContaining({ city: "tomsk", category: "cafe", res: 9 }),
    );
  });

  it("уважает город и категорию из query-параметров", async () => {
    render(<MapExplorer styleUrl="style.json" initialCity="tomsk" initialCategory="bar" />);

    await waitFor(() => expect(apiMock.fetchCells).toHaveBeenCalled());

    expect(apiMock.fetchCells).toHaveBeenCalledWith(expect.objectContaining({ category: "bar" }));
  });

  it("показывает честное состояние «нет данных» вместо пустой карты", async () => {
    apiMock.fetchCells.mockResolvedValue({
      ...CELLS,
      features: [],
      meta: { ...CELLS.meta, non_empty_count: 0, poi_count: 0, density_breaks: [0, 0, 0, 0, 0] },
    });

    render(<MapExplorer styleUrl="style.json" />);

    const empty = await screen.findByTestId("empty");
    expect(empty.textContent).toContain("нет размеченных объектов");
  });

  it("показывает ошибку API и умеет повторить запрос", async () => {
    apiMock.fetchCells.mockRejectedValue(
      new ApiError(503, "Сервис недоступен", "нет собранной сетки"),
    );

    render(<MapExplorer styleUrl="style.json" />);

    const errorCard = await screen.findByTestId("error");
    expect(errorCard.textContent).toContain("Сервис недоступен");
    expect(errorCard.textContent).toContain("Данные для города ещё не собраны");

    const callsBefore = apiMock.fetchCells.mock.calls.length;
    screen.getByRole("button", { name: "Повторить" }).click();

    await waitFor(() => expect(apiMock.fetchCells.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("при потере связи подсказывает проверить интернет", async () => {
    apiMock.fetchCells.mockRejectedValue(new ApiError(0, "Нет связи с сервисом", "fetch failed"));

    render(<MapExplorer styleUrl="style.json" />);

    const errorCard = await screen.findByTestId("error");
    expect(errorCard.textContent).toContain("Проверьте соединение с интернетом");
  });
});
