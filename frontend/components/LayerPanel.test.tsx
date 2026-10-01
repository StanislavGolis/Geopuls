import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import LayerPanel from "./LayerPanel";
import type { LayerMeta, LayerObjectsResponse } from "@/lib/api";

function layer(overrides: Partial<LayerMeta>): LayerMeta {
  return {
    slug: "layer",
    name: "Слой",
    kind: "osm",
    metric_kind: "count",
    unit: "шт",
    scale: "quantile",
    color: "#334155",
    can_be_base: false,
    categories: [],
    source: null,
    ...overrides,
  };
}

const LAYERS: LayerMeta[] = [
  layer({
    slug: "competitors",
    name: "Конкуренты (объекты по категориям)",
    metric_kind: "density",
    unit: "POI/км²",
    color: "#1f6fb2",
    can_be_base: true,
    categories: ["bar", "cafe"],
  }),
  layer({
    slug: "population",
    name: "Население",
    metric_kind: "people_density",
    unit: "чел/км²",
    color: "#7c3aed",
    can_be_base: true,
  }),
  layer({ slug: "transport_stops", name: "Транспорт: остановки и станции", color: "#0f766e" }),
  layer({ slug: "pedestrian", name: "Пешеходные пути", metric_kind: "length", unit: "км" }),
];

const OBJECTS: LayerObjectsResponse = {
  type: "LayerObjects",
  features: [],
  meta: {
    layer: "transport_stops",
    layer_name: "Транспорт: остановки и станции",
    bbox: "84.9,56.4,85.0,56.5",
    res: 9,
    limit: 2000,
    total: 2500,
    returned: 2000,
    truncated: true,
    data_version: "2026-09-27",
    updated_at: null,
  },
  sources: [],
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof LayerPanel>> = {}) {
  const props = {
    layers: LAYERS,
    base: LAYERS[0],
    objectsSlugs: [] as string[],
    objectsData: {} as Record<string, LayerObjectsResponse | null>,
    onToggleObjects: vi.fn(),
    ...overrides,
  };

  render(<LayerPanel {...props} />);
  return props;
}

describe("LayerPanel", () => {
  it("показывает тумблеры, а не кнопки: слой включается и выключается как переключатель", () => {
    const props = renderPanel();

    const toggle = screen.getByTestId("layer-objects-transport_stops");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(toggle);

    expect(props.onToggleObjects).toHaveBeenCalledWith("transport_stops");
  });

  it("не ограничивает число включённых слоёв: все тумблеры доступны одновременно", () => {
    renderPanel({
      objectsSlugs: ["population", "transport_stops", "pedestrian"],
    });

    // Раньше это был выбор «один слой за раз»: теперь включено может быть сколько угодно
    for (const slug of ["population", "transport_stops", "pedestrian"]) {
      const toggle = screen.getByTestId(`layer-objects-${slug}`) as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      expect(toggle.disabled).toBe(false);
    }
  });

  it("под включённым слоем честно пишет, сколько объектов видно и не все ли это", () => {
    renderPanel({
      objectsSlugs: ["transport_stops"],
      objectsData: { transport_stops: OBJECTS },
    });

    const note = screen.getByTestId("layer-objects-note-transport_stops");

    expect(note.textContent).toContain("2000");
    expect(note.textContent).toContain("из 2500");
    expect(note.textContent).toContain("показаны не все");
  });

  it("не обещает объекты, которых ещё нет: до загрузки пишет «загружаем»", () => {
    renderPanel({ objectsSlugs: ["population"], objectsData: { population: null } });

    expect(screen.getByTestId("layer-objects-note-population").textContent).toContain("загружаем");
  });

  it("под выключенным слоем подписи о числах объектов нет", () => {
    renderPanel({ objectsSlugs: [], objectsData: { transport_stops: OBJECTS } });

    expect(screen.queryByTestId("layer-objects-note-transport_stops")).toBeNull();
  });

  it("не показывает основу карты ни блоком, ни тумблером: её называют вкладка и легенда", () => {
    renderPanel();

    expect(screen.queryByTestId("layer-base")).toBeNull();
    expect(screen.queryByTestId("layer-objects-competitors")).toBeNull();
    expect(screen.getByTestId("layer-objects-transport_stops")).toBeTruthy();
  });

  it("объясняет, что числа слоёв живут в сводке по зоне, а тумблер отвечает за карту", () => {
    renderPanel();

    expect(screen.getByText(/Числа всех слоёв — в сводке по зоне/)).toBeTruthy();
  });

  it("называет источник данных одной строкой: слой без атрибуции показывать нельзя", () => {
    renderPanel();

    const sources = within(screen.getByTestId("layer-sources"));

    expect(sources.getByText(/Данные слоёв: © OpenStreetMap contributors \(ODbL\)/)).toBeTruthy();
  });

  it("на мобильном свёрнута в кнопку", () => {
    renderPanel();

    const toggle = screen.getByRole("button", { name: /Слои/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".layers")?.classList.contains("layers--collapsed")).toBe(true);

    fireEvent.click(toggle);

    expect(document.querySelector(".layers")?.classList.contains("layers--expanded")).toBe(true);
  });
});
