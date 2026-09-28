import { describe, expect, it } from "vitest";

import { formatDataVersion, pluralObjects } from "./format";

describe("pluralObjects", () => {
  it("склоняет слово «объект» по правилам русского языка", () => {
    expect(pluralObjects(1)).toBe("1 объект");
    expect(pluralObjects(2)).toBe("2 объекта");
    expect(pluralObjects(4)).toBe("4 объекта");
    expect(pluralObjects(5)).toBe("5 объектов");
    expect(pluralObjects(12)).toBe("12 объектов");
    expect(pluralObjects(21)).toBe("21 объект");
    expect(pluralObjects(22)).toBe("22 объекта");
    expect(pluralObjects(101)).toBe("101 объект");
    expect(pluralObjects(111)).toBe("111 объектов");
    expect(pluralObjects(0)).toBe("0 объектов");
  });
});

describe("formatDataVersion", () => {
  it("превращает ISO-дату в человеческую", () => {
    expect(formatDataVersion("2026-09-27")).toBe("27.09.2026");
  });

  it("понимает дату с временем и лишними пробелами", () => {
    expect(formatDataVersion(" 2026-09-27T12:39:25Z ")).toBe("27.09.2026");
  });

  it("не угадывает формат: странное значение отдаёт как есть", () => {
    expect(formatDataVersion("27.09.2026")).toBe("27.09.2026");
  });

  it("без значения возвращает null", () => {
    expect(formatDataVersion(null)).toBeNull();
    expect(formatDataVersion(undefined)).toBeNull();
    expect(formatDataVersion("")).toBeNull();
  });
});
