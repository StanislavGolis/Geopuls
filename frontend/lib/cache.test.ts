import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CellsResponse } from "./api";
import { cellsCacheKey, clearCells, loadCells, saveCells } from "./cache";

function payload(): CellsResponse {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "890b80db643ffff",
        properties: { h3: "890b80db643ffff", count: 2, density: 17.1, has_address_ratio: 0.5 },
        geometry: { type: "Polygon", coordinates: [[[85, 56.5], [85.01, 56.5], [85, 56.5]]] },
      },
    ],
    meta: {
      city: "tomsk",
      category: "cafe",
      res: 9,
      data_version: "2026-09-27",
      updated_at: null,
      cell_count: 1,
      non_empty_count: 1,
      poi_count: 2,
      max_density: 17.1,
      density_breaks: [0, 5, 10, 15, 17.1],
      bbox_filter: null,
    },
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("кэш последнего ответа", () => {
  it("ключ зависит от города, категории и разрешения", () => {
    expect(cellsCacheKey("tomsk", "cafe", 9)).toBe("geopuls.cells:tomsk:cafe:9");
    expect(cellsCacheKey("tomsk", "bar", 8)).not.toBe(cellsCacheKey("tomsk", "cafe", 8));
  });

  it("сохраняет и читает ответ", () => {
    const key = cellsCacheKey("tomsk", "cafe", 9);
    saveCells(key, payload());

    const restored = loadCells(key);

    expect(restored?.features).toHaveLength(1);
    expect(restored?.meta.data_version).toBe("2026-09-27");
  });

  it("без записи возвращает null", () => {
    expect(loadCells(cellsCacheKey("tomsk", "cafe", 9))).toBeNull();
  });

  it("битый JSON и чужие данные трактуются как отсутствие кэша", () => {
    const key = cellsCacheKey("tomsk", "cafe", 9);

    window.sessionStorage.setItem(key, "{не json");
    expect(loadCells(key)).toBeNull();

    window.sessionStorage.setItem(key, JSON.stringify({ items: [] }));
    expect(loadCells(key)).toBeNull();
  });

  it("удаление очищает запись", () => {
    const key = cellsCacheKey("tomsk", "cafe", 9);
    saveCells(key, payload());
    clearCells(key);

    expect(loadCells(key)).toBeNull();
  });

  it("не падает, если хранилище недоступно (приватный режим)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => saveCells("key", payload())).not.toThrow();
    expect(loadCells("key")).toBeNull();
    expect(() => clearCells("key")).not.toThrow();

    setItem.mockRestore();
    getItem.mockRestore();
  });
});
