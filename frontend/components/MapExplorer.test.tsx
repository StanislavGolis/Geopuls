import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MapExplorer from "./MapExplorer";
import { ApiError, type CategoryMeta, type CellsResponse, type CityMeta } from "@/lib/api";
import { cellsCacheKey, saveCells } from "@/lib/cache";
import { EMPTY_URL_STATE } from "@/lib/urlState";

// Карта тянет WebGL — в jsdom подменяем её заглушкой и проверяем передачу данных
vi.mock("./MapView", () => ({
  default: ({
    cells,
    onCellSelect,
    selectedCell,
  }: {
    cells: CellsResponse | null;
    onCellSelect: (h3: string) => void;
    selectedCell: string | null;
  }) => (
    <div data-testid="map">
      features={cells?.features.length ?? 0}
      <span data-testid="selected-cell">{selectedCell ?? ""}</span>
      <button type="button" data-testid="click-cell" onClick={() => onCellSelect("890b80db643ffff")}>
        клик по ячейке
      </button>
    </div>
  ),
}));

const apiMock = {
  fetchCities: vi.fn(),
  fetchCategories: vi.fn(),
  fetchCells: vi.fn(),
  fetchPois: vi.fn(),
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchCities: () => apiMock.fetchCities(),
    fetchCategories: () => apiMock.fetchCategories(),
    fetchCells: (query: unknown) => apiMock.fetchCells(query),
    fetchPois: (query: unknown) => apiMock.fetchPois(query),
  };
});

const POIS = {
  items: [
    {
      osm_type: "node",
      osm_id: 42,
      name: "Кофейня «Точка»",
      brand: null,
      address: "пр. Ленина, 10",
      categories: ["cafe"],
      lat: 56.47,
      lon: 85.02,
      osm_url: "https://www.openstreetmap.org/node/42",
    },
  ],
  meta: {
    city: "tomsk",
    cell: "890b80db643ffff",
    res: 9,
    category: "cafe",
    total: 1,
    returned: 1,
    limit: 100,
    offset: 0,
    data_version: "2026-09-27",
  },
};

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
  apiMock.fetchPois.mockResolvedValue(POIS);
  window.history.replaceState(null, "", "/");
  // Кэш последнего ответа живёт в sessionStorage и переживает тесты — начинаем с чистого
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("MapExplorer", () => {
  it("показывает данные, версию данных и разрешение сетки", async () => {
    render(<MapExplorer styleUrl="style.json" />);

    await waitFor(() => expect(apiMock.fetchCells).toHaveBeenCalled());

    const map = await screen.findByTestId("map");
    expect(map.textContent).toContain("features=1");
    expect(screen.getByTestId("data-version").textContent).toContain("27.09.2026");
    expect(screen.getByTestId("resolution").textContent).toContain("res 9");
    expect(screen.getByText("25.6 – 42.7")).toBeTruthy();
    expect(screen.getByTestId("attribution").textContent).toContain("OpenFreeMap");
  });

  it("по умолчанию выбирает категорию, по которой есть данные", async () => {
    render(<MapExplorer styleUrl="style.json" />);

    await waitFor(() => expect(apiMock.fetchCells).toHaveBeenCalled());

    expect(apiMock.fetchCells).toHaveBeenCalledWith(
      expect.objectContaining({ city: "tomsk", category: "cafe", res: 9 }),
    );
  });

  it("уважает город и категорию из query-параметров", async () => {
    render(
      <MapExplorer
        styleUrl="style.json"
        initialState={{ ...EMPTY_URL_STATE, city: "tomsk", category: "bar" }}
      />,
    );

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
      new ApiError(500, "Сервис недоступен", "внутренняя ошибка"),
    );

    render(<MapExplorer styleUrl="style.json" />);

    const errorCard = await screen.findByTestId("error");
    expect(errorCard.textContent).toContain("Сервис недоступен");

    const callsBefore = apiMock.fetchCells.mock.calls.length;
    screen.getByRole("button", { name: "Повторить" }).click();

    await waitFor(() => expect(apiMock.fetchCells.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("для 503 показывает человеческое объяснение, а не техническую ошибку", async () => {
    apiMock.fetchCells.mockRejectedValue(
      new ApiError(503, "Сервис недоступен", "нет собранной сетки"),
    );

    render(<MapExplorer styleUrl="style.json" />);

    const errorCard = await screen.findByTestId("error");
    expect(errorCard.textContent).toContain("Данные для этого города ещё не собраны");
    expect(errorCard.textContent).toContain("Мы работаем над этим");
    // Технические подробности (команды импорта) пользователю не показываем
    expect(errorCard.textContent).not.toContain("geopuls.aggregate");
    expect(screen.getByRole("button", { name: "Выбрать другой город" })).toBeTruthy();
  });

  it("при потере связи подсказывает проверить интернет", async () => {
    apiMock.fetchCells.mockRejectedValue(new ApiError(0, "Нет связи с сервисом", "fetch failed"));

    render(<MapExplorer styleUrl="style.json" />);

    const errorCard = await screen.findByTestId("error");
    expect(errorCard.textContent).toContain("Проверьте соединение с интернетом");
  });

  it("при потере связи показывает последние загруженные данные и баннер офлайн-режима", async () => {
    // Кэш как после успешной загрузки: сетка уже была получена
    saveCells(cellsCacheKey("tomsk", "cafe", 9), CELLS);
    apiMock.fetchCells.mockRejectedValue(new ApiError(0, "Нет связи с сервисом", "fetch failed"));

    render(<MapExplorer styleUrl="style.json" />);

    const offline = await screen.findByTestId("offline");
    expect(offline.textContent).toContain("Нет связи с сервисом");
    const map = await screen.findByTestId("map");
    expect(map.textContent).toContain("features=1");
    // Карточки ошибки нет: данные показываем, о проблеме сообщает баннер
    expect(screen.queryByTestId("error")).toBeNull();
  });

  it("клик по ячейке открывает список объектов и попадает в адресную строку", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchCells).toHaveBeenCalled());

    screen.getByTestId("click-cell").click();

    const panel = await screen.findByTestId("poi-panel");
    expect(panel).toBeTruthy();
    expect(await screen.findByText("Кофейня «Точка»")).toBeTruthy();
    expect(apiMock.fetchPois).toHaveBeenCalledWith({
      city: "tomsk",
      cell: "890b80db643ffff",
      res: 9,
      category: "cafe",
    });
    expect(screen.getByTestId("selected-cell").textContent).toBe("890b80db643ffff");
    await waitFor(() => expect(window.location.search).toContain("cell=890b80db643ffff"));
    expect(window.location.search).toContain("city=tomsk");
    expect(window.location.search).toContain("category=cafe");
  });

  it("смена города или категории закрывает список объектов прежней ячейки", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchCells).toHaveBeenCalled());

    screen.getByTestId("click-cell").click();
    await screen.findByTestId("poi-panel");

    // Смена значения как её делает React: присваиваем value и шлём change
    const select = screen.getByLabelText("Категория") as HTMLSelectElement;
    select.value = "bar";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(screen.queryByTestId("poi-panel")).toBeNull());
    expect(window.location.search).not.toContain("cell=");
  });

  it("кнопка «Поделиться» копирует ссылку на текущий вид", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchCells).toHaveBeenCalled());

    screen.getByTestId("share").click();

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain("city=tomsk");
    const status = await screen.findByTestId("share-status");
    expect(status.textContent).toContain("ссылка скопирована");
  });

  it("по кнопке CSV выгружает сетку с индексом H3, количеством и плотностью", async () => {
    const blobs: Blob[] = [];
    const created: HTMLAnchorElement[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:geopuls";
      }),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function mockClick(this: HTMLAnchorElement) {
        created.push(this);
      });

    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchCells).toHaveBeenCalled());

    // CSV живёт в меню «Экспорт» — сначала раскрываем его (дизайн-спека §4.9)
    fireEvent.click(screen.getByTestId("export"));
    fireEvent.click(await screen.findByTestId("export-csv"));

    await waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0].text();
    // Атрибуция в экспортe обязательна (ODbL), поэтому CSV начинается строкой-комментарием
    expect(text).toContain("OpenStreetMap contributors");
    expect(text).toContain("h3,count,density_poi_per_km2");
    expect(text).toContain("890b80db643ffff,2,17.1");
    expect(created[0].download).toBe("geopuls-томск-res9.csv");

    clickSpy.mockRestore();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });
});
