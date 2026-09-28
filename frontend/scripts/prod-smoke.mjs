// Проверка прода в реальном браузере: карта, тепловой слой, клик по ячейке, консоль и сеть.
//
//   PROD_URL="https://<домен>/?city=tomsk&category=cafe&debug=1" npm run prod:smoke
//
// Флаг debug=1 обязателен: в продакшене ссылка на карту (`window.__geopulsMap`) отдаётся только с ним
// (ADR 0009). Скриншот складывается в ../data/processed/prod-smoke.png. Код возврата 0 — прод живой.
import { chromium } from "playwright";

const url =
  process.env.PROD_URL ?? "https://201.34.158.13.sslip.io/?city=tomsk&category=cafe&debug=1";
const shot = process.env.PROD_SHOT ?? "../data/processed/prod-smoke.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text()}`);
});
page.on("response", (response) => {
  if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

// 1. Карта отрисована: канвас ненулевого размера, стиль подложки и слой ячеек на месте
await page.waitForFunction(
  () => {
    const canvas = document.querySelector("canvas.maplibregl-canvas");
    const map = window.__geopulsMap;
    return Boolean(canvas && canvas.clientWidth > 100 && map?.getLayer?.("cells-fill"));
  },
  null,
  { timeout: 90_000 },
);

// 2. Данные дошли до источника и ячейки реально нарисованы (публичный API мап-объекта)
await page.waitForFunction(
  () => (window.__geopulsMap?.querySourceFeatures("cells")?.length ?? 0) > 0,
  null,
  { timeout: 90_000 },
);

const rendered = await page.evaluate(() => ({
  cellsInSource: window.__geopulsMap.querySourceFeatures("cells").length,
  renderedCells: window.__geopulsMap.queryRenderedFeatures({ layers: ["cells-fill"] }).length,
  styleLayers: window.__geopulsMap.getStyle().layers.length,
  canvas: [
    document.querySelector("canvas.maplibregl-canvas").clientWidth,
    document.querySelector("canvas.maplibregl-canvas").clientHeight,
  ],
}));

// 3. Легенда и постоянная строка атрибуции
const legend = await page.locator(".legend").first().innerText();
const attribution = await page.locator('[data-testid="attribution"]').first().innerText();

// 4. Клик по непустой ячейке открывает панель объектов: точку берём из геометрии самой ячейки
const marker = await page.evaluate(() => {
  const map = window.__geopulsMap;
  const feature = map
    .queryRenderedFeatures({ layers: ["cells-fill"] })
    .find((item) => item.properties.count > 0);
  if (!feature || feature.geometry.type !== "Polygon") return null;
  const ring = feature.geometry.coordinates[0];
  const lons = ring.map((point) => point[0]);
  const lats = ring.map((point) => point[1]);
  const center = [
    (Math.min(...lons) + Math.max(...lons)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  ];
  const point = map.project(center);
  return { x: point.x, y: point.y, count: feature.properties.count };
});
let panel = "панель не открыта";
if (marker) {
  await page.mouse.click(marker.x, marker.y);
  await page.waitForSelector(".poi-panel", { timeout: 30_000 });
  panel = await page.locator(".poi-panel").first().innerText();
}

await page.screenshot({ path: shot, fullPage: false });
await browser.close();

console.log(
  JSON.stringify(
    {
      url,
      ...rendered,
      legend: legend.replace(/\s+/g, " ").slice(0, 120),
      attribution: attribution.replace(/\s+/g, " ").slice(0, 160),
      panel: panel.replace(/\s+/g, " ").slice(0, 120),
      problems,
    },
    null,
    2,
  ),
);

process.exit(problems.length === 0 && rendered.renderedCells > 0 ? 0 : 1);
