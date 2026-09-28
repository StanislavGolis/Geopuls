import { readFile } from "node:fs/promises";

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
  isMoving: () => boolean;
  project: (lngLat: [number, number]) => { x: number; y: number };
  getCenter: () => { lat: number; lng: number };
  queryRenderedFeatures: (options?: unknown, layers?: unknown) => { id?: string }[];
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

/** Ячейки с объектами, отсортированные по количеству: из них выбираем точку клика. */
async function nonEmptyCells(
  request: import("@playwright/test").APIRequestContext,
  res = 9,
  limit = 25,
): Promise<{ h3: string; count: number; lat: number; lon: number }[]> {
  const apiBase = process.env.GEOPULS_API_URL ?? "http://127.0.0.1:8000";
  const response = await request.get(`${apiBase}/api/v1/cells?city=tomsk&category=cafe&res=${res}`);
  expect(response.ok()).toBe(true);

  const body = (await response.json()) as {
    features: {
      id: string;
      properties: { count: number };
      geometry: { coordinates: number[][][] };
    }[];
  };

  return body.features
    .filter((feature) => feature.properties.count > 0)
    .sort((left, right) => right.properties.count - left.properties.count)
    .slice(0, limit)
    .map((feature) => {
      const ring = feature.geometry.coordinates[0].slice(0, -1);
      const lon = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
      const lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
      return { h3: feature.id, count: feature.properties.count, lat, lon };
    });
}

/** Самая плотная ячейка: нужна там, где кликать не требуется (проверка ссылки). */
async function densestCell(
  request: import("@playwright/test").APIRequestContext,
  res = 9,
): Promise<{ h3: string; count: number; lat: number; lon: number }> {
  const cells = await nonEmptyCells(request, res, 1);
  expect(cells.length).toBeGreaterThan(0);
  return cells[0];
}

test("клик по ячейке показывает объекты, подсвечивает её и пишет состояние в URL", async ({
  page,
  request,
}) => {
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });
  // Ждём, пока карта перестанет двигаться после подгонки по границам города
  await page.waitForFunction(() => !window.__geopulsMap!.isMoving(), null, { timeout: 30_000 });
  await expect(page.getByTestId("data-version")).toContainText("Данные OSM на");

  // Сетку выбирает зум: ячейку берём того разрешения, которое сейчас на карте
  const resolution = Number(
    (await page.getByTestId("resolution").textContent())?.match(/res (\d)/)?.[1] ?? 9,
  );
  const candidates = await nonEmptyCells(request, resolution, 25);

  /*
   * Точку клика считаем в координатах канваса. Карта есть и под панелью инструментов, и под
   * легендой, но клик по этим местам достаётся не карте, поэтому берём самую плотную ячейку,
   * которая видна, не перекрыта оверлеями и действительно лежит под курсором.
   */
  const point = await page.evaluate(
    (targets: { h3: string; lat: number; lon: number }[]) => {
      const map = window.__geopulsMap!;
      const canvas = map.getCanvas();
      const canvasRect = canvas.getBoundingClientRect();
      const overlays = Array.from(
        document.querySelectorAll(".legend, .poi-panel, .overlay"),
      ).map((element) => element.getBoundingClientRect());

      for (const target of targets) {
        const screen = map.project([target.lon, target.lat]);
        if (
          screen.x < 12 ||
          screen.y < 12 ||
          screen.x > canvas.clientWidth - 12 ||
          screen.y > canvas.clientHeight - 12
        ) {
          continue;
        }

        const viewportX = canvasRect.left + screen.x;
        const viewportY = canvasRect.top + screen.y;
        const covered = overlays.some(
          (rect) =>
            viewportX >= rect.left - 4 &&
            viewportX <= rect.right + 4 &&
            viewportY >= rect.top - 4 &&
            viewportY <= rect.bottom + 4,
        );
        if (covered) continue;

        const hit = map.queryRenderedFeatures([screen.x, screen.y], { layers: ["cells-fill"] })[0] as
          | { id?: string; properties?: { h3?: string } }
          | undefined;
        const hitId = hit?.id ?? hit?.properties?.h3;
        if (hitId !== target.h3) continue;

        return { h3: target.h3, x: screen.x, y: screen.y };
      }

      return null;
    },
    candidates,
  );

  console.log("КЛИК ПО ЯЧЕЙКЕ:", JSON.stringify({ resolution, point }));

  expect(point, "нужна видимая, не перекрытая ячейка с объектами").not.toBeNull();
  const cell = { h3: point!.h3, lat: 0, lon: 0 };

  // Клик с координатами внутри элемента — без пересчёта в координаты окна
  await page.locator(".map__canvas").click({ position: { x: point!.x, y: point!.y } });

  const panel = page.getByTestId("poi-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("poi-count")).toContainText("шт.");
  await expect(panel.getByRole("link", { name: "OpenStreetMap" }).first()).toBeVisible();
  await expect(panel).not.toContainText("нет размеченных объектов");

  // Состояние уходит в адресную строку: ссылкой можно поделиться
  const url = new URL(page.url());
  expect(url.searchParams.get("cell")).toBe(cell.h3);
  expect(url.searchParams.get("city")).toBe("tomsk");
  expect(url.searchParams.get("category")).toBe("cafe");
  expect(Number(url.searchParams.get("zoom"))).toBeGreaterThan(1);
  expect(url.searchParams.get("center")).toMatch(/^-?\d+\.\d+,-?\d+\.\d+$/);

  // Выбранная ячейка подсвечена отдельным слоем (индекс GeoJSON перестраивается асинхронно)
  await page.waitForFunction(
    () =>
      (
        window.__geopulsMap as unknown as { querySourceFeatures: (id: string) => unknown[] }
      ).querySourceFeatures("cells-selected").length > 0,
    null,
    { timeout: 15_000 },
  );
  const selected = await page.evaluate(
    () =>
      (window.__geopulsMap as unknown as { querySourceFeatures: (id: string) => unknown[] })
        .querySourceFeatures("cells-selected").length,
  );
  expect(selected).toBeGreaterThan(0);

  // Закрытие панели убирает ячейку из ссылки
  await page.getByRole("button", { name: "Закрыть список объектов" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/cell=/);
});

test("ссылка с состоянием открывает тот же кадр и список объектов", async ({ page, request }) => {
  const cell = await densestCell(request);
  const share = `/?city=tomsk&category=cafe&cell=${cell.h3}&res=9&zoom=13.5&center=${cell.lat.toFixed(
    5,
  )},${cell.lon.toFixed(5)}&debug=1`;

  await page.goto(share);
  await waitForStyle(page);

  // Список объектов открывается сразу по ссылке
  const panel = page.getByTestId("poi-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("poi-count")).toContainText("шт.");

  // Кадр восстанавливается из URL, а не по границам города
  const view = await page.evaluate(() => {
    const map = window.__geopulsMap!;
    const center = map.getCenter();
    return { zoom: map.getZoom(), lat: center.lat, lon: center.lng };
  });
  expect(view.zoom).toBeCloseTo(13.5, 1);
  expect(view.lon).toBeCloseTo(cell.lon, 3);
  await expect(page.getByTestId("resolution")).toContainText("res 9");
});

test("«Поделиться» кладёт ссылку в буфер обмена", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto(MAP_URL);
  await waitForStyle(page);

  await page.getByTestId("share").click();

  await expect(page.getByTestId("share-status")).toContainText("ссылка скопирована");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("city=tomsk");
  expect(copied).toContain("category=cafe");
});

test("экспорт PNG и CSV отдаёт настоящие файлы", async ({ page }) => {
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });

  const [png] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-png").click(),
  ]);
  expect(png.suggestedFilename()).toMatch(/^geopuls-.+-res\d+\.png$/);

  const pngBuffer = await readFile((await png.path()) as string);
  // PNG: сигнатура и размеры из IHDR — карта плюс подпись с атрибуцией
  expect(pngBuffer.subarray(1, 4).toString("ascii")).toBe("PNG");
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  expect(width).toBeGreaterThan(800);
  expect(height).toBeGreaterThan(400);
  expect(
    pngBuffer.length,
    "снимок с подложкой не может весить как пустая картинка",
  ).toBeGreaterThan(20_000);

  const [csv] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-csv").click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/^geopuls-.+-res\d+\.csv$/);

  const csvText = await readFile((await csv.path()) as string, "utf8");
  const lines = csvText.replace(/^\uFEFF/, "").trimEnd().split("\n");
  expect(lines[0]).toBe("h3,count,density_poi_per_km2,has_address_ratio,lat,lon");
  // Выгружается вся сетка города по текущей категории, включая пустые ячейки
  expect(lines.length).toBeGreaterThan(1000);
});

