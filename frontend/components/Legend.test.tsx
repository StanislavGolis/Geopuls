import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Legend from "./Legend";
import { ZERO_COLOR, heatColors } from "@/lib/heat";

const BREAKS = [0, 25.6, 42.7, 59.8, 76.9];

describe("Legend", () => {
  it("показывает классы с подписями и цветами по границам из API", () => {
    const { container } = render(<Legend breaks={BREAKS} res={9} poiCount={250} />);

    expect(screen.getByText("Плотность, POI / км²")).toBeTruthy();
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

  it("показывает разрешение сетки и число объектов в категории", () => {
    render(<Legend breaks={BREAKS} res={8} poiCount={1} />);

    expect(screen.getByTestId("resolution").textContent).toContain("res 8");
    expect(screen.getByText("в категории 1 объект")).toBeTruthy();
  });

  it("предупреждает, если объектов в OSM мало", () => {
    render(<Legend breaks={BREAKS} poiCount={7} thinDataThreshold={30} />);

    expect(screen.getByText(/Мало данных OSM/)).toBeTruthy();
  });

  it("не предупреждает при достаточном количестве объектов", () => {
    render(<Legend breaks={BREAKS} poiCount={250} thinDataThreshold={30} />);

    expect(screen.queryByText(/Мало данных OSM/)).toBeNull();
  });

  it("без границ классов показывает только нулевой класс", () => {
    const { container } = render(<Legend breaks={null} />);

    expect(container.querySelectorAll(".legend__swatch")).toHaveLength(1);
  });

  it("всегда напоминает о происхождении данных", () => {
    render(<Legend breaks={BREAKS} res={9} />);

    expect(screen.getByText(/Только объекты, размеченные в OpenStreetMap/)).toBeTruthy();
  });

  it("на мобильном свёрнута в кнопку, которая раскрывает список классов", () => {
    const { container } = render(<Legend breaks={BREAKS} res={9} />);

    const toggle = screen.getByRole("button", { name: /Легенда/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".legend")?.classList.contains("legend--collapsed")).toBe(true);

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: /Легенда/ }).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".legend")?.classList.contains("legend--expanded")).toBe(true);
  });
});
