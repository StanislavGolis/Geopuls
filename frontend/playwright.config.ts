import { defineConfig, devices } from "@playwright/test";

/**
 * E2E-проверки фронтенда (smoke).
 *
 * Требуется запущенный стек: `pwsh -File tools/dev-up.ps1` (API на 8000 + фронтенд на 3000).
 * Запуск: `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.GEOPULS_WEB_URL ?? "http://localhost:3000",
    // Программный WebGL: карта должна рисоваться и без аппаратного ускорения
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
