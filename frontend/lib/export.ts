/**
 * Экспорт текущего вида: PNG карты и CSV ячеек (раздел 4.4 ТЗ, Этап 6).
 *
 * Атрибуция обязательна и в экспорте тоже (лицензия ODbL + условия OpenFreeMap), поэтому PNG
 * собирается из канваса карты плюс подпись с источником данных, а CSV начинается строкой-комментарием
 * с источником, категорией и версией выгрузки — «голые» данные не отдаём.
 */

import type { CellFeature, CellsResponse } from "@/lib/api";
import { formatDensity } from "@/lib/heat";

export const CSV_HEADER = "h3,count,density_poi_per_km2,has_address_ratio,lat,lon";

/** Центр ячейки: среднее по вершинам кольца (для шестиугольника H3 это ровно центр). */
export function cellCenter(feature: CellFeature): { lat: number; lon: number } {
  const ring = feature.geometry.coordinates[0] ?? [];
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

/**
 * CSV загруженной сетки: строка-комментарий с атрибуцией, затем все ячейки города по текущей
 * категории (включая пустые) — это и есть «пустые зоны», ради которых сервис существует.
 *
 * BOM добавляем, чтобы Excel корректно открывал UTF-8.
 */
export function buildCellsCsv(cells: CellsResponse, context: ExportContext): string {
  const rows = cells.features.map((feature) => {
    const { lat, lon } = cellCenter(feature);
    return [
      csvValue(feature.properties.h3),
      csvValue(feature.properties.count),
      csvValue(formatDensity(feature.properties.density)),
      csvValue(feature.properties.has_address_ratio),
      csvValue(lat.toFixed(6)),
      csvValue(lon.toFixed(6)),
    ].join(",");
  });

  return `\uFEFF${[buildCsvComment(context), CSV_HEADER, ...rows].join("\n")}\n`;
}

export type ExportContext = {
  cityName: string;
  categoryName: string;
  res: number;
  dataVersion?: string | null;
};

/**
 * Строка-комментарий для CSV: источник данных, категория и версия выгрузки.
 *
 * Требование лицензии ODbL и §11.1 ТЗ — атрибуция в экспортах, а не только на экране. CSV с
 * комментарием читается pandas (`comment='#'`), PostgreSQL `COPY` (`HEADER`/`COMMENT`) и Excel;
 * подробность формата описана в README фронтенда.
 */
export function buildCsvComment(context: ExportContext): string {
  const version = context.dataVersion ? `, выгрузка ${context.dataVersion}` : "";
  return (
    `# ГЕОПУЛЬС · ${context.cityName} · ${context.categoryName} · сетка H3 res ${context.res} · ` +
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

/** Строки подписи под картой: источник данных, категория, дата — требование лицензий. */
export function buildExportFooter(context: ExportContext): string[] {
  return [
    `ГЕОПУЛЬС · ${context.cityName} · ${context.categoryName} · сетка H3 res ${context.res}`,
    `Данные © OpenStreetMap contributors (ODbL)${
      context.dataVersion ? `, выгрузка ${context.dataVersion}` : ""
    }`,
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
