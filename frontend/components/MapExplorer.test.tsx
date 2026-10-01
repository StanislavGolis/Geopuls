import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MapExplorer from "./MapExplorer";
import {
  ApiError,
  type CategoryMeta,
  type CityMeta,
  type LayerGrid,
  type LayerMeta,
  type LayerGridQuery,
} from "@/lib/api";
import { gridCacheKey, saveGrid } from "@/lib/cache";
import { EMPTY_URL_STATE } from "@/lib/urlState";

// Карта тянет WebGL — в jsdom подменяем её заглушкой и проверяем передачу данных
vi.mock("./MapView", () => ({
  default: ({
    grid,
    onCellSelect,
    onPointSelect,
    onViewChange,
    selectedCell,
    category,
  }: {
    grid: LayerGrid | null;
    onCellSelect: (h3: string) => void;
    onPointSelect?: (point: { lat: number; lon: number }) => void;
    onViewChange?: (view: { lat: number; lon: number; zoom: number; bbox: string }) => void;
    selectedCell: string | null;
    category?: string | null;
  }) => {
    // Настоящая карта сообщает границы вида после загрузки стиля — здесь то же самое, одним эффектом
    useEffect(() => {
      onViewChange?.({
        lat: 56.47,
        lon: 85.02,
        zoom: 12,
        bbox: "84.90,56.40,85.10,56.50",
      });
    }, [onViewChange]);

    return (
      <div data-testid="map">
        cells={grid?.cells.h3.length ?? 0}
        <span data-testid="selected-cell">{selectedCell ?? ""}</span>
        {/* Категория, которой карта фильтрует точки ячейки: должна совпадать со списком объектов */}
        <span data-testid="map-category">{category ?? ""}</span>
        <button type="button" data-testid="click-cell" onClick={() => onCellSelect("890b80db643ffff")}>
          клик по ячейке
        </button>
        {/* Ячейка обзорного слоя: разрешение в состоянии и у ячейки может расходиться при смене по зуму */}
        <button type="button" data-testid="click-cell-res8" onClick={() => onCellSelect("880b86a59dfffff")}>
          клик по ячейке res 8
        </button>
        {/* Точку радиуса ставит карта: обработчик появляется только в режиме радиуса (ADR 0016) */}
        {onPointSelect && (
          <button
            type="button"
            data-testid="click-point"
            onClick={() => onPointSelect({ lat: 56.4847, lon: 84.9482 })}
          >
            клик по карте в режиме радиуса
          </button>
        )}
      </div>
    );
  },
}));

const apiMock = {
  fetchCities: vi.fn(),
  fetchCategories: vi.fn(),
  fetchLayers: vi.fn(),
  fetchLayerGrid: vi.fn(),
  fetchPois: vi.fn(),
  fetchCityProfile: vi.fn(),
  fetchCellProfile: vi.fn(),
  fetchLayerObjects: vi.fn(),
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchCities: () => apiMock.fetchCities(),
    fetchCategories: () => apiMock.fetchCategories(),
    fetchLayers: () => apiMock.fetchLayers(),
    fetchLayerGrid: (query: LayerGridQuery) => apiMock.fetchLayerGrid(query),
    fetchPois: (query: unknown) => apiMock.fetchPois(query),
    fetchCityProfile: (slug: string) => apiMock.fetchCityProfile(slug),
    fetchCellProfile: (query: unknown) => apiMock.fetchCellProfile(query),
    fetchLayerObjects: (query: unknown) => apiMock.fetchLayerObjects(query),
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

/** Профиль города: минимальная сводка, достаточная, чтобы панель отрисовалась. */
const PROFILE = {
  type: "CityProfile" as const,
  city: CITY,
  grid: { res: 9, cells: 1, cells_non_empty: 1, empty_share: 0, poi_count: 2 },
  categories: [{ slug: "cafe", name: "Кофейни и кафе", color: "#1f6fb2", poi_count: 2, share: 100 }],
  layers: [
    {
      slug: "competitors",
      name: "Конкуренты (объекты по категориям)",
      metric_kind: "density",
      unit: "POI/км²",
      color: "#1f6fb2",
      covered_count: 1,
      non_empty_count: 1,
      max_value: 17.1,
      median_value: 17.1,
    },
  ],
  sources: [],
};

const CATEGORIES: CategoryMeta[] = [
  { slug: "bar", name: "Бары и пабы", color: "#1f6fb2", poi_count: 0 },
  { slug: "cafe", name: "Кофейни и кафе", color: "#1f6fb2", poi_count: 248 },
];

/** Реестр слоёв: базовый с вариантами и три слоя, которые можно включить наложением. */
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
    categories: ["bar", "cafe"],
    source: {
      slug: "osm",
      title: "OpenStreetMap (Geofabrik)",
      license: "ODbL 1.0",
      license_url: "https://opendatacommons.org/licenses/odbl/1-0/",
      attribution_text: "© OpenStreetMap contributors",
      citation: null,
      source_url: null,
      data_version: "2026-09-27",
    },
  },
  ...[
    ["population", "Население", "people_density", "чел/км²"],
    ["transport", "Транспорт", "count", "шт"],
    ["pedestrian", "Пешеходные пути", "length", "км"],
  ].map(([slug, name, metricKind, unit]): LayerMeta => ({
    slug,
    name,
    kind: "osm",
    metric_kind: metricKind,
    unit,
    scale: "quantile",
    color: "#334155",
    can_be_base: true,
    categories: [],
    source: null,
  })),
];

const GRID: LayerGrid = {
  type: "LayerGrid",
  cells: {
    h3: ["890b80db643ffff"],
    geometry: [
      [
        [85.02, 56.51],
        [85.03, 56.51],
        [85.03, 56.52],
        [85.02, 56.51],
      ],
    ],
  },
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
      values: [17.1],
      extras: { count: [2] },
      covered_count: 1,
      non_empty_count: 1,
      total_value: 17.1,
      max_value: 17.1,
      breaks: [0, 25.6, 42.7, 59.8, 76.9],
      source: null,
    },
  ],
  meta: {
    city: "tomsk",
    res: 9,
    cell_count: 1,
    base: "competitors:cafe",
    overlays: [],
    data_version: "2026-09-27",
    updated_at: "2026-09-28T12:39:25Z",
    bbox_filter: null,
    sources: [],
  },
};

beforeEach(() => {
  apiMock.fetchCities.mockResolvedValue([CITY]);
  apiMock.fetchCategories.mockResolvedValue(CATEGORIES);
  apiMock.fetchLayers.mockResolvedValue({ layers: LAYERS, data_version: "2026-09-27" });
  apiMock.fetchLayerObjects.mockResolvedValue({
    type: "LayerObjects",
    features: [],
    meta: {
      layer: "population",
      layer_name: "Население",
      bbox: "84.90,56.40,85.10,56.50",
      limit: 2000,
      total: 0,
      returned: 0,
      truncated: false,
      data_version: "2026-09-27",
      updated_at: null,
    },
    sources: [],
  });
  apiMock.fetchLayerGrid.mockResolvedValue(GRID);
  apiMock.fetchPois.mockResolvedValue(POIS);
  apiMock.fetchCityProfile.mockResolvedValue(PROFILE);
  apiMock.fetchCellProfile.mockResolvedValue({
    metrics: [
      {
        layer: "competitors",
        layer_name: "Конкуренты (объекты по категориям)",
        category: "cafe",
        metric_kind: "density",
        unit: "POI/км²",
        value: 17.1,
        extras: { count: 2 },
      },
    ],
    meta: { city: "tomsk", cell: "890b80db643ffff", res: 9, data_version: "2026-09-27", updated_at: null },
  });
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

    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    const map = await screen.findByTestId("map");
    expect(map.textContent).toContain("cells=1");
    expect(screen.getByTestId("data-version").textContent).toContain("27.09.2026");
    expect(screen.getByTestId("resolution").textContent).toContain("res 9");
    // Подпись класса есть и в легенде, и в виджете классов: проверяем именно легенду, чтобы тест
    // не зависел от того, сколько панелей открыто
    expect(screen.getAllByText("25.6 – 42.7").length).toBeGreaterThan(0);
    expect(screen.getByTestId("attribution").textContent).toContain("OpenFreeMap");
  });

  it("по умолчанию красит карту слоем с данными: слой конкурентов и категория с объектами", async () => {
    render(<MapExplorer styleUrl="style.json" />);

    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    expect(apiMock.fetchLayerGrid).toHaveBeenCalledWith(
      expect.objectContaining({ city: "tomsk", base: "competitors:cafe", res: 9 }),
    );
  });

  it("вкладка «Инфраструктура» красит карту выбранным показателем", async () => {
    render(
      <MapExplorer
        styleUrl="style.json"
        initialState={{
          ...EMPTY_URL_STATE,
          city: "tomsk",
          tab: "infrastructure",
          base: "population",
          overlays: "transport",
        }}
      />,
    );

    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    expect(apiMock.fetchLayerGrid).toHaveBeenCalledWith(
      expect.objectContaining({ base: "population", overlays: "transport" }),
    );
    expect(screen.getByTestId("tab-infrastructure").getAttribute("aria-selected")).toBe("true");
  });

  it("старая ссылка с одной категорией открывает ту же карту", async () => {
    // Ссылки вида `?category=bar` разошлись до появления слоёв: они обязаны работать
    render(
      <MapExplorer
        styleUrl="style.json"
        initialState={{ ...EMPTY_URL_STATE, city: "tomsk", category: "bar" }}
      />,
    );

    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    expect(apiMock.fetchLayerGrid).toHaveBeenCalledWith(
      expect.objectContaining({ base: "competitors:bar" }),
    );
  });

  it("показывает честное состояние «нет данных» вместо пустой карты", async () => {
    apiMock.fetchLayerGrid.mockResolvedValue({
      ...GRID,
      layers: [{ ...GRID.layers[0], values: [0], non_empty_count: 0, max_value: 0, breaks: [0, 0, 0, 0, 0] }],
    });

    render(<MapExplorer styleUrl="style.json" />);

    const empty = await screen.findByTestId("empty");
    expect(empty.textContent).toContain("нет размеченных объектов");
  });

  it("показывает ошибку API и умеет повторить запрос", async () => {
    apiMock.fetchLayerGrid.mockRejectedValue(
      new ApiError(500, "Сервис недоступен", "внутренняя ошибка"),
    );

    render(<MapExplorer styleUrl="style.json" />);

    const errorCard = await screen.findByTestId("error");
    expect(errorCard.textContent).toContain("Сервис недоступен");

    const callsBefore = apiMock.fetchLayerGrid.mock.calls.length;
    screen.getByRole("button", { name: "Повторить" }).click();

    await waitFor(() => expect(apiMock.fetchLayerGrid.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("для 503 показывает человеческое объяснение, а не техническую ошибку", async () => {
    apiMock.fetchLayerGrid.mockRejectedValue(
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
    apiMock.fetchLayerGrid.mockRejectedValue(new ApiError(0, "Нет связи с сервисом", "fetch failed"));

    render(<MapExplorer styleUrl="style.json" />);

    const errorCard = await screen.findByTestId("error");
    expect(errorCard.textContent).toContain("Проверьте соединение с интернетом");
  });

  it("при потере связи показывает последние загруженные данные и баннер офлайн-режима", async () => {
    // Кэш как после успешной загрузки: сетка уже была получена
    saveGrid(gridCacheKey("tomsk", "competitors:cafe", "", 9), GRID);
    apiMock.fetchLayerGrid.mockRejectedValue(new ApiError(0, "Нет связи с сервисом", "fetch failed"));

    render(<MapExplorer styleUrl="style.json" />);

    const offline = await screen.findByTestId("offline");
    expect(offline.textContent).toContain("Нет связи с сервисом");
    const map = await screen.findByTestId("map");
    expect(map.textContent).toContain("cells=1");
    // Карточки ошибки нет: данные показываем, о проблеме сообщает баннер
    expect(screen.queryByTestId("error")).toBeNull();
  });

  it("клик по ячейке открывает список объектов и попадает в адресную строку", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

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
    // Слой и его категория: ссылку читают и новые клиенты, и старые (см. urlState)
    expect(window.location.search).toContain("base=competitors:cafe");
    expect(window.location.search).toContain("category=cafe");
  });

  it("клик по ячейке другого разрешения запрашивает объекты с разрешением самой ячейки", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    // Сразу после смены разрешения по зуму состояние уже res 9, а отрисован ещё обзорный слой:
    // запрос со «своим» res давал 404 — разрешение обязано следовать за ячейкой
    screen.getByTestId("click-cell-res8").click();

    await screen.findByTestId("poi-panel");
    expect(apiMock.fetchPois).toHaveBeenCalledWith({
      city: "tomsk",
      cell: "880b86a59dfffff",
      res: 8,
      category: "cafe",
    });
  });

  it("дополнительный слой добавляет числа в карточку выбранной ячейки", async () => {
    apiMock.fetchLayerGrid.mockResolvedValue({
      ...GRID,
      layers: [
        ...GRID.layers,
        {
          ...GRID.layers[0],
          slug: "population",
          name: "Население",
          category: null,
          role: "overlay" as const,
          metric_kind: "people_density",
          unit: "чел/км²",
          values: [4321.5],
        },
      ],
    });

    render(
      <MapExplorer
        styleUrl="style.json"
        initialState={{ ...EMPTY_URL_STATE, city: "tomsk", overlays: "population" }}
      />,
    );
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    screen.getByTestId("click-cell").click();

    // Числа слоя читаются по той же ячейке: пользователь не переключает карту, а уточняет ответ
    const metrics = await screen.findByTestId("cell-metrics");

    expect(metrics.textContent).toContain("Население");
    expect(metrics.textContent).toContain("4321.5 чел/км²");
    expect(metrics.textContent).toContain("Плотность населения");
  });

  it("смена категории закрывает список объектов прежней ячейки", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    screen.getByTestId("click-cell").click();
    await screen.findByTestId("poi-panel");

    // Смена значения как её делает React: присваиваем value и шлём change
    const select = screen.getByLabelText("Категория") as HTMLSelectElement;
    select.value = "bar";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(screen.queryByTestId("poi-panel")).toBeNull());
    expect(window.location.search).not.toContain("cell=");
  });

  it("карта фильтрует точки ячейки той же категорией, что и список объектов", async () => {
    render(<MapExplorer styleUrl="style.json" />);

    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    // Иначе клик по гексу подсвечивал бы все бизнесы города, а панель показывала бы только конкуренцию
    expect(screen.getByTestId("map-category").textContent).toBe("cafe");

    const select = screen.getByLabelText("Категория") as HTMLSelectElement;
    select.value = "bar";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(screen.getByTestId("map-category").textContent).toBe("bar"));
  });

  it("режим сравнения открывается из «Инструментов»: клик по гексу набирает зоны", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("tab-tools"));
    // Пока инструмент не выбран, вкладка предлагает выбор: два инструмента, а не пять кнопок в шапке
    fireEvent.click(await screen.findByTestId("tool-compare"));

    // Пока зон меньше двух, панель объясняет, что делать — таблицы ещё нет
    expect(await screen.findByTestId("compare-hint")).toBeTruthy();

    fireEvent.click(screen.getByTestId("click-cell"));
    await waitFor(() => expect(window.location.search).toContain("compare=890b80db643ffff"));

    // Повторный клик по той же зоне убирает её из набора
    fireEvent.click(screen.getByTestId("click-cell"));
    await waitFor(() => expect(window.location.search).not.toContain("compare="));
  });

  it("инструмент «Радиус» включает режим: подсказка объясняет, что делать", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("tab-tools"));
    fireEvent.click(await screen.findByTestId("tool-radius"));

    expect(await screen.findByTestId("around-hint")).toBeTruthy();

    fireEvent.click(screen.getByTestId("click-point"));
    await waitFor(() => expect(window.location.search).toContain("around="));
    // Круг радиуса на карте считается тем же радиусом, что уходит в запрос
    expect(await screen.findByTestId("around-panel")).toBeTruthy();
  });

  it("вкладка «Город» — состояние ссылки: ей делятся, а не открывают заново", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("tab-city"));

    const panel = await screen.findByTestId("city-profile");
    expect(panel.textContent).toContain("Томск");
    expect(apiMock.fetchCityProfile).toHaveBeenCalledWith("tomsk");
    // Ссылкой на сводку делятся: сцена уходит в адресную строку
    await waitFor(() => expect(window.location.search).toContain("tab=city"));

    fireEvent.click(screen.getByTestId("city-profile-close"));

    await waitFor(() => expect(screen.queryByTestId("city-profile")).toBeNull());
    // Закрытие сводки возвращает на основную вкладку, а не оставляет пустую сцену
    expect(screen.getByTestId("tab-competitors").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(window.location.search).not.toContain("tab=city"));
  });

  it("виджеты зон: топ зон и классы плотности считаются по загруженной сетке", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    // Панель открыта по умолчанию: это ответ на «где выбранного больше всего»
    const widgets = await screen.findByTestId("cell-widgets");
    expect(widgets.textContent).toContain("Топ зон");
    expect(widgets.textContent).toContain("Классы плотности");

    // Клик по зоне открывает карточку зоны и попадает в ссылку — тот же выбор, что кликом по карте
    fireEvent.click(screen.getByTestId("widget-zone-890b80db643ffff"));
    await waitFor(() => expect(window.location.search).toContain("cell=890b80db643ffff"));

    // Клик по классу подсвечивает его (повторный — снимает), в ссылку это не пишется: это оформление
    fireEvent.click(screen.getByTestId("widget-class-0"));
    expect(screen.getByTestId("widget-class-0").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("widget-class-0"));
    expect(screen.getByTestId("widget-class-0").getAttribute("aria-pressed")).toBe("false");

    // Крестик и кнопка «Зоны» в панели сцены возвращают панель
    fireEvent.click(screen.getByTestId("widgets-close"));
    await waitFor(() => expect(screen.queryByTestId("cell-widgets")).toBeNull());
    fireEvent.click(screen.getByTestId("toggle-widgets"));
    expect(await screen.findByTestId("cell-widgets")).toBeTruthy();
  });

  it("в «Инструментах» и «Городе» сводки по зонам нет: там своя панель данных", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());
    expect(await screen.findByTestId("cell-widgets")).toBeTruthy();

    fireEvent.click(screen.getByTestId("tab-tools"));
    await waitFor(() => expect(screen.queryByTestId("cell-widgets")).toBeNull());
    expect(screen.queryByTestId("toggle-widgets")).toBeNull();

    fireEvent.click(screen.getByTestId("tab-competitors"));
    expect(await screen.findByTestId("cell-widgets")).toBeTruthy();
  });

  it("подсветка объектов слоя: запрос по границам вида и состояние в ссылке", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("layer-map-population"));

    // Запрос идёт по границам вида: слой целиком в браузер не тянем (план §6)
    await waitFor(() =>
      expect(apiMock.fetchLayerObjects).toHaveBeenCalledWith(
        expect.objectContaining({ layer: "population", bbox: "84.90,56.40,85.10,56.50" }),
      ),
    );
    // Ссылкой делятся: подсветка уезжает в адресную строку
    await waitFor(() => expect(window.location.search).toContain("objects=population"));

    // Повторный клик снимает подсветку: один слой за раз
    fireEvent.click(screen.getByTestId("layer-map-population"));
    await waitFor(() => expect(window.location.search).not.toContain("objects="));
  });

  it("вкладки хранят выбор пользователя: категория не сбрасывается при переходах", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("chip-bar"));
    await waitFor(() =>
      expect(apiMock.fetchLayerGrid).toHaveBeenLastCalledWith(
        expect.objectContaining({ base: "competitors:bar" }),
      ),
    );

    // Уходим в «Инфраструктуру» и возвращаемся: категория остаётся выбранной
    fireEvent.click(screen.getByTestId("tab-infrastructure"));
    await waitFor(() =>
      expect(apiMock.fetchLayerGrid).toHaveBeenLastCalledWith(
        expect.objectContaining({ base: expect.stringContaining("population") }),
      ),
    );

    fireEvent.click(screen.getByTestId("tab-competitors"));
    await waitFor(() =>
      expect(apiMock.fetchLayerGrid).toHaveBeenLastCalledWith(
        expect.objectContaining({ base: "competitors:bar" }),
      ),
    );
  });

  it("включение слоя меняет запрос и попадает в ссылку", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("layer-transport"));

    await waitFor(() =>
      expect(apiMock.fetchLayerGrid).toHaveBeenCalledWith(
        expect.objectContaining({ base: "competitors:cafe", overlays: "transport" }),
      ),
    );
    expect(window.location.search).toContain("overlays=transport");
  });

  it("слои включаются все: они не спорят за одну карту", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("layer-transport"));
    fireEvent.click(screen.getByTestId("layer-population"));
    await waitFor(() => expect(window.location.search).toContain("overlays=transport,population"));

    // Раньше третье наложение запрещалось: контуры делали карту нечитаемой. Теперь слои дают числа
    // в карточке ячейки, поэтому ограничения в интерфейсе нет.
    const third = screen.getByTestId("layer-pedestrian") as HTMLInputElement;
    expect(third.disabled).toBe(false);
    fireEvent.click(third);
    await waitFor(() => expect(window.location.search).toContain("overlays=transport,population,pedestrian"));
  });

  it("основу карты в «Конкурентах» не переключают: это главный ответ приложения", async () => {
    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    // В «Конкурентах» выбора основы нет: он живёт во вкладке «Инфраструктура» (ADR 0016)
    expect(screen.queryByTestId("base-population")).toBeNull();
    expect(screen.queryByTestId("infra-layer")).toBeNull();
    // Основу не рисуют ни блоком, ни строкой в списке слоёв: её называет вкладка «Конкуренты»
    expect(screen.queryByTestId("layer-base")).toBeNull();
    expect(screen.queryByTestId("layer-competitors")).toBeNull();
    expect(apiMock.fetchLayerGrid).toHaveBeenCalledWith(
      expect.objectContaining({ base: "competitors:cafe" }),
    );
  });

  it("смена показателя в «Инфраструктуре» меняет основу карты и попадает в ссылку", async () => {
    render(
      <MapExplorer
        styleUrl="style.json"
        initialState={{ ...EMPTY_URL_STATE, city: "tomsk", tab: "infrastructure" }}
      />,
    );
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    // Показатели берутся из реестра слоёв: интерфейс не хранит свой список
    const picker = await screen.findByTestId("infra-layer");
    expect(picker.textContent).toContain("Транспорт");

    fireEvent.change(picker, { target: { value: "pedestrian" } });

    await waitFor(() => expect(window.location.search).toContain("base=pedestrian"));
    await waitFor(() =>
      expect(apiMock.fetchLayerGrid).toHaveBeenLastCalledWith(
        expect.objectContaining({ base: "pedestrian" }),
      ),
    );
  });

  it("кнопка «Поделиться» копирует ссылку на текущий вид", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<MapExplorer styleUrl="style.json" />);
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    screen.getByTestId("share").click();

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain("city=tomsk");
    const status = await screen.findByTestId("share-status");
    expect(status.textContent).toContain("ссылка скопирована");
  });

  it("по кнопке CSV выгружает сетку с колонками активных слоёв", async () => {
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
    await waitFor(() => expect(apiMock.fetchLayerGrid).toHaveBeenCalled());

    // CSV живёт в меню «Экспорт» — сначала раскрываем его (дизайн-спека §4.9)
    fireEvent.click(screen.getByTestId("export"));
    fireEvent.click(await screen.findByTestId("export-csv"));

    await waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0].text();
    // Атрибуция в экспорте обязательна (ODbL), поэтому CSV начинается строкой-комментарием
    expect(text).toContain("OpenStreetMap contributors");
    expect(text).toContain("h3,competitors_cafe_value,competitors_cafe_count,lat,lon");
    expect(text).toContain("890b80db643ffff,17.1,2,");
    expect(created[0].download).toBe("geopuls-томск-res9.csv");

    clickSpy.mockRestore();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });
});