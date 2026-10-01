import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ZonePanel, { type CellMetricView } from "./ZonePanel";

const apiMock = { fetchPois: vi.fn() };

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchPois: (query: unknown) => apiMock.fetchPois(query),
  };
});

const CELL = "890b80db643ffff";

const POIS = {
  items: [
    {
      osm_type: "node",
      osm_id: 42,
      name: "Кофейня «Точка»",
      brand: "Точка",
      address: "пр. Ленина, 10",
      categories: ["cafe"],
      lat: 56.47,
      lon: 85.02,
      osm_url: "https://www.openstreetmap.org/node/42",
    },
  ],
  meta: {
    city: "tomsk",
    cell: CELL,
    res: 9,
    category: "cafe",
    total: 12,
    returned: 1,
    limit: 1,
    offset: 0,
    data_version: "2026-09-27",
  },
};

const METRICS: CellMetricView[] = [
  {
    slug: "competitors",
    name: "Конкуренты (объекты по категориям)",
    unit: "POI/км²",
    metricKind: "density",
    role: "base",
    value: 42.7,
    covered: true,
  },
  {
    slug: "residential",
    name: "Жилая застройка",
    unit: "%",
    metricKind: "area_share",
    role: "overlay",
    value: 100,
    covered: true,
  },
  {
    slug: "population",
    name: "Население",
    unit: "чел/км²",
    metricKind: "people_density",
    role: "overlay",
    // Слой собран не по всей сетке: «нет данных» — это не ноль
    value: null,
    covered: false,
  },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof ZonePanel>> = {}) {
  render(
    <ZonePanel
      city="tomsk"
      cell={CELL}
      res={9}
      category="cafe"
      categoryNames={{ cafe: "Кофейни и кафе" }}
      metrics={METRICS}
      baseBreaks={[0, 25.6, 42.7, 59.8, 76.9]}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  apiMock.fetchPois.mockResolvedValue(POIS);
});

describe("ZonePanel", () => {
  it("показывает числа всех слоёв и помечает тот, которым покрашена карта", async () => {
    renderPanel();

    const metrics = await screen.findByTestId("cell-metrics");

    expect(metrics.textContent).toContain("Конкуренты (объекты по категориям)");
    expect(metrics.textContent).toContain("42.7 POI/км²");
    expect(metrics.textContent).toContain("основа карты");
    // Дополнительные слои тоже на месте: выбирать их заранее не нужно
    expect(metrics.textContent).toContain("Жилая застройка");
    expect(metrics.textContent).toContain("100 %");
  });

  it("подписывает класс плотности словами: число само по себе ничего не говорит", async () => {
    renderPanel();

    // 42.7 — нижняя граница класса «42.7 – 59.8»: значение на границе читается как верхний класс,
    // ровно так же, как его красит карта
    expect((await screen.findByTestId("zone-metric-competitors")).textContent).toContain("42.7 – 59.8");
  });

  it("различает «нет данных» и полноту покрытия слоя", async () => {
    renderPanel();

    const metric = await screen.findByTestId("zone-metric-population");

    expect(metric.textContent).toContain("нет данных");
    expect(metric.textContent).toContain("не полностью");
  });

  it("показывает объекты выбранной категории и честно говорит про лимит списка", async () => {
    renderPanel();

    expect(await screen.findByText("Кофейня «Точка»")).toBeTruthy();
    expect(screen.getByTestId("zone-count").textContent).toBe("12 объектов");
    expect(screen.getByText(/Показано 1 из 12/)).toBeTruthy();
    expect(apiMock.fetchPois).toHaveBeenCalledWith({
      city: "tomsk",
      cell: CELL,
      res: 9,
      category: "cafe",
    });
  });

  it("пустой список объясняет, почему объектов нет", async () => {
    apiMock.fetchPois.mockResolvedValue({ items: [], meta: { ...POIS.meta, total: 0, returned: 0 } });

    renderPanel();

    await waitFor(() => expect(screen.getByTestId("zone-empty")).toBeTruthy());
    expect(screen.getByTestId("zone-empty").textContent).toContain("нет размеченных объектов");
  });

  it("ошибку загрузки показывает словами, а не пустым окном", async () => {
    apiMock.fetchPois.mockRejectedValue(new Error("сеть"));

    renderPanel();

    const error = await screen.findByTestId("zone-error");
    expect(error.textContent).toContain("Непредвиденная ошибка");
  });
});
