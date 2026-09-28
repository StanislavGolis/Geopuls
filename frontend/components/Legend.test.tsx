import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Legend from "./Legend";
import { HEAT_COLORS } from "@/lib/heat";

const BREAKS = [0, 25.6, 42.7, 59.8, 76.9];

describe("Legend", () => {
  it("показывает пять классов с подписями и цветами из ответа API", () => {
    const { container } = render(<Legend breaks={BREAKS} poiCount={250} />);

    expect(screen.getByText("Плотность объектов, POI / км²")).toBeTruthy();
    expect(screen.getByText(/0 — нет размеченных объектов/)).toBeTruthy();
    expect(screen.getByText("до 25.6")).toBeTruthy();
    expect(screen.getByText("25.6 – 42.7")).toBeTruthy();
    expect(screen.getByText("42.7 – 59.8")).toBeTruthy();
    expect(screen.getByText("более 59.8")).toBeTruthy();

    const swatches = Array.from(container.querySelectorAll<HTMLElement>(".legend__swatch"));
    expect(swatches).toHaveLength(HEAT_COLORS.length);
    expect(swatches[0].style.background).toBe("rgb(232, 238, 242)");
  });

  it("предупреждает, если объектов в OSM мало", () => {
    render(<Legend breaks={BREAKS} poiCount={7} thinDataThreshold={30} />);

    expect(screen.getByText(/Мало объектов в OSM/)).toBeTruthy();
  });

  it("не предупреждает при достаточном количестве объектов", () => {
    render(<Legend breaks={BREAKS} poiCount={250} thinDataThreshold={30} />);

    expect(screen.queryByText(/Мало объектов в OSM/)).toBeNull();
  });

  it("без границ классов показывает только нулевой класс", () => {
    const { container } = render(<Legend breaks={null} />);

    expect(container.querySelectorAll(".legend__swatch")).toHaveLength(1);
  });

  it("всегда напоминает о происхождении данных", () => {
    render(<Legend breaks={BREAKS} />);

    expect(screen.getByText(/Только объекты, размеченные в OpenStreetMap/)).toBeTruthy();
  });
});
