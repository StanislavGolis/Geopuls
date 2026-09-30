import { describe, expect, it } from "vitest";

import {
  EMPTY_URL_STATE,
  buildSearch,
  parseCellList,
  parseCenter,
  parseH3Cell,
  parseUrlState,
  parseZoom,
  resolutionFromZoom,
} from "./urlState";

const CELL = "890b80db643ffff";

describe("parseUrlState", () => {
  it("читает город, категорию, ячейку и вид из query-строки", () => {
    const state = parseUrlState(`?city=tomsk&category=cafe&cell=${CELL}&zoom=13.4&center=56.4736,85.024`);

    expect(state.city).toBe("tomsk");
    expect(state.category).toBe("cafe");
    expect(state.cell).toBe(CELL);
    expect(state.zoom).toBeCloseTo(13.4);
    expect(state.center).toEqual({ lat: 56.4736, lon: 85.024 });
    expect(state.res).toBe(9);
  });

  it("принимает объект searchParams, как их отдаёт Next", () => {
    const state = parseUrlState({ city: "tomsk", category: ["cafe", "bar"], cell: CELL });

    expect(state.city).toBe("tomsk");
    expect(state.category).toBe("cafe");
  });

  it("игнорирует мусор вместо того, чтобы ронять карту", () => {
    const state = parseUrlState("?city=%20&category=&cell=не-h3&zoom=99&center=56.4");

    expect(state.city).toBeNull();
    expect(state.category).toBeNull();
    expect(state.cell).toBeNull();
    expect(state.zoom).toBeNull();
    expect(state.center).toBeNull();
    expect(state.res).toBeNull();
  });

  it("на пустой строке возвращает пустое состояние (кроме выведенной вкладки)", () => {
    // Вкладка выводится всегда: без ссылки это основная сцена «Конкуренты» (ADR 0016)
    const empty = { ...EMPTY_URL_STATE, tab: "competitors" as const };
    expect(parseUrlState("")).toEqual(empty);
    expect(parseUrlState("?")).toEqual(empty);
    expect(parseUrlState({})).toEqual(empty);
  });

  it("разрешение выводится из зума, а при его отсутствии — из параметра res", () => {
    expect(parseUrlState("?zoom=13").res).toBe(9);
    expect(parseUrlState("?zoom=9.7").res).toBe(8);
    // Зум важнее: сетку на карте выбирает он
    expect(parseUrlState("?zoom=13&res=8").res).toBe(9);
    expect(parseUrlState("?res=8").res).toBe(8);
    expect(parseUrlState("?res=7").res).toBeNull();
  });

  it("центр учитывается только вместе с зумом", () => {
    expect(parseUrlState("?center=56.47,85.02").center).toBeNull();
    expect(parseUrlState("?zoom=12&center=56.47,85.02").center).not.toBeNull();
  });
});

describe("buildSearch", () => {
  it("пишет только значимые параметры", () => {
    expect(buildSearch({})).toBe("");
    expect(buildSearch({ city: "tomsk", category: null, cell: undefined })).toBe("city=tomsk");
  });

  it("не пишет битую ячейку и пустые значения", () => {
    expect(buildSearch({ city: "  ", cell: "ой" })).toBe("");
  });

  it("округляет зум и центр, чтобы ссылка была короткой и стабильной", () => {
    const search = buildSearch({
      city: "tomsk",
      category: "cafe",
      cell: CELL,
      res: 9,
      zoom: 13.43721,
      center: { lat: 56.47361234, lon: 85.02412345 },
    });

    expect(search).toBe(
      `city=tomsk&category=cafe&cell=${CELL}&res=9&zoom=13.44&center=56.47361,85.02412`,
    );
  });

  it("сохраняет состояние, собранное в ссылку (round-trip)", () => {
    const original = {
      city: "tomsk",
      category: "cafe",
      base: "competitors:cafe",
      overlays: "population,transport",
      cell: CELL,
      compare: null,
      around: { lat: 56.4847, lon: 84.9482 },
      radius: 1000,
      res: 9 as const,
      zoom: 13,
      center: { lat: 56.473, lon: 85.024 },
    };

    // Вкладку ссылка не хранит: клиент выводит её из состояния (точка радиуса → «Инструменты»)
    expect(parseUrlState(buildSearch(original))).toEqual({ ...original, tab: "tools" });
  });

  it("вкладка города — состояние ссылки: ей делятся, а не открывают заново", () => {
    expect(buildSearch({ city: "tomsk", tab: "city" })).toBe("city=tomsk&tab=city");
    expect(parseUrlState("?city=tomsk&tab=city").tab).toBe("city");
    // Основная вкладка в ссылку не пишется: это состояние по умолчанию
    expect(buildSearch({ city: "tomsk", tab: "competitors" })).toBe("city=tomsk");
    expect(parseUrlState("?city=tomsk").tab).toBe("competitors");
  });

  it("вкладка выводится из состояния, если её нет в ссылке (совместимость)", () => {
    // Профиль города раньше был отдельным экраном
    expect(parseUrlState("?city=tomsk&profile=1").tab).toBe("city");
    expect(parseUrlState("?city=tomsk&compare=890b80db643ffff,890b80db64bffff").tab).toBe("tools");
    expect(parseUrlState("?city=tomsk&around=56.4847,84.9482").tab).toBe("tools");
    expect(parseUrlState("?city=tomsk&base=competitors:cafe").tab).toBe("competitors");
    expect(parseUrlState("?city=tomsk&base=residential").tab).toBe("infrastructure");
    // Мусор вместо вкладки не роняет карту: показываем основную
    expect(parseUrlState("?city=tomsk&tab=nowhere").tab).toBe("competitors");
  });

  it("точка радиуса живёт в ссылке — расчёт можно переслать", () => {
    const search = buildSearch({ around: { lat: 56.4847, lon: 84.9482 } });

    // Радиус по умолчанию в ссылку не пишем: она остаётся короткой, а значение подставит клиент
    expect(search).toBe("around=56.48470,84.94820");
    expect(parseUrlState(`?${search}`).around).toEqual({ lat: 56.4847, lon: 84.9482 });
  });

  it("другой радиус попадает в ссылку", () => {
    expect(buildSearch({ around: { lat: 56.4847, lon: 84.9482 }, radius: 1000 })).toBe(
      "around=56.48470,84.94820&radius=1000",
    );
  });

  it("радиус без точки игнорируется: непонятно, вокруг чего считать", () => {
    expect(parseUrlState("?city=tomsk&radius=1000").radius).toBeNull();
  });

  it("мусор вместо координат и радиуса не роняет карту", () => {
    const state = parseUrlState("?around=abc&radius=999999");

    expect(state.around).toBeNull();
    expect(state.radius).toBeNull();
  });

  it("сравнение зон: список ячеек в ссылке, мусор отбрасывается, лишние обрезаются", () => {
    const cells = [CELL, "890b80db64bffff", "890b80db6cbffff"];
    expect(buildSearch({ city: "tomsk", compare: cells.join(",") })).toBe(
      `city=tomsk&compare=${cells.join(",")}`,
    );
    expect(parseCellList(`${CELL},не-ячейка,${CELL}`)).toEqual([CELL]);
    expect(parseCellList("a,b,c,d,e,f,g")).toEqual([]);
    expect(parseCellList("")).toEqual([]);
  });

  it("читает базовый слой и наложения из ссылки", () => {
    const state = parseUrlState("?city=tomsk&base=competitors:cafe&overlays=population,transport");

    expect(state.base).toBe("competitors:cafe");
    expect(state.overlays).toBe("population,transport");
  });

  it("пишет базовый слой рядом с категорией: старые клиенты читают ссылку по-прежнему", () => {
    const search = buildSearch({ city: "tomsk", category: "cafe", base: "competitors:cafe", overlays: "population" });

    expect(search).toBe("city=tomsk&category=cafe&base=competitors:cafe&overlays=population");
  });

  it("не пишет центр без зума", () => {
    expect(buildSearch({ city: "tomsk", center: { lat: 1, lon: 2 } })).toBe("city=tomsk");
  });
});

describe("частные разборы", () => {
  it("H3-индекс: только 15 hex-символов, регистр не важен", () => {
    expect(parseH3Cell(CELL.toUpperCase())).toBe(CELL);
    expect(parseH3Cell(` ${CELL.toUpperCase()} `)).toBe(CELL);
    expect(parseH3Cell("890b80db643ff")).toBeNull();
    expect(parseH3Cell("zzzzzzzzzzzzzzz")).toBeNull();
  });

  it("зум: конечное число в допустимом диапазоне", () => {
    expect(parseZoom("12")).toBe(12);
    expect(parseZoom("abc")).toBeNull();
    expect(parseZoom("0.5")).toBeNull();
    expect(parseZoom("23")).toBeNull();
    expect(parseZoom(null)).toBeNull();
  });

  it("центр: пара чисел в допустимых диапазонах", () => {
    expect(parseCenter("56.47,85.02")).toEqual({ lat: 56.47, lon: 85.02 });
    expect(parseCenter("56.47")).toBeNull();
    expect(parseCenter("91,85")).toBeNull();
    expect(parseCenter("56,200")).toBeNull();
    expect(parseCenter("широта,долгота")).toBeNull();
  });

  it("порог разрешения совпадает с картой", () => {
    expect(resolutionFromZoom(12)).toBe(9);
    expect(resolutionFromZoom(11.99)).toBe(8);
  });
});
