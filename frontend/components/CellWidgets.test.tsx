import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import CellWidgets from "./CellWidgets";
import type { LayerGrid, MapLayerColumn } from "@/lib/api";

const CELL_A = "890b80db643ffff";
const CELL_B = "890b80db64bffff";
const CELL_C = "890b80db653ffff";

function column(values: (number | null)[]): MapLayerColumn {
  return {
    slug: "competitors",
    name: "Конкуренты (объекты по категориям)",
    category: "cafe",
    role: "base",
    metric_kind: "density",
    unit: "POI/км²",
    scale: "quantile",
    color: "#1f6fb2",
    values,
    extras: { count: [12, 3, 0] },
    covered_count: values.length,
    non_empty_count: 2,
    total_value: 0,
    max_value: 17.1,
    breaks: [0, 5, 20],
    source: null,
  } as MapLayerColumn;
}

const GRID = {
  type: "LayerGrid",
  cells: { h3: [CELL_A, CELL_B, CELL_C], geometry: [] },
  layers: [],
  meta: {
    city: "tomsk",
    res: 9,
    cell_count: 3,
    base: "competitors:cafe",
    overlays: [],
    data_version: "2026-09-27",
    updated_at: null,
    bbox_filter: null,
    sources: [],
  },
} as unknown as LayerGrid;

function renderWidgets(props: Partial<React.ComponentProps<typeof CellWidgets>> = {}) {
  return render(
    <CellWidgets
      grid={GRID}
      column={column([17.1, 4.2, 0])}
      onZoneSelect={vi.fn()}
      onClassSelect={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe("CellWidgets", () => {
  it("показывает топ зон с единицами измерения и числом объектов", () => {
    renderWidgets();

    const zones = screen.getByTestId("widget-zones");

    expect(zones.textContent).toContain("17.1 POI/км²");
    expect(zones.textContent).toContain(CELL_A);
    expect(zones.textContent).toContain("12 объектов");
    // Пустая зона в топ не попадает: список лидеров не начинается с нулей
    expect(zones.textContent).not.toContain(CELL_C);
  });

  it("клик по зоне сообщает её индекс наружу — откроется карточка зоны", () => {
    const onZoneSelect = vi.fn();
    renderWidgets({ onZoneSelect });

    fireEvent.click(screen.getByTestId(`widget-zone-${CELL_B}`));

    expect(onZoneSelect).toHaveBeenCalledWith(CELL_B);
  });

  it("классы плотности считаются по той же шкале, что красит карту", () => {
    renderWidgets();

    const classes = screen.getByTestId("widget-classes");

    // Подписи совпадают с легендой: «до 5», «более 5» — один и тот же класс на карте и в списке
    expect(classes.textContent).toContain("до 5");
    expect(classes.textContent).toContain("более 5");
    expect(classes.textContent).toContain("1");
  });

  it("клик по классу подсвечивает его, повторный — снимает", () => {
    const onClassSelect = vi.fn();
    const { rerender } = renderWidgets({ onClassSelect });

    fireEvent.click(screen.getByTestId("widget-class-0"));
    expect(onClassSelect).toHaveBeenCalledWith(0);

    rerender(
      <CellWidgets
        grid={GRID}
        column={column([17.1, 4.2, 0])}
        activeClass={0}
        onZoneSelect={vi.fn()}
        onClassSelect={onClassSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("widget-class-0"));

    expect(onClassSelect).toHaveBeenLastCalledWith(null);
  });

  it("«пусто» и «нет данных» — разные строки: это не одно и то же", () => {
    renderWidgets({ column: column([17.1, null, 0]) });

    expect(screen.getByTestId("widget-empty").textContent).toContain("пусто");
    expect(screen.getByTestId("widget-unknown").textContent).toContain("нет данных");
  });

  it("говорит, что это наблюдения, а не вердикт", () => {
    renderWidgets();

    expect(screen.getByTestId("cell-widgets").textContent).toContain("Наблюдения по данным OSM");
    expect(document.body.textContent).not.toContain("перегрев");
  });

  it("закрывается крестиком", () => {
    const onClose = vi.fn();
    renderWidgets({ onClose });

    fireEvent.click(screen.getByTestId("widgets-close"));

    expect(onClose).toHaveBeenCalled();
  });
});
