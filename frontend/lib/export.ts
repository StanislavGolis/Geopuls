/**
 * Экспорт текущего вида: PNG карты и CSV ячеек (раздел 4.4 ТЗ, Этап 6).
 *
 * Атрибуция обязательна и в экспорте тоже (лицензия ODbL + условия OpenFreeMap), поэтому PNG
 * собирается из канваса карты плюс подпись с источником данных, а CSV начинается строкой-комментарием
 * с источником, категорией и версией выгрузки — «голые» данные не отдаём.
 */

import type { LayerGrid, MapLayerColumn } from "@/lib/api";

/**
 * Центр ячейки: среднее по вершинам кольца (для шестиугольника H3 это ровно центр).
 *
 * Геометрия в колоночном ответе идёт отдельным массивом, поэтому функция работает с кольцом, а не с
 * объектом GeoJSON: так CSV собирается без промежуточных фич.
 */
export function ringCenter(ring: number[][]): { lat: number; lon: number } {
  // Кольцо замкнуто (первая точка == последняя) — считаем только уникальные вершины
  const points = ring.length > 1 ? ring.slice(0, -1) : ring;
  if (points.length === 0) return { lat: 0, lon: 0 };

  const sums = points.reduce(
    (acc, [lon, lat]) => ({ lon: acc.lon + lon, lat: acc.lat + lat }),
    { lon: 0, lat: 0 },
  );

  return { lat: sums.lat / points.length, lon: sums.lon / points.length };
}

function csvValue(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Имя колонки CSV: `competitors_cafe_value`, `population_count`. */
export function columnName(column: MapLayerColumn, suffix: string): string {
  return [column.slug, column.category, suffix].filter(Boolean).join("_");
}

/** Дополнительные показатели, которые нужно вынести в колонки: объединение по всем слоям. */
export function extraKeys(columns: MapLayerColumn[]): string[] {
  return [...new Set(columns.flatMap((column) => Object.keys(column.extras)))].sort();
}

/**
 * CSV загруженной сетки: строка-комментарий с составом слоёв, затем все ячейки города (включая
 * пустые) — это и есть «пустые зоны», ради которых сервис существует.
 *
 * Колонка на слой: у каждого слоя своё значение и свои дополнительные показатели (`count` и т. п.).
 * Ячейка без данных остаётся пустой, а не нулём: пустое поле честно означает «неизвестно».
 *
 * BOM добавляем, чтобы Excel корректно открывал UTF-8.
 */
export function buildGridCsv(grid: LayerGrid, context: ExportContext): string {
  const columns = grid.layers;
  const extra = extraKeys(columns);

  const header = ["h3"];
  for (const column of columns) header.push(columnName(column, "value"));
  for (const column of columns) {
    for (const key of extra) {
      if (column.extras[key]) header.push(columnName(column, key));
    }
  }
  header.push("lat", "lon");

  const rows = grid.cells.h3.map((h3, index) => {
    const { lat, lon } = ringCenter(grid.cells.geometry[index] ?? []);
    const values: (string | number | null)[] = [h3];

    for (const column of columns) values.push(column.values[index] ?? null);
    for (const column of columns) {
      for (const key of extra) {
        if (column.extras[key]) values.push(column.extras[key][index] ?? null);
      }
    }
    values.push(lat.toFixed(6), lon.toFixed(6));

    return values.map(csvValue).join(",");
  });

  return `\uFEFF${[buildCsvComment(context), header.join(","), ...rows].join("\n")}\n`;
}

/** Слой, попавший в экспорт: имя и роль нужны в подписи, иначе файл не объясняет себя. */
export type ExportLayer = {
  slug: string;
  name: string;
  category: string | null;
  categoryName: string | null;
  role: "base" | "overlay";
  unit: string | null;
};

export type ExportContext = {
  cityName: string;
  res: number;
  /** Слои файла: базовый — первым (он красит карту). */
  layers: ExportLayer[];
  dataVersion?: string | null;
};

/** Подпись слоя для человека: «Конкуренты · Кофейни (базовый, POI/км²)». */
export function layerDescription(layer: ExportLayer): string {
  const name = layer.categoryName ? `${layer.name} · ${layer.categoryName}` : layer.name;
  const role = layer.role === "base" ? "базовый" : "наложение";
  return `${name} (${role}${layer.unit ? `, ${layer.unit}` : ""})`;
}

/**
 * Строка-комментарий для CSV: город, состав слоёв, сетка и лицензия данных.
 *
 * Требование лицензии ODbL и §11.1 ТЗ — атрибуция в экспортах, а не только на экране. CSV с
 * комментарием читается pandas (`comment='#'`), PostgreSQL `COPY` (`HEADER`/`COMMENT`) и Excel;
 * подробность формата описана в README фронтенда.
 */
export function buildCsvComment(context: ExportContext): string {
  const version = context.dataVersion ? `, выгрузка ${context.dataVersion}` : "";
  return (
    `# ГЕОПУЛЬС · ${context.cityName} · сетка H3 res ${context.res} · ` +
    `слои: ${context.layers.map(layerDescription).join("; ")} · ` +
    `данные © OpenStreetMap contributors (ODbL)${version}`
  );
}

export function exportFileName(context: ExportContext, extension: "png" | "csv"): string {
  const slug = context.cityName
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
  return `geopuls-${slug}-res${context.res}.${extension}`;
}

/** Строки подписи под картой: состав слоёв, источник данных и подложка — требование лицензий. */
export function buildExportFooter(context: ExportContext): string[] {
  const version = context.dataVersion ? `, выгрузка ${context.dataVersion}` : "";
  return [
    `ГЕОПУЛЬС · ${context.cityName} · сетка H3 res ${context.res}`,
    `Слои: ${context.layers.map(layerDescription).join(" · ")}`,
    `Данные © OpenStreetMap contributors (ODbL)${version}`,
    "Подложка: OpenFreeMap © OpenMapTiles · показаны только объекты, размеченные в OSM",
  ];
}

/**
 * Собрать PNG: снимок карты плюс подпись с атрибуцией под ним.
 *
 * Канвас карты — WebGL, поэтому снимок возможен только при `preserveDrawingBuffer: true`
 * (см. docs/decisions/0010-share-export.md).
 */
export async function canvasToPngWithFooter(
  source: HTMLCanvasElement,
  lines: string[],
): Promise<string> {
  // Подпись рисуем уже загруженным шрифтом: до `fonts.ready` браузер подставит системный
  if (typeof document !== "undefined" && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // Шрифты недоступны — рисуем тем, что есть
    }
  }

  const lineHeight = 18;
  const footerHeight = lines.length > 0 ? lines.length * lineHeight + 10 : 0;

  const output = document.createElement("canvas");
  output.width = source.width;
  output.height = source.height + footerHeight;

  const context = output.getContext("2d");
  if (!context) return source.toDataURL("image/png");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(source, 0, 0);

  context.fillStyle = "#334155";
  context.font = "14px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  lines.forEach((line, index) => {
    context.fillText(line, 12, source.height + 24 + index * lineHeight);
  });

  return output.toDataURL("image/png");
}

function triggerDownload(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  triggerDownload(dataUrl, filename);
}

export function downloadText(text: string, filename: string, mime = "text/csv;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  // Ссылку освобождаем после того, как браузер начал скачивание
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
