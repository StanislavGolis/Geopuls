import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PoiPanel from "./PoiPanel";
import { ApiError, type PoisResponse } from "@/lib/api";

const apiMock = { fetchPois: vi.fn() };

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchPois: (query: unknown) => apiMock.fetchPois(query),
  };
});

const CELL = "890b80db643ffff";
const OTHER_CELL = "890b80db643efff";
const CATEGORY_NAMES = { cafe: "Кофейни и кафе", restaurant: "Рестораны и фастфуд" };

const POIS: PoisResponse = {
  items: [
    {
      osm_type: "node",
      osm_id: 42,
      name: "Кофейня «Точка»",
      brand: "Surf Coffee",
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
    total: 1,
    returned: 1,
    limit: 100,
    offset: 0,
    data_version: "2026-09-27",
  },
};

function renderPanel(overrides: Partial<Parameters<typeof PoiPanel>[0]> = {}) {
  return render(
    <PoiPanel
      city="tomsk"
      category="cafe"
      cell={CELL}
      res={9}
      categoryNames={CATEGORY_NAMES}
      onClose={() => {}}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  apiMock.fetchPois.mockResolvedValue(POIS);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PoiPanel", () => {
  it("показывает объекты ячейки: название, бренд, адрес, категорию и ссылку на OSM", async () => {
    renderPanel();

    await screen.findByText("Кофейня «Точка»");

    expect(apiMock.fetchPois).toHaveBeenCalledWith({
      city: "tomsk",
      cell: CELL,
      res: 9,
      category: "cafe",
    });
    expect(screen.getByTestId("poi-count").textContent).toBe("1 объект");
    expect(screen.getByText("Surf Coffee")).toBeTruthy();
    expect(screen.getByText("пр. Ленина, 10")).toBeTruthy();
    // Показываем русское имя категории, а не slug из API
    expect(screen.getByText("Кофейни и кафе")).toBeTruthy();
    expect(screen.getByRole("link", { name: "OpenStreetMap" }).getAttribute("href")).toBe(
      "https://www.openstreetmap.org/node/42",
    );
  });

  it("честно сообщает, что в ячейке нет объектов", async () => {
    apiMock.fetchPois.mockResolvedValue({ items: [], meta: { ...POIS.meta, total: 0, returned: 0 } });

    renderPanel();

    const empty = await screen.findByTestId("poi-empty");
    expect(empty.textContent).toContain("нет размеченных объектов");
  });

  it("показывает ошибку API и умеет повторить запрос", async () => {
    apiMock.fetchPois.mockRejectedValue(new ApiError(503, "Сервис недоступен", "нет данных"));

    renderPanel();

    const error = await screen.findByTestId("poi-error");
    expect(error.textContent).toContain("Сервис недоступен");

    const callsBefore = apiMock.fetchPois.mock.calls.length;
    screen.getByRole("button", { name: "Повторить" }).click();

    await waitFor(() => expect(apiMock.fetchPois.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("предупреждает, когда список обрезан лимитом ответа", async () => {
    apiMock.fetchPois.mockResolvedValue({
      ...POIS,
      meta: { ...POIS.meta, total: 150, returned: 100 },
    });

    renderPanel();

    expect(await screen.findByText(/Показано 100 из 150/)).toBeTruthy();
  });

  it("закрывается по кнопке", async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });

    await screen.findByText("Кофейня «Точка»");
    screen.getByRole("button", { name: "Закрыть список объектов" }).click();

    expect(onClose).toHaveBeenCalled();
  });

  it("перезапрашивает объекты при переходе к другой ячейке", async () => {
    const { rerender } = renderPanel();
    await screen.findByText("Кофейня «Точка»");

    rerender(
      <PoiPanel
        city="tomsk"
        category="cafe"
        cell={OTHER_CELL}
        res={9}
        categoryNames={CATEGORY_NAMES}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(apiMock.fetchPois).toHaveBeenCalledWith(expect.objectContaining({ cell: OTHER_CELL })),
    );
  });

  it("без названия показывает бренд, а если нет и его — честную заглушку", async () => {
    apiMock.fetchPois.mockResolvedValue({
      ...POIS,
      items: [
        { ...POIS.items[0], name: null },
        { ...POIS.items[0], osm_id: 43, name: null, brand: null },
      ],
    });

    renderPanel();

    await screen.findByText("Surf Coffee");
    expect(screen.getByText("Без названия")).toBeTruthy();
  });
});
