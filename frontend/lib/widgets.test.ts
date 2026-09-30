import { describe, expect, it } from "vitest";

import type { LayerGrid, MapLayerColumn } from "@/lib/api";
import { cellsOfClass, classIndexOf, densityDistribution, topZones } from "./widgets";

/** Колонка слоя: значения и классы, как их отдаёт `/api/v1/map`. */
function column(values: (number | null)[], breaks: number[], counts?: (number | null)[]) {
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
    extras: counts ? { count: counts } : {},
    covered_count: values.length,
    non_empty_count: values.filter((value) => value !== null && value > 0).length,
    total_value: 0,
    max_value: Math.max(...values.map((value) => value ?? 0)),
    breaks,
    source: null,
  } as MapLayerColumn;
}

function grid(values: (number | null)[]) {
  return {
    type: "LayerGrid",
    cells: { h3: values.map((_, index) => `890b80db64${index}ffff`), geometry: [] },
    layers: [],
    meta: {
      city: "tomsk",
      res: 9,
      cell_count: values.length,
      base: "competitors:cafe",
      overlays: [],
      data_version: "2026-09-27",
      updated_at: null,
      bbox_filter: null,
      sources: [],
    },
  } as unknown as LayerGrid;
}

describe("topZones", () => {
  it("ставит в начало зоны с большим значением и отбрасывает пустые", () => {
    const values = [0, 4.2, null, 17.1, 8.5];
    const rows = topZones(grid(values), column(values, [0, 5, 10, 20]), 3);

    expect(rows.map((row) => row.value)).toEqual([17.1, 8.5, 4.2]);
    expect(rows[0]?.h3).toBe("890b80db643ffff");
    // Пустые и «нет данных» в списке лидеров не участвуют
    expect(rows.some((row) => row.value <= 0)).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("показывает число объектов зоны, если слой его считает", () => {
    const values = [12.0, 3.0];
    const rows = topZones(grid(values), column(values, [0, 5, 20], [7, 2]));

    expect(rows[0]?.count).toBe(7);
    // Нет данных о числе объектов — честный null, а не ноль
    expect(topZones(grid([12.0]), column([12.0], [0, 20]))[0]?.count).toBeNull();
  });

  it("не больше запрошенного числа зон", () => {
    const values = [1, 2, 3, 4, 5, 6];
    expect(topZones(grid(values), column(values, [0, 7]), 5)).toHaveLength(5);
  });
});

describe("classIndexOf", () => {
  const breaks = [0, 5, 10, 20];

  it("распределяет значения по интервалам, включая верхнюю границу", () => {
    expect(classIndexOf(1, breaks)).toBe(0);
    expect(classIndexOf(5, breaks)).toBe(1);
    expect(classIndexOf(9.9, breaks)).toBe(1);
    expect(classIndexOf(10, breaks)).toBe(2);
    expect(classIndexOf(20, breaks)).toBe(2);
  });
});

describe("densityDistribution", () => {
  it("считает зоны по классам и отдельно пустые и без данных", () => {
    const values = [0, 0, 3, 12, 18, null];
    const distribution = densityDistribution(grid(values), column(values, [0, 5, 10, 20]));

    expect(distribution.total).toBe(6);
    expect(distribution.empty).toBe(2);
    expect(distribution.unknown).toBe(1);
    // 3 попадает в класс [0; 5), а 12 и 18 — в [10; 20): средний класс пуст, и это видно
    expect(distribution.classes.map((item) => item.count)).toEqual([1, 0, 2]);
    expect(distribution.classes[0]).toMatchObject({ from: 0, to: 5 });
  });

  it("без классов возвращает только счётчики: объяснять нечего", () => {
    const values = [0, 3];
    const distribution = densityDistribution(grid(values), column(values, []));

    expect(distribution.classes).toEqual([]);
    expect(distribution.empty).toBe(1);
  });
});

describe("cellsOfClass", () => {
  it("возвращает зоны класса — их подсвечиваем контуром", () => {
    const values = [0, 3, 12, 18];
    const cells = cellsOfClass(grid(values), column(values, [0, 5, 10, 20]), 2);

    expect(cells).toEqual(["890b80db642ffff", "890b80db643ffff"]);
  });

  it("пустой класс не подсвечивает ничего", () => {
    const values = [0, 3];
    expect(cellsOfClass(grid(values), column(values, [0, 5, 10, 20]), 2)).toEqual([]);
  });
});
