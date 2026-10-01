import { describe, expect, it } from "vitest";

import { formatReportDate, reportFileName, reportHeading } from "./report";

describe("reportHeading", () => {
  const base = {
    cityName: "Томск",
    subject: "Кофейни и кафе",
    dataVersion: "2026-09-27",
    compareCount: 0,
    point: null,
    radiusM: null,
  };

  it("называет категорию: отчёт объясняет, что именно измерялось", () => {
    const heading = reportHeading({ ...base, tab: "competitors" });

    expect(heading.title).toBe("Конкуренты: Кофейни и кафе");
    expect(heading.subtitle).toContain("Томск");
    // Дата выгрузки обязательна: без неё документ нечем датировать
    expect(heading.subtitle).toContain("27.09.2026");
  });

  it("для инфраструктуры называет показатель слоя", () => {
    const heading = reportHeading({ ...base, tab: "infrastructure", subject: "Жилые дома и зоны" });

    expect(heading.title).toBe("Инфраструктура: Жилые дома и зоны");
    expect(heading.scene).toBe("инфраструктура");
  });

  it("радиус описывает точку и метры, а не «инструменты»", () => {
    const heading = reportHeading({
      ...base,
      tab: "tools",
      point: { lat: 56.4847, lon: 84.9482 },
      radiusM: 300,
    });

    expect(heading.title).toBe("Что вокруг точки: радиус 300 м");
    expect(heading.subtitle).toContain("56.48470, 84.94820");
    expect(heading.subtitle).toContain("Кофейни и кафе");
  });

  it("сравнение зон сообщает, сколько зон сравнивается", () => {
    const heading = reportHeading({ ...base, tab: "tools", compareCount: 3 });

    expect(heading.title).toBe("Сравнение зон: 3");
    expect(heading.scene).toBe("сравнение-зон");
  });

  it("город — это профиль, а не «город»", () => {
    const heading = reportHeading({ ...base, tab: "city" });

    expect(heading.title).toBe("Профиль города");
  });

  it("без даты выгрузки говорит об этом прямо, а не молчит", () => {
    const heading = reportHeading({ ...base, tab: "competitors", dataVersion: null });

    expect(heading.subtitle).toContain("дата выгрузки неизвестна");
  });
});

describe("formatReportDate", () => {
  it("переводит дату выгрузки в привычную запись", () => {
    expect(formatReportDate("2026-09-27")).toBe("27.09.2026");
    // Неизвестный формат отдаём как есть: выдумывать дату нельзя
    expect(formatReportDate("неизвестно")).toBe("неизвестно");
  });
});

describe("reportFileName", () => {
  it("собирает имя файла из города и сцены", () => {
    expect(reportFileName("Томск", "конкуренты", "2026-09-27")).toBe("geopuls-томск-конкуренты-2026-09-27");
  });

  it("без даты обходится без неё", () => {
    expect(reportFileName("Томск", "профиль-города", null)).toBe("geopuls-томск-профиль-города");
  });
});
