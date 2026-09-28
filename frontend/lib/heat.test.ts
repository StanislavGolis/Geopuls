import { describe, expect, it } from "vitest";

import {
  HEAT_COLORS,
  ZERO_COLOR,
  formatDensity,
  heatColorExpression,
  legendItems,
  resolutionForZoom,
} from "./heat";

const BREAKS = [0, 25.6, 42.7, 59.8, 76.9];

describe("legendItems", () => {
  it("строит пять классов: нулевой и четыре интервала", () => {
    const items = legendItems(BREAKS);

    expect(items).toHaveLength(5);
    expect(items.map((item) => item.color)).toEqual([...HEAT_COLORS]);
    expect(items[0].color).toBe(ZERO_COLOR);
    expect(items[0].label).toContain("нет размеченных объектов");
    expect(items[1].label).toBe("до 25.6");
    expect(items[2].label).toBe("25.6 – 42.7");
    expect(items[3].label).toBe("42.7 – 59.8");
    expect(items[4].label).toBe("более 59.8");
  });

  it("границы классов берутся из ответа API, а не выдумываются", () => {
    const items = legendItems([0, 8.5, 17.1, 25.6, 85.4]);

    expect(items[1].label).toBe("до 8.5");
    expect(items[4].label).toBe("более 25.6");
  });

  it("без данных показывает только нулевой класс", () => {
    expect(legendItems(null)).toHaveLength(1);
    expect(legendItems(undefined)).toHaveLength(1);
    expect(legendItems([0, 1, 2])).toHaveLength(1);
  });
});

describe("heatColorExpression", () => {
  it("выделяет ячейки без объектов отдельным цветом", () => {
    const expression = heatColorExpression(BREAKS) as unknown[];

    expect(expression[0]).toBe("case");
    expect(expression[1]).toEqual(["==", ["get", "count"], 0]);
    expect(expression[2]).toBe(ZERO_COLOR);
  });

  it("остальные ячейки раскрашиваются ступенями по плотности", () => {
    const expression = heatColorExpression(BREAKS) as unknown[];

    expect(expression[3]).toEqual([
      "step",
      ["get", "density"],
      HEAT_COLORS[1],
      25.6,
      HEAT_COLORS[2],
      42.7,
      HEAT_COLORS[3],
      59.8,
      HEAT_COLORS[4],
    ]);
  });

  it("не падает без границ классов", () => {
    expect(Array.isArray(heatColorExpression(null))).toBe(true);
    expect(Array.isArray(heatColorExpression([0, 0, 0, 0, 0]))).toBe(true);
  });
});

describe("resolutionForZoom", () => {
  it("на обзоре города — res 8, на улицах — res 9", () => {
    expect(resolutionForZoom(9)).toBe(8);
    expect(resolutionForZoom(11.9)).toBe(8);
    expect(resolutionForZoom(12)).toBe(9);
    expect(resolutionForZoom(16)).toBe(9);
  });
});

describe("formatDensity", () => {
  it("округляет до одного знака и не показывает лишний ноль", () => {
    expect(formatDensity(25.64)).toBe("25.6");
    expect(formatDensity(60)).toBe("60");
    expect(formatDensity(0)).toBe("0");
  });
});
