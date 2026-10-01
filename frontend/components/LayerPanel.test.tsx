import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import LayerPanel from "./LayerPanel";
import type { LayerGrid, LayerMeta, LayerObjectsResponse } from "@/lib/api";

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
  layer({
    slug: "population",
    name: "Население",
    metric_kind: "people_density",
    unit: "чел/км²",
    can_be_base: true,
    source: OSM,
  }),
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

function renderPanel(overrides: Partial<React.ComponentProps<typeof LayerPanel>> = {}) {
  const props = {
    layers: LAYERS,
    base: LAYERS[0],
    active: [] as { slug: string; category: string | null }[],
    grid: GRID,
    categoryName: "Кофейни и кафе",
    objectsSlug: null,
    objectsData: null,
    onToggle: vi.fn(),
    onToggleObjects: vi.fn(),
    ...overrides,
  };

  render(<LayerPanel {...props} />);
  return props;
}

describe("LayerPanel", () => {
  it("не показывает основу карты отдельным блоком: её называют панель сцены и легенда", () => {
    renderPanel();

    // Смена основы меняла бы главный ответ приложения, поэтому такой возможности в интерфейсе нет
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByTestId("base-population")).toBeNull();

    // Блок «Основа карты» убран: он повторял селект вкладки и название слоя в легенде
    expect(screen.queryByTestId("layer-base")).toBeNull();
    expect(screen.queryByText(/Основа карты/)).toBeNull();
  });

  it("не предлагает основу как дополнительный слой: она уже на карте", () => {
    renderPanel();

    expect(screen.queryByTestId("layer-competitors")).toBeNull();
    expect(screen.getByTestId("layer-transport")).toBeTruthy();
  });

  it("включает слой его первым вариантом", () => {
    const props = renderPanel();

    fireEvent.click(screen.getByTestId("layer-transport"));

    expect(props.onToggle).toHaveBeenCalledWith({ slug: "transport", category: null });
  });

  it("выключённый слой не подписывает метрикой, включённый — подписывает", () => {
    const props = renderPanel();

    expect(screen.queryByText(/чел\/км²/)).toBeNull();

    props.active.push({ slug: "population", category: null });
    fireEvent.click(screen.getByTestId("layer-transport"));

    expect(props.onToggle).toHaveBeenCalled();
  });

  it("под включённым слоем пишет метрику и честно говорит, если данных ещё нет", () => {
    renderPanel({
      active: [
        { slug: "population", category: null },
        { slug: "transport", category: null },
      ],
    });

    // Транспорта в этой сетке нет: обещать его числа нельзя
    expect(screen.getByText(/данные ещё собираются/)).toBeTruthy();
    expect(screen.getAllByText(/чел\/км²/).length).toBeGreaterThan(0);
  });

  it("объясняет, что слои дают числа в карточке зоны, а «на карте» — объекты", () => {
    renderPanel();

    expect(screen.getByText(/Числа слоя — в карточке зоны/)).toBeTruthy();
    expect(screen.getByText(/«На карте» — объекты слоя/)).toBeTruthy();
  });

  it("показывает покрытие слоя и называет источник данных одной строкой", () => {
    renderPanel({ active: [{ slug: "population", category: null }] });

    const sources = within(screen.getByTestId("layer-sources"));

    expect(sources.getByText("Население")).toBeTruthy();
    expect(sources.getByText("собрано по 1200 из 1507 ячеек")).toBeTruthy();
    // Атрибуция — общей строкой: построчно она дублировала подпись под картой
    expect(sources.getAllByText(/Данные слоёв: © OpenStreetMap contributors \(ODbL\)/).length).toBe(1);
  });

  it("на мобильном свёрнута в кнопку", () => {
    renderPanel();

    const toggle = screen.getByRole("button", { name: /Слои/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".layers")?.classList.contains("layers--collapsed")).toBe(true);

    fireEvent.click(toggle);

    expect(document.querySelector(".layers")?.classList.contains("layers--expanded")).toBe(true);
  });

  it("переключатель «на карте» подсвечивает один слой и честно говорит, сколько объектов видно", () => {
    const onToggleObjects = vi.fn();
    renderPanel({
      onToggleObjects,
      objectsSlug: "transport",
      objectsData: {
        type: "LayerObjects",
        features: [],
        meta: {
          layer: "transport",
          layer_name: "Транспорт",
          bbox: "84.9,56.4,85.0,56.5",
          limit: 2000,
          total: 2500,
          returned: 2000,
          truncated: true,
          data_version: "2026-09-27",
          updated_at: null,
        },
        sources: [],
      } as LayerObjectsResponse,
    });

    // Активный слой помечен, а «показаны не все» видно прямо в панели
    expect(screen.getByTestId("layer-map-transport").getAttribute("aria-pressed")).toBe("true");
    const note = screen.getByTestId("layer-objects-note");
    expect(note.textContent).toContain("2000");
    expect(note.textContent).toContain("из 2500");

    // Переключение на другой слой — один слой за раз (план §6)
    fireEvent.click(screen.getByTestId("layer-map-pedestrian"));
    expect(onToggleObjects).toHaveBeenCalledWith("pedestrian");
  });
});