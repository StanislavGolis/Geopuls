import { describe, expect, it } from "vitest";

import type { LayerGrid, LayerMeta, MapLayerColumn } from "./api";
import {
  MAX_OVERLAYS,
  baseColumn,
  buildCellFeatures,
  formatLayerValue,
  isPartiallyCovered,
  layerLegend,
  metricLabel,
  overlayColumns,
  overlayProperty,
  parseLayerList,
  parseLayerRef,
  resolveBaseLayer,
  sameLayerRef,
  serializeLayerList,
  serializeLayerRef,
  sumExtras,
} from "./layers";

describe("ссылки на слой", () => {
  it("разбирает слой с вариантом и без", () => {
    expect(parseLayerRef("competitors:cafe")).toEqual({ slug: "competitors", category: "cafe" });
    expect(parseLayerRef("population")).toEqual({ slug: "population", category: null });
    expect(parseLayerRef(" competitors:cafe ")).toEqual({ slug: "competitors", category: "cafe" });
  });

  it("игнорирует мусор вместо того, чтобы ронять карту", () => {
    expect(parseLayerRef("")).toBeNull();
    expect(parseLayerRef(null)).toBeNull();
    expect(parseLayerRef("Competitors!")).toBeNull();
    expect(parseLayerRef("competitors:cafe:bar")).toBeNull();
    expect(parseLayerRef("competitors:Кафе")).toBeNull();
  });

  it("собирает ссылку обратно", () => {
    expect(serializeLayerRef({ slug: "competitors", category: "cafe" })).toBe("competitors:cafe");
    expect(serializeLayerRef({ slug: "population", category: null })).toBe("population");
    expect(sameLayerRef({ slug: "a", category: null }, { slug: "a", category: null })).toBe(true);
    expect(sameLayerRef({ slug: "a", category: null }, { slug: "a", category: "cafe" })).toBe(false);
  });

  it("в наложениях отбрасывает повторы и лишние слои", () => {
    expect(parseLayerList("population,transport")).toEqual([
      { slug: "population", category: null },
      { slug: "transport", category: null },
    ]);
    expect(parseLayerList("population,population")).toHaveLength(1);
    expect(parseLayerList("population,transport,pedestrian")).toHaveLength(MAX_OVERLAYS);
    expect(parseLayerList(",,population,")).toEqual([{ slug: "population", category: null }]);
    expect(parseLayerList(null)).toEqual([]);
  });

  it("пишет список наложений строкой — в том же виде, что понимает API", () => {
    expect(
      serializeLayerList([
        { slug: "population", category: null },
        { slug: "competitors", category: "bar" },
      ]),
    ).toBe("population,competitors:bar");
  });
});

function column(overrides: Partial<MapLayerColumn> = {}): MapLayerColumn {
  return {
    slug: "competitors",
    name: "Конкуренты (объекты по категориям)",
    category: "cafe",
    role: "base",
    metric_kind: "density",
    unit: "POI/км²",
    scale: "quantile",
    color: "#1f6fb2",
    values: [17.14, 0],
    extras: { count: [2, 0] },
    covered_count: 2,
    non_empty_count: 1,
    total_value: 17.14,
    max_value: 17.14,
    breaks: [0, 5, 17.14],
    source: null,
    ...overrides,
  };
}

const RING = [
  [85.02, 56.51],
  [85.03, 56.51],
  [85.02, 56.51],
];

function grid(columns: MapLayerColumn[]): LayerGrid {
  return {
    type: "LayerGrid",
    cells: { h3: ["890b80db643ffff", "890b80db643fffe"], geometry: [RING, RING] },
    layers: columns,
    meta: {
      city: "tomsk",
      res: 9,
      cell_count: 2,
      base: "competitors:cafe",
      overlays: ["population"],
      data_version: "2026-09-27",
      updated_at: null,
      bbox_filter: null,
      sources: [],
    },
  };
}

describe("колонки слоёв", () => {
  const POPULATION = column({
    slug: "population",
    name: "Население",
    category: null,
    role: "overlay",
    metric_kind: "people_density",
    unit: "чел/км²",
    values: [1200, null],
    extras: {},
    // Второй ячейки у слоя нет: это «нет данных», а не ноль
    covered_count: 1,
  });

  it("различает базовый слой и наложения", () => {
    const data = grid([column(), POPULATION]);

    expect(baseColumn(data)?.slug).toBe("competitors");
    expect(overlayColumns(data).map((item) => item.slug)).toEqual(["population"]);
    expect(baseColumn(grid([]))).toBeNull();
  });

  it("собирает одну коллекцию ячеек со значениями всех слоёв", () => {
    const features = buildCellFeatures(grid([column(), POPULATION]), column());

    expect(features.features).toHaveLength(2);
    expect(features.features[0].id).toBe("890b80db643ffff");
    expect(features.features[0].properties).toEqual({
      h3: "890b80db643ffff",
      value: 17.14,
      count: 2,
      layer_population: 1200,
    });
    // Одна копия геометрии на карту: кольцо одно и то же у всех слоёв
    expect(features.features[0].geometry.coordinates).toEqual([RING]);
    // «Нет данных» наложения остаётся null: ноль означал бы «населения нет»
    expect(features.features[1].properties.layer_population).toBeNull();
  });

  it("без данных базового слоя ячейки пустые, а не выдуманные", () => {
    const features = buildCellFeatures(grid([POPULATION]), null);

    expect(features.features[0].properties.value).toBe(0);
    expect(features.features[0].properties.count).toBeNull();
  });

  it("имя свойства наложения безопасно для выражений MapLibre", () => {
    expect(overlayProperty("population")).toBe("layer_population");
    expect(overlayProperty("poi-transport")).toBe("layer_poi_transport");
  });

  it("видит, что слой собран не по всей сетке", () => {
    expect(isPartiallyCovered(POPULATION, 2)).toBe(true);
    expect(isPartiallyCovered(column(), 2)).toBe(false);
    expect(isPartiallyCovered(column(), 0)).toBe(false);
  });

  it("считает число объектов и собирает данные для легенды", () => {
    expect(sumExtras(column(), "count")).toBe(2);
    expect(sumExtras(POPULATION, "count")).toBeNull();

    expect(layerLegend(column())).toEqual({
      name: "Конкуренты (объекты по категориям)",
      metricKind: "density",
      unit: "POI/км²",
      breaks: [0, 5, 17.14],
      objectCount: 2,
    });
  });
});

describe("подписи значений", () => {
  it("подписывает тип метрики словами: шкалу нельзя прочитать неверно", () => {
    expect(metricLabel("density")).toBe("Плотность");
    expect(metricLabel("area_share")).toBe("Доля площади");
    expect(metricLabel("unknown-kind")).toBe("Значение");
  });

  it("округляет значение и добавляет единицу измерения", () => {
    expect(formatLayerValue(17.14, "POI/км²")).toBe("17.1 POI/км²");
    expect(formatLayerValue(60, "чел/км²")).toBe("60 чел/км²");
    expect(formatLayerValue(0, null)).toBe("0");
    expect(formatLayerValue(null, "шт")).toBe("нет данных");
  });
});

describe("resolveBaseLayer", () => {
  const registry: LayerMeta[] = [
    {
      slug: "competitors",
      name: "Конкуренты",
      kind: "osm",
      metric_kind: "density",
      unit: "POI/км²",
      scale: "quantile",
      color: "#1f6fb2",
      can_be_base: true,
      categories: ["bar", "cafe"],
      source: null,
    },
    {
      slug: "transport",
      name: "Транспорт",
      kind: "osm",
      metric_kind: "count",
      unit: "шт",
      scale: "quantile",
      color: "#0f766e",
      can_be_base: false,
      categories: [],
      source: null,
    },
  ];

  it("берёт слой из ссылки", () => {
    expect(resolveBaseLayer(registry, { base: "competitors:bar", category: null })).toEqual({
      slug: "competitors",
      category: "bar",
    });
  });

  it("выводит слой из старого параметра category: ссылки до слоёв обязаны работать", () => {
    expect(resolveBaseLayer(registry, { base: null, category: "cafe" })).toEqual({
      slug: "competitors",
      category: "cafe",
    });
  });

  it("не берёт слой, которого нет в реестре, и не берёт слой, который карту не красит", () => {
    expect(resolveBaseLayer(registry, { base: "nowhere", category: null })).toEqual({
      slug: "competitors",
      category: "bar",
    });
    expect(resolveBaseLayer(registry, { base: "transport", category: null })).toEqual({
      slug: "competitors",
      category: "bar",
    });
  });

  it("предпочитает вариант, по которому есть данные", () => {
    expect(resolveBaseLayer(registry, { base: null, category: null }, "cafe")).toEqual({
      slug: "competitors",
      category: "cafe",
    });
    // Предпочтение учитывается только если вариант есть у этого слоя
    expect(resolveBaseLayer(registry, { base: null, category: null }, "unknown")).toEqual({
      slug: "competitors",
      category: "bar",
    });
  });

  it("на пустом реестре честно возвращает null", () => {
    expect(resolveBaseLayer([], { base: null, category: null })).toBeNull();
  });
});