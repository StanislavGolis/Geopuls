import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import LayerPanel from "./LayerPanel";
import type { LayerGrid, LayerMeta } from "@/lib/api";

const OSM = {
  slug: "osm",
  title: "OpenStreetMap (Geofabrik)",
  license: "ODbL 1.0",
  license_url: null,
  attribution_text: "© OpenStreetMap contributors",
  citation: null,
  source_url: null,
  data_version: "2026-09-27",
};

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
    source: OSM,
  }),
  layer({ slug: "population", name: "Население", metric_kind: "people_density", unit: "чел/км²", can_be_base: true }),
  layer({ slug: "transport", name: "Транспорт", color: "#0f766e" }),
  layer({ slug: "pedestrian", name: "Пешеходные пути", metric_kind: "length", unit: "км" }),
];

function column(slug: string, overrides: Partial<LayerGrid["layers"][number]> = {}) {
  const meta = LAYERS.find((item) => item.slug === slug) as LayerMeta;
  return {
    slug,
    name: meta.name,
    category: null,
    role: "overlay" as const,
    metric_kind: meta.metric_kind,
    unit: meta.unit,
    scale: meta.scale,
    color: meta.color,
    values: [],
    extras: {},
    covered_count: 1507,
    non_empty_count: 0,
    total_value: 0,
    max_value: 0,
    breaks: [0, 25.6],
    source: null,
    ...overrides,
  };
}

const GRID: LayerGrid = {
  type: "LayerGrid",
  cells: { h3: [], geometry: [] },
  layers: [
    column("competitors", { category: "cafe", role: "base", non_empty_count: 130 }),
    // Слой собран не по всей сетке: панель обязана это сказать
    column("population", { covered_count: 1200 }),
  ],
  meta: {
    city: "tomsk",
    res: 9,
    cell_count: 1507,
    base: "competitors:cafe",
    overlays: [],
    data_version: "2026-09-27",
    updated_at: null,
    bbox_filter: null,
    sources: [],
  },
};

const CATEGORY_NAMES = { bar: "Бары и пабы", cafe: "Кофейни и кафе" };

function renderPanel(overrides: Partial<React.ComponentProps<typeof LayerPanel>> = {}) {
  const props = {
    layers: LAYERS,
    base: { slug: "competitors", category: "cafe" },
    overlays: [] as { slug: string; category: string | null }[],
    grid: GRID,
    categoryNames: CATEGORY_NAMES,
    onSelectBase: vi.fn(),
    onToggleOverlay: vi.fn(),
    ...overrides,
  };

  render(<LayerPanel {...props} />);
  return props;
}

describe("LayerPanel", () => {
  it("показывает базовыми только те слои, которыми можно красить карту", () => {
    renderPanel();

    expect(screen.getByTestId("base-competitors")).toBeTruthy();
    expect(screen.getByTestId("base-population")).toBeTruthy();
    // Транспорт и пешеходные пути карту не красят: для них остаётся только наложение
    expect(screen.queryByTestId("base-transport")).toBeNull();
    expect(screen.getByTestId("overlay-transport")).toBeTruthy();
  });

  it("отмечает выбранный базовый слой и даёт сменить его вариант", () => {
    const props = renderPanel();

    expect((screen.getByTestId("base-competitors") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("base-category-competitors")).toBeTruthy();

    fireEvent.change(screen.getByTestId("base-category-competitors"), { target: { value: "bar" } });

    expect(props.onSelectBase).toHaveBeenCalledWith({ slug: "competitors", category: "bar" });
  });

  it("не предлагает базовый слой как собственное наложение", () => {
    renderPanel();

    const baseAsOverlay = screen.getByTestId("overlay-competitors") as HTMLInputElement;
    // Слой нельзя наложить сам на себя: это запрещает и API, и панель
    expect(baseAsOverlay.disabled).toBe(true);
    expect(screen.getByText("уже красит карту")).toBeTruthy();
  });

  it("включает наложение с его первым вариантом", () => {
    const props = renderPanel();

    fireEvent.click(screen.getByTestId("overlay-transport"));

    expect(props.onToggleOverlay).toHaveBeenCalledWith({ slug: "transport", category: null });
  });

  it("у включённого наложения можно сменить вариант", () => {
    const props = renderPanel({ overlays: [{ slug: "competitors", category: "cafe" }] });

    fireEvent.change(screen.getByTestId("overlay-category-competitors"), { target: { value: "bar" } });

    expect(props.onToggleOverlay).toHaveBeenCalledWith({ slug: "competitors", category: "bar" });
  });

  it("при двух наложениях блокирует третье и объясняет почему", () => {
    renderPanel({
      overlays: [
        { slug: "population", category: null },
        { slug: "transport", category: null },
      ],
    });

    // Лимит ADR 0013: третье наложение сделать нечитаемым карту не даём
    expect((screen.getByTestId("overlay-pedestrian") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("сначала снимите другое наложение")).toBeTruthy();
  });

  it("показывает метрику, покрытие и источник каждого активного слоя", () => {
    renderPanel({ overlays: [{ slug: "population", category: null }] });

    // Список слоёв под картой: имя, метрика, покрытие и атрибуция — без них слой выглядит полным
    const sources = within(screen.getByTestId("layer-sources"));

    expect(sources.getByText("Конкуренты (объекты по категориям) · Кофейни и кафе")).toBeTruthy();
    expect(sources.getByText("Население")).toBeTruthy();
    expect(sources.getByText("Плотность, POI/км²")).toBeTruthy();
    expect(sources.getByText("собрано по 1200 из 1507 ячеек")).toBeTruthy();
    expect(sources.getAllByText("© OpenStreetMap contributors").length).toBeGreaterThan(0);
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