import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Legend from "./Legend";
import { ZERO_COLOR, heatColors } from "@/lib/heat";
import type { LayerLegend } from "@/lib/layers";

const BREAKS = [0, 25.6, 42.7, 59.8, 76.9];

function layer(overrides: Partial<LayerLegend> = {}): LayerLegend {
  return {
    name: "Конкуренты (объекты по категориям)",
    metricKind: "density",
    unit: "POI/км²",
    breaks: BREAKS,
    objectCount: 250,
    ...overrides,
  };
}

describe("Legend", () => {
  it("показывает классы с подписями и цветами по границам из API", () => {
    const { container } = render(<Legend layer={layer()} res={9} />);

    expect(screen.getByText("Плотность, POI/км²")).toBeTruthy();
    expect(screen.getByText("Конкуренты (объекты по категориям)")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText("пусто")).toBeTruthy();
    expect(screen.getByText("до 25.6")).toBeTruthy();
    expect(screen.getByText("25.6 – 42.7")).toBeTruthy();
    expect(screen.getByText("42.7 – 59.8")).toBeTruthy();
    expect(screen.getByText("более 59.8")).toBeTruthy();
    expect(screen.getByText("высокая")).toBeTruthy();

    const swatches = Array.from(container.querySelectorAll<HTMLElement>(".legend__swatch"));
    expect(swatches).toHaveLength(heatColors(4).length + 1);
    // Пустая ячейка — отдельный класс со своим контуром
    expect(swatches[0].classList.contains("legend__swatch--empty")).toBe(true);
    expect(swatches[0].style.background).toBe("rgb(230, 234, 239)");
    expect(ZERO_COLOR).toBe("#E6EAEF");
  });

  it("подписывает метрику слоя, а не только единицу измерения", () => {
    render(<Legend layer={layer({ metricKind: "people_density", unit: "чел/км²" })} />);

    expect(screen.getByText("Плотность населения, чел/км²")).toBeTruthy();
  });

  it("показывает разрешение сетки и число объектов в слое", () => {
    render(<Legend layer={layer({ objectCount: 1 })} res={8} />);

    expect(screen.getByTestId("resolution").textContent).toContain("res 8");
    expect(screen.getByText("в слое 1 объект")).toBeTruthy();
  });

  it("предупреждает, если объектов в OSM мало", () => {
    render(<Legend layer={layer({ objectCount: 7 })} thinDataThreshold={30} />);

    expect(screen.getByText(/Мало данных OSM/)).toBeTruthy();
  });

  it("не предупреждает при достаточном количестве объектов", () => {
    render(<Legend layer={layer()} thinDataThreshold={30} />);

    expect(screen.queryByText(/Мало данных OSM/)).toBeNull();
  });

  it("честно говорит, когда слой собран не по всей сетке", () => {
    render(<Legend layer={layer()} partialCoverage />);

    expect(screen.getByText(/не по всей сетке/)).toBeTruthy();
  });

  it("без данных слоя показывает только нулевой класс", () => {
    const { container } = render(<Legend layer={null} />);

    expect(screen.getByRole("heading", { name: "Легенда" })).toBeTruthy();
    expect(container.querySelectorAll(".legend__swatch")).toHaveLength(1);
  });

  it("всегда напоминает о происхождении данных", () => {
    render(<Legend layer={layer()} res={9} />);

    expect(screen.getByText(/Только объекты, размеченные в OpenStreetMap/)).toBeTruthy();
  });

  it("на мобильном свёрнута в кнопку, которая раскрывает список классов", () => {
    const { container } = render(<Legend layer={layer()} res={9} />);

    const toggle = screen.getByRole("button", { name: /Легенда/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".legend")?.classList.contains("legend--collapsed")).toBe(true);

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: /Легенда/ }).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".legend")?.classList.contains("legend--expanded")).toBe(true);
  });
});