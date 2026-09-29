import { describe, expect, it } from "vitest";

import type { LayerGrid, MapLayerColumn } from "./api";
import {
  buildCsvComment,
  buildExportFooter,
  buildGridCsv,
  columnName,
  exportFileName,
  extraKeys,
  layerDescription,
  ringCenter,
} from "./export";

const RING = [
  [85.0, 56.5],
  [85.01, 56.5],
  [85.015, 56.49],
  [85.01, 56.48],
  [85.0, 56.48],
  [84.995, 56.49],
  [85.0, 56.5],
];

const CAFE: MapLayerColumn = {
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
  breaks: [0, 5, 10, 17.14],
  source: null,
};

const POPULATION: MapLayerColumn = {
  slug: "population",
  name: "Население",
  category: null,
  role: "overlay",
  metric_kind: "people_density",
  unit: "чел/км²",
  scale: "quantile",
  color: "#334155",
  // Второй ячейки у слоя нет вовсе: в CSV это пустое поле, а не ноль
  values: [1200, null],
  extras: {},
  covered_count: 1,
  non_empty_count: 1,
  total_value: 1200,
  max_value: 1200,
  breaks: [0, 500, 1200],
  source: null,
};

function grid(columns: MapLayerColumn[] = [CAFE], h3: string[] = ["890b80db643ffff", "890b80db643fffe"]): LayerGrid {
  return {
    type: "LayerGrid",
    cells: { h3, geometry: h3.map(() => RING) },
    layers: columns,
    meta: {
      city: "tomsk",
      res: 9,
      cell_count: h3.length,
      base: "competitors:cafe",
      overlays: ["population"],
      data_version: "2026-09-27",
      updated_at: null,
      bbox_filter: null,
      sources: [],
    },
  };
}

const CONTEXT = {
  cityName: "Томск",
  res: 9,
  layers: [
    {
      slug: "competitors",
      name: "Конкуренты (объекты по категориям)",
      category: "cafe",
      categoryName: "Кофейни и кафе",
      role: "base" as const,
      unit: "POI/км²",
    },
    {
      slug: "population",
      name: "Население",
      category: null,
      categoryName: null,
      role: "overlay" as const,
      unit: "чел/км²",
    },
  ],
  dataVersion: "2026-09-27",
};

describe("ringCenter", () => {
  it("считает центр шестиугольника по уникальным вершинам кольца", () => {
    const center = ringCenter(RING);

    expect(center.lat).toBeCloseTo(56.49, 6);
    expect(center.lon).toBeCloseTo(85.005, 6);
  });

  it("не падает на пустой геометрии", () => {
    expect(ringCenter([])).toEqual({ lat: 0, lon: 0 });
  });
});

describe("имена колонок", () => {
  it("складывает слой, вариант и показатель: в файле видно, что с чем связано", () => {
    expect(columnName(CAFE, "value")).toBe("competitors_cafe_value");
    expect(columnName(CAFE, "count")).toBe("competitors_cafe_count");
    expect(columnName(POPULATION, "value")).toBe("population_value");
  });

  it("дополнительные показатели собираются по всем слоям", () => {
    expect(extraKeys([CAFE, POPULATION])).toEqual(["count"]);
  });
});

describe("buildGridCsv", () => {
  it("начинается строкой-комментарием с составом слоёв, затем заголовок, строки и BOM", () => {
    const csv = buildGridCsv(grid([CAFE, POPULATION]), CONTEXT);
    const [comment, header, first, second] = csv.replace("\uFEFF", "").split("\n");

    // Требование ODbL: атрибуция в экспорте, а не только на экране
    expect(comment).toContain("OpenStreetMap contributors");
    expect(comment).toContain("Томск");
    expect(comment).toContain("res 9");
    expect(comment).toContain("2026-09-27");
    expect(comment).toContain("базовый");
    expect(comment).toContain("наложение");

    expect(header).toBe("h3,competitors_cafe_value,population_value,competitors_cafe_count,lat,lon");
    expect(first.split(",")).toEqual(["890b80db643ffff", "17.14", "1200", "2", "56.490000", "85.005000"]);
    // Пустая ячейка базового слоя выгружается нулём, а «нет данных» наложения — пустым полем
    expect(second.split(",")).toEqual(["890b80db643fffe", "0", "", "0", "56.490000", "85.005000"]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
  });

  it("экранирует значения с разделителями и кавычками", () => {
    const csv = buildGridCsv(grid([CAFE], ['A"B,C']), CONTEXT);
    const row = csv.replace("\uFEFF", "").split("\n")[2];

    expect(row.startsWith('"A""B,C",')).toBe(true);
  });

  it("на пустой сетке отдаёт комментарий и заголовок", () => {
    const lines = buildGridCsv(grid([CAFE], []), CONTEXT).replace("\uFEFF", "").trimEnd().split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("h3,competitors_cafe_value,competitors_cafe_count,lat,lon");
  });
});

describe("layerDescription", () => {
  it("называет слой, вариант и роль: файл должен объяснять себя без интерфейса", () => {
    expect(layerDescription(CONTEXT.layers[0])).toBe(
      "Конкуренты (объекты по категориям) · Кофейни и кафе (базовый, POI/км²)",
    );
    expect(layerDescription(CONTEXT.layers[1])).toBe("Население (наложение, чел/км²)");
  });
});

describe("buildCsvComment", () => {
  it("указывает источник, город, сетку, слои и версию выгрузки", () => {
    const comment = buildCsvComment(CONTEXT);

    expect(comment.startsWith("# ")).toBe(true);
    expect(comment).toContain("ГЕОПУЛЬС");
    expect(comment).toContain("Томск");
    expect(comment).toContain("слои:");
    expect(comment).toContain("Кофейни и кафе");
    expect(comment).toContain("res 9");
    expect(comment).toContain("OpenStreetMap contributors");
    expect(comment).toContain("выгрузка 2026-09-27");
  });

  it("без версии данных не выдумывает её", () => {
    const comment = buildCsvComment({ ...CONTEXT, dataVersion: null });

    expect(comment).not.toContain("выгрузка");
    expect(comment).toContain("OpenStreetMap contributors");
  });
});

describe("exportFileName", () => {
  it("собирает понятное имя файла с городом и разрешением", () => {
    expect(exportFileName({ ...CONTEXT, res: 9 }, "csv")).toBe("geopuls-томск-res9.csv");
    expect(exportFileName({ ...CONTEXT, res: 9 }, "png")).toBe("geopuls-томск-res9.png");
  });
});

describe("buildExportFooter", () => {
  it("подпись содержит состав слоёв, атрибуцию и версию данных: экспорт без источника недопустим", () => {
    const lines = buildExportFooter(CONTEXT);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Томск");
    expect(lines[0]).toContain("res 9");
    expect(lines[1]).toContain("базовый");
    expect(lines[1]).toContain("наложение");
    expect(lines[2]).toContain("OpenStreetMap");
    expect(lines[2]).toContain("2026-09-27");
    expect(lines[3]).toContain("OpenFreeMap");
  });

  it("без версии данных подпись остаётся корректной", () => {
    const lines = buildExportFooter({ ...CONTEXT, dataVersion: null });

    expect(lines[2]).not.toContain("выгрузка");
  });
});