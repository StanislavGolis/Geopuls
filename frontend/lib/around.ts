/**
 * Круг радиуса R вокруг точки: геометрия для карты и допустимые значения радиуса.
 *
 * Почему круг строим на клиенте: бэкенд отвечает числами, а не геометрией, и тащить оттуда полигон
 * значило бы держать на экране две разные границы — ту, что показываем, и ту, по которой считали.
 * Формула та же, что в `ST_DWithin`: расстояние по сфере, поэтому и здесь пересчёт через метры
 * на градус, а не «на глазок по пикселям».
 */

/** Радиус по умолчанию: 500 м — это примерно пять минут пешком (ТЗ §3.2). */
export const DEFAULT_RADIUS_M = 500;

/** Что можно выбрать: сотни метров вокруг адреса, до двух километров — тот же пределы, что в API. */
export const RADIUS_OPTIONS = [100, 300, 500, 1000, 2000] as const;

export type RadiusOption = (typeof RADIUS_OPTIONS)[number];

/** Метров в одном градусе широты: длина дуги меридиана, достаточная точность для круга 2 км. */
const METERS_PER_DEGREE_LAT = 111_320;

export type AroundPoint = {
  lat: number;
  lon: number;
  radiusM: number;
};

/** Разумно ли значение радиуса: мусор из ссылки не должен уходить в API (там те же пределы). */
export function isValidRadius(value: number | null | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= RADIUS_OPTIONS[0] &&
    value <= RADIUS_OPTIONS[RADIUS_OPTIONS.length - 1]
  );
}

/**
 * Круг в форме GeoJSON-полигона: заметно больше полигона не нужно, 64 точки дают гладкий контур.
 *
 * Долгота: градус долготы короче широтного и зависит от широты — без `cos(lat)` круг вытянулся бы
 * к полюсам и обещал бы не ту площадь.
 */
export function buildRadiusCircle(
  lat: number,
  lon: number,
  radiusM: number,
  steps = 64,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const latDelta = radiusM / METERS_PER_DEGREE_LAT;
  const lonDelta = radiusM / (METERS_PER_DEGREE_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6));

  const ring: [number, number][] = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = (step / steps) * 2 * Math.PI;
    ring.push([lon + lonDelta * Math.cos(angle), lat + latDelta * Math.sin(angle)]);
  }

  return {
    type: "Feature",
    properties: { radius_m: radiusM },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}
