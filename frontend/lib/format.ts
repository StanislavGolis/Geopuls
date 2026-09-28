/**
 * Форматирование значений для интерфейса: числительные и даты.
 *
 * Вынесено отдельно от компонентов, чтобы правила были проверяемыми: «12 объектов» вместо «12 шт.»,
 * дата выгрузки — в человеческом виде («27.09.2026»), а не ISO.
 */

/**
 * Русская форма слова «объект» для числа: 1 объект, 2 объекта, 5 объектов.
 *
 * Правило: 11–14 — всегда «объектов»; иначе смотрим последнюю цифру (1 → «объект», 2–4 → «объекта»).
 */
export function pluralObjects(count: number): string {
  const value = Math.trunc(count);
  const hundreds = Math.abs(value) % 100;
  const last = hundreds % 10;

  if (hundreds > 10 && hundreds < 20) return `${value} объектов`;
  if (last === 1) return `${value} объект`;
  if (last >= 2 && last <= 4) return `${value} объекта`;
  return `${value} объектов`;
}

/** «2026-09-27» → «27.09.2026». Непонятный формат возвращаем как есть, null — как null. */
export function formatDataVersion(version: string | null | undefined): string | null {
  if (!version) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(version.trim());
  if (!match) return version;

  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}
