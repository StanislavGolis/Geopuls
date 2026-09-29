import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LayerGrid } from "./api";
import { clearGrid, gridCacheKey, loadGrid, saveGrid } from "./cache";

function payload(): LayerGrid {
  return {
    type: "LayerGrid",
    cells: {
      h3: ["890b80db643ffff"],
      geometry: [
        [
          [85, 56.5],
          [85.01, 56.5],
          [85, 56.5],
        ],
      ],
    },
    layers: [
      {
        slug: "competitors",
        name: "Конкуренты (объекты по категориям)",
        category: "cafe",
        role: "base",
        metric_kind: "density",
        unit: "POI/км²",
        scale: "quantile",
        color: "#1f6fb2",
        values: [17.14],
        extras: { count: [2] },
        covered_count: 1,
        non_empty_count: 1,
        total_value: 17.14,
        max_value: 17.14,
        breaks: [0, 5, 10, 17.14],
        source: null,
      },
    ],
    meta: {
      city: "tomsk",
      res: 9,
      cell_count: 1,
      base: "competitors:cafe",
      overlays: [],
      data_version: "2026-09-27",
      updated_at: null,
      bbox_filter: null,
      sources: [],
    },
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("кэш последнего ответа", () => {
  it("ключ зависит от города, разрешения и набора слоёв", () => {
    expect(gridCacheKey("tomsk", "competitors:cafe", "", 9)).toBe(
      "geopuls.grid:tomsk:9:competitors:cafe:",
    );
    // Другой состав слоёв — другая сетка: кэш одного вида не должен подменять другой
    expect(gridCacheKey("tomsk", "competitors:cafe", "population", 9)).not.toBe(
      gridCacheKey("tomsk", "competitors:cafe", "", 9),
    );
  });

  it("сохраняет и читает ответ", () => {
    const key = gridCacheKey("tomsk", "competitors:cafe", "", 9);
    saveGrid(key, payload());

    const restored = loadGrid(key);

    expect(restored?.cells.h3).toHaveLength(1);
    expect(restored?.layers[0].values).toEqual([17.14]);
    expect(restored?.meta.data_version).toBe("2026-09-27");
  });

  it("без записи возвращает null", () => {
    expect(loadGrid(gridCacheKey("tomsk", "competitors:cafe", "", 9))).toBeNull();
  });

  it("битый JSON и чужие данные трактуются как отсутствие кэша", () => {
    const key = gridCacheKey("tomsk", "competitors:cafe", "", 9);

    window.sessionStorage.setItem(key, "{не json");
    expect(loadGrid(key)).toBeNull();

    window.sessionStorage.setItem(key, JSON.stringify({ items: [] }));
    expect(loadGrid(key)).toBeNull();
  });

  it("удаление очищает запись", () => {
    const key = gridCacheKey("tomsk", "competitors:cafe", "", 9);
    saveGrid(key, payload());
    clearGrid(key);

    expect(loadGrid(key)).toBeNull();
  });

  it("не падает, если хранилище недоступно (приватный режим)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => saveGrid("key", payload())).not.toThrow();
    expect(loadGrid("key")).toBeNull();
    expect(() => clearGrid("key")).not.toThrow();

    setItem.mockRestore();
    getItem.mockRestore();
  });
});