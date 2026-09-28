/**
 * Копирует web-worker MapLibre и его «shared»-модуль в `public/`, чтобы задать воркер явно
 * через `setWorkerUrl`.
 *
 * Зачем: в сборке Next (Turbopack) MapLibre не может сам определить URL своего воркера
 * («Worker failed to load»), из-за чего не парсятся ни тайлы подложки, ни GeoJSON-слой —
 * карта остаётся пустой. Явный URL из `public/` решает проблему и в dev, и в проде.
 *
 * Копируются обе пары файлов, потому что main-thread-сборка тоже различается:
 *   dev  — maplibre-gl-worker-dev.mjs + maplibre-gl-shared-dev.mjs
 *   prod — maplibre-gl-worker.mjs     + maplibre-gl-shared.mjs
 * Выбор URL делает клиент (MapView) по `process.env.NODE_ENV`.
 *
 * Запускается автоматически перед `npm run dev` и `npm run build` (см. package.json).
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(dirname(require.resolve("maplibre-gl/package.json")), "dist");
const targetDir = join(projectRoot, "public");

/** Файлы воркера: воркер и его shared-модуль для каждой сборки. */
const WORKER_FILES = [
  "maplibre-gl-worker.mjs",
  "maplibre-gl-shared.mjs",
  "maplibre-gl-worker-dev.mjs",
  "maplibre-gl-shared-dev.mjs",
];

mkdirSync(targetDir, { recursive: true });

for (const file of WORKER_FILES) {
  const target = join(targetDir, file);
  copyFileSync(join(distDir, file), target);
  console.log(`[map-worker] ${file} → public/${file}`);
}

