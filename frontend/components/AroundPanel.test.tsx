import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AroundPanel, { formatDistance, formatObjects } from "./AroundPanel";
import { ApiError, type AroundResponse, fetchAround } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchAround: vi.fn() };
});

const POINT = { lat: 56.4847, lon: 84.9482 };

const RESPONSE: AroundResponse = {
  type: "AroundPoint",
  point: POINT,
  meta: {
    city: "tomsk",
    radius_m: 500,
    category: "cafe",
    data_version: "2026-09-27",
    updated_at: null,
  },
  layers: [
    {
      slug: "competitors",
      name: "Конкуренты (объекты по категориям)",
      category: "cafe",
      metric_kind: "density",
      unit: "POI/км²",
      objects: 3,
      nearest_m: 80.4,
      nearest_name: "Кофейня «Точка»",
    },
    {
      slug: "transport_stops",
      name: "Транспорт: остановки и станции",
      category: "transport_stops",
      metric_kind: "density",
      unit: "ост/км²",
      objects: 0,
      nearest_m: null,
      nearest_name: null,
    },
  ],
  sources: [],
};

function renderPanel(props: Partial<React.ComponentProps<typeof AroundPanel>> = {}) {
  return render(
    <AroundPanel
      city="tomsk"
      point={POINT}
      radiusM={500}
      category="cafe"
      onRadiusChange={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe("AroundPanel", () => {
  beforeEach(() => {
    vi.mocked(fetchAround).mockResolvedValue(RESPONSE);
  });

  it("показывает, что попадает в радиус, с расстоянием до ближайшего", async () => {
    renderPanel();

    const table = await screen.findByTestId("around-table");

    expect(table.textContent).toContain("Конкуренты (объекты по категориям)");
    expect(table.textContent).toContain("3 объекта");
    expect(table.textContent).toContain("Кофейня «Точка» — 80 м");
    expect(table.textContent).toContain("Транспорт: остановки и станции");
  });

  it("говорит «нет в радиусе» вместо нуля объектов и пустой строки", async () => {
    renderPanel();

    const stops = await screen.findByTestId("around-layer-transport_stops");

    expect(stops.textContent).toContain("нет в радиусе");
    expect(stops.textContent).toContain("—");
  });

  it("запрашивает данные тем же радиусом, что показан панелью", async () => {
    renderPanel({ radiusM: 1000 });

    await screen.findByTestId("around-table");

    expect(fetchAround).toHaveBeenCalledWith(
      expect.objectContaining({ radiusM: 1000, city: "tomsk", category: "cafe", lat: POINT.lat, lon: POINT.lon }),
    );
  });

  it("меняет радиус кнопкой и сообщает об этом наружу", async () => {
    const onRadiusChange = vi.fn();
    renderPanel({ onRadiusChange });

    await screen.findByTestId("around-table");
    fireEvent.click(screen.getByTestId("around-radius-1000"));

    expect(onRadiusChange).toHaveBeenCalledWith(1000);
  });

  it("показывает координаты точки — по ним расчёт можно повторить", async () => {
    renderPanel();

    const point = await screen.findByTestId("around-point");

    expect(point.textContent).toContain("56.48470");
    expect(point.textContent).toContain("500");
  });

  it("показывает ошибку и умеет повторить", async () => {
    vi.mocked(fetchAround).mockRejectedValueOnce(
      new ApiError(400, "Ошибка запроса", "Укажите категорию"),
    );

    renderPanel();

    const error = await screen.findByTestId("around-error");
    expect(error.textContent).toContain("Укажите категорию");

    vi.mocked(fetchAround).mockResolvedValueOnce(RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    await waitFor(() => expect(screen.getByTestId("around-table")).toBeTruthy());
  });

  it("это наблюдения, а не вердикт", async () => {
    renderPanel();

    expect(await screen.findByText(/Наблюдения по данным OSM/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("перегрев");
  });
});

describe("форматирование", () => {
  it("расстояние переводится в километры только после тысячи метров", () => {
    expect(formatDistance(80.4)).toBe("80 м");
    expect(formatDistance(500)).toBe("500 м");
    expect(formatDistance(2000)).toBe("2,0 км");
  });

  it("число объектов согласуется с существительным", () => {
    expect(formatObjects(0)).toBe("нет в радиусе");
    expect(formatObjects(1)).toBe("1 объект");
    expect(formatObjects(3)).toBe("3 объекта");
    expect(formatObjects(11)).toBe("11 объектов");
    expect(formatObjects(21)).toBe("21 объект");
  });
});
