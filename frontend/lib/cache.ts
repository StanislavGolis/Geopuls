/**
 * Кэш последнего успешного ответа карты.
 *
 * Зачем: при потере связи показываем последние загруженные данные и баннер «нет связи»
 * (раздел 4.3 ТЗ, дизайн-спека §4.8), а не пустую карту. Храним в `sessionStorage`: данные живут
 * в пределах вкладки, поэтому устаревшая сетка не «всплывает» через неделю.
 *
 * Своя ответственность: работа с хранилищем не должна ронять интерфейс ни при каких условиях —
 * приватный режим, переполнение квоты и битый JSON обрабатываются как «кэша нет».
 */

import type { LayerGrid } from "@/lib/api";

const PREFIX = "geopuls.grid";

/** Ключ кэша: сетка зависит от города, разрешения и набора слоёв (ADR 0013). */
export function gridCacheKey(city: string, base: string, overlays: string, res: number): string {
  return `${PREFIX}:${city}:${res}:${base}:${overlays}`;
}

export function saveGrid(key: string, payload: LayerGrid): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Приватный режим или квота — кэш не критичен для работы приложения
  }
}

export function loadGrid(key: string): LayerGrid | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<LayerGrid>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray(parsed.cells?.h3) ||
      !Array.isArray(parsed.layers) ||
      typeof parsed.meta !== "object" ||
      parsed.meta === null
    ) {
      return null;
    }

    return parsed as LayerGrid;
  } catch {
    return null;
  }
}

export function clearGrid(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // см. saveGrid
  }
}
