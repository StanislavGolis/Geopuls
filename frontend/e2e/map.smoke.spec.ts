import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

/**
 * Smoke-проверка карты: подложка, тепловой слой, отсутствие ошибок в консоли и сети.
 *
 * Требуется запущенный стек (API + фронтенд): `pwsh -File tools/dev-up.ps1`.
 */

/** URL карты с включённой отладочной ссылкой на объект карты (`?debug=1`). */
const MAP_URL = "/?city=tomsk&category=cafe&debug=1";

/**
 * Адрес API для проверок, которые ходят мимо страницы.
 *
 * По умолчанию локальный стек (`web` на 3000, `api` на 8000 — это разные порты). При прогоне против
 * прода API живёт на том же домене, поэтому там задаётся `GEOPULS_API_URL=https://<домен>`.
 */
const API_BASE = process.env.GEOPULS_API_URL ?? "http://127.0.0.1:8000";

type MapDebug = {
  getLayer: (id: string) => unknown;
  getStyle: () => { layers: { id: string }[]; sources: Record<string, unknown> } | undefined;
  areTilesLoaded: () => boolean;
  isMoving: () => boolean;
  project: (lngLat: [number, number]) => { x: number; y: number };
  getCenter: () => { lat: number; lng: number };
  queryRenderedFeatures: (options?: unknown, layers?: unknown) => { id?: string }[];
  querySourceFeatures: (sourceId: string, filter?: unknown) => unknown[];
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
  await expect(page.getByTestId("data-version")).toContainText(/\d{2}\.\d{2}\.\d{4}/);

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

  await page.getByLabel("Категория", { exact: true }).selectOption("pickup_point");

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

  await expect(page.getByTestId("data-version")).toContainText(/\d{2}\.\d{2}\.\d{4}/);
});

/** Ячейки с объектами, отсортированные по количеству: из них выбираем точку клика. */
async function nonEmptyCells(
  request: import("@playwright/test").APIRequestContext,
  res = 9,
  limit = 25,
): Promise<{ h3: string; count: number; lat: number; lon: number }[]> {
  const apiBase = API_BASE;
  const response = await request.get(
    `${apiBase}/api/v1/map?city=tomsk&base=competitors:cafe&res=${res}`,
  );
  expect(response.ok()).toBe(true);

  // Колоночный ответ: геометрия отдельно, значения — колонками по слоям (ADR 0013)
  const body = (await response.json()) as {
    cells: { h3: string[]; geometry: number[][][] };
    layers: { role: string; extras: Record<string, (number | null)[]> }[];
  };
  const base = body.layers.find((column) => column.role === "base");
  const counts = base?.extras.count ?? [];

  return body.cells.h3
    .map((h3, index) => {
      const ring = body.cells.geometry[index].slice(0, -1);
      const lon = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
      const lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
      return { h3, count: Number(counts[index] ?? 0), lat, lon };
    })
    .filter((cell) => cell.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
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

test("клик по ячейке показывает объекты, точки бизнесов и числа включённого слоя", async ({
  page,
  request,
}) => {
  // Дополнительный слой включаем ссылкой: панель обязана показать его числа по выбранной ячейке
  await page.goto(`${MAP_URL}&overlays=workplaces`);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });
  // Ждём, пока карта перестанет двигаться после подгонки по границам и подтянет тайлы: точка клика,
  // посчитанная в движении, попадает в соседнюю ячейку (этот флейк видели на проде сразу после выката)
  await page.waitForFunction(
    () => {
      const map = window.__geopulsMap!;
      return !map.isMoving() && map.areTilesLoaded();
    },
    null,
    { timeout: 30_000, polling: 500 },
  );

  // Подгонка по границам города стартует уже после загрузки стиля, поэтому «карта не движется» в
  // первый момент ничего не гарантирует. Ждём, пока zoom и центр перестанут меняться между опросами:
  // иначе точка, посчитанная до подгонки, указывает в другую ячейку, и клик уходит не туда.
  const mapView = () =>
    page.evaluate(() => {
      const map = window.__geopulsMap!;
      const center = map.getCenter();
      return {
        zoom: Number(map.getZoom().toFixed(5)),
        lat: Number(center.lat.toFixed(6)),
        lon: Number(center.lng.toFixed(6)),
      };
    });
  let previousView = await mapView();
  await expect
    .poll(
      async () => {
        const current = await mapView();
        const unchanged = JSON.stringify(current) === JSON.stringify(previousView);
        previousView = current;
        return unchanged;
      },
      {
        message: "вид карты должен устояться перед выбором точки клика",
        timeout: 30_000,
        intervals: [500],
      },
    )
    .toBe(true);
  // И пока не отрисуются непустые ячейки: иначе точку клика выбрать не из чего
  await page.waitForFunction(
    () => {
      const features = window.__geopulsMap?.queryRenderedFeatures({ layers: ["cells-fill"] }) ?? [];
      return features.some((feature) => {
        const properties = (feature as { properties?: { count?: number } }).properties;
        return (properties?.count ?? 0) > 0;
      });
    },
    null,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("data-version")).toContainText(/\d{2}\.\d{2}\.\d{4}/);

  // Сетку выбирает зум, и она меняется после подгонки по границам города: кандидатов берём из той
  // сетки, что реально отрисована (разрешение закодировано вторым символом H3-индекса), иначе клик
  // может уйти в ячейку соседнего разрешения и проверка URL станет случайной
  const res = await page.evaluate(() => {
    const feature = window.__geopulsMap!.queryRenderedFeatures({ layers: ["cells-fill"] })[0] as
      | { properties?: { h3?: string } }
      | undefined;
    return Number((feature?.properties?.h3 ?? "89")[1]) === 9 ? 9 : 8;
  });
  const candidates = await nonEmptyCells(request, res, 40);

  /*
   * Точку клика считаем в координатах канваса. Карта есть и под панелью инструментов, и под
   * легендой, но клик по этим местам достаётся не карте, поэтому берём ячейку, которая видна,
   * не перекрыта оверлеями и под курсором действительно лежит непустая ячейка.
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
          | { id?: string; properties?: { h3?: string; count?: number } }
          | undefined;
        const hitId = hit?.id ?? hit?.properties?.h3;
        if (!hitId || (hit?.properties?.count ?? 0) <= 0) continue;

        return { h3: String(hitId), x: screen.x, y: screen.y };
      }

      return null;
    },
    candidates,
  );

  console.log("КЛИК ПО ЯЧЕЙКЕ:", JSON.stringify({ point }));

  expect(point, "нужна видимая, не перекрытая ячейка с объектами").not.toBeNull();
  const cell = { h3: point!.h3 };

  // Клик с координатами внутри элемента — без пересчёта в координаты окна
  await page.locator(".map__canvas").click({ position: { x: point!.x, y: point!.y } });

  const panel = page.getByTestId("poi-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("poi-count")).toContainText(/объект/);
  await expect(panel.getByRole("link", { name: "OpenStreetMap" }).first()).toBeVisible();
  await expect(panel).not.toContainText("нет размеченных объектов");

  // Дополнительный слой отвечает числами по этой же ячейке — рядом со списком её объектов
  await expect(page.getByTestId("cell-metrics")).toContainText("Доля площади");

  // Карта показывает, где именно стоят конкуренты выбранной ячейки, и только они: сверяем точки с
  // ответом API по той же ячейке и категории (без фильтра на карте оказались бы все объекты OSM).
  // Ячейку берём из адресной строки — это то, что карта действительно выбрала и что видит пользователь.
  const selectedH3 = new URL(page.url()).searchParams.get("cell") ?? cell.h3;
  const cellRes = Number(selectedH3[1]) === 9 ? 9 : 8;
  const apiPois = await request.get(
    `${API_BASE}/api/v1/pois?city=tomsk&cell=${selectedH3}&res=${cellRes}&category=cafe&limit=200`,
  );
  expect(apiPois.ok()).toBe(true);
  const expectedIds = (
    (await apiPois.json()) as { items: { osm_type: string; osm_id: number }[] }
  ).items
    .map((item) => `${item.osm_type}-${item.osm_id}`)
    .sort();

  // querySourceFeatures отдаёт фичи с дублями (GeoJSON-источник раскладывается по тайлам), поэтому
  // сравниваем уникальные ключи объектов — они лежат в свойствах (`id` фичи MapLibre приводит к числу)
  const poiKeys = () =>
    page.evaluate(() => {
      const features = window.__geopulsMap!.querySourceFeatures("cell-pois") as {
        properties?: { osm?: string };
      }[];
      return [...new Set(features.map((feature) => String(feature.properties?.osm ?? "")))].sort();
    });

  await expect
    .poll(poiKeys, {
      message: "точки ячейки должны совпасть со списком объектов выбранной категории",
    })
    .toEqual(expectedIds);

  // И ни одного объекта без выбранной категории: у объекта бывают и другие категории (мультикатегорийность),
  // но чужой объект, не относящийся к «кафе», на карте появиться не должен
  const poiCategories = await page.evaluate(() =>
    (
      window.__geopulsMap!.querySourceFeatures("cell-pois") as {
        properties?: { categories?: string[] };
      }[]
    ).map((feature) => feature.properties?.categories ?? []),
  );
  expect(poiCategories.length).toBeGreaterThan(0);
  expect(poiCategories.every((categories) => categories.includes("cafe"))).toBe(true);

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
  await expect(page.getByTestId("poi-count")).toContainText(/объект/);

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

test("экспорт PNG и CSV отдаёт настоящие файлы", async ({ page, request }) => {
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => !window.__geopulsMap!.isMoving(), null, { timeout: 30_000 });
  await expect(page.getByTestId("data-version")).toContainText(/\d{2}\.\d{2}\.\d{4}/);

  // Форматы выбираются в меню «Экспорт» (дизайн-спека §4.9)
  await page.getByTestId("export").click();
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

  await page.getByTestId("export").click();
  const [csv] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-csv").click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/^geopuls-.+-res\d+\.csv$/);

  const apiBase = API_BASE;
  const resolution = Number(
    (await page.getByTestId("resolution").textContent())?.match(/res (\d)/)?.[1] ?? 9,
  );
  const grid = await request.get(
    `${apiBase}/api/v1/map?city=tomsk&base=competitors:cafe&res=${resolution}`,
  );
  const gridBody = (await grid.json()) as { meta: { cell_count: number } };

  const csvText = await readFile((await csv.path()) as string, "utf8");
  const lines = csvText.replace(/^\uFEFF/, "").trimEnd().split("\n");
  // Атрибуция обязательна и в экспорте (ODbL): первая строка — комментарий с источником
  expect(lines[0]).toContain("OpenStreetMap contributors");
  expect(lines[0]).toContain("ГЕОПУЛЬС");
  // Колонки собраны из активных слоёв: базовый слой с вариантом и его показателями (count, доля адресов)
  expect(lines[1].startsWith("h3,competitors_cafe_value,competitors_cafe_count,")).toBe(true);
  expect(lines[1].endsWith(",lat,lon")).toBe(true);
  // Выгружается вся сетка города по текущей категории, включая пустые ячейки
  expect(lines.length).toBe(gridBody.meta.cell_count + 2);
});

test("вёрстка не ломается на 360 px, тач-цели достаточного размера", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });

  // Интерфейс помещается по ширине: горизонтальной прокрутки нет
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, "ничего не должно выезжать за экран").toBeLessThanOrEqual(1);

  // Тач-цели ≥ 44px (дизайн-спека §6)
  const chip = await page.getByTestId("chip-cafe").boundingBox();
  const share = await page.getByTestId("share").boundingBox();
  expect(chip!.height, "чип категории").toBeGreaterThanOrEqual(44);
  expect(share!.height, "кнопка «Поделиться»").toBeGreaterThanOrEqual(44);

  // Категория выбирается чипами, кнопки — иконочные
  await expect(page.getByLabel("Категория", { exact: true })).toBeHidden();
  await expect(page.locator(".topbar__button-label").first()).toBeHidden();

  await page.screenshot({ path: "e2e/screenshots/mobile-360x640.png" });
});

test("тепловой слой не скрывает подложку: заливка полупрозрачная", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });

  const opacity = await page.evaluate(
    () =>
      (
        window.__geopulsMap as unknown as {
          getPaintProperty: (layer: string, name: string) => unknown;
        }
      ).getPaintProperty("cells-fill", "fill-opacity") as unknown[],
  );

  // Выражение вида ["case", ["==", ["get","count"], 0], <пустые>, <непустые>]
  const empties = Number(opacity[2]);
  const filled = Number(opacity[3]);

  expect(empties, "пустые ячейки не должны закрывать подложку сплошной заливкой").toBeLessThanOrEqual(
    0.2,
  );
  expect(filled, "классы плотности должны быть полупрозрачными").toBeLessThanOrEqual(0.5);
  expect(empties).toBeLessThan(filled);
});

test("панель слоёв показывает основу карты, а слои попадают в ссылку", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });

  // Панель строится из реестра слоёв: основа карты одна и не переключается
  const panel = page.getByLabel("Слои карты");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("layer-base")).toContainText("Конкуренты");
  await expect(panel.getByTestId("layer-transport_stops")).not.toBeChecked();

  // Ссылку собирает сама карта: набор слоёв должен быть в адресе, иначе им нельзя поделиться
  await expect(page).toHaveURL(/base=competitors(:|%3A)cafe/);

  await panel.getByTestId("layer-transport_stops").check();

  await expect(page).toHaveURL(/overlays=transport_stops/);
  // Источник с лицензией виден в панели: слой без атрибуции показывать нельзя
  await expect(page.getByTestId("layer-sources")).toContainText("OpenStreetMap");
});

test("сравнение зон показывает таблицу по двум гексам и живёт в ссылке", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const [first, second] = await nonEmptyCells(request, 9, 2);
  expect(first && second, "нужны две непустые ячейки").toBeTruthy();

  await page.goto(`/?city=tomsk&category=cafe&debug=1&compare=${first!.h3},${second!.h3}`);
  await waitForStyle(page);

  const panel = page.getByTestId("compare-panel");
  await expect(panel).toBeVisible();

  const table = page.getByTestId("compare-table");
  await expect(table).toContainText(first!.h3);
  await expect(table).toContainText(second!.h3);
  // Единицы метрик обязательны: «Плотность, POI/км²» вместо голых чисел
  await expect(table).toContainText("POI/км²");
  // Вердиктов нет — только наблюдения (ADR 0015)
  await expect(panel).not.toContainText("перегрев");

  // Зона уходит из сравнения вместе со ссылкой
  await page.getByTestId(`compare-remove-${second!.h3}`).click();
  await expect(page).not.toHaveURL(new RegExp(second!.h3));
});

test("радиус: клик по карте считает, что вокруг точки, и живёт в ссылке", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });

  await page.getByTestId("tab-tools").click();
  // Инструмент выбирают на вкладке: в шапке больше нет отдельных кнопок (ADR 0016)
  await page.getByTestId("tool-radius").click();
  // Пока точки нет, режим объясняет, что делать: иначе он выглядит как «ничего не произошло»
  await expect(page.getByTestId("around-hint")).toBeVisible();

  // Точку ставит клик по карте — проверяем тот путь, которым идёт пользователь
  const canvas = page.locator(".map__canvas");
  const box = await canvas.boundingBox();
  expect(box, "карта должна занимать область").toBeTruthy();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2 - 80);

  const panel = page.getByTestId("around-panel");
  await expect(panel).toBeVisible();

  const table = page.getByTestId("around-table");
  await expect(table).toContainText("Конкуренты");
  await expect(table).toContainText("В радиусе");
  await expect(table).toContainText("Ближайший");
  // Вердиктов нет — только наблюдения (ADR 0015)
  await expect(panel).not.toContainText("перегрев");

  // Круг радиуса на карте: числа и картинка считаются по одному радиусу
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__geopulsMap?.getLayer("around-circle-line"))))
    .toBe(true);
  // Ссылка помнит точку: расчётом делятся так же, как видом карты
  await expect.poll(() => page.url()).toContain("around=");
});

test("радиус: ссылка с точкой открывает расчёт с тем же радиусом", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${MAP_URL}&around=56.4847,84.9482&radius=300`);
  await waitForStyle(page);

  const panel = page.getByTestId("around-panel");
  await expect(panel).toBeVisible();
  // Радиус из ссылки — тот же, которым посчитан ответ
  await expect(page.getByTestId("around-radius-300")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("around-point")).toContainText("300");
  await expect(page.getByTestId("around-table")).toContainText("Конкуренты");
});

test("профиль города открывается по ссылке и объясняет данные", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${MAP_URL}&profile=1`);
  await waitForStyle(page);

  const panel = page.getByTestId("city-profile");
  await expect(panel).toBeVisible();

  // Карточка обязана быть непрозрачной: прозрачный фон однажды уже ломал читаемость сводки
  const background = await page
    .locator(".city-profile__card")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background, "фон карточки профиля должен быть задан").not.toBe("rgba(0, 0, 0, 0)");
  expect(background, "фон карточки не должен быть полупрозрачным").not.toContain("rgba(");

  // Сводка: площадь, охват и категории — то, что менеджер показывает руководству
  await expect(page.getByTestId("city-profile-facts")).toContainText("Площадь");
  await expect(page.getByTestId("city-profile-categories")).toContainText("Кофейни и кафе");
  await expect(page.getByTestId("city-profile-sources")).toContainText("OpenStreetMap");
  // Пустые ячейки объясняются прямо, а не остаются загадкой
  await expect(panel).toContainText("а не что бизнеса нет в городе");

  // Ссылкой делятся: закрытие убирает состояние из адреса
  await page.getByTestId("city-profile-close").click();
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/profile=1/);
});

test("вкладки переключают сцену и живут в ссылке", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(MAP_URL);
  await waitForStyle(page);

  // Основная вкладка — «Конкуренты»: она состояние по умолчанию, поэтому в ссылку не пишется
  await expect(page.getByTestId("tab-competitors")).toHaveAttribute("aria-selected", "true");
  await expect(page).not.toHaveURL(/tab=/);

  // «Инфраструктура»: карту красит выбранный показатель, его slug уезжает в base (ADR 0016)
  await page.getByTestId("tab-infrastructure").click();
  await expect(page.getByTestId("tab-infrastructure")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=infrastructure/);
  await expect(page).toHaveURL(/base=/);
  await expect(page.getByTestId("infra-layer")).toBeVisible();
  // Категория конкурентов здесь не при чём: выбор показателя заменяет её
  await expect(page).not.toHaveURL(/category=/);

  // «Город»: сводка открывается вкладкой, а не кнопкой поверх карты
  await page.getByTestId("tab-city").click();
  await expect(page.getByTestId("tab-city")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("city-profile")).toBeVisible();
  await expect(page).toHaveURL(/tab=city/);

  // Возврат на основную вкладку убирает сцену города и её параметр из ссылки
  await page.getByTestId("tab-competitors").click();
  await expect(page.getByTestId("city-profile")).toHaveCount(0);
  await expect(page).not.toHaveURL(/tab=/);
});

test("старая ссылка с profile=1 открывает вкладку «Город»", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Ссылки, разошедшиеся до вкладок, обязаны открывать то же самое (ADR 0016)
  await page.goto(`${MAP_URL}&profile=1`);
  await waitForStyle(page);

  await expect(page.getByTestId("city-profile")).toBeVisible();
  await expect(page.getByTestId("tab-city")).toHaveAttribute("aria-selected", "true");
});

test("постоянная строка атрибуции видна и не перекрывается легендой", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });

  const line = page.getByTestId("attribution");
  await expect(line).toBeVisible();
  // Три обязательных упоминания: данные, подложка, ссылка на исправление (ADR 0002)
  await expect(line).toContainText("OpenStreetMap contributors");
  await expect(line).toContainText("OpenFreeMap");
  await expect(line.getByRole("link", { name: "Сообщить об ошибке" })).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/fixthemap",
  );

  // Легенда стоит над строкой, а не поверх неё (дизайн-спека §4.4)
  const legendBox = await page.locator(".legend").boundingBox();
  const lineBox = await line.boundingBox();
  expect(legendBox, "легенда должна быть видна").not.toBeNull();
  expect(lineBox, "строка атрибуции должна быть видна").not.toBeNull();
  expect(legendBox!.y + legendBox!.height).toBeLessThanOrEqual(lineBox!.y + 1);

  // Контрол атрибуции MapLibre отключён: текст показываем мы, а не «иконка i»
  await expect(page.locator(".maplibregl-ctrl-attrib")).toHaveCount(0);

  await page.screenshot({ path: "e2e/screenshots/desktop-1280x800.png" });
});

test("мобильная вёрстка: чипы категорий, свёрнутая легенда, иконочные кнопки", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(MAP_URL);
  await waitForStyle(page);
  await page.waitForFunction(() => Boolean(window.__geopulsMap?.getLayer("cells-fill")), null, {
    timeout: 30_000,
  });

  // Категория выбирается чипами, селект скрыт стилями
  await expect(page.getByTestId("chip-cafe")).toBeVisible();
  await expect(page.getByLabel("Категория", { exact: true })).toBeHidden();

  // Панель слоёв на телефоне свёрнута в кнопку — как и легенда
  await expect(page.getByRole("button", { name: /Слои/ })).toBeVisible();

  // Легенда свёрнута в кнопку: тело скрыто, пока не раскрыли (дизайн-спека §6)
  const toggle = page.getByRole("button", { name: /Легенда/ });
  await expect(toggle).toBeVisible();
  // Классы легенды ищем внутри легенды: та же подпись есть и в панели слоёв
  const legendBody = page.locator(".legend__body");
  await expect(legendBody.getByText("Плотность, POI/км²")).toBeHidden();

  await toggle.click();
  await expect(legendBody.getByText("Плотность, POI/км²")).toBeVisible();
  await expect(page.getByText("пусто")).toBeVisible();

  // Кнопки действий на телефоне — только иконки
  await expect(page.locator(".topbar__button-label").first()).toBeHidden();

  await page.screenshot({ path: "e2e/screenshots/mobile-390x844.png" });

  // Переключение категории чипом меняет тепловой слой
  await page.getByTestId("chip-pickup_point").click();
  await expect(page.getByTestId("chip-pickup_point")).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(
    () => {
      const features = window.__geopulsMap?.queryRenderedFeatures({ layers: ["cells-fill"] }) ?? [];
      return features.some((feature) => {
        const properties = (feature as { properties?: { count?: number } }).properties;
        return (properties?.count ?? 0) > 0;
      });
    },
    null,
    { timeout: 30_000 },
  );
});

