/**
 * Кэш последнего успешного ответа теплового слоя.
 *
 * Зачем: при потере связи показываем последние загруженные данные и баннер «нет связи»
 * (раздел 4.3 ТЗ, дизайн-спека §4.8), а не пустую карту. Храним в `sessionStorage`: данные живут
 * в пределах вкладки, поэтому устаревшая сетка не «всплывает» через неделю.
 *
 * Своя ответственность: работа с хранилищем не должна ронять интерфейс ни при каких условиях —
 * приватный режим, переполнение квоты и битый JSON обрабатываются как «кэша нет».
 */

import type { CellsResponse } from "@/lib/api";

const PREFIX = "geopuls.cells";

/** Ключ кэша: сетка зависит от города, категории и разрешения. */
export function cellsCacheKey(city: string, category: string, res: number): string {
  return `${PREFIX}:${city}:${category}:${res}`;
}

export function saveCells(key: string, payload: CellsResponse): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Приватный режим или квота — кэш не критичен для работы приложения
  }
}

export function loadCells(key: string): CellsResponse | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as CellsResponse).features) ||
      typeof (parsed as CellsResponse).meta !== "object"
    ) {
      return null;
    }

    return parsed as CellsResponse;
  } catch {
    return null;
  }
}

export function clearCells(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // см. saveCells
  }
}
