import { describe, expect, it } from "vitest";

import type { CellFeature, CellsResponse } from "./api";
import {
  CSV_HEADER,
  buildCellsCsv,
  buildExportFooter,
  cellCenter,
  exportFileName,
} from "./export";

function cell(overrides: Partial<CellFeature["properties"]> = {}, coordinates?: number[][]): CellFeature {
  return {
    type: "Feature",
    id: overrides.h3 ?? "890b80db643ffff",
    properties: {
      h3: "890b80db643ffff",
      count: 2,
      density: 17.14,
      has_address_ratio: 0.5,
      ...overrides,
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        coordinates ?? [
          [85.0, 56.5],
          [85.01, 56.5],
          [85.015, 56.49],
          [85.01, 56.48],
          [85.0, 56.48],
          [84.995, 56.49],
          [85.0, 56.5],
        ],
      ],
    },
  };
}

function response(features: CellFeature[]): CellsResponse {
  return {
    type: "FeatureCollection",
    features,
    meta: {
      city: "tomsk",
      category: "cafe",
      res: 9,
      data_version: "2026-09-27",
      updated_at: null,
      cell_count: features.length,
      non_empty_count: features.filter((item) => item.properties.count > 0).length,
      poi_count: 2,
      max_density: 17.14,
      density_breaks: [0, 1, 2, 3, 17.14],
      bbox_filter: null,
    },
  };
}

describe("cellCenter", () => {
  it("считает центр шестиугольника по уникальным вершинам кольца", () => {
    const center = cellCenter(cell());

    expect(center.lat).toBeCloseTo(56.49, 6);
    expect(center.lon).toBeCloseTo(85.005, 6);
  });

  it("не падает на пустой геометрии", () => {
    expect(cellCenter(cell({}, []))).toEqual({ lat: 0, lon: 0 });
  });
});

describe("buildCellsCsv", () => {
  it("пишет заголовок, строки и BOM для Excel", () => {
    const csv = buildCellsCsv(response([cell()]));
    const [header, row] = csv.replace("\uFEFF", "").split("\n");

    expect(header).toBe(CSV_HEADER);
    expect(row.split(",")).toEqual(["890b80db643ffff", "2", "17.1", "0.5", "56.490000", "85.005000"]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
  });

  it("пустые ячейки тоже выгружаются — это и есть «пустые зоны»", () => {
    const csv = buildCellsCsv(
      response([cell({ count: 0, density: 0, has_address_ratio: null }, [[85, 56.5], [85.01, 56.5], [85, 56.5]])]),
    );
    const row = csv.replace("\uFEFF", "").split("\n")[1];

    expect(row.split(",")).toEqual(["890b80db643ffff", "0", "0", "", "56.500000", "85.005000"]);
  });

  it("экранирует значения с разделителями и кавычками", () => {
    const csv = buildCellsCsv(response([cell({ h3: 'A"B,C' })]));
    const row = csv.replace("\uFEFF", "").split("\n")[1];

    expect(row.startsWith('"A""B,C",2,')).toBe(true);
  });

  it("на пустой коллекции отдаёт только заголовок", () => {
    const lines = buildCellsCsv(response([])).replace("\uFEFF", "").trimEnd().split("\n");

    expect(lines).toEqual([CSV_HEADER]);
  });
});

describe("exportFileName", () => {
  it("собирает понятное имя файла с городом и разрешением", () => {
    const context = { cityName: "Томск", categoryName: "Кофейни и кафе", res: 9 };

    expect(exportFileName(context, "csv")).toBe("geopuls-томск-res9.csv");
    expect(exportFileName(context, "png")).toBe("geopuls-томск-res9.png");
  });
});

describe("buildExportFooter", () => {
  it("подпись содержит атрибуцию и версию данных: экспорт без источника недопустим", () => {
    const lines = buildExportFooter({
      cityName: "Томск",
      categoryName: "Кофейни и кафе",
      res: 9,
      dataVersion: "2026-09-27",
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Томск");
    expect(lines[0]).toContain("res 9");
    expect(lines[1]).toContain("OpenStreetMap");
    expect(lines[1]).toContain("2026-09-27");
    expect(lines[2]).toContain("OpenFreeMap");
  });

  it("без версии данных подпись остаётся корректной", () => {
    const lines = buildExportFooter({ cityName: "Томск", categoryName: "Кафе", res: 8 });

    expect(lines[1]).not.toContain("выгрузка");
  });
});
