import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ComparePanel from "./ComparePanel";
import { ApiError, type CellProfile, type CityProfile, fetchCellProfile, fetchCityProfile } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchCellProfile: vi.fn(), fetchCityProfile: vi.fn() };
});

const CELL_A = "890b80db643ffff";
const CELL_B = "890b80db64bffff";

function cellProfile(cell: string, density: number, stops: number | null): CellProfile {
  return {
    metrics: [
      {
        layer: "competitors",
        layer_name: "Конкуренты (объекты по категориям)",
        category: "cafe",
        metric_kind: "density",
        unit: "POI/км²",
        value: density,
        extras: { count: 3 },
      },
      {
        layer: "transport_stops",
        layer_name: "Транспорт: остановки и станции",
        category: "transport_stops",
        metric_kind: "density",
        unit: "ост/км²",
        value: stops ?? 0,
        extras: {},
      },
    ],
    meta: { city: "tomsk", cell, res: 9, data_version: "2026-09-27", updated_at: null },
  };
}

const CITY_PROFILE = {
  type: "CityProfile",
  city: {
    slug: "tomsk",
    name: "Томск",
    region: "Томская область",
    h3_res: 9,
    area_km2: 176.8,
    center: { lat: 56.47, lon: 85.02 },
    bbox: { min_lat: 56.37, min_lon: 84.82, max_lat: 56.57, max_lon: 85.15 },
    data_version: "2026-09-27",
    updated_at: null,
  },
  grid: { res: 9, cells: 1538, cells_non_empty: 341, empty_share: 77.8, poi_count: 2100 },
  categories: [],
  layers: [
    {
      slug: "transport_stops",
      name: "Транспорт: остановки и станции",
      metric_kind: "density",
      unit: "ост/км²",
      color: "#0f766e",
      covered_count: 1538,
      non_empty_count: 321,
      max_value: 51.25,
      median_value: 8.4,
    },
  ],
  sources: [],
} as CityProfile;

function renderPanel(props: Partial<React.ComponentProps<typeof ComparePanel>> = {}) {
  return render(
    <ComparePanel
      city="tomsk"
      cells={[CELL_A, CELL_B]}
      res={9}
      onRemove={vi.fn()}
      onClear={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe("ComparePanel", () => {
  beforeEach(() => {
    vi.mocked(fetchCityProfile).mockResolvedValue(CITY_PROFILE);
    vi.mocked(fetchCellProfile).mockImplementation((query) =>
      Promise.resolve(
        query.cell === CELL_A ? cellProfile(CELL_A, 17.1, 12.5) : cellProfile(CELL_B, 4.2, 0),
      ),
    );
  });

  it("просит выбрать две зоны, если выбрана одна", () => {
    renderPanel({ cells: [CELL_A] });

    expect(screen.getByTestId("compare-hint").textContent).toContain("хотя бы две зоны");
    expect(screen.queryByTestId("compare-table")).toBeNull();
  });

  it("показывает таблицу по зонам с показателями и единицами", async () => {
    renderPanel();

    const table = await screen.findByTestId("compare-table");

    // Данные приезжают асинхронно: ждём строки, а не только каркас таблицы
    await waitFor(() => expect(table.textContent).toContain("17.1"));

    expect(table.textContent).toContain(CELL_A);
    expect(table.textContent).toContain(CELL_B);
    expect(table.textContent).toContain("Конкуренты (объекты по категориям) — объектов");
    expect(table.textContent).toContain("Транспорт: остановки и станции");
    // Единица измерения обязательна: «Плотность, ост/км²» вместо голого числа
    expect(table.textContent).toContain("Плотность, ост/км²");
    expect(table.textContent).toContain("4.2");
  });

  it("не подменяет отсутствие данных нулём", async () => {
    vi.mocked(fetchCellProfile).mockImplementation((query) =>
      Promise.resolve(
        query.cell === CELL_A
          ? cellProfile(CELL_A, 17.1, 12.5)
          : { ...cellProfile(CELL_B, 4.2, null), metrics: [cellProfile(CELL_B, 4.2, null).metrics[0]!] },
      ),
    );

    renderPanel();

    const table = await screen.findByTestId("compare-table");

    await waitFor(() => expect(table.textContent).toContain("нет данных"));
  });

  it("говорит, что это наблюдения, а не вердикт", async () => {
    renderPanel();

    expect(await screen.findByText(/Наблюдения по данным/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("перегрев");
  });

  it("убирает зону и очищает набор", async () => {
    const onRemove = vi.fn();
    const onClear = vi.fn();
    renderPanel({ onRemove, onClear });

    await screen.findByTestId("compare-table");
    fireEvent.click(screen.getByTestId(`compare-remove-${CELL_B}`));
    fireEvent.click(screen.getByTestId("compare-clear"));

    expect(onRemove).toHaveBeenCalledWith(CELL_B);
    expect(onClear).toHaveBeenCalled();
  });

  it("показывает ошибку и умеет повторить", async () => {
    vi.mocked(fetchCityProfile).mockRejectedValueOnce(
      new ApiError(503, "Сервис недоступен", "нет собранной сетки"),
    );

    renderPanel();

    const error = await screen.findByTestId("compare-error");
    expect(error.textContent).toContain("Сервис недоступен");

    vi.mocked(fetchCityProfile).mockResolvedValueOnce(CITY_PROFILE);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    await waitFor(() => expect(screen.getByTestId("compare-table")).toBeTruthy());
  });
});
