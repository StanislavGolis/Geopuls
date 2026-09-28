import { expect, test } from "@playwright/test";

/**
 * Smoke-проверка карты: подложка, тепловой слой, отсутствие ошибок в консоли и сети.
 *
 * Требуется запущенный стек (API + фронтенд): `pwsh -File tools/dev-up.ps1`.
 */

/** URL карты с включённой отладочной ссылкой на объект карты (`?debug=1`). */
const MAP_URL = "/?city=tomsk&category=cafe&debug=1";

type MapDebug = {
  getLayer: (id: string) => unknown;
  getStyle: () => { layers: { id: string }[]; sources: Record<string, unknown> } | undefined;
  areTilesLoaded: () => boolean;
  queryRenderedFeatures: (options?: unknown) => unknown[];
  getZoom: () => number;
  getCanvas: () => HTMLCanvasElement;
};

declare global {
  interface Window {
    __geopulsMap?: MapDebug;
  }
}

type Diagnostics = {
  layers: number;
  sources: string[];
  hasCellsLayer: boolean;
  renderedCells: number;
  sourceCells: number;
  tilesLoaded: boolean;
  mapLoaded: boolean;
  canvasSize: [number, number];
  clientSize: [number, number];
  hasWebgl2: boolean;
  cellsSourceLoaded: boolean;
  zoom: number;
};

/** Ждём, пока карта создастся и загрузит стиль. */
async function waitForStyle(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const map = window.__geopulsMap;
      const style = map?.getStyle?.();
      return Boolean(style && style.layers.length > 0);
    },
    null,
    { timeout: 30_000 },
  );
}

/** Диагностика из браузера: WebGL, размер канваса, данные источника, отрисованные объекты. */
async function collectDiagnostics(page: import("@playwright/test").Page): Promise<Diagnostics> {
  return page.evaluate(async () => {
    const map = window.__geopulsMap!;
    const deadline = Date.now() + 20_000;
    while (!map.areTilesLoaded() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    // Даём карте отрисовать кадр после подгрузки данных
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const debug = map as unknown as {
      getStyle: () => { layers: unknown[]; sources: Record<string, unknown> } | undefined;
      isSourceLoaded?: (id: string) => boolean;
      querySourceFeatures?: (id: string) => unknown[];
      loaded?: () => boolean;
    };
    const style = debug.getStyle();
    const canvas = map.getCanvas();

    return {
      layers: style?.layers.length ?? 0,
      sources: Object.keys(style?.sources ?? {}),
      hasCellsLayer: Boolean(map.getLayer("cells-fill")),
      renderedCells: map.queryRenderedFeatures({ layers: ["cells-fill"] }).length,
      sourceCells: debug.querySourceFeatures?.("cells").length ?? -1,
      tilesLoaded: map.areTilesLoaded(),
      mapLoaded: debug.loaded?.() ?? false,
      canvasSize: [canvas.width, canvas.height],
      clientSize: [canvas.clientWidth, canvas.clientHeight],
      hasWebgl2: Boolean(canvas.getContext("webgl2")),
      cellsSourceLoaded: debug.isSourceLoaded?.("cells") ?? false,
      zoom: map.getZoom(),
    };
  });
}

test("карта рисует подложку и тепловой слой Томска", async ({ page }) => {
  const consoleErrors: string[] = [];
  const consoleMessages: string[] = [];
  const badResponses: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (message) => {
    consoleMessages.push(`${message.type()}: ${message.text().slice(0, 200)}`);
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
  });

  await page.goto(MAP_URL);
  await waitForStyle(page);
  const diagnostics = await collectDiagnostics(page);

  console.log(
    "ДИАГНОСТИКА КАРТЫ:",
    JSON.stringify({ diagnostics, consoleMessages, badResponses: badResponses.slice(0, 5), failedRequests: failedRequests.slice(0, 5) }),
  );

  expect(diagnostics.hasCellsLayer, "тепловой слой должен быть добавлен").toBe(true);
  expect(diagnostics.sourceCells, "данные должны попасть в источник карты").toBeGreaterThan(0);
  expect(diagnostics.layers, "слои стиля подложки должны быть загружены").toBeGreaterThan(5);
  expect(diagnostics.sources.length, "источник подложки должен быть в стиле").toBeGreaterThan(0);
  expect(diagnostics.tilesLoaded, "тайлы подложки должны быть загружены").toBe(true);
  expect(diagnostics.hasWebgl2, "WebGL2 должен быть доступен").toBe(true);
  expect(diagnostics.canvasSize[0], "канвас должен иметь размер").toBeGreaterThan(0);
  expect(diagnostics.clientSize[1], "контейнер карты должен иметь высоту").toBeGreaterThan(100);
  expect(diagnostics.renderedCells, "ячейки должны быть отрисованы").toBeGreaterThan(0);

  await expect(page.getByTestId("basemap-warning")).toHaveCount(0);
  await expect(page.getByTestId("error")).toHaveCount(0);
  await expect(page.getByTestId("data-version")).toContainText("Данные OSM на");

  const realErrors = consoleErrors.filter((text) => !text.includes("favicon"));
  expect(realErrors, `ошибки в консоли: ${realErrors.join(" | ")}`).toHaveLength(0);
  expect(badResponses, `ответы с ошибками: ${badResponses.join(" | ")}`).toHaveLength(0);
});

test("карта занимает основную часть экрана", async ({ page }) => {
  await page.goto(MAP_URL);
  await waitForStyle(page);

  const sizes = await page.evaluate(() => {
    const element = document.querySelector(".map__canvas");
    const rect = element?.getBoundingClientRect();
    const computed = element ? getComputedStyle(element) : null;
    const canvas = document.querySelector("canvas");
    return {
      viewport: window.innerHeight,
      app: document.querySelector(".app")?.clientHeight ?? 0,
      map: document.querySelector(".map")?.clientHeight ?? 0,
      canvasContainer: element?.clientHeight ?? -1,
      canvasContainerCount: document.querySelectorAll(".map__canvas").length,
      canvasContainerRect: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
      canvasContainerPosition: computed?.position ?? null,
      canvasContainerDisplay: computed?.display ?? null,
      canvasContainerTop: computed?.top ?? null,
      canvasContainerHeight: computed?.height ?? null,
      parentClass: element?.parentElement?.className ?? null,
      actualCanvas: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
    };
  });

  console.log("ВЫСОТЫ:", JSON.stringify(sizes));

  // Карта — основной элемент экрана: она не должна схлопываться до минимальной высоты
  expect(sizes.map, `карта ${sizes.map}px при окне ${sizes.viewport}px`).toBeGreaterThan(
    sizes.viewport * 0.5,
  );
  expect(sizes.actualCanvas?.[1] ?? 0, "канвас карты должен заполнять область").toBe(sizes.map);
});

test("переключение категории меняет тепловой слой", async ({ page }) => {
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });

  await page.getByLabel("Категория").selectOption("pickup_point");

  await page.waitForFunction(
    () => {
      const map = window.__geopulsMap;
      const features = map?.queryRenderedFeatures({ layers: ["cells-fill"] }) ?? [];
      return features.some((feature) => {
        const properties = (feature as { properties?: { count?: number } }).properties;
        return (properties?.count ?? 0) > 0;
      });
    },
    null,
    { timeout: 30_000 },
  );

  await expect(page.getByTestId("data-version")).toContainText("Данные OSM на");
});
