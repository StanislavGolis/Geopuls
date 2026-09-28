import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Тот же алиас, что в tsconfig.json: "@/..." → корень фронтенда
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    // Компоненты тестируем в jsdom, логику — там же (единая среда проще для CI)
    environment: "jsdom",
    // globals нужны Testing Library: иначе она не регистрирует авто-очистку DOM между тестами
    globals: true,
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
  },
});
