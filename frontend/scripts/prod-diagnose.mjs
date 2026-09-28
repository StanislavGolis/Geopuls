// Диагностика прод-страницы, когда «карта пустая»: что видит браузер на самом деле.
//
//   PROD_URL="https://<домен>/?city=tomsk&category=cafe&debug=1" npm run prod:diagnose
//
// Печатает состояние карты и интерфейса, все запросы к /api и сообщения консоли — этого достаточно,
// чтобы отличить сбой данных от сбоя рендеринга, не гадая.
import { chromium } from "playwright";

const url =
  process.env.PROD_URL ?? "https://201.34.158.13.sslip.io/?city=tomsk&category=cafe&debug=1";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const messages = [];
const api = [];
page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
page.on("requestfailed", (request) => api.push(`FAILED ${request.url()} — ${request.failure()?.errorText}`));
page.on("response", (response) => {
  if (response.url().includes("/api/")) api.push(`${response.status()} ${response.url()}`);
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(20_000); // даём карте и запросу данных время

const state = await page.evaluate(() => {
  const map = window.__geopulsMap;
  const safe = (fn) => {
    try {
      return fn();
    } catch (error) {
      return `ошибка: ${error}`;
    }
  };
  return {
    hasMap: Boolean(map),
    styleLayers: safe(() => map.getStyle().layers.length),
    hasCellsLayer: Boolean(map?.getLayer("cells-fill")),
    hasCellsSource: Boolean(map?.getSource("cells")),
    sourceFeatures: safe(() => map.querySourceFeatures("cells").length),
    rendered: safe(() => map.queryRenderedFeatures({ layers: ["cells-fill"] }).length),
    zoom: safe(() => map.getZoom()),
    canvas: [
      document.querySelector("canvas.maplibregl-canvas")?.clientWidth ?? 0,
      document.querySelector("canvas.maplibregl-canvas")?.clientHeight ?? 0,
    ],
    legend: document.querySelector(".legend")?.innerText?.replace(/\s+/g, " ").slice(0, 160) ?? null,
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 300),
  };
});

await page.screenshot({ path: process.env.PROD_SHOT ?? "../data/processed/prod-debug.png" });
await browser.close();

console.log(JSON.stringify({ url, state, api, console: messages.slice(0, 15) }, null, 2));
