import { describe, expect, it, vi } from "vitest";

import { FALLBACK_STYLE, supportsWebGL2 } from "./MapView";

/**
 * Проверки чистых помощников карты: они отвечают за деградацию без WebGL2
 * и за минимальный стиль, с которым тепловой слой рисуется без подложки.
 */
describe("MapView: помощники карты", () => {
  it("в jsdom без WebGL возвращает false и не бросает исключение", () => {
    // jsdom не реализует WebGL: getContext возвращает null
    const contextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(null as unknown as RenderingContext);

    expect(supportsWebGL2()).toBe(false);

    contextSpy.mockRestore();
  });

  it("считает WebGL2 доступным, если контекст получен", () => {
    const contextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as unknown as RenderingContext);

    expect(supportsWebGL2()).toBe(true);

    contextSpy.mockRestore();
  });

  it("не падает, если браузер бросает исключение при создании контекста", () => {
    const contextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      throw new Error("WebGL недоступен");
    });

    expect(supportsWebGL2()).toBe(false);

    contextSpy.mockRestore();
  });

  it("минимальный стиль содержит фон и не тянет внешние источники", () => {
    expect(FALLBACK_STYLE.version).toBe(8);
    expect(FALLBACK_STYLE.sources).toEqual({});
    expect(FALLBACK_STYLE.layers).toHaveLength(1);
    expect(FALLBACK_STYLE.layers[0].type).toBe("background");
  });
});
