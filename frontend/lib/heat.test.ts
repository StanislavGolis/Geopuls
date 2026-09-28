import { describe, expect, it } from "vitest";

import {
  EMPTY_CELL_STROKE,
  HEAT_RAMP,
  SELECTED_CELL_COLOR,
  ZERO_COLOR,
  formatDensity,
  heatColorExpression,
  heatColors,
  heatFillOpacityExpression,
  heatOutlineColorExpression,
  legendItems,
  rampIndexes,
  resolutionForZoom,
} from "./heat";

const BREAKS = [0, 25.6, 42.7, 59.8, 76.9];
const BREAKS_6 = [0, 12, 24, 36, 48, 60, 76.9];

describe("палитра", () => {
  it("шесть ступеней рэмпа YlOrRd по возрастанию насыщенности", () => {
    expect(HEAT_RAMP).toHaveLength(6);
    expect(HEAT_RAMP[0]).toBe("#FEF3C7");
    expect(HEAT_RAMP[5]).toBe("#B91C1C");
  });

  it("для 4 классов берём ступени, согласованные с дизайн-спекой", () => {
    expect(rampIndexes(4)).toEqual([0, 2, 3, 4]);
    expect(heatColors(4)).toEqual(["#FEF3C7", "#FCD34D", "#F59E0B", "#EA580C"]);
  });

  it("для 6 классов используем весь рэмп", () => {
    expect(heatColors(6)).toEqual([...HEAT_RAMP]);
  });

  it("на нестандартном числе классов не падает, а распределяет цвета равномерно", () => {
    expect(heatColors(7)).toHaveLength(6);
    expect(heatColors(0)).toHaveLength(1);
    expect(heatColors(1)).toHaveLength(1);
  });

  it("обводка пустых ячеек и выбранной ячейки — смысловые цвета, не белые", () => {
    expect(EMPTY_CELL_STROKE).toBe("#7C8794");
    expect(SELECTED_CELL_COLOR).toBe("#2563EB");
    expect(ZERO_COLOR).toBe("#E6EAEF");
  });
});

describe("legendItems", () => {
  it("строит нулевой класс и четыре интервала по границам из API", () => {
    const items = legendItems(BREAKS);

    expect(items).toHaveLength(5);
    expect(items[0].color).toBe(ZERO_COLOR);
    expect(items[0].label).toBe("0");
    expect(items[0].note).toBe("пусто");
    expect(items[1].label).toBe("до 25.6");
    expect(items[2].label).toBe("25.6 – 42.7");
    expect(items[3].label).toBe("42.7 – 59.8");
    expect(items[4].label).toBe("более 59.8");
    expect(items[4].note).toBe("высокая");
    expect(items.map((item) => item.color)).toEqual([ZERO_COLOR, ...heatColors(4)]);
  });

  it("работает с шкалой из шести классов: число цветов следует за числом границ", () => {
    const items = legendItems(BREAKS_6);

    expect(items).toHaveLength(7);
    expect(items[1].label).toBe("до 12");
    expect(items[3].label).toBe("24 – 36");
    expect(items[6].label).toBe("более 60");
    expect(items.map((item) => item.color)).toEqual([ZERO_COLOR, ...heatColors(6)]);
  });

  it("границы классов берутся из ответа API, а не выдумываются", () => {
    const items = legendItems([0, 8.5, 17.1, 25.6, 85.4]);

    expect(items[1].label).toBe("до 8.5");
    expect(items[4].label).toBe("более 25.6");
  });

  it("без данных показывает только нулевой класс", () => {
    expect(legendItems(null)).toHaveLength(1);
    expect(legendItems(undefined)).toHaveLength(1);
    expect(legendItems([0])).toHaveLength(1);
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
    const [, , , step] = expression as [string, unknown, string, unknown[]];

    expect(step[0]).toBe("step");
    expect(step[1]).toEqual(["get", "density"]);
    expect(step[2]).toBe(heatColors(4)[0]);
    expect(step[3]).toBe(25.6);
    expect(step[4]).toBe(heatColors(4)[1]);
    expect(step[step.length - 1]).toBe(heatColors(4)[3]);
  });

  it("без границ классов отдаёт цвет пустой ячейки, а не мусорное выражение", () => {
    expect(heatColorExpression(null)).toBe(ZERO_COLOR);
    expect(heatColorExpression([0])).toBe(ZERO_COLOR);
  });
});

describe("правила отрисовки ячеек", () => {
  it("пустые ячейки рисуются плотно, непустые — полупрозрачно", () => {
    expect(heatFillOpacityExpression()).toEqual(["case", ["==", ["get", "count"], 0], 1, 0.75]);
  });

  it("смысл пустой ячейки несёт обводка, а не заливка", () => {
    expect(heatOutlineColorExpression()).toEqual([
      "case",
      ["==", ["get", "count"], 0],
      EMPTY_CELL_STROKE,
      "rgba(255, 255, 255, 0.45)",
    ]);
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
